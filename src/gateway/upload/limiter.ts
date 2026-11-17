/**
 * Per-session limit on upload_begin: ten a minute (a fixed one-minute window).
 * Each begin is a Slack API call and a fresh upload URL, so a runaway loop
 * costs the workspace's rate budget.
 *
 * Shared across gateway replicas through Redis in the gateway role (the same
 * choice as the MCP credential epochs), per process in memory otherwise (mono,
 * tests). A Redis error falls back to the in-process count for that call: the
 * limit is a guard against loops, not a security boundary, so a Redis outage
 * must not stop uploads. With several replicas and Redis down the effective
 * limit is per replica.
 */
import type { Redis } from "ioredis";
import { env } from "../../config/env";
import { getRedis } from "../../queue/redis";
import { redisPrefix } from "../../queue/keys";

export const UPLOAD_BEGINS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

export interface UploadLimiter {
  /** Count one begin for the session; false when the minute's allowance is spent. */
  take(session: string): Promise<boolean>;
}

export function localUploadLimiter(now: () => number = Date.now, limit = UPLOAD_BEGINS_PER_MINUTE): UploadLimiter {
  const windows = new Map<string, { bucket: number; n: number }>();
  return {
    async take(session) {
      const bucket = Math.floor(now() / WINDOW_MS);
      if (windows.size > 2000) for (const [k, w] of windows) if (w.bucket < bucket) windows.delete(k);
      const w = windows.get(session);
      if (!w || w.bucket !== bucket) {
        windows.set(session, { bucket, n: 1 });
        return true;
      }
      if (w.n >= limit) return false;
      w.n++;
      return true;
    },
  };
}

export function redisUploadLimiter(redis: Redis, prefix: string, fallback: UploadLimiter, now: () => number = Date.now, limit = UPLOAD_BEGINS_PER_MINUTE): UploadLimiter {
  return {
    async take(session) {
      const key = `${prefix}:upload-begin:${session}:${Math.floor(now() / WINDOW_MS)}`;
      try {
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, 120);
        return n <= limit;
      } catch {
        return fallback.take(session);
      }
    },
  };
}

let shared: UploadLimiter | undefined;
/** Redis in the gateway role, else in-process. */
export function uploadLimiter(): UploadLimiter {
  if (shared) return shared;
  const local = localUploadLimiter();
  return (shared = env.role() === "gateway" ? redisUploadLimiter(getRedis(), redisPrefix(), local) : local);
}
/** TEST SEAM. */
export function __setUploadLimiter(l: UploadLimiter | undefined): void {
  shared = l;
}
