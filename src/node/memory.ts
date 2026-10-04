/**
 * The node's memory provider: a REST client of the gateway's memory routes
 * (POST /v1/tools/memory/prefetch|sync). A node holds no database and no brain;
 * the gateway runs the real provider with the persona's own agent id and the
 * scope it derives from the verified job token.
 *
 * Memory never breaks a turn. Every failure resolves (prefetch to null) and is
 * logged once per kind, not once per turn: a gateway that predates the routes
 * (404), a refusal (the label gate's 403, a 400), a gateway error, the network,
 * or a session with no job token.
 */
import type { MemoryProvider, SyncTurn } from "../memory/provider";
import { NodeApiError, type NodeClient } from "./client";

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
  const unsupported = () =>
    once("unsupported", "the gateway does not serve /v1/tools/memory (older gateway): no <memory-context>, turns not recorded");
  const failed = (op: string, e: unknown) => {
    if (e instanceof NodeApiError) once(`${op}:${e.status}`, `memory ${op} refused by the gateway: HTTP ${e.status}`);
    else once(`${op}:network`, `memory ${op} failed: ${e instanceof Error ? e.message : String(e)}`);
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
        const r = await deps.client.memorySync({ user: turn.user, assistant: turn.assistant }, t);
        if (r === "unsupported") unsupported();
      } catch (e) {
        failed("sync", e);
      }
    },
  };
}
