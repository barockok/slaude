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

  });
}

describe("two instances over one fake Redis", () => {
  test("one claim, one budget", async () => {
    const c = clock();
    const r = fakeEngageRedis({ now: c.now });
    const a = redisEngageState(r, "t", { now: c.now, dailyBudget: () => 4, minuteCeiling: () => 10 });
    const b = redisEngageState(r, "t", { now: c.now, dailyBudget: () => 4, minuteCeiling: () => 10 });
    const claims = await Promise.all([a.claim("C1", "5.0", "ana"), b.claim("C1", "5.0", "ana")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect([await a.spend("C1"), await b.spend("C1"), await a.spend("C1"), await b.spend("C1"), await a.spend("C1")]).toEqual(["ok", "ok", "ok", "ok", "day"]);
  });

  test("a Redis failure fails closed", async () => {
    let down = false;
    const r = fakeEngageRedis({ fail: () => down });
    const s = redisEngageState(r, "t", {});
    down = true;
    expect(await s.claim("C1", "1.0", "ana")).toBe(false);
    expect(await s.spend("C1")).toBe("error");
    expect(await s.claimAct("C1", "1.0")).toBe(false);
    expect(await s.actSlot("C1", 5)).toBe("error");
  });
});

describe("atomic Redis operations", () => {
  test("every counter step is one eval, with the tenant in the key", async () => {
    const c = clock();
    const r = fakeEngageRedis({ now: c.now });
    const s = redisEngageState(r, "t", { now: c.now, dailyBudget: () => 50, minuteCeiling: () => 50 });
    await s.spend("C1", "T1");
    expect(r.evals).toBe(2); // the minute and the day counter, one script each
    expect([...r.data.keys()].some((k) => k.includes(":day:T1:C1:"))).toBe(true);
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
