import { describe, expect, test } from "bun:test";
import { circuitBreaker, memoryEngageState, redisEngageState, type EngageState } from "../../../src/gateway/engage/budget";
import { fakeEngageRedis } from "../../helpers/fake-engage-redis";

const clock = () => {
  let t = Date.UTC(2026, 10, 17, 12, 0, 0);
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

type Make = (o: Parameters<typeof memoryEngageState>[0]) => EngageState;
const impls: Array<[string, (c: ReturnType<typeof clock>) => Make]> = [
  ["memory", (c) => (o) => memoryEngageState({ ...o, now: c.now })],
  ["redis", (c) => { const r = fakeEngageRedis({ now: c.now }); return (o) => redisEngageState(r, "t", { ...o, now: c.now }); }],
];

for (const [name, mk] of impls) {
  describe(`engage state (${name})`, () => {
    test("one claim wins per channel and ts", async () => {
      const c = clock();
      const s = mk(c)({});
      expect(await s.claim("C1", "1.0")).toBe(true);
      expect(await s.claim("C1", "1.0")).toBe(false);
      expect(await s.claim("C1", "2.0")).toBe(true);
      expect(await s.claim("C2", "1.0")).toBe(true);
    });

    test("the daily bucket and the minute ceiling", async () => {
      const c = clock();
      const s = mk(c)({ dailyBudget: () => 5, minuteCeiling: () => 3 });
      expect([await s.spend("C1"), await s.spend("C1"), await s.spend("C1"), await s.spend("C1")]).toEqual(["ok", "ok", "ok", "minute"]);
      c.advance(60_000);
      expect([await s.spend("C1"), await s.spend("C1"), await s.spend("C1")]).toEqual(["ok", "ok", "day"]);
      expect(await s.spend("C2")).toBe("ok");
      c.advance(24 * 3600_000);
      expect(await s.spend("C1")).toBe("ok");
    });

    test("pass memory covers the author, not a new one, and ends when the agent speaks or after 30 minutes", async () => {
      const c = clock();
      const s = mk(c)({});
      expect(await s.passed("C1", "9.0", "UA")).toBe(false);
      await s.markPass("C1", "9.0", "UA");
      expect(await s.passed("C1", "9.0", "UA")).toBe(true);
      expect(await s.passed("C1", "9.0", "UB")).toBe(false);
      await s.clearPass("C1", "9.0");
      expect(await s.passed("C1", "9.0", "UA")).toBe(false);
      await s.markPass("C1", "9.0", "UA");
      c.advance(1801_000);
      expect(await s.passed("C1", "9.0", "UA")).toBe(false);
    });

    test("a root cooldown covers the next three candidates, or 120 seconds", async () => {
      const c = clock();
      const s = mk(c)({});
      expect(await s.cooling("C1")).toBe(false);
      await s.markCooldown("C1");
      expect([await s.cooling("C1"), await s.cooling("C1"), await s.cooling("C1"), await s.cooling("C1")]).toEqual([true, true, true, false]);
      await s.markCooldown("C1");
      c.advance(121_000);
      expect(await s.cooling("C1")).toBe(false);
    });

    test("sampling: a draw and a daily cap of 5", async () => {
      const c = clock();
      const s = mk(c)({ sampleEvery: () => 20, rng: () => 0 });
      const taken: boolean[] = [];
      for (let i = 0; i < 7; i++) taken.push(await s.sample("C1"));
      expect(taken).toEqual([true, true, true, true, true, false, false]);
      expect(await mk(c)({ sampleEvery: () => 20, rng: () => 0.5 }).sample("C9")).toBe(false);
      expect(await mk(c)({ sampleEvery: () => 0, rng: () => 0 }).sample("C9")).toBe(false);
    });
  });
}

describe("two instances over one fake Redis", () => {
  test("one claim, one budget, one pass memory", async () => {
    const c = clock();
    const r = fakeEngageRedis({ now: c.now });
    const a = redisEngageState(r, "t", { now: c.now, dailyBudget: () => 4, minuteCeiling: () => 10 });
    const b = redisEngageState(r, "t", { now: c.now, dailyBudget: () => 4, minuteCeiling: () => 10 });
    const claims = await Promise.all([a.claim("C1", "5.0"), b.claim("C1", "5.0")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect([await a.spend("C1"), await b.spend("C1"), await a.spend("C1"), await b.spend("C1"), await a.spend("C1")]).toEqual(["ok", "ok", "ok", "ok", "day"]);
    await a.markPass("C1", "7.0", "UA");
    expect(await b.passed("C1", "7.0", "UA")).toBe(true);
    await b.clearPass("C1", "7.0");
    expect(await a.passed("C1", "7.0", "UA")).toBe(false);
  });

  test("a Redis failure fails closed for the classifier and open for observation", async () => {
    let down = false;
    const r = fakeEngageRedis({ fail: () => down });
    const s = redisEngageState(r, "t", {});
    await s.markPass("C1", "7.0", "UA");
    down = true;
    expect(await s.claim("C1", "1.0")).toBe(false);
    expect(await s.spend("C1")).toBe("error");
    expect(await s.sample("C1")).toBe(false);
    expect(await s.passed("C1", "7.0", "UA")).toBe(false);
    expect(await s.cooling("C1")).toBe(false);
    await s.markPass("C1", "8.0", "UA");
    await s.clearPass("C1", "8.0");
  });
});

describe("circuit breaker", () => {
  test("three consecutive failures open it, a single probe goes through after the backoff, a success closes it", () => {
    const c = clock();
    const b = circuitBreaker({ now: c.now, baseMs: 1000, maxMs: 4000 });
    b.failure();
    b.failure();
    b.success();
    b.failure();
    b.failure();
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    expect(b.allow()).toBe(false);
    c.advance(1000);
    expect(b.state).toBe("half-open");
    expect([b.allow(), b.allow()]).toEqual([true, false]);
    b.failure();
    expect(b.state).toBe("open");
    c.advance(1999);
    expect(b.allow()).toBe(false);
    c.advance(1);
    expect(b.allow()).toBe(true);
    b.success();
    expect(b.state).toBe("closed");
    expect(b.allow()).toBe(true);
  });
  test("the backoff doubles up to its cap", () => {
    const c = clock();
    const b = circuitBreaker({ now: c.now, baseMs: 1000, maxMs: 3000 });
    for (let i = 0; i < 3; i++) b.failure();
    for (const wait of [1000, 2000, 3000, 3000]) {
      c.advance(wait - 1);
      expect(b.allow()).toBe(false);
      c.advance(1);
      expect(b.allow()).toBe(true);
      b.failure();
    }
  });
});
