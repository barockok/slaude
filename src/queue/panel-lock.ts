/**
 * Active-surface exclusivity lock for the control panel (design §"Active-surface
 * lock"). Redis key `panel:<sessionId>` → operatorId, SET NX PX with a short
 * TTL (~60s) kept alive by an operator-tab heartbeat. While an operator holds
 * it, the gateway defers inbound Slack for that session and suppresses the
 * outbound Slack echo; on release / TTL-expiry Slack resumes.
 *
 * Thin wrapper over the proven raw primitives in ./locks (SET NX PX + owner-
 * compared extend/release) so ownership can never be stolen or clobbered.
 */
import type { Redis } from "ioredis";
import { makeKeys, type Keys } from "./keys";
import { acquireLock, extendLock, releaseLock } from "./locks";

/** Default active-surface lock TTL (ms). Short by design — an operator crash
 *  must auto-release so Slack resumes without a stuck session. */
export const PANEL_LOCK_TTL_MS = 60_000;

export interface PanelLockOpts {
  redis: Redis;
  keys?: Keys;
  ttlMs?: number;
}

export type PanelLock = ReturnType<typeof makePanelLock>;

export function makePanelLock(opts: PanelLockOpts) {
  const redis = opts.redis;
  const keys = opts.keys ?? makeKeys();
  const ttlMs = opts.ttlMs ?? PANEL_LOCK_TTL_MS;

  return {
    keys,
    ttlMs,

    /** Take the lock for `operatorId`. True if acquired (or already ours —
     *  a re-acquire by the same owner refreshes the TTL). False if another
     *  operator holds it. */
    async acquire(sessionId: string, operatorId: string): Promise<boolean> {
      const key = keys.panelLock(sessionId);
      if (await acquireLock(redis, key, operatorId, ttlMs)) return true;
      // Contended — unless it is already ours, in which case refresh + succeed.
      return extendLock(redis, key, operatorId, ttlMs);
    },

    /** Refresh the TTL while the operator tab is active. False = the lock
     *  expired or changed hands (caller must stop driving). */
    async heartbeat(sessionId: string, operatorId: string): Promise<boolean> {
      return extendLock(redis, keys.panelLock(sessionId), operatorId, ttlMs);
    },

    /** Owner-checked release. True if we held it and released it. */
    async release(sessionId: string, operatorId: string): Promise<boolean> {
      return releaseLock(redis, keys.panelLock(sessionId), operatorId);
    },

    /** Current owner, or null when the session is not panel-locked. */
    async owner(sessionId: string): Promise<string | null> {
      return redis.get(keys.panelLock(sessionId));
    },

    /**
     * Force-transfer control to `newOperator` — the semantics of a
     * force-release: an operator STEALS the session from whoever holds it
     * rather than handing it back to Slack. Unconditional SET keeps the lock
     * held (TTL refreshed) under the new owner; returns the displaced operator
     * so the caller can audit old → new. Slack stays suppressed because someone
     * is still driving.
     */
    async steal(sessionId: string, newOperator: string): Promise<string | null> {
      const key = keys.panelLock(sessionId);
      const prev = await redis.get(key);
      await redis.set(key, newOperator, "PX", ttlMs);
      return prev === newOperator ? null : prev;
    },

    /**
     * Cross-replica once-guard for the deferral thread notice. SET NX PX on
     * `panel-notice:<id>` — only the first replica to win posts the notice for
     * this lock window. `windowMs` defaults to the lock TTL.
     */
    async noticeOnce(sessionId: string, windowMs = ttlMs): Promise<boolean> {
      return (await redis.set(keys.panelNotice(sessionId), "1", "PX", windowMs, "NX")) === "OK";
    },

    /** Clear the notice guard on resume so the next lock window notices again. */
    async clearNotice(sessionId: string): Promise<void> {
      await redis.del(keys.panelNotice(sessionId));
    },
  };
}
