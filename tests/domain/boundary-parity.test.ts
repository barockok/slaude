import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { main } from "../../src/cli/domain";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as Domain from "../../src/db/domain";
import { mask, boundaryParity, formatParity, type ParityReport } from "../../src/domain/boundary-parity";
import type { Place } from "../../src/domain/boundary-backfill";

const WS = "T0EXAMPLE";
const CH = "C0EXAMPLE";
const ONE: Place = () => ({ ws: WS });
const NOW = 10_000_000;

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`boundary parity (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });
    beforeEach(async () => {
      for (const t of ["sessions", "one_on_one_locks", "cron_jobs", "boundaries"]) await db.run(`DELETE FROM ${t}`);
    });
    const tenant = async (t: string) =>
      dialect === "pg" && Number((await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_name = ? AND column_name = 'tenant_id'", [t]))!.n) > 0;
    const ins = async (table: string, row: Record<string, unknown>) => {
      const r = { ...row };
      if (await tenant(table)) r.tenant_id = "default";
      const n = Object.keys(r);
      await db.run(`INSERT INTO ${table} (${n.join(", ")}) VALUES (${n.map(() => "?").join(", ")})`, n.map((k) => r[k]) as never);
    };
    const session = (id: string, over: Record<string, unknown> = {}) =>
      ins("sessions", { id, created_at: 1, updated_at: 1, model: "m", working_dir: "/w", slack_team_id: WS, slack_channel_id: CH, slack_thread_ts: id, ...over });
    const bnd = async (ch = CH) => (await Domain.ensureBoundary({ service: "slack", workspace: WS, value: ch, kind: "channel", state: "observed" }, db)).boundary.id;
    const run = (o: { table?: string } = {}) => boundaryParity(db, { place: ONE, now: () => NOW, ...o });
    const t = (r: ParityReport, name = "sessions") => r.tables.find((x) => x.table === name)!;

    test("a clean database is ok", async () => {
      const b = await bnd();
      await session("1.1", { boundary_id: b, locator: "1.1" });
      const r = await run();
      expect(r.ok).toBe(true);
      expect(t(r)).toMatchObject({ filled: 1, nullOld: 0, mismatch: 0, locatorMismatch: 0, duplicates: 0 });
    });

    test("the gate: NULL older than 10 minutes counts, young rows, ineligible channels and unresolvable teams do not", async () => {
      await bnd();
      await session("old", { created_at: NOW - 11 * 60_000 });
      await session("young", { created_at: NOW - 60_000 });
      await session("inel", { created_at: 1, slack_channel_id: "cron:abc" });
      const none: Place = () => ({ reason: "ambiguous" });
      await session("noteam", { created_at: 1, slack_team_id: null });
      const r = await boundaryParity(db, { place: none, now: () => NOW, table: "sessions" });
      expect(t(r)).toMatchObject({ nullOld: 1, nullYoung: 1, ineligible: 1, unresolvable: 1 });
      expect(r.ok).toBe(false);
      expect(t(r).samples).toEqual([{ kind: "null_old", row: mask("old") && "***" }]);
    });

    test("a wrong boundary, a missing boundary and a wrong locator are caught; a team-less filled row is not judged", async () => {
      const b = await bnd();
      await session("a", { boundary_id: "b-wrong", locator: "a" });
      await session("b", { boundary_id: b, locator: "other" });
      await session("c", { boundary_id: b, locator: "c", slack_team_id: null });
      const several: Place = () => ({ reason: "ambiguous" });
      const r = await boundaryParity(db, { place: several, now: () => NOW, table: "sessions" });
      expect(t(r)).toMatchObject({ filled: 3, mismatch: 1, locatorMismatch: 1, unverifiable: 1 });
      expect(r.ok).toBe(false);
    });

    test("duplicate (boundary_id, locator, persona_id) groups are counted, personas apart are not", async () => {
      const b = await bnd();
      await session("x1", { boundary_id: b, locator: "same", slack_thread_ts: "same", persona_id: "p1" });
      await session("x2", { boundary_id: b, locator: "same", slack_thread_ts: "same2", persona_id: "p1" });
      await session("x3", { boundary_id: b, locator: "same", slack_thread_ts: "same3", persona_id: "p2" });
      expect(t(await run({ table: "sessions" })).duplicates).toBe(1);
    });

    test("cron rule and the CT tables are recomputed", async () => {
      const b = await bnd();
      await ins("cron_jobs", { id: "j1", slack_team_id: WS, slack_channel_id: CH, slack_thread_ts: "4.4", channel_id: CH, thread_ts: "9.9", created_by: "U0EXAMPLE", cron_expr: "* * * * *", prompt: "p", next_run_at: 1, target: "channel", boundary_id: b, locator: "cron:j1" });
      await ins("cron_jobs", { id: "j2", slack_team_id: WS, slack_channel_id: CH, slack_thread_ts: "4.4", channel_id: CH, thread_ts: "9.9", created_by: "U0EXAMPLE", cron_expr: "* * * * *", prompt: "p", next_run_at: 1, target: "thread", boundary_id: b, locator: "9.9" });
      await ins("one_on_one_locks", { channel_id: CH, thread_ts: "1.1", locked_user: "U0EXAMPLE", created_by: "U0EXAMPLE", created_at: 1, team_id: WS, boundary_id: b, locator: "1.1" });
      const r = await run();
      expect(t(r, "cron_jobs")).toMatchObject({ filled: 2, locatorMismatch: 1 });
      expect(t(r, "one_on_one_locks")).toMatchObject({ filled: 1, mismatch: 0, duplicates: 0 });
    });

    test("it is read only and never touches audit_events", async () => {
      const b = await bnd();
      await session("1.1", { boundary_id: b, locator: "1.1" });
      const seen: string[] = [];
      const spy = new Proxy(db, {
        get(tg, k, rc) {
          const v = Reflect.get(tg, k, rc);
          if (k === "query" || k === "one" || k === "run" || k === "exec") return (sql: string, ...a: unknown[]) => (seen.push(sql), (v as (...x: unknown[]) => unknown).call(tg, sql, ...a));
          return typeof v === "function" ? v.bind(tg) : v;
        },
      }) as DbClient;
      await boundaryParity(spy, { place: ONE, now: () => NOW });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => /audit_events|\b(INSERT|UPDATE|DELETE)\b/i.test(s))).toEqual([]);
    });

    test("an unknown table is refused", async () => {
      await expect(run({ table: "nope" })).rejects.toThrow(/unknown table/);
    });

    test("paging gives the same answer with a page of 2", async () => {
      const b = await bnd();
      for (let i = 0; i < 7; i++) await session(`s${i}`, { boundary_id: b, locator: `s${i}` });
      expect(t(await boundaryParity(db, { place: ONE, now: () => NOW, pageSize: 2, table: "sessions" })).filled).toBe(7);
    });
  });
}

describe("masking and the CLI", () => {
  test("mask hides the middle", () => {
    expect(mask("C0EXAMPLE")).toBe("C0E***LE");
    expect(mask("abc")).toBe("***");
  });

  const rep = (ok: boolean): ParityReport => ({ ok, checkedAt: 1, tables: [{ table: "sessions", filled: 1, nullOld: ok ? 0 : 2, nullYoung: 0, ineligible: 0, unresolvable: 0, unverifiable: 0, mismatch: 0, locatorMismatch: 0, duplicates: 0, samples: [] }] });
  test("exit 0 when clean, 1 when not, text and --json", async () => {
    const lines: string[] = [];
    expect(await main(["boundary-check"], { out: (s) => lines.push(s), boundaryCheck: async () => rep(true) })).toBe(0);
    expect(lines[0]).toContain("OK");
    expect(await main(["boundary-check", "--json"], { out: (s) => lines.push(s), boundaryCheck: async () => rep(false) })).toBe(1);
    expect(JSON.parse(lines[1]!).tables[0].nullOld).toBe(2);
    expect(formatParity(rep(false))).toContain("NOT CLEAN");
  });
  test("--table is passed through; usage errors and a failure have their own codes", async () => {
    let seen: { table?: string } | undefined;
    await main(["boundary-check", "--table", "sessions"], { out: () => {}, boundaryCheck: async (o) => ((seen = o), rep(true)) });
    expect(seen?.table).toBe("sessions");
    const { spyOn } = await import("bun:test");
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["boundary-check", "--apply"], { boundaryCheck: async () => rep(true) })).toBe(2);
    expect(await main(["boundary-check"], { out: () => {}, boundaryCheck: async () => { throw new Error("db down"); } })).toBe(3);
    expect(await main(["boundary-check"], { out: () => {}, boundaryCheck: async () => { throw new Error("unknown table 'x'"); } })).toBe(2);
    err.mockRestore();
  });
});
