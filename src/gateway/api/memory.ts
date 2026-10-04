/**
 * POST /v1/tools/memory/prefetch|sync — episodic memory for node turns, run ON
 * THE GATEWAY. A node holds no database, so its manager's memory provider is a
 * REST client of these two routes (src/node/memory.ts).
 *
 * Everything that decides where memory lives comes from the verified job token:
 * the session, the persona (whose own `agent-<id>` slice is used, never the
 * process-wide one), the gate input (channel trust, manager) through the same
 * brainGateFor the KB tools use, and the /1on1 lock (the more private of the
 * live lock and the token's `lock` claim). The body carries only the turn's
 * text; any other field is a 400.
 *
 *   prefetch  {}                              → { block: string | null }
 *   sync      { user: string, assistant: string } → { ok: true }
 *
 * A persona that is not live is refused (PersonaNotLiveError, mapped to 409 by
 * the router) for every provider. A provider call that hangs is abandoned at
 * GATEWAY_MEMORY_TIMEOUT_MS: prefetch answers null, sync answers ok, and the
 * timeout is logged once per operation.
 */
import { z } from "zod";
import type { GateInput } from "../../knowledge/gated-dispatch";
import { agentIdReady } from "../../knowledge/agent-identity";
import type { MemoryProvider } from "../../memory/provider";
import { BrainMemoryProvider } from "../../memory/brain-provider";
import { memoryScopeFor, withClaimLock } from "../../memory/scope";
import { livePersona } from "../../persona/registry";
import { zodIssueLine } from "../../tools/contracts/types";
import type { JobClaims } from "./auth";
import { json, notFound } from "./http";
import type { ToolPlaneDeps } from "./tools/deps";

export const MEMORY_OPS = ["prefetch", "sync"] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

/** The gateway's bound on one provider call; below the node's own bound. */
export const GATEWAY_MEMORY_TIMEOUT_MS = 2000;
/** A sync body is two clipped strings (the node sends at most ~2000 chars each). */
export const MEMORY_BODY_MAX_BYTES = 64 * 1024;

const prefetchBody = z.object({}).strict();
const syncBody = z.object({ user: z.string(), assistant: z.string() }).strict();

export interface MemoryPlane {
  prefetch(claims: JobClaims): Promise<string | null>;
  sync(claims: JobClaims, turn: { user: string; assistant: string }): Promise<void>;
}

/** Refuse a named persona the registry does not list as live (throws). */
const defaultAssertLive = (claims: JobClaims): void => {
  if (claims.persona && claims.persona !== "default") livePersona(claims.persona);
};

/**
 * The gateway's memory plane over a provider. A brain-backed provider is read
 * and written in the scope memoryScopeFor derives from the gate input; with no
 * gate (brain disabled) it reads and writes nothing. A flat provider
 * (SLAUDE_MEMORY=sqlite, keyed on the session alone) runs as it does in mono.
 */
export function makeMemoryPlane(deps: {
  /** The provider, or a getter read on every call (the process provider). */
  provider: MemoryProvider | (() => MemoryProvider);
  gateFor(claims: JobClaims): Promise<GateInput | null>;
  /** Settles the process agent identity before a gate is computed, so the
   *  default persona never scopes by the "default" fallback. */
  ready?: () => Promise<unknown>;
  assertLive?: (claims: JobClaims) => void;
  timeoutMs?: number;
  warn?: (msg: string) => void;
}): MemoryPlane {
  const providerNow = (): MemoryProvider => (typeof deps.provider === "function" ? deps.provider() : deps.provider);
  const ready = deps.ready ?? agentIdReady;
  const assertLive = deps.assertLive ?? defaultAssertLive;
  const timeoutMs = deps.timeoutMs ?? GATEWAY_MEMORY_TIMEOUT_MS;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const warned = new Set<string>();

  async function bounded<T>(op: MemoryOp, p: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");
    p.catch(() => {}); // a late rejection of the abandoned call is not unhandled
    try {
      const r = await Promise.race([p, new Promise<typeof timedOut>((res) => (timer = setTimeout(() => res(timedOut), timeoutMs)))]);
      if (r !== timedOut) return r as T;
    } finally {
      clearTimeout(timer);
    }
    if (!warned.has(op)) {
      warned.add(op);
      warn(`[memory] ${op} gave up after ${timeoutMs}ms; the turn runs without it (logged once)`);
    }
    return fallback;
  }

  /** The turn's memory scope, or null when the brain gives it none. */
  async function scope(claims: JobClaims) {
    await ready();
    const gate = await deps.gateFor(claims);
    if (!gate) return null;
    return memoryScopeFor(withClaimLock(gate, claims.lock?.user), { channel: claims.channel });
  }

  return {
    async prefetch(claims) {
      assertLive(claims);
      const provider = providerNow();
      if (!(provider instanceof BrainMemoryProvider)) return bounded("prefetch", provider.prefetch(claims.session), null);
      const s = await scope(claims);
      return s?.read ? bounded("prefetch", provider.prefetchIn(claims.session, s.read), null) : null;
    },
    async sync(claims, turn) {
      assertLive(claims);
      const provider = providerNow();
      const t = { sessionId: claims.session, ...turn };
      if (!(provider instanceof BrainMemoryProvider)) return bounded("sync", provider.syncTurn(t), undefined);
      const s = await scope(claims);
      if (s?.write) await bounded("sync", provider.syncTurnIn(t, s.write), undefined);
    },
  };
}

/** The default plane: the process's provider, gated like the KB tools (the
 *  same SlackContext from the claims, the same brainGateFor behind brainDeps). */
export function defaultMemoryPlane(tools: ToolPlaneDeps, provider: MemoryProvider | (() => MemoryProvider)): MemoryPlane {
  return makeMemoryPlane({
    provider,
    gateFor: async (claims) => {
      const ctx = tools.slackCtx(claims);
      const brain = tools.brainDeps(ctx, tools.surfaceFor(ctx));
      return brain ? await brain.gate() : null;
    },
  });
}

export async function handleMemory(op: string, body: unknown, claims: JobClaims, plane: MemoryPlane | undefined): Promise<Response> {
  if (!plane) return notFound("memory is not served by this deployment");
  try {
    if (op === "prefetch") {
      prefetchBody.parse(body);
      return json(200, { block: await plane.prefetch(claims) });
    }
    const turn = syncBody.parse(body);
    await plane.sync(claims, turn);
    return json(200, { ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return json(400, { error: `invalid input: ${zodIssueLine(e)}` });
    throw e;
  }
}
