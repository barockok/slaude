/**
 * Lessons upkeep (spec §9.1, §9.2; ruling D): after the nightly review, one
 * agent-scope pass merges the lesson proposals into the agent's lessons page.
 *
 *   `self/lesson-proposals` (type `correction`: spec §8.2 places the agent's
 *     corrections in its own slice as lesson candidates) is written by the
 *     nightly review's agent-scope pass, one dated, sourced line per proposal;
 *   `self/lessons` (type `lessons`, at most LESSONS_MAX_LINES lines, which
 *     memoize enforces) is rewritten whole by this pass.
 *
 * The pass then writes the proposals page back with only the proposals still
 * waiting for a second sighting (a lesson needs a correction or a pattern
 * seen twice), or NO_PROPOSALS when none remain. The lessons page is one page
 * rewritten in place; gbrain keeps its earlier versions. With no open
 * proposal the pass does not run (no model call, no ledger row).
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { env } from "../../config/env";
import * as MemoryScopes from "../../db/memory-scopes";
import { composePage, readPageRecord } from "../../knowledge/memory-pages";
import { getPageOrNull } from "../../knowledge/memory-trail";
import { agentSourceId, type BrainScope } from "../../knowledge/scope";
import { placeBound } from "../../memory/place-binding";
import { hasPlacePrefix } from "../../memory/place-id";
import { lessonPageViolation } from "../lesson-lines";
import { runPass, type Outcome } from "../runner";
import { LESSONS_MAX_LINES, LESSONS_REFUSAL, passToolId, type PassTool } from "../pass-tools";
import { LESSON_PROPOSALS_PAGE_SLUG, LESSONS_PAGE_SLUG } from "../proposal-payload";
import { renderPassPrompt } from "../prompts";
import type { NightlyDeps } from "./nightly-review";
import type { AgentGroup } from "../scheduler";

export const LESSONS_SLUG = LESSONS_PAGE_SLUG;
export const PROPOSALS_SLUG = LESSON_PROPOSALS_PAGE_SLUG;
/** The proposals page's whole body once nothing is waiting. */
export const NO_PROPOSALS = "No open lesson proposals.";

export type UpkeepDeps = Pick<NightlyDeps, "runner" | "call" | "run" | "placesOn" | "places">;

/** True when the agent's proposals page holds something to merge. */
export async function hasOpenProposals(agentId: string, call: UpkeepDeps["call"]): Promise<boolean> {
  const source = agentSourceId(agentId);
  const rec = readPageRecord(await getPageOrNull(call, PROPOSALS_SLUG, { clientId: agentId, sourceId: source, allowedSources: [source] }));
  const body = rec?.body.trim() ?? "";
  return body !== "" && body !== NO_PROPOSALS;
}

/** The tool that writes the merged lessons page when places are on. */
export const WRITE_LESSONS_TOOL = "write_lessons";
/** A proposal older than this is dropped by code, never handed to the pass. */
export const PROPOSAL_MAX_AGE_MS = 14 * 24 * 3600_000;

/** One proposal line found on a place's (or the persona's) proposals page. */
export interface ProposalItem {
  /** The handle the pass refers to it by. */
  id: string;
  /** The source whose proposals page holds the line. */
  source: string;
  line: string;
  /** The line's date (`- YYYY-MM-DD ...`), or null. */
  date: string | null;
}

const proposalScope = (agentId: string, source: string): BrainScope => ({
  clientId: agentId,
  sourceId: source,
  allowedSources: [source],
  ...(hasPlacePrefix(source) ? { placeAgent: agentId } : {}),
});

const bodyLines = (body: string): string[] => body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("- "));

async function proposalLinesIn(call: UpkeepDeps["call"], agentId: string, source: string): Promise<string[]> {
  const rec = readPageRecord(await getPageOrNull(call, PROPOSALS_SLUG, proposalScope(agentId, source)));
  const body = rec?.body.trim() ?? "";
  return body === "" || body === NO_PROPOSALS ? [] : bodyLines(body);
}

/**
 * The lesson proposals of every place of the agent (registry order), then the persona slice's own page from before
 * the switch. Code reads them; the pass is only handed the text. A source the registry does not bind to this agent
 * is skipped, and one that cannot be read is skipped with a warning (its proposals wait).
 */
export async function collectProposals(agentId: string, deps: Pick<UpkeepDeps, "call" | "places">): Promise<ProposalItem[]> {
  const registered = await (deps.places ?? (async (a: string) => (await MemoryScopes.listByAgent(a)).map((x) => x.source_id)))(agentId);
  const sources = [...[...registered].sort(), agentSourceId(agentId)];
  const items: ProposalItem[] = [];
  for (const source of sources) {
    if (hasPlacePrefix(source) && !(await placeBound(agentId, source))) continue;
    let lines: string[];
    try {
      lines = await proposalLinesIn(deps.call, agentId, source);
    } catch (e) {
      console.warn(`[background] agent=${agentId} pass=lessons-upkeep: proposals in one source could not be read (${e instanceof Error ? e.name : typeof e}); they wait`);
      continue;
    }
    for (const line of lines) items.push({ id: `P${items.length + 1}`, source, line, date: /^- (\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1] ?? null });
  }
  return items;
}

/** Remove exactly these lines from a source's proposals page (re-read first, so a line written meanwhile stays). */
export async function removeProposalLines(call: UpkeepDeps["call"], agentId: string, source: string, gone: readonly string[], now: Date): Promise<void> {
  if (gone.length === 0) return;
  const left = (await proposalLinesIn(call, agentId, source)).filter((l) => !gone.includes(l));
  const c = composePage({ slug: PROPOSALS_SLUG, content: left.length > 0 ? left.join("\n") : NO_PROPOSALS, type: "correction" }, now);
  if ("error" in c) throw new Error(c.error);
  await call("put_page", { slug: PROPOSALS_SLUG, content: c.content }, proposalScope(agentId, source));
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const toolErr = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * `write_lessons`: the only write of `self/lessons` when places are on. Code checks every new line (lesson-lines.ts),
 * keeps the 40 line cap, writes the page in the persona's slice, then removes the proposals the pass says it merged
 * or dropped from the pages they came from. A proposal the pass does not name stays where it is.
 */
export function writeLessonsTool(a: { agentId: string; call: UpkeepDeps["call"]; items: ProposalItem[]; now: () => Date }): PassTool {
  const agentSrc = agentSourceId(a.agentId);
  return tool(
    WRITE_LESSONS_TOOL,
    `Write the whole lessons page (at most ${LESSONS_MAX_LINES} lines, each \`- YYYY-MM-DD <lesson>\`, general: no name, id, mention, address, link or reference), and say which proposals it merges or drops. Proposals you do not name stay where they are.`,
    {
      lessons: z.array(z.string()).max(LESSONS_MAX_LINES).describe("Every line of the new lessons page."),
      merged: z.array(z.string()).default([]).describe("Proposal handles (P1, P2, ...) now covered by a line above."),
      dropped: z.array(z.string()).default([]).describe("Proposal handles to discard: a duplicate, or a lesson that is not one."),
    },
    async ({ lessons, merged, dropped }): Promise<ToolResult> => {
      const lines = lessons.map((l) => l.trim()).filter((l) => l !== "");
      if (lines.length > LESSONS_MAX_LINES) return toolErr(LESSONS_REFUSAL);
      const existing = readPageRecord(await getPageOrNull(a.call, LESSONS_SLUG, proposalScope(a.agentId, agentSrc)));
      // A line already on the page was persona-wide before this release: it may stay as written, a new or changed one may not.
      const keep = new Set(existing ? existing.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
      const bad = lessonPageViolation(lines, keep);
      if (bad) return toolErr(`refused: ${bad}; rewrite it so it names no person, place, channel, customer or task, and leave that proposal waiting if it cannot be put generally`);
      const c = composePage({ slug: LESSONS_SLUG, content: lines.join("\n"), type: "lessons" }, a.now());
      if ("error" in c) return toolErr(c.error);
      try {
        await a.call("put_page", { slug: LESSONS_SLUG, content: c.content }, proposalScope(a.agentId, agentSrc));
      } catch (e) {
        return toolErr(`brain put_page failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const gone = new Map<string, string[]>();
      for (const id of new Set([...merged, ...dropped])) {
        const it = a.items.find((x) => x.id === id);
        if (it) gone.set(it.source, [...(gone.get(it.source) ?? []), it.line]);
      }
      let failed = 0;
      for (const [source, ls] of gone) {
        try {
          await removeProposalLines(a.call, a.agentId, source, ls, a.now());
        } catch {
          failed++;
        }
      }
      return { content: [{ type: "text", text: `written: ${LESSONS_SLUG} (${lines.length} lines)${failed ? `; ${failed} proposal page(s) could not be cleared and will be offered again` : ""}` }] };
    },
  ) as unknown as PassTool;
}

/** Memory places on (rc.47): the proposals of every place, generalised by the pass, merged into the persona's lessons. */
async function runPlacesUpkeep(r: AgentGroup & { slot: string; signal?: AbortSignal }, deps: UpkeepDeps): Promise<{ outcome: Outcome } | null> {
  const now = deps.runner.now();
  let items = await collectProposals(r.agentId, deps);
  // A proposal over its age is dropped by code and never handed to the pass.
  const stale = items.filter((i) => i.date !== null && now.getTime() - Date.parse(`${i.date}T00:00:00Z`) > PROPOSAL_MAX_AGE_MS);
  for (const source of new Set(stale.map((i) => i.source))) {
    await removeProposalLines(deps.call, r.agentId, source, stale.filter((i) => i.source === source).map((i) => i.line), now).catch(() => {});
  }
  items = items.filter((i) => !stale.includes(i));
  if (items.length === 0) {
    console.log(`[background] agent=${r.agentId} pass=lessons-upkeep: no open lesson proposals; not running`);
    return null;
  }
  const prompt = renderPassPrompt("lessons-upkeep-general", {
    DAY: r.slot,
    LESSONS_SLUG,
    LESSONS_MAX_LINES: String(LESSONS_MAX_LINES),
    WRITE_TOOL: passToolId(WRITE_LESSONS_TOOL),
  });
  const res = await (deps.run ?? runPass)(
    {
      pass: "lessons-upkeep",
      personaId: r.personaId,
      agentId: r.agentId,
      scope: { kind: "agent" },
      prompt,
      // The proposals are text handed over by code: the pass reads and searches no place, and has no search tool at all.
      transcripts: items.map((i) => ({ at: i.date ?? r.slot, author: i.id, text: i.line })),
      baseTools: ["read_pages", "list_pages", "propose"],
      extraTools: [writeLessonsTool({ agentId: r.agentId, call: deps.runner.brainCall, items, now: deps.runner.now })],
      ...(r.signal ? { signal: r.signal } : {}),
    },
    deps.runner,
  );
  return { outcome: res.outcome };
}

/** Run the upkeep pass for one agent group and slot; null when there was nothing to merge. */
export async function runLessonsUpkeep(r: AgentGroup & { slot: string; signal?: AbortSignal }, deps: UpkeepDeps): Promise<{ outcome: Outcome } | null> {
  if (r.signal?.aborted) {
    console.log(`[background] agent=${r.agentId} pass=lessons-upkeep: shutting down; not running`);
    return null;
  }
  if (r.personaIds.some((p) => (deps.placesOn ?? ((x: string) => env.memory.placesOn(x)))(p))) return runPlacesUpkeep(r, deps);
  if (!(await hasOpenProposals(r.agentId, deps.call))) {
    console.log(`[background] agent=${r.agentId} pass=lessons-upkeep: no open lesson proposals; not running`);
    return null;
  }
  const prompt = renderPassPrompt("lessons-upkeep", {
    DAY: r.slot,
    LESSONS_SLUG,
    PROPOSALS_SLUG,
    LESSONS_MAX_LINES: String(LESSONS_MAX_LINES),
    NO_PROPOSALS,
  });
  const res = await (deps.run ?? runPass)({ pass: "lessons-upkeep", personaId: r.personaId, agentId: r.agentId, scope: { kind: "agent" }, prompt, ...(r.signal ? { signal: r.signal } : {}) }, deps.runner);
  return { outcome: res.outcome };
}
