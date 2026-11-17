/**
 * The must-reply Stop guard on a node: the same rule the gateway installs in
 * mono (src/gateway/core/gateway.ts setStopGuard), fed from this node's own
 * AgentManager events instead of the gateway's routes.
 *
 * Which turns it may force mirrors mono. Mono guards only a route that is not
 * silent; every cron-origin route is silent (a cron job's run, and every
 * dispatchThreadTurn: promise checks, heartbeat turns, wakes). A node has no
 * route, so it reads the same facts from the job: the signed `origin`,
 * `bgRun` and `wake` claims, and the job's own `bgRun`/`wake`. Only a turn a
 * person started (origin slack or panel) with no background run is forced. A
 * voice call's turns are skipped, as in mono.
 */
import type { AgentEvent, StopGuard } from "../agent/manager";
import { MUST_REPLY_INSTRUCTION, mustReplyEffect } from "../agent/must-reply";
import type { JobClaims } from "../gateway/api/auth";

/** What a job tells the guard about its turn. */
export interface StopGuardTurn {
  /** The job token's claims (unverified decode), or null when unreadable. */
  claims: Partial<JobClaims> | null;
  /** The job payload's background run and wake, as a fallback for the claims. */
  bgRun?: string;
  wake?: unknown;
  /** Every message of the job was an implicit start (no @mention): the turn may end in a pass without a reply. */
  implicit?: boolean;
}

/** A turn the guard may send back: a person started it and it is not a background run. */
export function mustReplyApplies(turn: StopGuardTurn): boolean {
  const c = turn.claims;
  if (turn.bgRun || turn.wake || c?.bgRun || c?.wake) return false;
  // Implicit engagement: the message was not addressed to the agent, so saying nothing is an answer.
  if (turn.implicit) return false;
  // Mono marks every cron-origin route silent; an absent origin (an older
  // gateway) is not known to be a person's turn, so it is not forced either.
  return c?.origin === "slack" || c?.origin === "panel";
}

/**
 * Whether a job's turn is an implicit start: every NON-suppressed message in it
 * is implicit. A recording (suppressed) coalesced with an explicit message
 * cannot relax that message's must-reply, and one coalesced with an implicit
 * message does not switch it on.
 */
export function turnIsImplicit(messages: ReadonlyArray<{ suppress?: boolean; implicit?: boolean }>): boolean {
  const live = messages.filter((m) => m.suppress !== true);
  return live.length > 0 && live.every((m) => m.implicit === true);
}

export interface NodeStopGuard {
  /** A job's turn is starting on this session: reset spoke/passed and decide whether it is guarded. */
  beginTurn(sessionId: string, turn: StopGuardTurn): void;
  /** Feed every AgentEvent of this node's manager. */
  onEvent(e: AgentEvent): void;
  /** The guard to install with AgentManager.setStopGuard. */
  guard: StopGuard;
  /** Drop a session's state (its live session ended). */
  forget(sessionId: string): void;
}

export function makeNodeStopGuard(deps: { voiceActive(sessionId: string): boolean }): NodeStopGuard {
  const turns = new Map<string, { applies: boolean; spoke: boolean; passed: boolean }>();
  return {
    beginTurn(sessionId, turn) {
      turns.set(sessionId, { applies: mustReplyApplies(turn), spoke: false, passed: false });
    },
    onEvent(e) {
      if (e.type !== "toolCall") return;
      // As in mono: a voice turn's reply is suppressed and does not count, and
      // the post-turn skill-evolution turn's tools are not the turn's answer.
      if (e.autoEvolve || deps.voiceActive(e.sessionId)) return;
      const t = turns.get(e.sessionId);
      if (!t) return;
      const effect = mustReplyEffect(e.tool);
      if (effect === "spoke") t.spoke = true;
      else if (effect === "passed") t.passed = true;
    },
    guard: (sessionId) => {
      if (deps.voiceActive(sessionId)) return null;
      const t = turns.get(sessionId);
      if (!t || !t.applies || t.spoke || t.passed) return null;
      return MUST_REPLY_INSTRUCTION;
    },
    forget(sessionId) {
      turns.delete(sessionId);
    },
  };
}
