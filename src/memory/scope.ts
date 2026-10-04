import type { GateInput } from "../knowledge/gated-dispatch";
import { AGENT_SOURCE, PUBLIC_SOURCE, agentSourceId, resolveBrainScope, type BrainScope } from "../knowledge/scope";

/**
 * Where one turn's episodic memory is read from and written to, derived from
 * the same gate input the KB tools use (resolveBrainScope), so memory follows
 * the KB scoping rules:
 *
 *   - a turn whose KB scope writes a private slice (the agent's own mind on a
 *     trusted/manager/agent turn, the user's slice in their own /1on1) reads
 *     and writes its conversation page there. The agent slice also reads the
 *     legacy `agent` source, as the in-process provider always has;
 *   - a public or unknown channel, where the KB scope is `public` only: no
 *     read (a private slice must not reach a public turn), and the turn is
 *     written to the agent's OWN slice, never to `public` (a transcript is not
 *     world-readable content). Content only flows towards more privacy;
 *   - someone else's locked thread: neither read nor written, so a 1:1's
 *     context cannot spread into the agent's mind through a bystander's turn.
 *
 * `agentId` is the persona's own identity (brainGateFor resolves it), so a
 * named persona never writes into another persona's `agent-<id>` slice.
 */
export interface MemoryScope {
  read: BrainScope | null;
  write: BrainScope | null;
}

export function memoryScopeFor(g: GateInput): MemoryScope {
  const r = resolveBrainScope({ ...g, kbSources: [] });
  const agentSrc = agentSourceId(g.agentId);
  if (r.sourceId !== PUBLIC_SOURCE) {
    const reads = r.sourceId === agentSrc ? [agentSrc, AGENT_SOURCE] : [r.sourceId];
    return {
      read: { clientId: r.clientId, sourceId: r.sourceId, allowedSources: reads },
      write: { clientId: r.clientId, sourceId: r.sourceId, allowedSources: [r.sourceId] },
    };
  }
  if (g.userId !== null && g.lockedUser !== null && g.lockedUser !== g.userId) return { read: null, write: null };
  return { read: null, write: { clientId: g.agentId, sourceId: agentSrc, allowedSources: [agentSrc] } };
}
