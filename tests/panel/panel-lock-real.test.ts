import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sleep, testPrefix, until } from "../queue/real";
import type { Keys } from "../../src/queue/keys";
import type { PanelLock } from "../../src/queue/panel-lock";

const prefix = testPrefix("panellock");

describe.skipIf(!realEnabled)("panel active-surface lock against real Redis", () => {
  let redis: Redis;
  let keys: Keys;
  let lock: PanelLock;

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { makePanelLock } = await import("../../src/queue/panel-lock");
    redis = realRedis();
    keys = makeKeys(prefix);
    lock = makePanelLock({ redis, keys, ttlMs: 800 });
  })();

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await cleanupPrefix(redis, prefix);
    await redis.quit();
  });

  test("acquire is exclusive; owner reads back; re-acquire by owner refreshes", async () => {
    await ready;
    expect(await lock.acquire("s1", "op-a")).toBe(true);
    expect(await lock.owner("s1")).toBe("op-a");
    // another operator cannot take it
    expect(await lock.acquire("s1", "op-b")).toBe(false);
    // the same operator re-acquiring succeeds (TTL refresh)
    expect(await lock.acquire("s1", "op-a")).toBe(true);
    expect(await lock.owner("s1")).toBe("op-a");
  });

  test("owner-checked heartbeat and release", async () => {
    await ready;
    await lock.acquire("s2", "op-a");
    // wrong owner can neither heartbeat nor release
    expect(await lock.heartbeat("s2", "op-b")).toBe(false);
    expect(await lock.release("s2", "op-b")).toBe(false);
    expect(await lock.owner("s2")).toBe("op-a");
    // right owner can
    expect(await lock.heartbeat("s2", "op-a")).toBe(true);
    expect(await lock.release("s2", "op-a")).toBe(true);
    expect(await lock.owner("s2")).toBeNull();
  });

  test("TTL auto-expiry releases the lock", async () => {
    await ready;
    await lock.acquire("s3", "op-a");
    await until(async () => (await lock.owner("s3")) === null, 3000);
    expect(await lock.owner("s3")).toBeNull();
  });

  test("heartbeat keeps a lock alive past its raw TTL", async () => {
    await ready;
    const l = (await import("../../src/queue/panel-lock")).makePanelLock({ redis, keys, ttlMs: 300 });
    await l.acquire("s4", "op-a");
    for (let i = 0; i < 4; i++) {
      await sleep(120);
      expect(await l.heartbeat("s4", "op-a")).toBe(true);
    }
    expect(await l.owner("s4")).toBe("op-a");
    await l.release("s4", "op-a");
  });

  test("steal transfers a contended lock to the new operator and returns the displaced one", async () => {
    await ready;
    await lock.acquire("s5", "op-a");
    const displaced = await lock.steal("s5", "op-b");
    expect(displaced).toBe("op-a");
    // Lock stays HELD, now under op-b (Slack still suppressed).
    expect(await lock.owner("s5")).toBe("op-b");
    // op-a's heartbeat now fails — they lost control.
    expect(await lock.heartbeat("s5", "op-a")).toBe(false);
    expect(await lock.heartbeat("s5", "op-b")).toBe(true);
    await lock.release("s5", "op-b");
  });

  test("noticeOnce is a cross-replica once-guard; clearNotice re-arms it", async () => {
    await ready;
    expect(await lock.noticeOnce("s6", 5000)).toBe(true);
    expect(await lock.noticeOnce("s6", 5000)).toBe(false); // a second replica loses
    await lock.clearNotice("s6");
    expect(await lock.noticeOnce("s6", 5000)).toBe(true); // re-armed after resume
    await lock.clearNotice("s6");
  });
});
