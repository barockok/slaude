import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { loadMigrations, runMigrations } from "../../src/db/migrate";

/**
 * Migration 0051 (slice E, rc.24): additive columns on `environments` for
 * definition rows. A personal row keeps working with the old insert shape.
 */
const NEW_COLS = ["source", "definition_name", "definition_hash", "definition_revision", "description", "retired_at"];

const cols = async (db: DbClient): Promise<string[]> =>
  db.dialect === "sqlite"
    ? (await db.query<{ name: string }>("PRAGMA table_info(environments)")).map((r) => r.name)
    : (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'environments'")).map((r) => r.column_name);

const OLD_INSERT = `INSERT INTO environments (id, team_id, user_id, name, kind, config, secrets, default_dir, created_at, updated_at)
  VALUES (?, 'T0EXAMPLE', 'U0EXAMPLE', ?, 'ssh', '{}', NULL, NULL, 1, 1)`;

async function checkDefaults(db: DbClient) {
  const r = await db.one<Record<string, unknown>>("SELECT * FROM environments WHERE id = 'e1'");
  expect(r?.source).toBe("user");
  for (const c of ["definition_name", "definition_hash", "definition_revision", "description", "retired_at"]) expect(r?.[c]).toBeNull();
}

describe("environment definitions schema (sqlite)", () => {
  test("a fresh database has the columns and the old insert shape works", async () => {
    const db = await openDb({ dialect: "sqlite", path: ":memory:" });
    try {
      expect(await cols(db)).toEqual(expect.arrayContaining(NEW_COLS));
      await db.run(OLD_INSERT, ["e1", "mine"]);
      await checkDefaults(db);
    } finally {
      await db.close();
    }
  });

  test("an old file gains the columns and personal rows keep their values", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "slaude-0051-")), "old.sqlite");
    const old = new Database(path);
    old.run(`CREATE TABLE environments (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL, secrets TEXT, default_dir TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (team_id, user_id, name))`);
    old.run(`INSERT INTO environments VALUES ('e1', 'T0EXAMPLE', 'U0EXAMPLE', 'mine', 'ssh', '{}', NULL, NULL, 1, 1)`);
    old.close();
    const db = await openDb({ dialect: "sqlite", path });
    try {
      expect(await cols(db)).toEqual(expect.arrayContaining(NEW_COLS));
      await checkDefaults(db);
    } finally {
      await db.close();
    }
  });

  test("a definition name is unique", async () => {
    const db = await openDb({ dialect: "sqlite", path: ":memory:" });
    try {
      const ins = (id: string, team: string, name: string | null) =>
        db.run(`INSERT INTO environments (id, team_id, user_id, name, kind, config, created_at, updated_at, source, definition_name) VALUES (?, ?, ?, ?, 'ssh', '{}', 1, 1, 'definition', ?)`, [id, team, name ?? id, name ?? id, name]);
      await ins("d1", "def~default", "box");
      await expect(ins("d2", "def~default", "box")).rejects.toThrow();
      await ins("p1", "def~default", null);
      await ins("p2", "def~default", null);
    } finally {
      await db.close();
    }
  });
});

describe("environment definitions schema (pg)", () => {
  test("migrating from 0041 keeps personal rows with defaults and NULLs", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations().filter((m) => m.version <= "0051"); // this file owns 0051; later migrations have their own tests
      expect(all.some((m) => m.version === "0051")).toBe(true);
      await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version < "0051") });
      await db.run(OLD_INSERT, ["e1", "mine"]);
      const r = await runMigrations(db, { log: () => {}, migrations: all });
      expect(r.applied).toEqual(["0051"]);
      expect(await cols(db)).toEqual(expect.arrayContaining(NEW_COLS));
      await checkDefaults(db);
      expect((await runMigrations(db, { log: () => {}, migrations: all })).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });

  test("the definition index is unique per tenant and name, and absent for personal rows", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(db, { log: () => {} });
      const ins = (id: string, tenant: string, name: string | null) =>
        db.run(`INSERT INTO environments (id, tenant_id, team_id, user_id, name, kind, config, created_at, updated_at, source, definition_name) VALUES (?, ?, ?, ?, ?, 'ssh', '{}', 1, 1, ?, ?)`, [id, tenant, `def~${tenant}`, id, id, name ? "definition" : "user", name]);
      await ins("d1", "t1", "box");
      await expect(ins("d2", "t1", "box")).rejects.toThrow();
      await ins("d3", "t2", "box");
      await ins("p1", "t1", null);
      await ins("p2", "t1", null);
    } finally {
      await db.close();
    }
  });
});
