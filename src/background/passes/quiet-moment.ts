/**
 * The quiet-moment pass (spec §9.1, §8.5; rulings A, B): when a busy thread
 * goes quiet, review that one thread sooner than the nightly review would, and
 * write its rolling summary.
 *
 * Selection (thread_activity, bumped at turn end by memory sync): a thread is
 * due when it has at least N turns (SLAUDE_QUIET_MIN_TURNS), no turn for M
 * minutes (SLAUDE_QUIET_MINUTES), and no summary through its last turn; at
 * most K quiet-moment runs per agent per persona-local day
 * (SLAUDE_QUIET_MAX_PER_DAY), counted from the ledger (every outcome counts).
 * The claim is the slot `<session>@<last_turn_at>`, so a thread is reviewed
 * at most once per quiet stretch across replicas and restarts; a new turn
 * makes a new stretch.
 *
 * Scope is the thread_activity row's, set at turn end by the rule memory sync
 * uses: `user:<id>` (a /1on1 or DM thread) runs as that person over their
 * `user-<id>` slice, with only their own turns, the agent's and runtime text;
 * `agent` runs agent-scope over `agent-<id>`.
 *
 * The summary is written by the pass's own `write_summary` tool to
 * `conversations/<session>/summary` in the same source as the conversation
 * page (the pass's write source), never anywhere else; the conversation page
 * itself is never rewritten (memoize refuses `conversations/…`). Once written,
 * summarized_at is set to the slot's last_turn_at.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { env } from "../../config/env";
import * as Runs from "../../db/background-runs";
import * as Sessions from "../../db/sessions";
import * as ThreadActivity from "../../db/thread-activity";
import { redactSecrets } from "../../gateway/core/status-text";
import { CREDENTIAL_REFUSAL, readPageRecord } from "../../knowledge/memory-pages";
import { getPageOrNull } from "../../knowledge/memory-trail";
import type { BrainScope } from "../../knowledge/scope";
import { conversationSlug, conversationSummarySlug, orderTimeline } from "../../memory/brain-provider";
import { localDay } from "../budget";
import { passToolId, passWriteSource, type PassScope, type PassTool, type TranscriptTurn } from "../pass-tools";
import { renderPassPrompt } from "../prompts";
import { runPass, type Outcome } from "../runner";
import type { AgentGroup } from "../scheduler";
import { capped, deliverRunProposals, ownTurns, parseTimelineRow, SYSTEM_AUTHOR, TIMELINE_CEILING, type DayRow, type NightlyDeps } from "./nightly-review";

export const QUIET_MOMENT = "quiet-moment" as const;
/** The summary tool's name on `slaude_pass`. */
export const SUMMARY_TOOL = "write_summary";
/** Longest summary the tool accepts. */
export const SUMMARY_MAX_CHARS = 4000;

export interface QuietThresholds {
  /** N: turns a thread needs. */
  minTurns: number;
  /** M, in ms: how long the thread has had no turn. */
  quietMs: number;
  /** K: quiet-moment runs per agent per persona-local day. */
  maxPerDay: number;
}

export function quietThresholds(): QuietThresholds {
  return { minTurns: env.quietMinTurns(), quietMs: env.quietMinutes() * 60_000, maxPerDay: env.quietMaxPerDay() };
}

export type QuietDeps = Pick<NightlyDeps, "runner" | "call" | "run" | "deliver">;

/** The claim slot for one quiet stretch of a thread. */
export const quietSlot = (sessionId: string, lastTurnAt: number): string => `${sessionId}@${lastTurnAt}`;

export function parseQuietSlot(slot: string): { sessionId: string; lastTurnAt: number } | null {
  const at = slot.lastIndexOf("@");
  if (at <= 0) return null;
  const lastTurnAt = Number(slot.slice(at + 1));
  return Number.isSafeInteger(lastTurnAt) ? { sessionId: slot.slice(0, at), lastTurnAt } : null;
}

/**
 * The group's threads due a quiet-moment pass at `now`: quiet longest first,
 * no more than today's remaining K. Threads past K wait for a later day (or
 * the nightly review).
 */
export async function dueQuietThreads(g: AgentGroup, now: Date, t: QuietThresholds = quietThresholds()): Promise<ThreadActivity.ThreadActivity[]> {
  const used = await Runs.countOn(g.agentId, QUIET_MOMENT, localDay(now, g.timeZone));
  const left = t.maxPerDay - used;
  if (left <= 0) return [];
  return ThreadActivity.due(g.agentId, { minTurns: t.minTurns, quietBefore: now.getTime() - t.quietMs, limit: left });
}

/** The pass scope a thread_activity scope names, or null when it is unusable. */
function passScopeOf(scope: string, teamId: string): PassScope | null {
  if (scope === "agent") return { kind: "agent" };
  if (scope.startsWith("user:") && scope.length > "user:".length) return { kind: "user", userId: scope.slice("user:".length), teamId };
  return null;
}

/** The summary page: frontmatter naming the session and how far it covers, then the body. */
export function summaryPage(sessionId: string, body: string, through: number, now: Date): string {
  return [
    "---",
    "type: conversation-summary",
    `session: ${sessionId}`,
    `as_of: ${now.toISOString().slice(0, 10)}`,
    `through: ${new Date(through).toISOString()}`,
    "---",
    body.trim(),
    "",
  ].join("\n");
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const toolErr = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * `write_summary`: the one write of the summary page, to `slug` in `scope`'s
 * single source (the pass's write source, where the conversation page is).
 */
export function summaryTool(a: { slug: string; sessionId: string; through: number; scope: BrainScope; call: QuietDeps["call"]; now: () => Date; onWritten: () => void }): PassTool {
  return tool(
    SUMMARY_TOOL,
    `Write this thread's rolling summary (replaces the earlier one), at most ${SUMMARY_MAX_CHARS} characters. Plain text; no frontmatter.`,
    { content: z.string().describe("The summary of the whole thread so far.") },
    async ({ content }): Promise<ToolResult> => {
      const body = content.trim();
      if (!body) return toolErr("refused: the summary is empty");
      if (body.length > SUMMARY_MAX_CHARS) return toolErr(`refused: the summary is over ${SUMMARY_MAX_CHARS} characters`);
      if (/^---\r?\n/.test(body)) return toolErr("refused: the summary is the body only; no frontmatter");
      if (redactSecrets(body) !== body) return toolErr(CREDENTIAL_REFUSAL);
      try {
        await a.call("put_page", { slug: a.slug, content: summaryPage(a.sessionId, body, a.through, a.now()) }, a.scope);
      } catch (e) {
        return toolErr(redactSecrets(`brain put_page failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      a.onWritten();
      return { content: [{ type: "text", text: `written: ${a.slug}` }] };
    },
  ) as unknown as PassTool;
}

export interface QuietResult {
  outcome: Outcome;
  summarized: boolean;
}

/**
 * Run the quiet-moment pass for one claimed slot. Null when nothing ran: an
 * unparseable slot, a thread with no activity row or an unusable scope, no
 * recorded turns in its slice, or shutting down.
 */
export async function runQuietMoment(r: AgentGroup & { slot: string; signal?: AbortSignal }, deps: QuietDeps): Promise<QuietResult | null> {
  const tag = `[background] agent=${r.agentId} pass=${QUIET_MOMENT}`;
  const parsed = parseQuietSlot(r.slot);
  if (!parsed) {
    console.error(`${tag}: bad slot '${r.slot.slice(0, 120)}'; not running`);
    return null;
  }
  const { sessionId, lastTurnAt } = parsed;
  if (r.signal?.aborted) {
    console.log(`${tag}: shutting down; session=${sessionId} not reviewed`);
    return null;
  }
  const act = await ThreadActivity.get(sessionId);
  if (!act || act.agentId !== r.agentId) {
    console.warn(`${tag}: session=${sessionId} has no activity row for this agent; not running`);
    return null;
  }
  const session = await Sessions.findById(sessionId);
  const scope = passScopeOf(act.scope, session?.slack_team_id ?? "");
  if (!scope) {
    console.warn(`${tag}: session=${sessionId} has an unusable scope; not running`);
    return null;
  }
  const source = passWriteSource(scope, r.agentId);
  const brainScope: BrainScope = { clientId: scope.kind === "user" ? scope.userId : r.agentId, sourceId: source, allowedSources: [source] };

  const slug = conversationSlug(sessionId);
  const rows = await deps.call("get_timeline", { slug }, brainScope);
  const list = Array.isArray(rows) ? (rows as DayRow[]) : [];
  if (list.length >= TIMELINE_CEILING) console.warn(`${tag}: ${slug} returned ${list.length} timeline entries, gbrain's limit; older turns may be missing`);
  let turns: TranscriptTurn[] = orderTimeline(list).flatMap((row) => parseTimelineRow(row));
  if (scope.kind === "user") {
    const own = ownTurns(turns, scope.userId);
    if (own.length < turns.length) console.warn(`${tag}: ${turns.length - own.length} turn(s) by someone else in ${source} are left out`);
    turns = own;
  }
  if (turns.length === 0) {
    console.log(`${tag}: session=${sessionId} has no recorded turns in its slice; nothing to review`);
    return null;
  }

  const sumSlug = conversationSummarySlug(sessionId);
  const previous = readPageRecord(await getPageOrNull(deps.call, sumSlug, brainScope))?.body.trim();
  const transcripts = capped(turns, tag);
  if (previous) transcripts.unshift({ at: transcripts[0]!.at, author: SYSTEM_AUTHOR, text: `earlier summary of this thread: ${previous}` });

  let summarized = false;
  const prompt = renderPassPrompt(scope.kind === "user" ? "quiet-moment-user" : "quiet-moment-agent", {
    CONVERSATION_SLUG: slug,
    SUMMARY_TOOL: passToolId(SUMMARY_TOOL),
    SUMMARY_MAX_CHARS: String(SUMMARY_MAX_CHARS),
    ...(scope.kind === "user" ? { USER_ID: scope.userId } : {}),
  });
  const res = await (deps.run ?? runPass)(
    {
      pass: QUIET_MOMENT,
      personaId: r.personaId,
      agentId: r.agentId,
      scope,
      prompt,
      transcripts,
      extraTools: [
        summaryTool({ slug: sumSlug, sessionId, through: lastTurnAt, scope: brainScope, call: deps.runner.brainCall, now: deps.runner.now, onWritten: () => (summarized = true) }),
      ],
      ...(r.signal ? { signal: r.signal } : {}),
    },
    deps.runner,
  );
  const app = session?.slack_app_id ? { apiAppId: session.slack_app_id, teamId: session.slack_team_id ?? "" } : session?.slack_team_id ? { teamId: session.slack_team_id } : undefined;
  await deliverRunProposals(deps.deliver, { agentId: r.agentId, scope, ...(app ? { app } : {}), proposed: res.proposed, tag });
  if (summarized) await ThreadActivity.markSummarized(sessionId, lastTurnAt);
  else console.log(`${tag}: session=${sessionId} ended ${res.outcome} without a summary`);
  return { outcome: res.outcome, summarized };
}
