import { afterAll, describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { cleanupPrefix, realEnabled, realRedis, sleep, testPrefix, until } from "./real";
import type { Keys } from "../../src/queue/keys";
import type { PubSub } from "../../src/queue/pubsub";

const prefix = testPrefix("pubsub");

describe.skipIf(!realEnabled)("queue/pubsub against real Redis", () => {
  let redis: Redis;
  let sub: Redis;
  let keys: Keys;
  let ps: PubSub;
  let mkPubSub: (opts?: { streamMaxLen?: number; abortFlagTtlMs?: number }) => PubSub;

  const ready = (async () => {
    if (!realEnabled) return;
    const { makeKeys } = await import("../../src/queue/keys");
    const { makePubSub } = await import("../../src/queue/pubsub");
    redis = realRedis();
    sub = realRedis();
    keys = makeKeys(prefix);
    mkPubSub = (opts) => makePubSub({ redis, sub, keys, ...opts });
    ps = mkPubSub();
  })();

  afterAll(async () => {
    if (!realEnabled) return;
    await ready;
    await ps.close();
    await cleanupPrefix(redis, prefix);
    await Promise.all([redis.quit(), sub.quit()]);
  });

  test("abort: delivered to the right session only; unsubscribe stops it", async () => {
    await ready;
    let hitsA = 0;
    let hitsB = 0;
    const offA = await ps.onAbort("sessA", () => hitsA++);
    const offB = await ps.onAbort("sessB", () => hitsB++);

    const receivers = await ps.publishAbort("sessA");
    expect(receivers).toBe(1);
    await until(() => hitsA === 1);
    expect(hitsB).toBe(0);

    await offA();
    expect(await ps.publishAbort("sessA")).toBe(0); // nobody listening anymore
    await ps.publishAbort("sessB");
    await until(() => hitsB === 1);
    expect(hitsA).toBe(1);
    await offB();
  });

  test("durable abort flag: zero-subscriber publish is consumable exactly once", async () => {
    await ready;
    expect(await ps.publishAbort("sessFlag")).toBe(0); // nobody subscribed
    expect(await ps.consumeAbortFlag("sessFlag")).toBe(true); // flag survived
    expect(await ps.consumeAbortFlag("sessFlag")).toBe(false); // GETDEL: once only
  });

  test("abort flag expires at its TTL", async () => {
    await ready;
    const quick = mkPubSub({ abortFlagTtlMs: 100 });
    await quick.publishAbort("sessFlagTtl");
    await sleep(200);
    expect(await quick.consumeAbortFlag("sessFlagTtl")).toBe(false);
  });

  test("gate + reload channels deliver", async () => {
    await ready;
    let gate = 0;
    let reload = 0;
    const offG = await ps.onGate("pend-1", () => gate++);
    const offR = await ps.onReload("tenant-1", () => reload++);
    await ps.publishGate("pend-1");
    await ps.publishReload("tenant-1");
    await until(() => gate === 1 && reload === 1);
    await offG();
    await offR();
  });

  test("two subscribers on one channel each fire; one unsubscribing leaves the other", async () => {
    await ready;
    let a = 0;
    let b = 0;
    const offA = await ps.onAbort("sessM", () => a++);
    const offB = await ps.onAbort("sessM", () => b++);
    await ps.publishAbort("sessM");
    await until(() => a === 1 && b === 1);
    await offA();
    await ps.publishAbort("sessM");
    await until(() => b === 2);
    expect(a).toBe(1);
    await offB();
  });

  test("events stream: append + read, fromId is exclusive", async () => {
    await ready;
    const id1 = await ps.appendEvent("sessE", { kind: "chunk", n: 1 });
    const id2 = await ps.appendEvent("sessE", { kind: "chunk", n: 2 });
    const id3 = await ps.appendEvent("sessE", { kind: "done" });
    expect(id1 < id2 && id2 < id3).toBe(true);

    const all = await ps.readEvents("sessE");
    expect(all.map((e) => e.id)).toEqual([id1, id2, id3]);
    expect(all[0]!.event).toEqual({ kind: "chunk", n: 1 });

    const after1 = await ps.readEvents("sessE", id1);
    expect(after1.map((e) => e.id)).toEqual([id2, id3]);
    expect(await ps.readEvents("sessE", id3)).toEqual([]);
  });

  test("events stream tolerates non-JSON and missing fields", async () => {
    await ready;
    await redis.xadd(keys.eventsStream("sessRaw"), "*", "event", "not json");
    await redis.xadd(keys.eventsStream("sessRaw"), "*", "other", "field");
    const events = await ps.readEvents("sessRaw");
    expect(events[0]!.event).toBe("not json");
    expect(events[1]!.event).toBeNull();
  });

  test("MAXLEN caps the stream (exact and approximate)", async () => {
    await ready;
    const exact = mkPubSub({ streamMaxLen: 50 });
    for (let i = 0; i < 60; i++) await exact.appendEvent("sessCapX", { i }, { exact: true });
    expect(await redis.xlen(keys.eventsStream("sessCapX"))).toBe(50);
    // oldest entries were the ones trimmed
    const kept = await exact.readEvents("sessCapX");
    expect(kept[0]!.event).toEqual({ i: 10 });

    const approx = mkPubSub({ streamMaxLen: 100 });
    for (let i = 0; i < 400; i++) await approx.appendEvent("sessCapA", { i });
    const len = await redis.xlen(keys.eventsStream("sessCapA"));
    expect(len).toBeGreaterThanOrEqual(100); // never trims below the cap…
    expect(len).toBeLessThan(400); // …but does trim
  });

  test("close drops every subscription at once", async () => {
    await ready;
    const mine = mkPubSub();
    let hits = 0;
    await mine.onAbort("sessZ1", () => hits++);
    await mine.onReload("tenZ", () => hits++);
    await mine.close();
    await ps.publishAbort("sessZ1");
    await ps.publishReload("tenZ");
    await sleep(150);
    expect(hits).toBe(0);
  });
});
