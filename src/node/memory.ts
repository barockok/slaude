/**
 * The node's memory provider: a REST client of the gateway's memory routes
 * (POST /v1/tools/memory/prefetch|sync). A node holds no database and no brain;
 * the gateway runs the real provider with the persona's own agent id and the
 * scope it derives from the verified job token.
 *
 * Memory never breaks a turn. Every failure resolves (prefetch to null) and is
 * logged once per kind, not once per turn: a gateway that predates the routes
 * (404), a refusal (the label gate's 403, a 400, a retired persona's 409), a
 * gateway error, the bound on the call (NodeClient.memoryTimeoutMs, no retry),
 * the network, or a session with no job token. Every failure also counts in
 * slaude_memory_gateway_failures_total{kind}.
 */
import type { MemoryProvider, SyncTurn } from "../memory/provider";
import { m as metric } from "../metrics";
import { MemoryTimeoutError, NodeApiError, type NodeClient } from "./client";

/** Per side of a turn sent to the gateway. The brain provider keeps ~800
 *  characters of each; a little more leaves the gateway's own truncation in
 *  charge of the exact cut, and the request stays small. */
export const MEMORY_TURN_MAX_CHARS = 2000;
const clip = (s: string) => (s.length <= MEMORY_TURN_MAX_CHARS ? s : s.slice(0, MEMORY_TURN_MAX_CHARS) + "…");

export function makeNodeMemoryProvider(deps: {
  client: Pick<NodeClient, "memoryPrefetch" | "memorySync">;
  tokenFor(sessionId: string): string | undefined;
  /** Injectable logger (tests). */
  warn?: (msg: string) => void;
}): MemoryProvider {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const warned = new Set<string>();
  const once = (kind: string, msg: string) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    warn(`[node-memory] ${msg} (logged once; turns continue without memory)`);
  };
  const unsupported = () => {
    metric.memoryGatewayFailuresTotal.inc({ kind: "unsupported" });
    once("unsupported", "the gateway does not serve /v1/tools/memory (older gateway): no <memory-context>, turns not recorded");
  };
  const failed = (op: string, e: unknown) => {
    const kind =
      e instanceof NodeApiError ? String(e.status) : e instanceof MemoryTimeoutError ? "timeout" : "network";
    metric.memoryGatewayFailuresTotal.inc({ kind: `${op}:${kind}` });
    if (e instanceof NodeApiError) once(`${op}:${kind}`, `memory ${op} refused by the gateway: HTTP ${e.status}`);
    else once(`${op}:${kind}`, `memory ${op} failed: ${e instanceof Error ? e.message : String(e)}`);
  };
  const token = (sessionId: string): string | undefined => {
    const t = deps.tokenFor(sessionId);
    if (!t) once("no-token", `no job token for session ${sessionId}; memory skipped`);
    return t;
  };

  return {
    async prefetch(sessionId: string): Promise<string | null> {
      const t = token(sessionId);
      if (!t) return null;
      try {
        const r = await deps.client.memoryPrefetch(t);
        if (r === "unsupported") {
          unsupported();
          return null;
        }
        return r;
      } catch (e) {
        failed("prefetch", e);
        return null;
      }
    },
    async syncTurn(turn: SyncTurn): Promise<void> {
      const t = token(turn.sessionId);
      if (!t) return;
      try {
        const r = await deps.client.memorySync({ user: clip(turn.user), assistant: clip(turn.assistant) }, t);
        if (r === "unsupported") unsupported();
      } catch (e) {
        failed("sync", e);
      }
    },
  };
}
