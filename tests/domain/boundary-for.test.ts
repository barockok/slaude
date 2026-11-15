import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as Domain from "../../src/db/domain";
import { db as globalDb } from "../../src/db/schema";
import { createBoundaryResolver, FAIL_BACKOFF_MS, locatorOf, NEG_TTL_MS, RECHECK_MS, LRU_CAP, boundaryForCached, resetBoundaryResolver } from "../../src/domain/boundary-for";
import { createFirstSight } from "../../src/domain/first-sight";
import { metrics } from "../../src/metrics";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";

/** Counts reads and writes that reach the client; `hold` makes reads hang or fail. */
function spy(inner: DbClient) {
  const s = { reads: 0, writes: 0, mode: "ok" as "ok" | "hang" | "fail" };
  const db = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k === "one" || k === "query") {
        return (...a: unknown[]) => {
          s.reads += 1;
          if (s.mode === "hang") return new Promise(() => {});
          if (s.mode === "fail") return Promise.reject(new Error("boom"));
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      if (k === "run" || k === "exec" || k === "transaction") {
        return (...a: unknown[]) => {
          s.writes += 1;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as DbClient;
  return { db, s };
}

const outcome = (o: string): number => {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_boundary_resolve_total") && l.includes(`outcome="${o}"`));
  return line ? Number(line.split(" ").pop()) : 0;
};

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`boundary resolver (${dialect})`, () => {
    let base: DbClient;
    beforeAll(async () => {
      base = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(base, { log: () => {} });
    });
    afterAll(async () => {
      await base.close();
    });
    beforeEach(async () => {
      await base.run("DELETE FROM boundaries");
    });
    const seed = async (team = WS, channel = CH): Promise<string> =>
      (await Domain.ensureBoundary({ service: "slack", workspace: team, value: channel, kind: "channel", state: "observed" }, base)).boundary.id;

    test("a miss answers unknown at once, warms the cache, and the next call hits", async () => {
      const id = await seed();
      const { db, s } = spy(base);
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway" });
      expect(r.cached(WS, CH)).toBeUndefined();
      expect(s.writes).toBe(0);
      await r.resolve(WS, CH); // joins the warm read already in flight
      expect(r.cached(WS, CH)).toEqual({ id });
      expect(s.reads).toBe(1);
      expect(r.cached(WS, CH)).toEqual({ id });
      expect(s.reads).toBe(1);
    });

    test("a known absence is null, expires after NEG_TTL_MS, and a positive entry lasts RECHECK_MS", async () => {
      let t = 1_000_000;
      const { db, s } = spy(base);
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway", now: () => t });
      expect(await r.resolve(WS, CH)).toBeNull();
      expect(r.cached(WS, CH)).toBeNull();
      t += NEG_TTL_MS - 1;
      expect(r.cached(WS, CH)).toBeNull();
      t += 2;
      expect(r.cached(WS, CH)).toBeUndefined(); // re-asks, and warms again
      expect(await r.resolve(WS, CH)).toBeNull(); // joins that warm read
      t += NEG_TTL_MS + 1;
      const id = await seed();
      await r.resolve(WS, CH);
      expect(r.cached(WS, CH)).toEqual({ id });
      t += RECHECK_MS - 1;
      expect(r.cached(WS, CH)).toEqual({ id });
      t += 2;
      expect(r.cached(WS, CH)).toBeUndefined();
      expect(s.reads).toBeGreaterThanOrEqual(3);
    });

    test("single flight: 50 concurrent resolves issue one query", async () => {
      const id = await seed();
      const { db, s } = spy(base);
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway" });
      const out = await Promise.all(Array.from({ length: 50 }, () => r.resolve(WS, CH)));
      expect(out.every((x) => x?.id === id)).toBe(true);
      expect(s.reads).toBe(1);
    });

    test("a read that outlasts the timeout resolves null, leaves the key unknown, counts, and is not retried during the backoff", async () => {
      let t = 1_000_000;
      const { db, s } = spy(base);
      s.mode = "hang";
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway", timeoutMs: () => 20, now: () => t });
      const before = outcome("timeout");
      const t0 = Date.now();
      expect(await r.resolve(WS, CH)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(500);
      expect(r.cached(WS, CH)).toBeUndefined(); // unknown, not absent, and no new read started
      expect(outcome("timeout")).toBeGreaterThan(before);
      expect(s.reads).toBe(1);
      for (let i = 0; i < 20; i++) await r.resolve(WS, CH);
      expect(s.reads).toBe(1); // backed off: a stalled database gets no SELECT per write
      // after the backoff the key is asked again
      t += FAIL_BACKOFF_MS + 1;
      s.mode = "ok";
      const id = await seed();
      expect((await r.resolve(WS, CH))?.id).toBe(id);
      expect(s.reads).toBe(2);
    });

    test("an error resolves null and is not cached as absent", async () => {
      const { db, s } = spy(base);
      s.mode = "fail";
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway" });
      const before = outcome("error");
      expect(await r.resolve(WS, CH)).toBeNull();
      expect(r.cached(WS, CH)).toBeUndefined();
      expect(outcome("error")).toBeGreaterThan(before);
      expect(s.reads).toBe(1);
      await r.resolve(WS, CH);
      expect(s.reads).toBe(1);
    });

    test("a node never touches a database", async () => {
      await seed();
      const { db, s } = spy(base);
      const r = createBoundaryResolver({ db: () => db, role: () => "node" });
      expect(r.cached(WS, CH)).toBeUndefined();
      expect(await r.resolve(WS, CH)).toBeNull();
      expect(s.reads + s.writes).toBe(0);
    });

    test("null team, empty team and a channel first sight never records are not queried", async () => {
      const { db, s } = spy(base);
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway" });
      for (const team of [null, undefined, ""]) {
        expect(r.cached(team, CH)).toBeNull();
        expect(await r.resolve(team, CH)).toBeNull();
      }
      for (const ch of ["", null, undefined, "cron:abc", "W0EXAMPLE", "channel:C0EXAMPLE", "c0lower"]) {
        expect(r.cached(WS, ch)).toBeNull();
        expect(await r.resolve(WS, ch)).toBeNull();
      }
      expect(s.reads + s.writes).toBe(0);
    });

    test("never inserts: an absent boundary stays absent", async () => {
      const { db, s } = spy(base);
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway" });
      expect(await r.resolve(WS, CH)).toBeNull();
      expect(s.writes).toBe(0);
      expect(Number((await base.one<{ n: number }>("SELECT COUNT(*) AS n FROM boundaries"))!.n)).toBe(0);
    });

    test("a team is part of the key: the same channel id in another workspace is another answer", async () => {
      const id = await seed(WS, CH);
      const r = createBoundaryResolver({ db: () => base, role: () => "gateway" });
      expect((await r.resolve(WS, CH))?.id).toBe(id);
      expect(await r.resolve("T0OTHER", CH)).toBeNull();
    });

    test("prime answers without a query, the switch turns the cached answer unknown, the cache is bounded", async () => {
      const { db, s } = spy(base);
      let on = true;
      const r = createBoundaryResolver({ db: () => db, role: () => "gateway", enabled: () => on });
      r.prime(WS, CH, "b-example");
      expect(r.cached(WS, CH)).toEqual({ id: "b-example" });
      expect(s.reads).toBe(0);
      on = false;
      expect(r.cached(WS, CH)).toBeUndefined();
      expect(s.reads).toBe(0);
      on = true;
      for (let i = 0; i < LRU_CAP + 10; i++) r.prime(WS, `C${String(i).padStart(8, "0")}`, `b${i}`);
      expect(r.cached(WS, "C00000000")).toBeUndefined(); // evicted
      expect(r.cached(WS, `C${String(LRU_CAP + 9).padStart(8, "0")}`)).toEqual({ id: `b${LRU_CAP + 9}` });
    });

    test("first sight primes after the commit, with the boundary's id", async () => {
      const primed: Array<[string, string, string]> = [];
      const fs = createFirstSight({ db: () => base, prime: (t, c, id) => primed.push([t, c, id]), emit: async () => {}, summary: async () => {} });
      fs.observeSlackChannel({ teamId: WS, channelId: "C0PRIMED" });
      await fs.flush();
      const row = await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0PRIMED" }, base);
      expect(primed).toEqual([[WS, "C0PRIMED", row!.id]]);
    });

    test("an injected database keeps its ids out of the shared cache", async () => {
      resetBoundaryResolver();
      const fs = createFirstSight({ db: () => base, emit: async () => {}, summary: async () => {} });
      fs.observeSlackChannel({ teamId: WS, channelId: "C0PRIMED" });
      await fs.flush();
      expect(boundaryForCached(WS, "C0PRIMED")).toBeUndefined();
      resetBoundaryResolver();
    });
  });
}

describe("locatorOf", () => {
  test("verbatim, empty is none", () => {
    expect(locatorOf("1700000000.000100")).toBe("1700000000.000100");
    expect(locatorOf("channel:C0EXAMPLE")).toBe("channel:C0EXAMPLE");
    expect(locatorOf("channel-archived:C0EXAMPLE:5")).toBe("channel-archived:C0EXAMPLE:5");
    expect(locatorOf("")).toBeNull();
    expect(locatorOf(null)).toBeNull();
    expect(locatorOf(undefined)).toBeNull();
  });
});

describe("first sight on the shared database primes the shared cache", () => {
  test("the id a session writer reads is the id first sight stored", async () => {
    resetBoundaryResolver();
    const fs = createFirstSight({ emit: async () => {}, summary: async () => {} });
    fs.observeSlackChannel({ teamId: WS, channelId: "C0SHARED" });
    await fs.flush();
    const row = await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0SHARED" }, globalDb);
    expect(row).not.toBeNull();
    expect(boundaryForCached(WS, "C0SHARED")).toEqual({ id: row!.id });
    await Domain._wipeForTests();
  });
});
