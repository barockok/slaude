import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as Domain from "../../src/db/domain";
import { BOUNDARY_FILL_LOCK_KEY, boundaryFillTick, fillBoundaryColumns, loadWorkspaces, resetBoundaryFillCursors, startBoundaryFill, totalFilled, type Place } from "../../src/domain/boundary-backfill";
import { reconcile } from "../../src/domain/reconcile";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";
const ONE: Place = () => ({ ws: WS });

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`boundary fill (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });
    const TABLES = ["sessions", "one_on_one_locks", "mention_only_threads", "ignores", "cron_jobs", "commitments", "env_bindings", "proactive_posts", "channel_wake_state", "boundaries"];
    beforeEach(async () => {
      for (const t of TABLES) await db.run(`DELETE FROM ${t}`);
      resetBoundaryFillCursors();
    });

    const hasTenant = async (t: string) =>
      dialect === "pg" && Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = ? AND column_name = 'tenant_id'", [t]))!.n) > 0;
    const insert = async (table: string, row: Record<string, unknown>) => {
      const r = { ...row };
      if (await hasTenant(table)) r.tenant_id = "default";
      const names = Object.keys(r);
      await db.run(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => r[n]) as never);
    };
    const session = (id: string, team: string | null, channel: string, thread: string | null) =>
      insert("sessions", { id, created_at: 1, updated_at: 1, model: "m", working_dir: "/w", slack_team_id: team, slack_channel_id: channel, slack_thread_ts: thread });
    const boundary = async (channel = CH, team = WS) =>
      (await Domain.ensureBoundary({ service: "slack", workspace: team, value: channel, kind: "channel", state: "observed" }, db)).boundary.id;
    const sess = () => db.query<{ id: string; boundary_id: string | null; locator: string | null }>("SELECT id, boundary_id, locator FROM sessions ORDER BY id");
    const none = () => {};

    test("fills the pair from the row's own team, then a second run fills nothing", async () => {
      const b = await boundary();
      await session("s1", WS, CH, "1.1");
      await session("s2", WS, CH, `channel:${CH}`);
      const r1 = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none });
      expect(r1.sessions!.filled).toBe(2);
      expect(await sess()).toEqual([
        { id: "s1", boundary_id: b, locator: "1.1" },
        { id: "s2", boundary_id: b, locator: `channel:${CH}` },
      ]);
      const r2 = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none });
      expect(totalFilled(r2)).toBe(0);
      expect(r2.sessions!.existing).toBe(2);
    });

    test("paged: a page of 2 over 7 rows fills all 7", async () => {
      const b = await boundary();
      for (let i = 0; i < 7; i++) await session(`s${i}`, WS, CH, `${i}.1`);
      const r = await fillBoundaryColumns(db, { maxRows: 100, pageSize: 2, place: ONE, handOff: none, tables: ["sessions"] });
      expect(r.sessions!.filled).toBe(7);
      expect((await sess()).every((x) => x.boundary_id === b)).toBe(true);
    });

    test("the per-run cap holds and the next run continues", async () => {
      await boundary();
      for (let i = 0; i < 7; i++) await session(`s${i}`, WS, CH, `${i}.1`);
      expect(totalFilled(await fillBoundaryColumns(db, { maxRows: 3, pageSize: 2, place: ONE, handOff: none }))).toBe(3);
      expect((await sess()).filter((x) => x.boundary_id).length).toBe(3);
      expect(totalFilled(await fillBoundaryColumns(db, { maxRows: 3, pageSize: 2, place: ONE, handOff: none }))).toBe(3);
      expect(totalFilled(await fillBoundaryColumns(db, { maxRows: 3, pageSize: 2, place: ONE, handOff: none }))).toBe(1);
    });

    test("a dry run writes nothing and reports what it would fill", async () => {
      await boundary();
      await session("s1", WS, CH, "1.1");
      const r = await fillBoundaryColumns(db, { dryRun: true, maxRows: 100, place: ONE, handOff: () => { throw new Error("no hand off in a dry run"); } });
      expect(r.sessions!.filled).toBe(1);
      expect((await sess())[0]!.boundary_id).toBeNull();
    });

    test("never repoints a filled row's boundary (only a stale locator is repaired)", async () => {
      await boundary();
      await session("s1", WS, CH, "1.1");
      await db.run("UPDATE sessions SET boundary_id = 'b-other', locator = '1.1'");
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none });
      expect(r.sessions).toMatchObject({ filled: 0, repaired: 0 });
      expect((await sess())[0]).toEqual({ id: "s1", boundary_id: "b-other", locator: "1.1" });
    });

    test("repair: a thread key rewritten by an rc.21 writer or a rollback gets its locator recomputed, the boundary untouched", async () => {
      const b = await boundary();
      await session("s1", WS, CH, `channel:${CH}`, );
      await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none });
      // an rc.21 /new writes only the thread column
      await db.run("UPDATE sessions SET slack_thread_ts = 'channel-archived:C0EXAMPLE:5'");
      await session("s2", WS, CH, `channel:${CH}`);
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none });
      expect(r.sessions).toMatchObject({ repaired: 1, filled: 1 });
      expect(await sess()).toEqual([
        { id: "s1", boundary_id: b, locator: "channel-archived:C0EXAMPLE:5" },
        { id: "s2", boundary_id: b, locator: `channel:${CH}` },
      ]);
      expect(totalFilled(await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none }))).toBe(0);
      expect((await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none })).sessions!.repaired).toBe(0);
      // a dry run reports without writing
      await db.run("UPDATE sessions SET slack_thread_ts = 'x.1' WHERE id = 's2'");
      expect((await fillBoundaryColumns(db, { dryRun: true, maxRows: 100, place: ONE, handOff: none })).sessions!.repaired).toBe(1);
      expect((await sess())[1]!.locator).toBe(`channel:${CH}`);
    });

    test("a /new between the scan and the write cannot leave a stale locator (the statement reads the thread column itself)", async () => {
      const b = await boundary();
      await session("s1", WS, CH, `channel:${CH}`);
      let armed = true;
      const racing = new Proxy(db, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r);
          if (k === "query") {
            return async (sql: string, ...a: unknown[]) => {
              const rows = await (v as (...x: unknown[]) => Promise<unknown>).call(t, sql, ...a);
              if (armed && /FROM sessions/.test(sql) && /boundary_id IS NULL/.test(sql)) {
                armed = false;
                await db.run("UPDATE sessions SET slack_thread_ts = 'channel-archived:C0EXAMPLE:9' WHERE id = 's1'");
              }
              return rows;
            };
          }
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as DbClient;
      await fillBoundaryColumns(racing, { maxRows: 100, place: ONE, handOff: none, tables: ["sessions"] });
      expect((await sess())[0]).toEqual({ id: "s1", boundary_id: b, locator: "channel-archived:C0EXAMPLE:9" });
    });

    test("a row whose channel changes between the scan and the write is not filled with the old channel's boundary", async () => {
      await boundary();
      await session("s1", WS, CH, "1.1");
      let armed = true;
      const racing = new Proxy(db, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r);
          if (k === "query") {
            return async (sql: string, ...a: unknown[]) => {
              const rows = await (v as (...x: unknown[]) => Promise<unknown>).call(t, sql, ...a);
              if (armed && /FROM sessions/.test(sql) && /boundary_id IS NULL/.test(sql)) {
                armed = false;
                await db.run("UPDATE sessions SET slack_channel_id = 'C0MOVED' WHERE id = 's1'");
              }
              return rows;
            };
          }
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as DbClient;
      await fillBoundaryColumns(racing, { maxRows: 100, place: ONE, handOff: none, tables: ["sessions"] });
      expect((await sess())[0]!.boundary_id).toBeNull();
    });

    test("no page transaction and no multi-row statement: each row is its own statement", async () => {
      await boundary();
      for (let i = 0; i < 5; i++) await session(`s${i}`, WS, CH, `${i}.1`);
      let txs = 0;
      const updates: string[] = [];
      const spy = new Proxy(db, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r);
          if (k === "transaction") return (...a: unknown[]) => (txs++, (v as (...x: unknown[]) => unknown).apply(t, a));
          if (k === "run") return (sql: string, ...a: unknown[]) => (updates.push(sql), (v as (...x: unknown[]) => unknown).call(t, sql, ...a));
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as DbClient;
      await fillBoundaryColumns(spy, { maxRows: 100, place: ONE, handOff: none, tables: ["sessions"] });
      expect(txs).toBe(0);
      expect(updates.filter((u) => /^UPDATE/.test(u.trim()))).toHaveLength(5);
      expect(updates.every((u) => /WHERE id = \?/.test(u))).toBe(true);
    });

    test("a team-less row is never handed to first sight and never fabricates a boundary; with the boundary present it is filled", async () => {
      await session("n1", null, CH, "1.1");
      const handed: string[] = [];
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: (t, c) => handed.push(`${t}/${c}`), tables: ["sessions"] });
      expect(r.sessions).toMatchObject({ filled: 0, team_unknown: 1, no_boundary: 0, handed_to_first_sight: 0 });
      expect(handed).toEqual([]);
      const b = await boundary();
      await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none, tables: ["sessions"] });
      expect((await sess())[0]!.boundary_id).toBe(b);
    });

    test("the scan budget and the cursor: a capped tick resumes where it stopped and wraps after a full pass", async () => {
      for (let i = 0; i < 6; i++) await session(`s${i}`, WS, `C0STUCK${i}`, "1.1"); // channels with no boundary: never fillable
      await boundary();
      await session("zz", WS, CH, "1.1"); // sorts last
      const cursors = new Map<string, unknown[]>();
      const seen: number[] = [];
      const cursor: unknown[] = [];
      for (let tick = 0; tick < 4; tick++) {
        await fillBoundaryColumns(db, { maxRows: 100, maxExamine: 3, pageSize: 3, cursors, place: ONE, handOff: none, tables: ["sessions"], counts: false });
        seen.push((await sess()).filter((x) => x.boundary_id).length);
        cursor.push(cursors.get("sessions:fill")?.[0]);
      }
      expect(seen[0]).toBe(0); // the first tick did not look at everything
      expect(cursor[0]).toBe("s2"); // and remembers where it stopped
      expect(seen[2]).toBe(1); // the third reached the last row
      expect(cursor[2]).toBeUndefined(); // a full pass: wrapped
      expect(cursor[3]).toBe("s2"); // the next pass starts over
    });

    test("the tick runs no COUNT scan", async () => {
      await boundary();
      await session("s1", WS, CH, "1.1");
      const seen: string[] = [];
      const spy = new Proxy(db, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r);
          if (k === "query" || k === "one") return (sql: string, ...a: unknown[]) => (seen.push(sql), (v as (...x: unknown[]) => unknown).call(t, sql, ...a));
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as DbClient;
      await boundaryFillTick({ db: spy, role: () => "gateway", liveTeamIds: () => [WS], handOff: none });
      expect(seen.filter((q) => /COUNT\(\*\)/i.test(q) && !/information_schema/.test(q))).toEqual([]);
    });

    test("stop waits for the tick in flight and starts nothing after it", async () => {
      await boundary();
      await session("s1", WS, CH, "1.1");
      const stop = startBoundaryFill({ db, role: () => "gateway", liveTeamIds: () => [WS], intervalMs: 5, handOff: none });
      await new Promise((r) => setTimeout(r, 40));
      await stop();
      expect((await sess())[0]!.boundary_id).not.toBeNull();
      await db.run("UPDATE sessions SET boundary_id = NULL, locator = NULL");
      await new Promise((r) => setTimeout(r, 40));
      expect((await sess())[0]!.boundary_id).toBeNull(); // no tick after stop
      const never = startBoundaryFill({ db, role: () => "node", intervalMs: 5 });
      await never();
    });

    test("a failing boundary stage cannot abort the reconcile or lose its report", async () => {
      await session("s1", WS, CH, "1.1");
      const r = await reconcile({ db, liveTeamIds: () => [WS], audit: async () => {}, log: () => {}, boundaryFill: async () => { throw new Error("boom"); } });
      expect(r.sources.sessionChannels).toBeDefined();
      expect(r.boundaryColumns).toEqual({});
      expect(r.finishedAt).toBeGreaterThanOrEqual(r.startedAt);
    });

    test("ineligible channels, ambiguous and unplaced rows are classed and never written; workspace '' is never used", async () => {
      await boundary();
      await session("i1", WS, "cron:abc", "1.1");
      await session("i2", WS, "W0EXAMPLE", "1.1");
      await session("n1", null, CH, "1.1");
      await session("e1", "", CH, "1.1");
      await session("t1", WS, CH, null);
      const amb: Place = () => ({ reason: "ambiguous" });
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: amb, handOff: none, tables: ["sessions"] });
      expect(r.sessions).toMatchObject({ filled: 0, ineligible: 2, ambiguous: 2, no_locator: 1 });
      const nowhere: Place = () => ({ reason: "no_workspace" });
      const r2 = await fillBoundaryColumns(db, { maxRows: 100, place: nowhere, handOff: none, tables: ["sessions"] });
      expect(r2.sessions).toMatchObject({ filled: 0, no_workspace: 2 });
      expect((await sess()).every((x) => x.boundary_id === null)).toBe(true);
      expect(Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM boundaries WHERE workspace = ''"))!.n)).toBe(0);
    });

    test("a team-less row is placed only in a single workspace", async () => {
      const b = await boundary();
      await session("n1", null, CH, "1.1");
      const app = (id: string, team: string) => db.run("INSERT INTO slack_apps (api_app_id, team_id, tenant_id, bot_token, signing_secret, created_at, updated_at) VALUES (?, ?, 'default', 'x', 'y', 1, 1)", [id, team]);
      if (dialect === "pg") await app("A0", WS);
      const place = await loadWorkspaces(db, () => [WS]);
      await fillBoundaryColumns(db, { maxRows: 100, place, handOff: none, tables: ["sessions"] });
      expect((await sess())[0]!.boundary_id).toBe(b);
      await db.run("UPDATE sessions SET boundary_id = NULL, locator = NULL");
      if (dialect === "pg") await app("A1", "T0OTHER");
      const two = await loadWorkspaces(db, () => [WS, "T0OTHER"]);
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: two, handOff: none, tables: ["sessions"] });
      expect(r.sessions).toMatchObject({ filled: 0, ambiguous: 1 });
      if (dialect === "pg") await db.run("DELETE FROM slack_apps");
    });

    test("a missing boundary is never created: the channel is handed to first sight once, and the next run fills", async () => {
      await session("s1", WS, CH, "1.1");
      await session("s2", WS, CH, "2.2");
      const handed: string[] = [];
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: (t, c) => handed.push(`${t}/${c}`), tables: ["sessions"] });
      expect(r.sessions).toMatchObject({ filled: 0, no_boundary: 2, handed_to_first_sight: 1 });
      expect(handed).toEqual([`${WS}/${CH}`]);
      expect(Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM boundaries"))!.n)).toBe(0);
      const b = await boundary(); // first sight did its part
      expect((await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none, tables: ["sessions"] })).sessions!.filled).toBe(2);
      expect((await sess()).every((x) => x.boundary_id === b)).toBe(true);
    });

    test("every table is filled, the cron rule picks the session key, and the legacy delivery pair is not the locator", async () => {
      const b = await boundary();
      await insert("one_on_one_locks", { channel_id: CH, thread_ts: "1.1", locked_user: "U0EXAMPLE", created_by: "U0EXAMPLE", created_at: 1, team_id: WS });
      await insert("mention_only_threads", { channel_id: CH, thread_ts: "2.2", created_by: "U0EXAMPLE", created_at: 1 });
      await insert("ignores", { id: "i1", target_type: "thread", channel_id: CH, thread_ts: "3.3", created_by: "U0EXAMPLE", created_at: 1 });
      await insert("ignores", { id: "i2", target_type: "user", user_id: "U0EXAMPLE", created_by: "U0EXAMPLE", created_at: 1 });
      const cron = (id: string, target: string, thread: string | null) =>
        insert("cron_jobs", { id, slack_team_id: WS, slack_channel_id: CH, slack_thread_ts: thread, channel_id: CH, thread_ts: "9.9", created_by: "U0EXAMPLE", cron_expr: "* * * * *", prompt: "p", next_run_at: 1, target });
      await cron("j-thread", "thread", "4.4");
      await cron("j-chan", "channel", "4.4");
      await cron("j-null", "thread", null);
      await insert("commitments", { agent_id: "a", source: "s", slug: "x", team_id: WS, channel_id: CH, thread_ts: "5.5", beneficiary: "U0EXAMPLE", due_text: "d", due_kind: "time", next_check_at: 1, expires_at: 2, created_at: 1 });
      await insert("env_bindings", { channel_id: CH, thread_ts: "6.6", env_id: "e", dir: "/d", last_used_at: 1, created_at: 1 });
      await insert("proactive_posts", { id: "p1", agent_id: "a", audience: "person", recipient: "U0EXAMPLE", topic: "t", text_hash: "h", channel_id: CH, team_id: WS, posted_at: 1 });
      await insert("channel_wake_state", { agent_id: "a", channel_id: CH, updated_at: 1 });
      await session("s1", WS, CH, "7.7");
      const r = await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none });
      expect(totalFilled(r)).toBe(11);
      const one = async (sql: string) => db.one<Record<string, unknown>>(sql);
      expect(await one("SELECT boundary_id, locator FROM one_on_one_locks")).toEqual({ boundary_id: b, locator: "1.1" });
      expect(await one("SELECT boundary_id, locator FROM mention_only_threads")).toEqual({ boundary_id: b, locator: "2.2" });
      expect(await one("SELECT boundary_id, locator FROM ignores WHERE id = 'i1'")).toEqual({ boundary_id: b, locator: "3.3" });
      expect(await one("SELECT boundary_id, locator FROM ignores WHERE id = 'i2'")).toEqual({ boundary_id: null, locator: null });
      expect(await one("SELECT locator FROM cron_jobs WHERE id = 'j-thread'")).toEqual({ locator: "4.4" });
      expect(await one("SELECT locator FROM cron_jobs WHERE id = 'j-chan'")).toEqual({ locator: "cron:j-chan" });
      expect(await one("SELECT locator FROM cron_jobs WHERE id = 'j-null'")).toEqual({ locator: "cron:j-null" });
      expect(await one("SELECT boundary_id, locator FROM commitments")).toEqual({ boundary_id: b, locator: "5.5" });
      expect(await one("SELECT boundary_id, locator FROM env_bindings")).toEqual({ boundary_id: b, locator: "6.6" });
      expect((await one("SELECT boundary_id FROM proactive_posts"))!.boundary_id).toBe(b);
      expect((await one("SELECT boundary_id FROM channel_wake_state"))!.boundary_id).toBe(b);
      expect(await one("SELECT boundary_id, locator FROM sessions")).toEqual({ boundary_id: b, locator: "7.7" });
    });

    test("an archived channel session without a boundary gets its archived key as the locator", async () => {
      const b = await boundary();
      await session("s1", WS, CH, `channel-archived:${CH}:42`);
      await fillBoundaryColumns(db, { maxRows: 100, place: ONE, handOff: none, tables: ["sessions"] });
      expect((await sess())[0]).toEqual({ id: "s1", boundary_id: b, locator: `channel-archived:${CH}:42` });
    });

    test("two concurrent runners and a live writer end consistent, with every row filled once", async () => {
      const b = await boundary();
      for (let i = 0; i < 20; i++) await session(`s${String(i).padStart(2, "0")}`, WS, CH, `${i}.1`);
      const writer = (async () => {
        await db.run("UPDATE sessions SET boundary_id = ?, locator = slack_thread_ts WHERE id = 's05'", [b]);
      })();
      const [a, c] = await Promise.all([
        fillBoundaryColumns(db, { maxRows: 100, pageSize: 3, place: ONE, handOff: none, tables: ["sessions"] }),
        fillBoundaryColumns(db, { maxRows: 100, pageSize: 3, place: ONE, handOff: none, tables: ["sessions"] }),
        writer,
      ]).then((x) => [x[0], x[1]] as const);
      expect(a.sessions!.filled + c.sessions!.filled).toBe(19);
      const all = await sess();
      expect(all.every((x) => x.boundary_id === b && x.locator !== null)).toBe(true);
    });

    test("audit_events is never queried", async () => {
      await boundary();
      await session("s1", WS, CH, "1.1");
      const seen: string[] = [];
      const spy = new Proxy(db, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r);
          if (k === "transaction") return (fn: (tx: DbClient) => Promise<unknown>) => t.transaction((tx) => fn(wrap(tx)));
          if (k === "query" || k === "one" || k === "run") return (sql: string, ...a: unknown[]) => (seen.push(sql), (v as (...x: unknown[]) => unknown).call(t, sql, ...a));
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as DbClient;
      const wrap = (c: DbClient): DbClient =>
        new Proxy(c, {
          get(t, k, r) {
            const v = Reflect.get(t, k, r);
            if (k === "query" || k === "one" || k === "run") return (sql: string, ...a: unknown[]) => (seen.push(sql), (v as (...x: unknown[]) => unknown).call(t, sql, ...a));
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      await fillBoundaryColumns(spy, { maxRows: 100, place: ONE, handOff: none });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => /audit_events/.test(s))).toEqual([]);
    });

    test("the periodic tick: a node and the kill switch do nothing; a normal tick fills", async () => {
      const b = await boundary();
      await session("s1", WS, CH, "1.1");
      expect(await boundaryFillTick({ db, role: () => "node", liveTeamIds: () => [WS] })).toBeNull();
      process.env.SLAUDE_BOUNDARY_WRITE = "off";
      expect(await boundaryFillTick({ db, role: () => "gateway", liveTeamIds: () => [WS] })).toBeNull();
      delete process.env.SLAUDE_BOUNDARY_WRITE;
      expect((await sess())[0]!.boundary_id).toBeNull();
      const r = await boundaryFillTick({ db, role: () => "gateway", liveTeamIds: () => [WS], handOff: none });
      expect(r!.sessions!.filled).toBe(1);
      expect((await sess())[0]!.boundary_id).toBe(b);
    });

    test("the tick respects SLAUDE_BOUNDARY_FILL_MAX_ROWS", async () => {
      await boundary();
      for (let i = 0; i < 5; i++) await session(`s${i}`, WS, CH, `${i}.1`);
      process.env.SLAUDE_BOUNDARY_FILL_MAX_ROWS = "2";
      try {
        const r = await boundaryFillTick({ db, role: () => "gateway", liveTeamIds: () => [WS], handOff: none });
        expect(totalFilled(r!)).toBe(2);
      } finally {
        delete process.env.SLAUDE_BOUNDARY_FILL_MAX_ROWS;
      }
    });

    test("reconciler stage 7: a dry run reports, a real run fills, a rerun is quiet", async () => {
      const b = await boundary();
      await session("s1", WS, CH, "1.1");
      const opts = { db, liveTeamIds: () => [WS], boundaryHandOff: none, audit: async () => {} };
      const dry = await reconcile({ ...opts, dryRun: true });
      expect(dry.boundaryColumns.sessions!.filled).toBe(1);
      expect((await sess())[0]!.boundary_id).toBeNull();
      const real = await reconcile(opts);
      expect(real.boundaryColumns.sessions!.filled).toBe(1);
      expect((await sess())[0]).toEqual({ id: "s1", boundary_id: b, locator: "1.1" });
      expect((await reconcile(opts)).boundaryColumns.sessions!.filled).toBe(0);
    });
  });
}

test("the fill lock key is distinct from the reconciler's and the migrator's", async () => {
  const { RECONCILE_LOCK_KEY } = await import("../../src/domain/reconcile");
  const { MIGRATE_LOCK_KEY } = await import("../../src/db/migrate");
  expect(BOUNDARY_FILL_LOCK_KEY).not.toEqual(RECONCILE_LOCK_KEY);
  expect(BOUNDARY_FILL_LOCK_KEY).not.toEqual(MIGRATE_LOCK_KEY);
});
