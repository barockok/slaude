import type { GateInput } from "../knowledge/gated-dispatch";
import { AGENT_SOURCE, PUBLIC_SOURCE, agentSourceId, resolveBrainScope, userSourceId, type BrainScope } from "../knowledge/scope";

/**
 * Where one turn's episodic memory is read from and written to, derived from
 * the same gate input the KB tools use (resolveBrainScope). Memory reads only
 * ever fetch the session's own conversation page (`conversations/<session>`),
 * so the source decides whose copy of THIS thread is read, never another
 * thread:
 *
 *   - a turn whose KB scope writes a private slice (the persona's own mind on a
 *     trusted/manager/agent turn, the user's slice in their own /1on1) reads
 *     and writes its page there. The persona's slice also reads the legacy
 *     `agent` source, as the in-process provider always has;
 *   - a direct message from a user the KB rules treat as public (an
 *     allow-listed non-manager): the user's own slice, read and written, like
 *     a /1on1. A DM is private to that user and must not land in the persona's
 *     slice, which trusted turns of other users read;
 *   - a public or unknown channel: the thread's page in the persona's own
 *     slice, read and written. The page holds only this thread's turns, which
 *     every participant already saw; nothing private reaches the turn, and the
 *     transcript is never written to `public`;
 *   - someone else's locked thread: neither read nor written, so a 1:1's
 *     context cannot spread through a bystander's turn.
 *
 * `agentId` is the persona's own identity (brainGateFor resolves it), so a
 * named persona never writes into another persona's `agent-<id>` slice.
 */
export interface MemoryScope {
  read: BrainScope | null;
  write: BrainScope | null;
}

/** A Slack direct-message channel id. */
export const isDmChannel = (channel: string | undefined): boolean => !!channel && channel.startsWith("D");

const both = (clientId: string, source: string, reads: string[] = [source]): MemoryScope => ({
  read: { clientId, sourceId: source, allowedSources: reads },
  write: { clientId, sourceId: source, allowedSources: [source] },
});

export function memoryScopeFor(g: GateInput, opts: { channel?: string } = {}): MemoryScope {
  const r = resolveBrainScope({ ...g, kbSources: [] });
  const agentSrc = agentSourceId(g.agentId);
  if (r.sourceId !== PUBLIC_SOURCE) {
    return both(r.clientId, r.sourceId, r.sourceId === agentSrc ? [agentSrc, AGENT_SOURCE] : [r.sourceId]);
  }
  if (g.userId !== null && g.lockedUser !== null && g.lockedUser !== g.userId) return { read: null, write: null };
  if (g.userId !== null && isDmChannel(opts.channel)) return both(g.userId, userSourceId(g.userId));
  return both(g.agentId, agentSrc);
}

/**
 * The /1on1 lock to scope by: the MORE PRIVATE of the thread's live lock and
 * the job token's `lock` claim (signed at dispatch). A turn dispatched under a
 * lock and synced after `/1on1 off` stays private; a lock taken after dispatch
 * applies too. When both name an owner and they differ, the one that is not the
 * speaker wins (someone else's thread is the most restrictive case). An absent
 * claim (older gateway) leaves the live lock alone.
 */
export function withClaimLock(g: GateInput, claimLockUser: string | null | undefined): GateInput {
  const claim = claimLockUser ?? null;
  const live = g.lockedUser;
  if (claim === null || claim === live) return g;
  if (live === null) return { ...g, lockedUser: claim };
  return { ...g, lockedUser: live !== g.userId ? live : claim };
}
