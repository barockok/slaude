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
  o: { suppress: boolean; voice: boolean },
  timeoutMs: number,
  signal?: AbortSignal,
) {
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
  o: { turnTimeoutMs?: number; maxWaitMs?: number; pollMs?: number } = {},
): TurnRunner {
  return {
    async run(sid, text, ro) {
      const deadline = Date.now() + (o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
      while (agent.isTurnInFlight(sid)) {
        if (Date.now() >= deadline) throw new Error(BUSY_MESSAGE);
        await Bun.sleep(o.pollMs ?? 100);
      }
      await runOnce(agent, sid, text, ro, o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    },
  };
}

export function nodeRunner(o: {
  agent: TurnAgent;
  lock<T>(sessionId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
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

export function makeTokenKeeper(o: {
  jobId: string;
  token: string;
  refresh(jobId: string, token: string): Promise<string>;
  bind(token: string): void;
}): { refresh(): Promise<void> } {
  let token = o.token;
  return {
    async refresh() {
      token = await o.refresh(o.jobId, token);
      o.bind(token);
    },
  };
}
