/**
 * Shared plumbing for the real-Redis queue tests (mirrors tests/db/pg-real
 * gating). Gated on SLAUDE_REDIS_TEST_URL; every suite runs under its own
 * random key prefix and deletes `${prefix}:*` afterwards, so suites can't
 * collide with each other or with anything else on the server.
 *
 * IMPORTANT: gated test files must import src/queue/* DYNAMICALLY (inside
 * beforeAll) — a static import would load those modules in the redis-less
 * test leg and drag its coverage; skipped suites load nothing.
 */
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";

export const REAL_URL = process.env.SLAUDE_REDIS_TEST_URL ?? "";
export const realEnabled = REAL_URL.length > 0;

export function testPrefix(tag: string): string {
  return `slaudetest-${tag}-${randomBytes(3).toString("hex")}`;
}

/** Fresh dedicated connection (BullMQ-compatible options). */
export function realRedis(): Redis {
  return new Redis(REAL_URL, { maxRetriesPerRequest: null });
}

/** Delete every key under the suite's prefix. */
export async function cleanupPrefix(redis: Redis, prefix: string): Promise<void> {
  await deletePattern(redis, `${prefix}:*`);
}

/**
 * Delete every key from ANY previous run of this suite tag
 * (`slaudetest-<tag>-*`). An interrupted run never reaches its afterAll
 * cleanup, so its random-prefix keys (notably BullMQ `:meta`) leak until the
 * NEXT run of the same suite sweeps them here. Assumes at most one concurrent
 * run per suite tag against one Redis — true in CI (per-job service
 * container) and the documented constraint for a shared local Redis.
 */
export async function sweepTag(redis: Redis, tag: string): Promise<void> {
  await deletePattern(redis, `slaudetest-${tag}-*`);
}

/** BullMQ-aware teardown: obliterate the named queues (removes :meta and all
 *  internal structures) before the generic prefix delete. */
export async function obliterateQueues(redis: Redis, bullPrefix: string, names: string[]): Promise<void> {
  const { Queue } = await import("bullmq");
  for (const name of names) {
    const q = new Queue(name, { connection: redis, prefix: bullPrefix });
    try {
      await q.obliterate({ force: true });
    } catch {
      // Queue never materialized — nothing to remove.
    }
    await q.close();
  }
}

async function deletePattern(redis: Redis, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

/** Poll until cond() is true; throws past the deadline. */
export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 4000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`until: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
