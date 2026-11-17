import { describe, expect, test } from "bun:test";
import { memoryLastSpeakerStore, redisLastSpeakerStore, type LastSpeaker, type SpeakerRedis } from "../../../src/gateway/engage/last-speaker";

/** A small Redis double: one shared keyspace, SET ... EX, GETDEL, optional failure. */
function fakeRedis(opts: { fail?: boolean } = {}) {
  const kv = new Map<string, { v: string; until: number }>();
  let clock = 1_000_000;
  const r = {
    async set(k: string, v: string, _ex: string, secs: number, nx?: string) {
      if (opts.fail) throw new Error("down");
      if (nx === "NX" && (kv.get(k)?.until ?? 0) > clock) return null;
      kv.set(k, { v, until: clock + secs * 1000 });
      return "OK";
    },
    async get(k: string) {
      if (opts.fail) throw new Error("down");
      const e = kv.get(k);
      return e && e.until > clock ? e.v : null;
    },
    async del(...ks: string[]) {
      if (opts.fail) throw new Error("down");
      return ks.filter((k) => kv.delete(k)).length;
    },
    async getdel(k: string) {
      if (opts.fail) throw new Error("down");
      const e = kv.get(k);
      kv.delete(k);
      return e && e.until > clock ? e.v : null;
    },
  } as unknown as SpeakerRedis;
  return { r, kv, advance: (ms: number) => void (clock += ms) };
}

const rec: LastSpeaker = { ts: "1700000000.000100", persona: "ana", app: "A0EXAMPLE", repliedToUser: "U0PERSON" };
const place = { channel: "C0EXAMPLE", thread: "1700000000.000001", persona: "ana" };

describe("memory store", () => {
  test("take returns the record once and clears it", async () => {
    const s = memoryLastSpeakerStore();
    await s.put(place, rec);
    expect(await s.take(place)).toEqual(rec);
    expect(await s.take(place)).toBeNull();
  });
  test("places are independent, and a root place differs from a thread", async () => {
    const s = memoryLastSpeakerStore();
    await s.put(place, rec);
    expect(await s.take({ ...place, thread: null })).toBeNull();
    expect(await s.take({ ...place, channel: "C0OTHER" })).toBeNull();
    expect(await s.take(place)).toEqual(rec);
  });
  test("a record expires after its ttl", async () => {
    let t = 0;
    const s = memoryLastSpeakerStore(() => t);
    await s.put(place, rec, { ttlSeconds: 60 });
    t = 61_000;
    expect(await s.take(place)).toBeNull();
  });
});

describe("personas, peek and clear", () => {
  const stores = () => {
    const f = fakeRedis();
    return [memoryLastSpeakerStore(), redisLastSpeakerStore(f.r)];
  };
  test("each persona has its own record in one place", async () => {
    for (const s of stores()) {
      await s.put(place, rec);
      await s.put({ ...place, persona: "robin" }, { ...rec, persona: "robin" });
      expect((await s.take({ ...place, persona: "robin" }))?.persona).toBe("robin");
      expect(await s.take(place)).toEqual(rec);
    }
  });
  test("peek leaves the record", async () => {
    for (const s of stores()) {
      await s.put(place, rec);
      expect(await s.peek(place)).toEqual(rec);
      expect(await s.peek(place)).toEqual(rec);
      expect(await s.take(place)).toEqual(rec);
      expect(await s.peek(place)).toEqual(rec); // the marker outlives the consumed record
    }
  });
  test("clear removes it", async () => {
    for (const s of stores()) {
      await s.put(place, rec);
      await s.clear(place);
      expect(await s.peek(place)).toBeNull();
      expect(await s.take(place)).toBeNull();
    }
  });
  test("peek and clear fail open on a Redis error", async () => {
    const s = redisLastSpeakerStore(fakeRedis({ fail: true }).r);
    expect(await s.peek(place)).toBeNull();
    await s.clear(place);
  });
});

describe("ifAbsent", () => {
  const richer = { ...rec, repliedToUser: "U0PERSON" };
  const echo = { ...rec, repliedToUser: null };
  test("memory: the echo does not overwrite, a plain put does", async () => {
    const s = memoryLastSpeakerStore();
    await s.put(place, richer);
    await s.put(place, echo, { ifAbsent: true });
    expect(await s.take(place)).toEqual(richer);
    await s.put(place, echo, { ifAbsent: true });
    expect(await s.take(place)).toEqual(echo);
  });
  test("redis: the same", async () => {
    const s = redisLastSpeakerStore(fakeRedis().r);
    await s.put(place, richer);
    await s.put(place, echo, { ifAbsent: true });
    expect(await s.take(place)).toEqual(richer);
  });
});

describe("redis store", () => {
  test("two replicas over one Redis: exactly one consumes the record", async () => {
    const { r } = fakeRedis();
    const a = redisLastSpeakerStore(r);
    const b = redisLastSpeakerStore(r);
    await a.put(place, rec);
    const [x, y] = await Promise.all([a.take(place), b.take(place)]);
    expect([x, y].filter(Boolean)).toEqual([rec]);
  });
  test("a write on one replica is read on another", async () => {
    const { r } = fakeRedis();
    await redisLastSpeakerStore(r).put(place, rec);
    expect(await redisLastSpeakerStore(r).take(place)).toEqual(rec);
  });
  test("the ttl is applied (an expired record is gone)", async () => {
    const f = fakeRedis();
    const s = redisLastSpeakerStore(f.r);
    await s.put(place, rec, { ttlSeconds: 600 });
    f.advance(601_000);
    expect(await s.take(place)).toBeNull();
  });
  test("a Redis failure fails open: no record, nothing thrown", async () => {
    const s = redisLastSpeakerStore(fakeRedis({ fail: true }).r);
    await s.put(place, rec);
    expect(await s.take(place)).toBeNull();
  });
  test("a corrupt value reads as no record", async () => {
    const f = fakeRedis();
    f.kv.set("slaude:engage:last:C0EXAMPLE:root:ana", { v: "{nope", until: Infinity });
    expect(await redisLastSpeakerStore(f.r).take({ ...place, thread: null })).toBeNull();
  });
});
