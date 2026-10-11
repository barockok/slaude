/**
 * Inbound-Slack defer queue (design §"Active-surface lock" — paused-Slack:
 * defer + notice + replay).
 *
 * While an operator holds the active-surface lock for a session, inbound Slack
 * messages for that session are not dropped — they are held here as replay
 * thunks and flushed in arrival order when the lock releases (explicit release
 * or TTL expiry). This queue is PER-REPLICA: a message deferred on replica B
 * lives in B's queue, so resume is broadcast over Redis pub/sub and every
 * replica drains its own queue on receipt (the "⏸ handled in ops panel" notice
 * is deduped separately over Redis, not here).
 *
 * Pure, dependency-free, and synchronous so the hold/replay logic is
 * unit-testable without Redis, Slack, or a running gateway. The gateway
 * supplies the replay thunk (the already-built dispatch tail for that message)
 * and calls `drain` on resume.
 */

export type ReplayThunk = () => void | Promise<void>;

export function makeDeferQueue() {
  const held = new Map<string, ReplayThunk[]>();

  return {
    /** Queue one inbound message's replay thunk under its session. */
    hold(sessionId: string, thunk: ReplayThunk): void {
      const arr = held.get(sessionId);
      if (arr) arr.push(thunk);
      else held.set(sessionId, [thunk]);
    },

    /** Number of messages currently held for a session. */
    pending(sessionId: string): number {
      return held.get(sessionId)?.length ?? 0;
    },

    /**
     * Remove and return every held thunk for a session (arrival order). The
     * caller runs the thunks (awaiting if it cares about ordering).
     */
    drain(sessionId: string): ReplayThunk[] {
      const arr = held.get(sessionId) ?? [];
      held.delete(sessionId);
      return arr;
    },

    /** Sessions with at least one held message (sweeper work list). */
    heldSessions(): string[] {
      return [...held.keys()];
    },
  };
}

export type DeferQueue = ReturnType<typeof makeDeferQueue>;
