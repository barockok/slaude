import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { createFirstSight, insideFirstSight, observeFromAudit, BURST_LIMIT, type FirstSightDeps } from "../../src/domain/first-sight";
import type { DomainEvent } from "../../src/db/domain";

const WS = "T0EXAMPLE";

/** A client that counts every statement sent through it (and through its transactions). */
function counting(inner: DbClient): { db: DbClient; n: () => number } {
  let n = 0;
  const wrap = (c: DbClient): DbClient =>
    new Proxy(c, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "transaction") return (fn: (tx: DbClient) => Promise<unknown>) => t.transaction((tx) => fn(wrap(tx)));
        if (typeof v === "function" && (k === "run" || k === "one" || k === "query")) {
          return (...a: unknown[]) => (n++, (v as (...x: unknown[]) => unknown).apply(t, a));
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return { db: wrap(inner), n: () => n };
}

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`first sight (${dialect})`, () => {
    let base: DbClient;
    beforeAll(async () => {
      base = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(base, { log: () => {} });
    });
    afterAll(async () => {
      await base.close();
    });
    beforeEach(async () => {
      for (const t of ["user_aliases", "bindings", "boundaries", "users"]) await base.run(`DELETE FROM ${t}`);
    });

    let emitted: DomainEvent[];
    let logs: string[];
    let summaries: number;
    let counter: ReturnType<typeof counting>;
    const make = (o: FirstSightDeps = {}) => {
      emitted = [];
      logs = [];
      summaries = 0;
      counter = counting(base);
      return createFirstSight({
        db: () => counter.db,
        role: () => "mono",
        emit: async (e) => void emitted.push(...e),
        summary: async () => void summaries++,
        log: (m) => void logs.push(m),
        ...o,
      });
    };
    const count = async (t: string) => Number((await base.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n);

    test("an unknown user is observed once: one user, one binding, audited", async () => {
      const fs = make();
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, base);
      expect(b).toMatchObject({ state: "observed", source: "first-sight" });
      expect(await count("users")).toBe(1);
      expect(await count("bindings")).toBe(1);
      expect(emitted.map((e) => e.action)).toEqual(["user.created", "binding.created"]);
    });

    test("repeated messages add no query", async () => {
      const fs = make();
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      const before = counter.n();
      expect(before).toBeGreaterThan(0);
      for (let i = 0; i < 100; i++) fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      expect(counter.n()).toBe(before);
      expect(emitted.length).toBe(2);
    });

    test("a refused actor is observed the same way (admission seam passes the user before the verdict)", async () => {
      const fs = make();
      fs.observeSlackUser({ teamId: WS, userId: "U1EXAMPLE" });
      fs.observeSlackChannel({ teamId: WS, channelId: "C0EXAMPLE" });
      fs.observeSlackChannel({ teamId: WS, channelId: "D0EXAMPLE" });
      await fs.flush();
      expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U1EXAMPLE" }, base))?.state).toBe("observed");
      expect((await Domain.findBoundary({ service: "slack", workspace: WS, value: "C0EXAMPLE" }, base))?.kind).toBe("channel");
      expect((await Domain.findBoundary({ service: "slack", workspace: WS, value: "D0EXAMPLE" }, base))?.kind).toBe("dm");
    });

    test("never throws and logs once per key when the write fails; failure is not cached", async () => {
      let fail = true;
      const bad = new Proxy(base, {
        get(t, k, r) {
          if (k === "transaction") return (fn: (tx: DbClient) => Promise<unknown>) => (fail ? Promise.reject(new Error("db down")) : t.transaction(fn));
          const v = Reflect.get(t, k, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const fs = make({ db: () => bad });
      expect(() => fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" })).not.toThrow();
      await fs.flush();
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      expect(logs.length).toBe(1);
      expect(await count("bindings")).toBe(0);
      fail = false;
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      expect(await count("bindings")).toBe(1);
    });

    test("a failing audit emit does not throw and the record stays", async () => {
      const fs = make({ emit: async () => Promise.reject(new Error("audit down")) });
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      expect(await count("bindings")).toBe(1);
    });

    test("node role does nothing", async () => {
      const fs = make({ role: () => "node" });
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      fs.observeSlackChannel({ teamId: WS, channelId: "C0EXAMPLE" });
      await fs.flush();
      expect(counter.n()).toBe(0);
      expect(await count("bindings")).toBe(0);
    });

    test("grid, bot, system and malformed ids are skipped; no empty workspace", async () => {
      const fs = make();
      for (const userId of ["W0EXAMPLE", "B0EXAMPLE", "USLACKBOT", "u0lower", ""]) fs.observeSlackUser({ teamId: WS, userId });
      fs.observeSlackUser({ teamId: "", userId: "U0EXAMPLE" });
      fs.observeSlackChannel({ teamId: "", channelId: "C0EXAMPLE" });
      fs.observeSlackChannel({ teamId: WS, channelId: "W0EXAMPLE" });
      await fs.flush();
      expect(counter.n()).toBe(0);
      expect(await count("bindings")).toBe(0);
      expect(await count("boundaries")).toBe(0);
    });

    test("a stronger state is never lowered and no account link is made", async () => {
      await base.run("INSERT INTO users (id, kind, display_name, created_at, updated_at) VALUES ('u-v', 'person', NULL, 1, 1)");
      await Domain.ensureBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE", state: "verified", source: "portal", userId: "u-v" }, base);
      const fs = make();
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U0EXAMPLE" }, base);
      expect(b).toMatchObject({ state: "verified", user_id: "u-v", source: "portal" });
      expect(await count("users")).toBe(1);
      expect(emitted).toEqual([]);
    });

    test("no recursion: nothing observes inside first sight's own audit write", async () => {
      let inside = false;
      let seen = 0;
      const fs = make({
        emit: async () => {
          inside = insideFirstSight();
          // What the audit seam does for the event it just wrote, and a direct call.
          observeFromAudit({ actorKind: "slack_user", actorId: "U9EXAMPLE", channelId: "C9EXAMPLE" });
          fs.observeSlackUser({ teamId: WS, userId: "U9EXAMPLE" });
          seen = counter.n();
        },
      });
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      expect(inside).toBe(true);
      expect(await Domain.findBinding({ service: "slack", kind: "user", workspace: WS, value: "U9EXAMPLE" }, base)).toBeNull();
      expect(counter.n()).toBe(seen);
      expect(insideFirstSight()).toBe(false);
    });

    test("two replicas racing yield one row", async () => {
      const a = make();
      const b = createFirstSight({ db: () => base, role: () => "mono", emit: async () => {}, log: () => {} });
      a.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      b.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      a.observeSlackChannel({ teamId: WS, channelId: "C0EXAMPLE" });
      b.observeSlackChannel({ teamId: WS, channelId: "C0EXAMPLE" });
      await Promise.all([a.flush(), b.flush()]);
      expect(await count("bindings")).toBe(1);
      expect(await count("users")).toBe(1);
      expect(await count("boundaries")).toBe(1);
    });

    test("a burst writes one summary instead of per-row events", async () => {
      const fs = make();
      for (let i = 0; i < BURST_LIMIT + 20; i++) fs.observeSlackUser({ teamId: WS, userId: `U${String(i).padStart(4, "0")}EXAMPLE` });
      await fs.flush();
      expect(await count("bindings")).toBe(BURST_LIMIT + 20);
      expect(emitted.length).toBe(BURST_LIMIT * 2);
      expect(summaries).toBe(1);
    });

    test("the LRU re-checks after 10 minutes", async () => {
      let t = 1_000_000;
      const fs = make({ now: () => t });
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      const n1 = counter.n();
      t += 11 * 60 * 1000;
      fs.observeSlackUser({ teamId: WS, userId: "U0EXAMPLE" });
      await fs.flush();
      expect(counter.n()).toBeGreaterThan(n1);
      expect(await count("bindings")).toBe(1);
    });
  });
}
