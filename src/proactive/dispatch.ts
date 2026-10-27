/**
 * `ask` and `act` items of the heartbeat round (spec: Decide, Stitching): once
 * the round has posted about an item, a turn goes into that post's thread
 * through the cron path promise checks use (a route bound like a cron run's,
 * origin cron; the queue in the gateway role, this process in mono). The turn
 * runs as the agent, never as a person: no carried identity, and a thread
 * that has a /1on1 lock is refused. It is budgeted as a `heartbeat-turn`
 * ledger run, which the turn's own usage closes, and the thread is engaged
 * so a later human reply continues it.
 *
 * Each post is dispatched at most once: the dispatch claims
 * `heartbeat-act:<post id>` in `background_slots` first, so a second replica
 * or a retried round finds it claimed.
 */
import type { ProactivePost } from "../db/proactive-posts";
import { claimSlot } from "../db/background-slots";
import { finishSkillCheck, startSkillCheck } from "../background/skill-check";
import { personaDefaultModel } from "../persona/registry";
import type { ProactiveRule } from "./rules";
import type { Level } from "./levels";

export const HEARTBEAT_TURN = "heartbeat-turn" as const;

/** How a dispatched turn reaches the post's thread (the gateway or mono implements it). */
export interface ProactiveTransport {
  /** Dispatch the turn into the post's thread as the agent of `personaId`, carrying its open run. */
  dispatch(post: ProactivePost, envelope: string, run: { runId: string; agentId: string }, personaId: string): Promise<void>;
}

export interface ProactiveDispatchDeps {
  transport: ProactiveTransport;
  /** The persona the round runs for: the thread's session is keyed on it. */
  personaId: string;
  /** Open a `heartbeat-turn` run for the post. ok=false: no budget. */
  openRun(post: ProactivePost): Promise<{ ok: true; runId: string; agentId: string } | { ok: false }>;
  /** Claim a slot once across replicas (claimSlot under the heartbeat-turn pass). */
  claim(agentId: string, slot: string, at: number): Promise<boolean>;
  /** End a run whose turn never went out, at no cost. Absent: the stale sweep ends it. */
  dropRun?(runId: string, agentId: string): Promise<void>;
  now?: () => number;
}

export const dispatchSlot = (post: Pick<ProactivePost, "id">): string => `heartbeat-act:${post.id}`;

/** One line, and nothing that can close the envelope's blocks. */
const safe = (s: string | null | undefined): string => (s ?? "").replace(/[\r\n]+/g, " ").trim().replaceAll("</", "<\\/");

/** The turn's prompt: what was posted and why, then what to do now. */
export function proactiveEnvelope(post: ProactivePost, level: "ask" | "act", rule: ProactiveRule | null, highest: Level): string {
  const c = post.context;
  const posted = new Date(post.postedAt).toISOString();
  const ruleLine = rule
    ? `Rule: ${safe(rule.slug)} (${safe(rule.level)}, scope ${safe(rule.scope)}, taught by <@${safe(rule.taughtBy)}> on ${safe(rule.taughtAt)}).`
    : "Rule: none (default inform).";
  const todo =
    level === "ask"
      ? "ask: You asked before acting. Wait for an answer in this thread; do nothing else now. Call pass."
      : `act: Do this now, within the mandate: ${safe(rule?.how) || "what your post says you will do"}. Then reply in one line saying what you did. If you are unsure it is within the mandate, ask the approvers here instead.`;
  return [
    "<proactive-context>",
    `You posted this proactively (${posted}) about "${safe(post.topic)}": ${safe(post.text) || "(the text was not kept)"}`,
    `Source: ${safe(c?.source) || "none"} item ${safe(c?.itemId) || "none"}. Summary: ${safe(c?.summary) || "none"}. Evidence: ${safe(c?.evidence) || "none"}.`,
    ruleLine,
    `Most allowed here: ${safe(highest)}.`,
    "</proactive-context>",
    "<runtime-check>",
    todo,
    "</runtime-check>",
  ].join("\n");
}

/**
 * Dispatch one `ask`/`act` post's turn. `duplicate`: it was claimed before
 * (this post's turn went out, or is going out, elsewhere). `no-budget`: no
 * turn, and the post stays as sent. A transport failure ends the run and
 * throws; the claim stays, so the post is never dispatched twice.
 */
export async function dispatchProactive(
  post: ProactivePost,
  level: "ask" | "act",
  rule: ProactiveRule | null,
  highest: Level,
  deps: ProactiveDispatchDeps,
): Promise<"sent" | "duplicate" | "no-budget"> {
  if (!post.messageTs) throw new Error(`proactive post ${post.id} has no message ts; there is no thread to dispatch into`);
  const now = (deps.now ?? Date.now)();
  if (!(await deps.claim(post.agentId, dispatchSlot(post), now))) return "duplicate";
  const run = await deps.openRun(post);
  if (!run.ok) {
    console.log(`[proactive] agent=${post.agentId} post=${post.id}: no budget for the ${level} turn; the post stays as sent`);
    return "no-budget";
  }
  try {
    await deps.transport.dispatch(post, proactiveEnvelope(post, level, rule, highest), { runId: run.runId, agentId: run.agentId }, deps.personaId);
  } catch (e) {
    await deps.dropRun?.(run.runId, run.agentId).catch((d) =>
      console.error(`[proactive] agent=${post.agentId} post=${post.id}: could not end its run: ${d instanceof Error ? d.message : String(d)}`),
    );
    throw e;
  }
  return "sent";
}

/** Production deps for a persona: budgeted on the ledger as `heartbeat-turn`, claimed in background_slots. */
export function defaultDispatchDeps(transport: ProactiveTransport, personaId: string): ProactiveDispatchDeps {
  const named = personaId && personaId !== "default" ? personaId : undefined;
  return {
    transport,
    personaId,
    claim: (agentId, slot, at) => claimSlot(agentId, HEARTBEAT_TURN, slot, at),
    openRun: async () => {
      const r = await startSkillCheck({ personaId: personaId || "default", model: personaDefaultModel(named), scope: "agent", pass: HEARTBEAT_TURN });
      return r.ok ? { ok: true, runId: r.runId, agentId: r.agentId } : { ok: false };
    },
    dropRun: async (runId, agentId) => {
      await finishSkillCheck({ runId, agentId, usage: {}, outcome: "error", pass: HEARTBEAT_TURN });
    },
  };
}
