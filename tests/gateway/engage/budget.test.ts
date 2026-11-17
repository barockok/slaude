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
      expect(await s.claim("C1", "1.0", "ana")).toBe(true);
      expect(await s.claim("C1", "1.0", "ana")).toBe(false);
      expect(await s.claim("C1", "2.0", "ana")).toBe(true);
      expect(await s.claim("C2", "1.0", "ana")).toBe(true);
      // another persona on the same message has its own claim
      expect(await s.claim("C1", "1.0", "robin")).toBe(true);
      expect(await s.claim("C1", "1.0", "robin")).toBe(false);
    });

    test("the act claim has one owner per message, whatever the persona", async () => {
      const c = clock();
      const s = mk(c)({});
      expect(await s.claimAct("C1", "1.0")).toBe(true);
      expect(await s.claimAct("C1", "1.0")).toBe(false);
      expect(await s.claimAct("C1", "2.0")).toBe(true);
      expect(await s.claimAct("C2", "1.0")).toBe(true);
    });

    test("the acting cap is per channel per hour", async () => {
      const c = clock();
      const s = mk(c)({});
      expect([await s.actSlot("C1", 2), await s.actSlot("C1", 2), await s.actSlot("C1", 2)]).toEqual(["ok", "ok", "cap"]);
      expect(await s.actSlot("C2", 2)).toBe("ok");
      c.advance(3600_000);
      expect(await s.actSlot("C1", 2)).toBe("ok");
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
      expect(await s.passed("C1", "9.0", "ana", "UA")).toBe(false);
      await s.markPass("C1", "9.0", "ana", "UA");
      expect(await s.passed("C1", "9.0", "ana", "UA")).toBe(true);
      expect(await s.passed("C1", "9.0", "ana", "UB")).toBe(false);
      expect(await s.passed("C1", "9.0", "robin", "UA")).toBe(false); // another persona's memory is its own
      await s.clearPass("C1", "9.0", "ana");
      expect(await s.passed("C1", "9.0", "ana", "UA")).toBe(false);
      await s.markPass("C1", "9.0", "ana", "UA");
      c.advance(1801_000);
      expect(await s.passed("C1", "9.0", "ana", "UA")).toBe(false);
    });

    test("a root cooldown covers the next three candidates, or 120 seconds", async () => {
      const c = clock();
      const s = mk(c)({});
      expect(await s.cooling("C1", "ana")).toBe(false);
      await s.markCooldown("C1", "ana");
      expect([await s.cooling("C1", "ana"), await s.cooling("C1", "ana"), await s.cooling("C1", "ana"), await s.cooling("C1", "ana")]).toEqual([true, true, true, false]);
      await s.markCooldown("C1", "ana");
      expect(await s.cooling("C1", "robin")).toBe(false);
      c.advance(121_000);
      expect(await s.cooling("C1", "ana")).toBe(false);
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
    const claims = await Promise.all([a.claim("C1", "5.0", "ana"), b.claim("C1", "5.0", "ana")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect([await a.spend("C1"), await b.spend("C1"), await a.spend("C1"), await b.spend("C1"), await a.spend("C1")]).toEqual(["ok", "ok", "ok", "ok", "day"]);
    await a.markPass("C1", "7.0", "ana", "UA");
    expect(await b.passed("C1", "7.0", "ana", "UA")).toBe(true);
    await b.clearPass("C1", "7.0", "ana");
    expect(await a.passed("C1", "7.0", "ana", "UA")).toBe(false);
  });

  test("a Redis failure fails closed for the classifier and open for observation", async () => {
    let down = false;
    const r = fakeEngageRedis({ fail: () => down });
    const s = redisEngageState(r, "t", {});
    await s.markPass("C1", "7.0", "ana", "UA");
    down = true;
    expect(await s.claim("C1", "1.0", "ana")).toBe(false);
    expect(await s.spend("C1")).toBe("error");
    expect(await s.sample("C1")).toBe(false);
    expect(await s.passed("C1", "7.0", "ana", "UA")).toBe(false);
    expect(await s.cooling("C1", "ana")).toBe(false);
    await s.markPass("C1", "8.0", "ana", "UA");
    await s.clearPass("C1", "8.0", "ana");
  });
});

describe("atomic Redis operations", () => {
  test("every counter, pass and cooldown step is one eval, and the cooldown never goes below zero", async () => {
    const c = clock();
    const r = fakeEngageRedis({ now: c.now });
    const s = redisEngageState(r, "t", { now: c.now, dailyBudget: () => 50, minuteCeiling: () => 50 });
    await s.spend("C1", "T1");
    expect(r.evals).toBe(2); // the minute and the day counter, one script each
    expect([...r.data.keys()].some((k) => k.includes(":day:T1:C1:"))).toBe(true); // the tenant is in the key
    await s.markCooldown("C1", "ana");
    expect([await s.cooling("C1", "ana"), await s.cooling("C1", "ana"), await s.cooling("C1", "ana"), await s.cooling("C1", "ana"), await s.cooling("C1", "ana")]).toEqual([true, true, true, false, false]);
    expect([...r.data.keys()].some((k) => k.includes("cool:"))).toBe(false); // gone at zero, not recreated at -1
  });
  test("pass memory keeps the window of the first no, and expiry drops the whole set", async () => {
    const c = clock();
    const r = fakeEngageRedis({ now: c.now });
    const s = redisEngageState(r, "t", { now: c.now });
    await s.markPass("C1", "7.0", "ana", "UA");
    c.advance(1000_000);
    await s.markPass("C1", "7.0", "ana", "UB");
    expect(await s.passed("C1", "7.0", "ana", "UA")).toBe(true);
    c.advance(801_000); // 1801 s after the first add
    expect(await s.passed("C1", "7.0", "ana", "UB")).toBe(false);
  });
});

describe("circuit breaker", () => {
  test("three consecutive failures open it, a single probe goes through after the backoff, a success closes it", () => {
    const c = clock();
    const b = circuitBreaker({ now: c.now, baseMs: 1000, maxMs: 4000 });
    b.failure(b.allow()!);
    b.failure(b.allow()!);
    b.success(b.allow()!);
    b.failure(b.allow()!);
    b.failure(b.allow()!);
    const third = b.allow();
    expect(third).not.toBeNull();
    b.failure(third!);
    expect(b.state).toBe("open");
    expect(b.allow()).toBeNull();
    c.advance(1000);
    expect(b.state).toBe("half-open");
    const probe = b.allow();
    expect([probe !== null, b.allow() !== null]).toEqual([true, false]);
    b.failure(probe!);
    expect(b.state).toBe("open");
    c.advance(1999);
    expect(b.allow()).toBeNull();
    c.advance(1);
    const again = b.allow();
    expect(again).not.toBeNull();
    b.success(again!);
    expect(b.state).toBe("closed");
    expect(b.allow()).not.toBeNull();
  });
  test("the backoff doubles up to its cap", () => {
    const c = clock();
    const b = circuitBreaker({ now: c.now, baseMs: 1000, maxMs: 3000 });
    for (let i = 0; i < 3; i++) b.failure(b.allow()!);
    for (const wait of [1000, 2000, 3000, 3000]) {
      c.advance(wait - 1);
      expect(b.allow()).toBeNull();
      c.advance(1);
      const t = b.allow();
      expect(t).not.toBeNull();
      b.failure(t!);
    }
  });
  test("late results from calls started before the state changed are ignored", () => {
    const c = clock();
    const b = circuitBreaker({ now: c.now, baseMs: 1000, maxMs: 8000 });
    // five calls in flight at once, all later timing out
    const flight = [1, 2, 3, 4, 5].map(() => b.allow()!);
    flight.forEach((t) => b.failure(t));
    expect(b.state).toBe("open"); // the third opened it; the fourth and fifth were stale
    c.advance(1000); // base backoff, not doubled by the stale failures
    expect(b.state).toBe("half-open");
    const probe = b.allow()!;
    // a stale failure or release arriving while the probe is out neither doubles the backoff nor frees the slot
    b.failure(flight[0]!);
    b.release(flight[1]!);
    expect(b.allow()).toBeNull();
    b.success(probe);
    expect(b.state).toBe("closed");
    // a stale success after a close does not reset a newer failure streak
    const t1 = b.allow()!;
    b.success(flight[2]!);
    b.failure(t1);
    b.failure(b.allow()!);
    b.failure(b.allow()!);
    expect(b.state).toBe("open");
  });
});
