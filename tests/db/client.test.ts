import { describe, expect, test } from "bun:test";
import { openDb, resolveDbConfig, toPositional, normalizeRow, type DbClient } from "../../src/db/client";
import { runMigrations, appliedVersions, loadMigrations, noopLeaderLock, type LeaderLock } from "../../src/db/migrate";

const EXPECTED_TABLES = [
  "tenants", "slack_apps", "personas", "provider_creds", "sessions", "pending_gates",
  "seen_events", "ignores", "cron_jobs", "one_on_one_locks", "mention_only_threads",
  "soul_overrides", "kb_ingest_jobs", "memory_turns", "memory_facts",
];

describe("db/client resolveDbConfig", () => {
  test("defaults to sqlite", () => {
    expect(resolveDbConfig({}).dialect).toBe("sqlite");
    expect(resolveDbConfig({ SLAUDE_DB: "sqlite" }).dialect).toBe("sqlite");
  });
  test("pg + url → bun-sql; pg without url → pglite", () => {
    expect(resolveDbConfig({ SLAUDE_DB: "pg", SLAUDE_PG_URL: "postgres://u:p@h/db" })).toEqual({
      dialect: "pg", driver: "bun-sql", url: "postgres://u:p@h/db",
    });
    expect(resolveDbConfig({ SLAUDE_DB: "pg" })).toEqual({ dialect: "pg", driver: "pglite", dataDir: undefined });
    expect(resolveDbConfig({ SLAUDE_DB: "postgres", SLAUDE_PGLITE_DIR: "/tmp/x" })).toEqual({
      dialect: "pg", driver: "pglite", dataDir: "/tmp/x",
    });
  });
  test("rejects unknown dialect", () => {
    expect(() => resolveDbConfig({ SLAUDE_DB: "mysql" })).toThrow(/SLAUDE_DB/);
  });
});

describe("db/client helpers", () => {
  test("toPositional rewrites ? outside string literals", () => {
    expect(toPositional("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(toPositional("SELECT '?' AS q, ? AS p")).toBe("SELECT '?' AS q, $1 AS p");
    expect(toPositional("no params")).toBe("no params");
  });
  test("normalizeRow converts bigint to number", () => {
    expect(normalizeRow<Record<string, unknown>>({ a: 1n, b: "x", c: null })).toEqual({ a: 1, b: "x", c: null });
  });
});

async function withClient(fn: (db: DbClient) => Promise<void>, cfg: Parameters<typeof openDb>[0]) {
  const db = await openDb(cfg);
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

describe("db/client drivers", () => {
  test("sqlite driver: query/one/run/exec/transaction", async () => {
    await withClient(async (db) => {
      expect(db.dialect).toBe("sqlite");
      expect(db.driver).toBe("bun-sqlite");
      await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      expect((await db.run("INSERT INTO t (v) VALUES (?)", ["a"])).changes).toBe(1);
      expect(await db.one<{ v: string }>("SELECT v FROM t WHERE id = ?", [1])).toEqual({ v: "a" });
      expect(await db.one("SELECT v FROM t WHERE id = ?", [99])).toBeNull();
      await expect(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO t (v) VALUES (?)", ["b"]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.query("SELECT v FROM t ORDER BY id")).toEqual([{ v: "a" }]);
      await db.transaction(async (tx) => { await tx.run("INSERT INTO t (v) VALUES (?)", ["c"]); });
      expect((await db.query("SELECT v FROM t")).length).toBe(2);
      await expect(db.query("SELECT * FROM nope")).rejects.toThrow();
      await expect(db.one("SELECT * FROM nope")).rejects.toThrow();
      await expect(db.run("INSERT INTO nope VALUES (1)")).rejects.toThrow();
      await expect(db.exec("CREATE TABLE")).rejects.toThrow();
    }, { dialect: "sqlite", path: ":memory:" });
  });

  test("pglite driver: query/one/run/exec/transaction + migrations", async () => {
    await withClient(async (db) => {
      expect(db.dialect).toBe("pg");
      expect(db.driver).toBe("pglite");
      const seen: string[] = [];
      const lock: LeaderLock = { withLock: (name, fn) => { seen.push(name); return fn(); } };
      const first = await runMigrations(db, { lock, log: () => {} });
      expect(seen).toEqual(["migrate"]);
      expect(first.applied.length).toBeGreaterThanOrEqual(5);
      expect(first.skipped).toEqual([]);
      const second = await runMigrations(db, { log: () => {} });
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(first.applied);
      expect(await appliedVersions(db)).toEqual(first.applied);

      const tables = (await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )).map((r) => r.table_name);
      for (const t of EXPECTED_TABLES) expect(tables).toContain(t);
      expect(tables).not.toContain("skill_usage");
      expect(await db.one<{ id: string }>("SELECT id FROM tenants WHERE id = ?", ["default"])).toEqual({ id: "default" });

      const now = Date.now();
      const ins = await db.run(
        "INSERT INTO seen_events (event_id, ts) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING",
        ["ev1", now],
      );
      expect(ins.changes).toBe(1);
      const dup = await db.run(
        "INSERT INTO seen_events (event_id, ts) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING",
        ["ev1", now],
      );
      expect(dup.changes).toBe(0);
      // BIGINT round-trips as a JS number
      expect(await db.one<{ ts: number }>("SELECT ts FROM seen_events WHERE event_id = ?", ["ev1"])).toEqual({ ts: now });

      await expect(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO seen_events (event_id, ts) VALUES (?, ?)", ["ev2", now]);
          // nested transaction joins the outer one
          await tx.transaction(async (inner) => { await inner.run("INSERT INTO seen_events (event_id, ts) VALUES (?, ?)", ["ev3", now]); });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await db.query("SELECT * FROM seen_events")).length).toBe(1);
    }, { dialect: "pg", driver: "pglite" });
  });

  test("runMigrations is a no-op on sqlite", async () => {
    await withClient(async (db) => {
      expect(await runMigrations(db)).toEqual({ applied: [], skipped: [] });
      expect(await appliedVersions(db)).toEqual([]);
    }, { dialect: "sqlite", path: ":memory:" });
  });

  test("loadMigrations rejects duplicate versions", () => {
    const all = loadMigrations();
    expect(all.map((m) => m.version)).toEqual([...all.map((m) => m.version)].sort());
    expect(noopLeaderLock.withLock("x", async () => 1)).resolves.toBe(1);
  });
});
