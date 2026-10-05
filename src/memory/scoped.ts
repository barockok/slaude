import type { MemoryProvider, SyncTurn } from "./provider";
import { BrainMemoryProvider } from "./brain-provider";
import type { MemoryScope } from "./scope";
import { agentIdReady } from "../knowledge/agent-identity";

/**
 * The in-process (mono) memory provider: the brain provider read and written
 * in the scope of the turn's OWN context, the same memoryScopeFor the gateway's
 * memory routes use for node turns. Never the process-wide agentScope(): in a
 * multi-persona mono every named persona's turns, 1:1s included, would land in
 * the default persona's slice.
 *
 * `scopeFor` derives the scope from the session's live context (persona, speaker,
 * lock, runAs), never from anything the model supplies. It answers null when it
 * cannot tell (no route for the session, a persona that is not live): memory then
 * reads nothing and writes nothing. A flat provider (SLAUDE_MEMORY=sqlite, keyed
 * on the session alone) runs unscoped, as it always has.
 */
export function makeScopedMemory(deps: {
  /** The provider, read on every call (the process provider's live binding). */
  provider: () => MemoryProvider;
  scopeFor(sessionId: string): Promise<MemoryScope | null>;
  /** Settles the process agent identity before a scope is computed. */
  ready?: () => Promise<unknown>;
  warn?: (msg: string) => void;
}): MemoryProvider {
  const ready = deps.ready ?? agentIdReady;
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const scope = async (sessionId: string): Promise<MemoryScope | null> => {
    try {
      await ready();
      return await deps.scopeFor(sessionId);
    } catch (e) {
      warn(`[memory] no scope for session=${sessionId}; memory skipped: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  return {
    async prefetch(sessionId: string): Promise<string | null> {
      const p = deps.provider();
      if (!(p instanceof BrainMemoryProvider)) return p.prefetch(sessionId);
      const s = await scope(sessionId);
      return s?.read ? p.prefetchIn(sessionId, s.read) : null;
    },
    async syncTurn(t: SyncTurn): Promise<void> {
      const p = deps.provider();
      if (!(p instanceof BrainMemoryProvider)) return p.syncTurn(t);
      const s = await scope(t.sessionId);
      if (s?.write) await p.syncTurnIn(t, s.write);
    },
  };
}
