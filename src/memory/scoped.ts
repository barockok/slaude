import type { MemoryProvider, SyncTurn } from "./provider";
import { BrainMemoryProvider } from "./brain-provider";
import type { MemoryScope } from "./scope";
import { agentIdReady } from "../knowledge/agent-identity";
import type { BrainScope } from "../knowledge/scope";
import { noteThreadTurn } from "../db/thread-activity";

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
 *
 * A brain-backed sync with a write scope also calls `onSynced` (default
 * noteThreadTurn: counts the turn in thread_activity, a database write only,
 * never a brain call), when the scope names an `activityAgentId`: the
 * persona's agent id on a turn that counts as thread activity (an interactive
 * one; a cron or runtime turn does not make a thread busy).
 */
export function makeScopedMemory(deps: {
  /** The provider, read on every call (the process provider's live binding). */
  provider: () => MemoryProvider;
  /** `activityAgentId`: set on an interactive turn, the persona's agent id (thread activity is keyed on it). */
  scopeFor(sessionId: string): Promise<(MemoryScope & { activityAgentId?: string }) | null>;
  /** Settles the process agent identity before a scope is computed. */
  ready?: () => Promise<unknown>;
  warn?: (msg: string) => void;
  onSynced?: (sessionId: string, agentId: string, write: BrainScope) => Promise<void>;
}): MemoryProvider {
  const ready = deps.ready ?? agentIdReady;
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const onSynced = deps.onSynced ?? noteThreadTurn;
  const scope = async (sessionId: string): Promise<(MemoryScope & { activityAgentId?: string }) | null> => {
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
      if (!s?.write) return;
      await p.syncTurnIn(t, s.write);
      if (s.activityAgentId) await onSynced(t.sessionId, s.activityAgentId, s.write).catch(() => {});
    },
  };
}
