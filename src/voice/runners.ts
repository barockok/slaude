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
  on(ev: "event", cb: (e: any) => void): unknown;
  off(ev: "event", cb: (e: any) => void): unknown;
}

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_WAIT_MS = 120_000;
const BUSY_MESSAGE = "session busy: could not start the voice turn";

export function waitTurnDone(agent: TurnAgent, sessionId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { agent.off("event", on); reject(new Error("voice turn timed out")); }, timeoutMs);
    const on = (e: any) => {
      if (e?.sessionId !== sessionId) return;
      if (e.type === "done" && !e.autoEvolve) { clearTimeout(t); agent.off("event", on); resolve(); }
      else if (e.type === "error") { clearTimeout(t); agent.off("event", on); reject(new Error(String(e.error ?? "turn error"))); }
    };
    agent.on("event", on);
  });
}

async function runOnce(agent: TurnAgent, sessionId: string, text: string, o: { suppress: boolean; voice: boolean }, timeoutMs: number) {
  injectedTurns.enter(sessionId);
  if (o.voice) voiceTurns.enter(sessionId);
  try {
    const done = waitTurnDone(agent, sessionId, timeoutMs);
    // sendMessage may throw before any event: don't leave `done` rejecting unhandled.
    done.catch(() => {});
    if (o.suppress) agent.suppressNextTurn(sessionId);
    await agent.sendMessage(sessionId, text);
    await done;
  } finally {
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
  lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | typeof HELD_BY_OTHER>;
  refreshToken(sessionId: string): Promise<void>;
  turnTimeoutMs?: number;
  retryMs?: number;
  maxWaitMs?: number;
}): TurnRunner {
  return {
    async run(sid, text, ro) {
      const deadline = Date.now() + (o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
      while (true) {
        const r = await o.lock(sid, async () => {
          await o.refreshToken(sid);
          await runOnce(o.agent, sid, text, ro, o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
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
