/**
 * Running voice-originated turns on the warm session (voice mode spec §6).
 *
 * mono: Slack turns share the AgentManager's prompt queue, and a `done` event
 *       cannot be told apart from the voice turn's, so wait until no turn is in
 *       flight before injecting; then sendMessage + wait.
 * node: take lock:session:<id> exactly like a queued job (withSessionLock never
 *       waits, so retry), then refresh the call's job token through the
 *       existing /v1/jobs/:id/token-refresh and bind it, then run.
 *
 * Every runner turn (voice delegate, transcript flush, summary) is an
 * "injected" turn for its whole duration; only voice delegates are also
 * "voice" turns (their Slack writes are dropped).
 */
import { HELD_BY_OTHER } from "../queue/locks";
import type { TurnRunner } from "./call";
import { injectedTurns, voiceTurns } from "./turn-flags";

export interface TurnAgent {
  suppressNextTurn(id: string): void;
  sendMessage(id: string, text: string): Promise<void>;
  /** A voice turn never boots a session: sendMessage would start a fresh one,
   *  possibly under another identity. */
  isLive(id: string): boolean;
  /** Cancel the session's in-flight turn (AgentManager has it). */
  abort?(id: string): void;
  on(ev: "event" | "sessionExit", cb: (e: any) => void): unknown;
  off(ev: "event" | "sessionExit", cb: (e: any) => void): unknown;
}

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 120_000;
const BUSY_MESSAGE = "session busy: could not start the voice turn";

/** The gateway refused to refresh the call's job token (label changed, past
 *  the token's maximum age): the call cannot run turns any more and ends with
 *  `auth_lost`. */
export class VoiceAuthLost extends Error {}

/** The call was cancelled (session rebooted, identity lost) while the turn
 *  waited: nothing is sent. */
export class VoiceTurnCancelled extends Error {
  constructor() {
    super("voice call ended: turn not sent");
  }
}

/** The turn may still be running: the runner must abort it. */
class TurnStuckError extends Error {}

/**
 * Resolves on a non-autoEvolve `done`, rejects on `error`, on the session
 * exiting (AgentManager emits no done/error then), on timeout, or when
 * `signal` aborts. Listeners and timer are released on every outcome.
 */
export function waitTurnDone(agent: TurnAgent, sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(t);
      agent.off("event", onEvent);
      agent.off("sessionExit", onExit);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const t = setTimeout(() => settle(() => reject(new TurnStuckError("voice turn timed out"))), timeoutMs);
    const onEvent = (e: any) => {
      if (e?.sessionId !== sessionId) return;
      if (e.type === "done" && !e.autoEvolve) settle(resolve);
      else if (e.type === "error") settle(() => reject(new Error(String(e.error ?? "turn error"))));
    };
    const onExit = (id: unknown) => {
      if (id === sessionId) settle(() => reject(new Error("session exited during the voice turn")));
    };
    const onAbort = () => settle(() => reject(new TurnStuckError("session lock lost during the voice turn")));
    agent.on("event", onEvent);
    agent.on("sessionExit", onExit);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
  });
}

async function runOnce(
  agent: TurnAgent,
  sessionId: string,
  text: string,
  o: { suppress: boolean; voice: boolean; cancelled(): boolean },
  timeoutMs: number,
  signal?: AbortSignal,
) {
  // Re-read after every wait, immediately before the send (only synchronous
  // code follows until sendMessage).
  if (o.cancelled()) throw new VoiceTurnCancelled();
  if (!agent.isLive(sessionId)) throw new Error("session is not live: the voice turn would boot a new one");
  // The session lock was lost before the send (e.g. during the token
  // refresh): another node may own the session now. Nothing was sent, so
  // there is no turn to abort.
  if (signal?.aborted) throw new TurnStuckError("session lock lost before the voice turn was sent");
  injectedTurns.enter(sessionId);
  if (o.voice) voiceTurns.enter(sessionId);
  // `local` lets the finally release the listeners and timer when we leave
  // before the turn settles (sendMessage threw); it also relays the lock signal.
  const local = new AbortController();
  const relay = () => local.abort();
  if (signal?.aborted) local.abort();
  else signal?.addEventListener("abort", relay);
  const done = waitTurnDone(agent, sessionId, timeoutMs, local.signal);
  // Swallow so a throwing sendMessage cannot leave `done` unhandled.
  done.catch(() => {});
  try {
    if (o.suppress) agent.suppressNextTurn(sessionId);
    await agent.sendMessage(sessionId, text);
    await done;
  } catch (err) {
    if (err instanceof TurnStuckError) {
      console.warn(`[voice] ${err.message}; aborting turn session=${sessionId}`);
      agent.abort?.(sessionId);
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", relay);
    local.abort();
    if (o.voice) voiceTurns.exit(sessionId);
    injectedTurns.exit(sessionId);
  }
}

export function monoRunner(
  agent: TurnAgent & { isTurnInFlight(sessionId: string): boolean },
  o: {
    turnTimeoutMs?: number;
    maxWaitMs?: number;
    pollMs?: number;
    /** Required identity re-check at the point of use: throws (VoiceAuthLost)
     *  when the thread no longer runs as the agent. Runs after the in-flight
     *  wait, and only synchronous code separates it from sendMessage. */
    check(sessionId: string): Promise<void>;
  },
): TurnRunner {
  return {
    async run(sid, text, ro) {
      const deadline = Date.now() + (o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
      while (true) {
        while (agent.isTurnInFlight(sid)) {
          if (Date.now() >= deadline) throw new Error(BUSY_MESSAGE);
          await Bun.sleep(o.pollMs ?? 100);
        }
        await o.check(sid);
        // A turn may have started during the check: check again after it.
        if (!agent.isTurnInFlight(sid)) break;
      }
      await runOnce(agent, sid, text, ro, o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    },
  };
}

export function nodeRunner(o: {
  agent: TurnAgent;
  lock<T>(sessionId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
  /** Required: refresh the call's token AND re-check the thread's identity
   *  (the token bound is the token checked); throws VoiceAuthLost to refuse. */
  refreshToken(sessionId: string): Promise<void>;
  turnTimeoutMs?: number;
  retryMs?: number;
  maxWaitMs?: number;
}): TurnRunner {
  return {
    async run(sid, text, ro) {
      const deadline = Date.now() + (o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
      while (true) {
        const r = await o.lock(sid, async (signal) => {
          // Cancelled while waiting for the lock: no refresh, no bind, no send.
          if (ro.cancelled()) throw new VoiceTurnCancelled();
          await o.refreshToken(sid);
          await runOnce(o.agent, sid, text, ro, o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, signal);
          return true as const;
        });
        if (r !== HELD_BY_OTHER) return;
        if (Date.now() >= deadline) throw new Error(BUSY_MESSAGE);
        await Bun.sleep(o.retryMs ?? 250);
      }
    },
  };
}

/**
 * A call's job-token chain on a node. Each refresh is also the identity
 * re-check: the gateway reports the thread's identity as of NOW alongside the
 * fresh token, and the token is bound for the turn only when `allow` accepts
 * that identity — the token used is the token checked. A refused refresh or
 * identity throws VoiceAuthLost and the chain stays refused.
 */
export function makeTokenKeeper(o: {
  jobId: string;
  token: string;
  refresh(jobId: string, token: string): Promise<{ jobToken: string; identity?: unknown }>;
  allow(identity: unknown): boolean;
  bind(token: string): void;
}): { refresh(): Promise<void>; allowed(): boolean } {
  let token = o.token;
  let ok = true;
  return {
    async refresh() {
      if (!ok) throw new VoiceAuthLost("the call's identity was already refused");
      let r: { jobToken: string; identity?: unknown };
      try {
        r = await o.refresh(o.jobId, token);
      } catch (e) {
        ok = false;
        throw new VoiceAuthLost(e instanceof Error ? e.message : String(e));
      }
      token = r.jobToken;
      if (!o.allow(r.identity)) {
        ok = false;
        throw new VoiceAuthLost("the thread no longer runs as the agent");
      }
      o.bind(token);
    },
    allowed: () => ok,
  };
}
