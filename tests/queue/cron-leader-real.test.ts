/**
 * Cron must run on exactly one gateway replica. Without this, every replica
 * ticks, every replica sees the same due jobs (the query claims nothing, and the
 * in-process "already running" guard is invisible to the others), and the user
 * gets each job run once per replica.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, testPrefix, until } from "./real";
import { makeKeys } from "../../src/queue/keys";
import { startCronLeader, type SchedulerLike } from "../../src/gateway/core/cron-leader";

const prefix = testPrefix("cronldr");
const keys = makeKeys(prefix);
let redis: Redis | null = null;

/** Records start/stop instead of ticking. */
function fakeScheduler(): SchedulerLike & { running: boolean; starts: number } {
  return {
    running: false,
    starts: 0,
    start() {
      this.running = true;
      this.starts++;
    },
    stop() {
      this.running = false;
    },
  };
}

afterAll(async () => {
  if (redis) {
    await cleanupPrefix(redis, prefix);
    redis.disconnect();
  }
});

describe.skipIf(!realEnabled)("cron leader election against real Redis", () => {
  test("only one of two replicas runs the scheduler, and the other takes over when it goes", async () => {
    redis ??= realRedis();
    const a = fakeScheduler();
    const b = fakeScheduler();

    const ha = startCronLeader(a, { redis, keys, ttlSec: 1 });
    const hb = startCronLeader(b, { redis, keys, ttlSec: 1 });

    await until(() => a.running || b.running, 5_000);
    // Give the follower every chance to wrongly start too.
    await new Promise((r) => setTimeout(r, 600));
    expect([a.running, b.running].filter(Boolean)).toHaveLength(1);

    const leader = a.running ? ha : hb;
    const follower = a.running ? b : a;
    const wasLeaderScheduler = a.running ? a : b;

    // The leader leaves; the other must pick the schedule up.
    await leader.stop();
    expect(wasLeaderScheduler.running).toBe(false);
    await until(() => follower.running, 5_000);

    expect(follower.running).toBe(true);
    await (a.running ? ha : hb).stop().catch(() => {});
    await ha.stop().catch(() => {});
    await hb.stop().catch(() => {});
    expect(a.running || b.running).toBe(false);
  }, 20_000);

  test("stopping the only replica stops the scheduler", async () => {
    redis ??= realRedis();
    const s = fakeScheduler();
    const h = startCronLeader(s, { redis, keys, ttlSec: 1 });

    await until(() => s.running, 5_000);
    await h.stop();

    expect(s.running).toBe(false);
    expect(s.starts).toBe(1);
  }, 15_000);
});
