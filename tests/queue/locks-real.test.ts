import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sleep, testPrefix, until } from "./real";
import type { Keys } from "../../src/queue/keys";

const prefix = testPrefix("locks");

describe.skipIf(!realEnabled)("queue/locks against real Redis", () => {
  let redis: Redis;
  let keys: Keys;
  let locks: typeof import("../../src/queue/locks");

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    locks = await import("../../src/queue/locks");
    redis = realRedis();
    keys = makeKeys(prefix);
  })();

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await cleanupPrefix(redis, prefix);
    await redis.quit();
  });

  test("primitives: NX acquire, owner-checked extend and release", async () => {
    await ready;
    const key = keys.sessionLock("prim");
    expect(await locks.acquireLock(redis, key, "a", 5000)).toBe(true);
    expect(await locks.acquireLock(redis, key, "b", 5000)).toBe(false);
    // wrong owner can neither extend nor release
    expect(await locks.extendLock(redis, key, "b", 5000)).toBe(false);
    expect(await locks.releaseLock(redis, key, "b")).toBe(false);
    expect(await redis.get(key)).toBe("a");
    // right owner can do both
    expect(await locks.extendLock(redis, key, "a", 5000)).toBe(true);
    expect(await locks.releaseLock(redis, key, "a")).toBe(true);
    expect(await redis.get(key)).toBeNull();
    // extend/release on a missing key
    expect(await locks.extendLock(redis, key, "a", 5000)).toBe(false);
    expect(await locks.releaseLock(redis, key, "a")).toBe(false);
  });

  test("withSessionLock: contention yields HELD_BY_OTHER without running fn", async () => {
    await ready;
    const opts = { redis, keys, ttlMs: 5000 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = locks.withSessionLock("s1", "owner-a", async () => {
      await gate;
      return "ran-a";
    }, opts);
    await until(async () => (await redis.get(keys.sessionLock("s1"))) === "owner-a");

    let bRan = false;
    const b = await locks.withSessionLock("s1", "owner-b", async () => {
      bRan = true;
      return "ran-b";
    }, opts);
    expect(b).toBe(locks.HELD_BY_OTHER);
    expect(bRan).toBe(false);

    release();
    expect(await holder).toBe("ran-a");
    // released: a third owner acquires and runs
    const c = await locks.withSessionLock("s1", "owner-c", async () => "ran-c", opts);
    expect(c).toBe("ran-c");
  });

  test("extender keeps the lock alive through a long fn", async () => {
    await ready;
    const opts = { redis, keys, ttlMs: 300, extendEveryMs: 100 };
    const result = await locks.withSessionLock("s-long", "owner-a", async () => {
      // run 3× the TTL; the extender must keep contenders out the whole time
      for (let i = 0; i < 6; i++) {
        await sleep(150);
        expect(await locks.withSessionLock("s-long", "owner-b", async () => "stolen", opts)).toBe(
          locks.HELD_BY_OTHER,
        );
      }
      return "kept";
    }, opts);
    expect(result).toBe("kept");
    expect(await redis.get(keys.sessionLock("s-long"))).toBeNull();
  });

  test("TTL lapse under a stalled fn: signal aborts, second owner runs — dual-run is never silent", async () => {
    await ready;
    const events: string[] = [];
    // TTL 250ms, extender deliberately slower than the TTL — models a node
    // whose event loop stalled (GC pause, blocked I/O) long enough for the
    // lock to expire out from under it.
    const a = locks.withSessionLock(
      "s-esc",
      "owner-a",
      async (signal) => {
        const aborted = new Promise<void>((r) =>
          signal.addEventListener("abort", () => {
            events.push("a-abort");
            r();
          }),
        );
        await sleep(350); // stall past the TTL — the lock is now expired
        // second owner acquires the lapsed lock and runs while fn A is live…
        const b = await locks.withSessionLock(
          "s-esc",
          "owner-b",
          async () => {
            events.push("b-ran");
            return "b";
          },
          { redis, keys, ttlMs: 5000 },
        );
        expect(b).toBe("b");
        // …but A is TOLD: the extender's next compare-owner extend fails and
        // aborts A's signal within one extendEveryMs of the loss.
        await aborted;
        events.push("a-end");
        return "a";
      },
      { redis, keys, ttlMs: 250, extendEveryMs: 450 },
    );
    expect(await a).toBe("a");
    // Timeline: the overlap happened, and the abort fired before A carried on
    // — the dual-run window exists (bounded by extendEveryMs) but is never
    // silent, so P6 can abort the in-flight turn.
    expect(events).toEqual(["b-ran", "a-abort", "a-end"]);
    // A's owner-checked finally-release must not have clobbered anything
    // (B released its own lock already; the key is simply gone).
    expect(await redis.get(keys.sessionLock("s-esc"))).toBeNull();
  });

  test("signal stays quiet while the extender keeps the lock", async () => {
    await ready;
    const r = await locks.withSessionLock(
      "s-quiet",
      "owner-a",
      async (signal) => {
        await sleep(700); // several extend cycles beyond the raw TTL
        return signal.aborted;
      },
      { redis, keys, ttlMs: 200, extendEveryMs: 80 },
    );
    expect(r).toBe(false);
  });

  test("release does not clobber a lock the extender already lost", async () => {
    await ready;
    // ttl tiny, extender far too slow → the lock lapses mid-fn and another
    // owner takes it; the finally-release must leave the new owner alone.
    const r = await locks.withSessionLock(
      "s-lost",
      "owner-a",
      async () => {
        await until(async () => (await redis.get(keys.sessionLock("s-lost"))) === null, 2000);
        expect(await locks.acquireLock(redis, keys.sessionLock("s-lost"), "owner-b", 60_000)).toBe(true);
        return "finished-anyway";
      },
      { redis, keys, ttlMs: 200, extendEveryMs: 10_000 },
    );
    expect(r).toBe("finished-anyway");
    expect(await redis.get(keys.sessionLock("s-lost"))).toBe("owner-b");
    await locks.releaseLock(redis, keys.sessionLock("s-lost"), "owner-b");
  });

  test("leaderLoop: single leader, crashed leader fails over within TTL", async () => {
    await ready;
    const mk = (owner: string, log: string[]) =>
      locks.leaderLoop(
        "reaper",
        (signal) =>
          new Promise<void>((resolve) => {
            log.push(`${owner}:lead`);
            signal.addEventListener("abort", () => {
              log.push(`${owner}:abort`);
              resolve();
            });
          }),
        { redis, keys, ttlSec: 0.5, ownerId: owner },
      );

    const logA: string[] = [];
    const a = mk("A", logA);
    await until(() => a.isLeader(), 2000);
    expect(logA).toEqual(["A:lead"]);

    const logB: string[] = [];
    const b = mk("B", logB);
    await sleep(300);
    expect(b.isLeader()).toBe(false); // A holds the key

    // A "crashes": stops renewing but leaves the key → B must take over ≤ TTL
    const t0 = Date.now();
    await a.stop({ release: false });
    expect(logA).toEqual(["A:lead", "A:abort"]);
    await until(() => b.isLeader(), 2500);
    expect(Date.now() - t0).toBeLessThanOrEqual(1500); // ttl 500ms + tick slack
    expect(logB).toEqual(["B:lead"]);

    // graceful stop releases the key immediately
    await b.stop();
    expect(await redis.get(keys.leaderLock("reaper"))).toBeNull();
    expect(logB).toEqual(["B:lead", "B:abort"]);
  });

  test("leaderLoop: graceful release hands over on the next tick", async () => {
    await ready;
    const a = locks.leaderLoop("cron", async () => {}, { redis, keys, ttlSec: 0.5, ownerId: "A" });
    await until(() => a.isLeader(), 2000);
    const b = locks.leaderLoop("cron", async () => {}, { redis, keys, ttlSec: 0.5, ownerId: "B" });
    await a.stop(); // releases
    await until(() => b.isLeader(), 1000);
    await b.stop();
  });
});
