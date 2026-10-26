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
import { readPageRecord } from "../../knowledge/memory-pages";
import { getPageOrNull } from "../../knowledge/memory-trail";
import { agentSourceId } from "../../knowledge/scope";
import { runPass, type Outcome } from "../runner";
import { LESSONS_MAX_LINES } from "../pass-tools";
import { renderPassPrompt } from "../prompts";
import type { NightlyDeps } from "./nightly-review";
import type { AgentGroup } from "../scheduler";

export const LESSONS_SLUG = "self/lessons";
export const PROPOSALS_SLUG = "self/lesson-proposals";
/** The proposals page's whole body once nothing is waiting. */
export const NO_PROPOSALS = "No open lesson proposals.";

export type UpkeepDeps = Pick<NightlyDeps, "runner" | "call" | "run">;

/** True when the agent's proposals page holds something to merge. */
export async function hasOpenProposals(agentId: string, call: UpkeepDeps["call"]): Promise<boolean> {
  const source = agentSourceId(agentId);
  const rec = readPageRecord(await getPageOrNull(call, PROPOSALS_SLUG, { clientId: agentId, sourceId: source, allowedSources: [source] }));
  const body = rec?.body.trim() ?? "";
  return body !== "" && body !== NO_PROPOSALS;
}

/** Run the upkeep pass for one agent group and slot; null when there was nothing to merge. */
export async function runLessonsUpkeep(r: AgentGroup & { slot: string; signal?: AbortSignal }, deps: UpkeepDeps): Promise<{ outcome: Outcome } | null> {
  if (r.signal?.aborted) {
    console.log(`[background] agent=${r.agentId} pass=lessons-upkeep: shutting down; not running`);
    return null;
  }
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
