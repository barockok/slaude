import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sleep, testPrefix, until } from "./real";
import type { Registry } from "../../src/queue/registry";
import type { Keys } from "../../src/queue/keys";

const prefix = testPrefix("reg");

describe.skipIf(!realEnabled)("queue/registry against real Redis", () => {
  let redis: Redis;
  let keys: Keys;
  let mkRegistry: (opts?: { heartbeatSec?: number; nodeTtlSec?: number }) => Registry;

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { makeRegistry } = await import("../../src/queue/registry");
    redis = realRedis();
    keys = makeKeys(prefix);
    mkRegistry = (opts) => makeRegistry({ redis, keys, ...opts });
  })();

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await cleanupPrefix(redis, prefix);
    await redis.quit();
  });

  test("register → lookup fresh; unregister → null", async () => {
    await ready;
    const reg = mkRegistry({ heartbeatSec: 10 });
    await reg.register("s1", "nodeA");
    const loc = await reg.lookup("s1");
    expect(loc).not.toBeNull();
    expect(loc!.node).toBe("nodeA");
    expect(loc!.fresh).toBe(true);
    expect(loc!.since).toBeGreaterThan(0);
    await reg.unregister("s1");
    expect(await reg.lookup("s1")).toBeNull();
  });

  test("TTL expiry: entry vanishes at 2× heartbeat without beats", async () => {
    await ready;
    const reg = mkRegistry({ heartbeatSec: 0.15 }); // TTL 300ms
    await reg.register("s-ttl", "nodeA");
    expect(await reg.lookup("s-ttl")).not.toBeNull();
    await until(async () => (await reg.lookup("s-ttl")) === null, 2000);
  });

  test("heartbeat keeps an entry alive and refuses to resurrect a dead one", async () => {
    await ready;
    const reg = mkRegistry({ heartbeatSec: 0.15 }); // TTL 300ms
    await reg.register("s-beat", "nodeA");
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      expect(await reg.heartbeat("s-beat")).toBe(true);
    }
    // alive well past the unbeaten TTL
    const loc = await reg.lookup("s-beat");
    expect(loc!.fresh).toBe(true);
    // let it die — the beat must NOT recreate it
    await until(async () => (await reg.lookup("s-beat")) === null, 2000);
    expect(await reg.heartbeat("s-beat")).toBe(false);
    expect(await reg.lookup("s-beat")).toBeNull();
  });

  test("listByNode filters by owning node", async () => {
    await ready;
    const reg = mkRegistry({ heartbeatSec: 10 });
    await reg.register("s-a1", "nA");
    await reg.register("s-a2", "nA");
    await reg.register("s-b1", "nB");
    expect((await reg.listByNode("nA")).sort()).toEqual(["s-a1", "s-a2"]);
    expect(await reg.listByNode("nB")).toEqual(["s-b1"]);
    expect(await reg.listByNode("nC")).toEqual([]);
    for (const s of ["s-a1", "s-a2", "s-b1"]) await reg.unregister(s);
  });

  test("node heartbeat: up → alive, expiry → dead but still known", async () => {
    await ready;
    const reg = mkRegistry({ nodeTtlSec: 0.25 });
    await reg.nodeUp("n-exp");
    expect(await reg.nodeAlive("n-exp")).toBe(true);
    expect(await reg.listNodes()).toContain("n-exp");
    expect(await reg.knownNodes()).toContain("n-exp");
    await until(async () => !(await reg.nodeAlive("n-exp")), 2000);
    // dead: liveness gone, but the reaper work list still remembers it
    expect(await reg.listNodes()).not.toContain("n-exp");
    expect(await reg.knownNodes()).toContain("n-exp");
    await reg.forgetNode("n-exp");
    expect(await reg.knownNodes()).not.toContain("n-exp");
  });

  test("beatNode refreshes liveness; nodeDown clears key and set", async () => {
    await ready;
    const reg = mkRegistry({ nodeTtlSec: 0.3 });
    await reg.nodeUp("n-beat");
    for (let i = 0; i < 4; i++) {
      await sleep(150);
      await reg.beatNode("n-beat");
    }
    expect(await reg.nodeAlive("n-beat")).toBe(true); // outlived 2× its TTL
    await reg.nodeDown("n-beat");
    expect(await reg.nodeAlive("n-beat")).toBe(false);
    expect(await reg.knownNodes()).not.toContain("n-beat");
  });
});
