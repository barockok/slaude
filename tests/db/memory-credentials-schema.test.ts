import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { loadMigrations, runMigrations } from "../../src/db/migrate";
import { setCredentialPointer } from "../../src/db/credential-pointers";

/**
 * Migration 0052 (slice F, rc.22): the credential bookkeeping pointer and the
 * operator tombstone table. Additive and nullable: an older binary that never
 * names the column still writes. The drift test sees columns only; keys, the
 * foreign key action and the CHECK are here, on both dialects.
 */
async function ins(db: DbClient, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await db.run(sql, params as never);
    return true;
  } catch {
    return false;
  }
}

const cols = async (db: DbClient, table: string): Promise<string[]> =>
  db.dialect === "sqlite"
    ? (await db.query<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name)
    : (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`, [table])).map((r) => r.column_name);

const seedAccount = (db: DbClient, id: string) =>
  db.run(`INSERT INTO accounts (id, issuer, subject, email, created_at, updated_at) VALUES (?, 'https://idp.example.com', ?, 'a@example.com', 1, 1)`, [id, `sub-${id}`]);
const cred = (db: DbClient, id: string, accountId: string, extra = "") =>
  ins(db, `INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at${extra ? ", user_id" : ""}) VALUES (?, ?, ?, 'x', 1, 1${extra ? ", ?" : ""})`, extra ? [id, accountId, `k-${id}`, extra] : [id, accountId, `k-${id}`]);

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`memory credentials schema (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });

    test("the pointer column and the tombstone table exist", async () => {
      expect(await cols(db, "mcp_credentials")).toContain("user_id");
      expect((await cols(db, "slice_tombstones")).sort()).toEqual(["created_at", "created_by", "reason", "source_id", "user_id"]);
    });

    test("an older binary can still insert credentials without the pointer, which reads NULL", async () => {
      await seedAccount(db, "a-old");
      expect(await cred(db, "c-old", "a-old")).toBe(true);
      expect(await ins(db, `INSERT INTO mcp_credentials (id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at) VALUES ('c-agent', 't1', 'p1', 'k', 'x', 1, 1)`)).toBe(true);
      expect((await db.one<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE id = 'c-old'"))!.user_id).toBeNull();
    });

    test("deleting a user nulls the pointer and keeps the credential", async () => {
      await seedAccount(db, "a-del");
      await db.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u-del', 1, 1)`);
      expect(await cred(db, "c-del", "a-del", "u-del")).toBe(true);
      await db.run(`DELETE FROM users WHERE id = 'u-del'`);
      expect(await db.one<{ id: string; user_id: string | null; payload: string }>("SELECT id, user_id, payload FROM mcp_credentials WHERE id = 'c-del'")).toEqual({ id: "c-del", user_id: null, payload: "x" });
    });

    test("a pointer never lands on an agent row: the pg CHECK, and the repo function on both dialects", async () => {
      await db.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u-chk', 1, 1)`);
      await seedAccount(db, "a-chk");
      await cred(db, "c-person", "a-chk");
      if (dialect === "pg") {
        expect(await ins(db, `INSERT INTO mcp_credentials (id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at, user_id) VALUES ('c-bad', 't2', 'p2', 'k', 'x', 1, 1, 'u-chk')`)).toBe(false);
        expect(await ins(db, `UPDATE mcp_credentials SET user_id = 'u-chk' WHERE id = 'c-agent'`)).toBe(false);
      }
      expect(await setCredentialPointer("c-agent", "u-chk", db)).toBe(false);
      expect((await db.one<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE id = 'c-agent'"))!.user_id).toBeNull();
      expect(await setCredentialPointer("c-person", "u-chk", db)).toBe(true);
      expect((await db.one<{ user_id: string | null }>("SELECT user_id FROM mcp_credentials WHERE id = 'c-person'"))!.user_id).toBe("u-chk");
    });

    test("a tombstone is unique per (user, source), accepts '*', and has no foreign key", async () => {
      const t = (u: string, s: string) => ins(db, `INSERT INTO slice_tombstones (user_id, source_id, created_by, reason, created_at) VALUES (?, ?, 'op', 'because', 1)`, [u, s]);
      expect(await t("no-such-user", "user-u0example")).toBe(true);
      expect(await t("no-such-user", "user-u0example")).toBe(false);
      expect(await t("no-such-user", "*")).toBe(true);
      expect(await t("other", "user-u0example")).toBe(true);
    });
  });
}

describe("upgrade from 0041", () => {
  test("sqlite: an old file gains the column, rows and payloads keep their bytes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "slaude-0052-")), "old.sqlite");
    const old = new Database(path);
    old.run(`CREATE TABLE accounts (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject))`);
    old.run(`CREATE TABLE mcp_credentials (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE, agent_tenant TEXT, agent_persona TEXT, server_key TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((account_id IS NOT NULL) <> (agent_tenant IS NOT NULL)), CHECK ((agent_tenant IS NULL) = (agent_persona IS NULL)), UNIQUE (account_id, server_key), UNIQUE (agent_tenant, agent_persona, server_key))`);
    old.run(`INSERT INTO accounts VALUES ('a1', 'https://idp.example.com', 's1', 'a@example.com', 1, 1)`);
    old.run(`INSERT INTO mcp_credentials VALUES ('c1', 'a1', NULL, NULL, 'k', 'ciphertext-bytes', 9, 8)`);
    old.close();
    const db = await openDb({ dialect: "sqlite", path });
    try {
      expect(await cols(db, "mcp_credentials")).toContain("user_id");
      expect(await db.one<Record<string, unknown>>("SELECT * FROM mcp_credentials")).toEqual({ id: "c1", account_id: "a1", agent_tenant: null, agent_persona: null, server_key: "k", payload: "ciphertext-bytes", expires_at: 9, updated_at: 8, user_id: null });
    } finally {
      await db.close();
    }
  });

  test("pg: 0052 applies on top of 0041 data, leaves every old read unchanged, and reruns as a no-op", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations();
      await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version < "0052") });
      await seedAccount(db, "a1");
      await db.run(`INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at) VALUES ('c1', 'a1', 'k', 'ciphertext-bytes', 9, 8)`);
      const upTo52 = all.filter((m) => m.version <= "0052");
      const r = await runMigrations(db, { log: () => {}, migrations: upTo52 });
      expect(r.applied).toEqual(["0052"]);
      expect(await db.one<Record<string, unknown>>("SELECT payload, expires_at, user_id FROM mcp_credentials WHERE id = 'c1'")).toEqual({ payload: "ciphertext-bytes", expires_at: 9, user_id: null });
      expect((await runMigrations(db, { log: () => {}, migrations: upTo52 })).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
