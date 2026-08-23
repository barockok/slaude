/**
 * Redis locks: per-session turn serialization and leader election.
 *
 * Both are SET NX + TTL with an owner token; release and extend are Lua
 * compare-owner scripts so one holder can never release or extend another's
 * lock (pattern per n8n's redis-lock / leader-election services).
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { makeKeys, type Keys } from "./keys";

const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const EXTEND_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

/** SET NX PX. True if this call took the lock. */
export async function acquireLock(redis: Redis, key: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(key, owner, "PX", ttlMs, "NX")) === "OK";
}

/** Compare-owner delete. True if we held it and released it. */
export async function releaseLock(redis: Redis, key: string, owner: string): Promise<boolean> {
  return (await redis.eval(RELEASE_IF_OWNER, 1, key, owner)) === 1;
}

/** Compare-owner PEXPIRE. False means the lock expired or changed hands. */
export async function extendLock(redis: Redis, key: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.eval(EXTEND_IF_OWNER, 1, key, owner, ttlMs)) === 1;
}

/** Sentinel: the session lock is held by another owner; fn did not run. */
export const HELD_BY_OTHER: unique symbol = Symbol("held-by-other");

export interface SessionLockOpts {
  redis: Redis;
  keys?: Keys;
  /** Lock TTL. Spec default: 10 minutes. */
  ttlMs?: number;
  /** Extender cadence. Spec default: 60s. */
  extendEveryMs?: number;
}

/**
 * Run `fn` under `lock:session:<id>`. If the lock is currently held by a
 * different owner, resolves to HELD_BY_OTHER without running fn (the caller
 * re-queues the job with a short delay). While fn runs, a background extender
 * re-arms the TTL so a long turn never loses its lock; the extender is
 * compare-owner, so if the lock is somehow lost it silently stops extending
 * rather than stealing it back.
 */
export async function withSessionLock<T>(
  sessionId: string,
  ownerId: string,
  fn: () => Promise<T>,
  opts: SessionLockOpts,
): Promise<T | typeof HELD_BY_OTHER> {
  const keys = opts.keys ?? makeKeys();
  const key = keys.sessionLock(sessionId);
  const ttlMs = opts.ttlMs ?? 600_000;
  if (!(await acquireLock(opts.redis, key, ownerId, ttlMs))) return HELD_BY_OTHER;
  const extender = setInterval(() => {
    extendLock(opts.redis, key, ownerId, ttlMs).catch(() => {
      /* transient — TTL still covers us until the next attempt */
    });
  }, opts.extendEveryMs ?? 60_000);
  extender.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(extender);
    await releaseLock(opts.redis, key, ownerId).catch(() => {
      /* best-effort: TTL expires it either way */
    });
  }
}

export interface LeaderLoopOpts {
  redis: Redis;
  keys?: Keys;
  /** Leader key TTL in seconds (fractional allowed — applied as PX).
   *  Spec default: 30. */
  ttlSec?: number;
  /** Identity written into the leader key. Default: random UUID. */
  ownerId?: string;
  /** Called with acquire/renew/fn errors. Default: swallow (loop keeps going). */
  onError?: (err: unknown) => void;
}

export interface LeaderHandle {
  ownerId: string;
  isLeader(): boolean;
  /**
   * Stop contending. Aborts a running fn and awaits it. `release: false`
   * keeps the key in Redis (simulates a crashed leader: followers take over
   * only after the TTL lapses).
   */
  stop(opts?: { release?: boolean }): Promise<void>;
}

/**
 * Leader election for singleton roles (cron, reaper, migrate). Every ttl/3 the
 * loop either tries SET NX EX (follower) or compare-owner-renews (leader). On
 * winning, `fn(signal)` is started once and runs for the whole leadership
 * term; losing the key (missed renewals, e.g. a Redis partition) aborts the
 * signal — fn must treat that as "stop working immediately".
 */
export function leaderLoop(
  role: string,
  fn: (signal: AbortSignal) => Promise<void>,
  opts: LeaderLoopOpts,
): LeaderHandle {
  const keys = opts.keys ?? makeKeys();
  const key = keys.leaderLock(role);
  const ttlMs = Math.max(100, Math.round((opts.ttlSec ?? 30) * 1000));
  const owner = opts.ownerId ?? randomUUID();
  let leader = false;
  let stopped = false;
  let ac: AbortController | null = null;
  let running: Promise<void> = Promise.resolve();

  const demote = () => {
    leader = false;
    ac?.abort();
    ac = null;
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (!leader) {
        if ((await opts.redis.set(key, owner, "PX", ttlMs, "NX")) === "OK") {
          leader = true;
          ac = new AbortController();
          running = fn(ac.signal).catch((err) => opts.onError?.(err));
        }
      } else if (!(await extendLock(opts.redis, key, owner, ttlMs))) {
        demote();
      }
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const timer = setInterval(() => void tick(), Math.max(50, Math.floor(ttlMs / 3)));
  timer.unref?.();
  void tick();

  return {
    ownerId: owner,
    isLeader: () => leader,
    async stop(o) {
      stopped = true;
      clearInterval(timer);
      const wasLeader = leader;
      demote();
      await running.catch(() => {});
      if (wasLeader && (o?.release ?? true)) {
        await releaseLock(opts.redis, key, owner).catch(() => {});
      }
    },
  };
}
