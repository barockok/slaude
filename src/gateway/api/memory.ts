/**
 * POST /v1/tools/memory/prefetch|sync — episodic memory for node turns, run ON
 * THE GATEWAY. A node holds no database, so its manager's memory provider is a
 * REST client of these two routes (src/node/memory.ts).
 *
 * Everything that decides where memory lives comes from the verified job token:
 * the session, the persona (whose own `agent-<id>` slice is used, never the
 * process-wide one) and the gate input (channel trust, /1on1 lock, manager),
 * through the same brainGateFor the KB tools use. The body carries only the
 * turn's text; any other field is a 400.
 *
 *   prefetch  {}                              → { block: string | null }
 *   sync      { user: string, assistant: string } → { ok: true }
 */
import { z } from "zod";
import type { GateInput } from "../../knowledge/gated-dispatch";
import type { MemoryProvider } from "../../memory/provider";
import { BrainMemoryProvider } from "../../memory/brain-provider";
import { memoryScopeFor } from "../../memory/scope";
import { zodIssueLine } from "../../tools/contracts/types";
import type { JobClaims } from "./auth";
import { json, notFound } from "./http";
import type { ToolPlaneDeps } from "./tools/deps";

export const MEMORY_OPS = ["prefetch", "sync"] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

const prefetchBody = z.object({}).strict();
const syncBody = z.object({ user: z.string(), assistant: z.string() }).strict();

export interface MemoryPlane {
  prefetch(claims: JobClaims): Promise<string | null>;
  sync(claims: JobClaims, turn: { user: string; assistant: string }): Promise<void>;
}

/**
 * The gateway's memory plane over a provider. A brain-backed provider is read
 * and written in the scope memoryScopeFor derives from the gate input; with no
 * gate (brain disabled) or a flat provider (SLAUDE_MEMORY=sqlite, keyed on the
 * session alone) the provider runs as it does in mono.
 */
export function makeMemoryPlane(deps: {
  provider: MemoryProvider;
  gateFor(claims: JobClaims): Promise<GateInput | null>;
}): MemoryPlane {
  const { provider } = deps;
  return {
    async prefetch(claims) {
      if (!(provider instanceof BrainMemoryProvider)) return provider.prefetch(claims.session);
      const gate = await deps.gateFor(claims);
      if (!gate) return null;
      const { read } = memoryScopeFor(gate);
      return read ? provider.prefetchIn(claims.session, read) : null;
    },
    async sync(claims, turn) {
      const t = { sessionId: claims.session, ...turn };
      if (!(provider instanceof BrainMemoryProvider)) return provider.syncTurn(t);
      const gate = await deps.gateFor(claims);
      if (!gate) return;
      const { write } = memoryScopeFor(gate);
      if (write) await provider.syncTurnIn(t, write);
    },
  };
}

/** The default plane: the process's provider, gated like the KB tools (the
 *  same SlackContext from the claims, the same brainGateFor behind brainDeps). */
export function defaultMemoryPlane(tools: ToolPlaneDeps, provider: MemoryProvider): MemoryPlane {
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
