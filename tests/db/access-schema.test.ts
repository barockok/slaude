import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { loadMigrations, runMigrations } from "../../src/db/migrate";

/**
 * Migration 0040 (slice C, rc.19): the grant reference columns, the lock team,
 * accounts.email_proven and the link token ledger. Additive, nullable or
 * defaulted, so an older binary that never names them can still write. The
 * drift test sees columns only: keys and the old-writer guarantee are here.
 */
async function ins(db: DbClient, sql: string, params: unknown[]): Promise<boolean> {
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

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`access schema (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });

    test("the new columns exist", async () => {
      expect(await cols(db, "agent_grants")).toEqual(expect.arrayContaining(["subject_ref", "subject_user_id"]));
      expect(await cols(db, "one_on_one_locks")).toContain("team_id");
      expect(await cols(db, "accounts")).toContain("email_proven");
      expect((await cols(db, "link_token_uses")).sort()).toEqual(["expires_at", "jti", "slack_user_id", "team_id", "used_at"]);
    });

    test("an older binary can still insert grants, locks and accounts without the new columns", async () => {
      const tenant = dialect === "pg" ? ", tenant_id" : "";
      const tmark = dialect === "pg" ? ", 'default'" : "";
      const bool = dialect === "pg" ? "FALSE" : "0";
      expect(
        await ins(
          db,
          `INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, deny, dm_only, created_by, created_at${tenant})
           VALUES ('g1', 'scout', 'user', 'U0EXAMPLE', 'member', ${bool}, ${bool}, 'U0ADMIN', 1${tmark})`,
          [],
        ),
      ).toBe(true);
      expect(
        await ins(
          db,
          `INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at${tenant})
           VALUES ('C0EXAMPLE', '1.1', 'U0EXAMPLE', 'U0EXAMPLE', 1${tmark})`,
          [],
        ),
      ).toBe(true);
      expect(await ins(db, `INSERT INTO accounts (id, issuer, subject, email, created_at, updated_at) VALUES ('a1', 'https://idp.example.com', 's1', 'a@example.com', 1, 1)`, [])).toBe(true);
      const g = await db.one<{ subject_ref: string | null; subject_user_id: string | null }>("SELECT subject_ref, subject_user_id FROM agent_grants WHERE id = 'g1'");
      expect(g).toEqual({ subject_ref: null, subject_user_id: null });
      expect((await db.one<{ team_id: string | null }>("SELECT team_id FROM one_on_one_locks WHERE channel_id = 'C0EXAMPLE'"))!.team_id).toBeNull();
      const a = await db.one<{ email_proven: unknown }>("SELECT email_proven FROM accounts WHERE id = 'a1'");
      expect(Boolean(a!.email_proven)).toBe(false);
    });

    test("the link token ledger is unique per jti", async () => {
      const row = (jti: string) => ins(db, `INSERT INTO link_token_uses (jti, team_id, slack_user_id, used_at, expires_at) VALUES (?, 'T0EXAMPLE', 'U0EXAMPLE', 1, 2)`, [jti]);
      expect(await row("j1")).toBe(true);
      expect(await row("j1")).toBe(false);
      expect(await row("j2")).toBe(true);
    });

    test("the link token ledger insert-or-ignore reports whether it won", async () => {
      const take = (jti: string) =>
        db.run(`INSERT INTO link_token_uses (jti, team_id, slack_user_id, used_at, expires_at) VALUES (?, 'T0EXAMPLE', 'U0EXAMPLE', 1, 2) ON CONFLICT (jti) DO NOTHING`, [jti]);
      expect((await take("j9")).changes).toBe(1);
      expect((await take("j9")).changes).toBe(0);
    });
  });
}

describe("upgrade from 0039 keeps existing rows", () => {
  test("sqlite: an old file gains the columns, rows keep their values", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "slaude-0040-")), "old.sqlite");
    const old = new Database(path);
    old.run(`CREATE TABLE accounts (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject))`);
    old.run(`CREATE TABLE one_on_one_locks (channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, locked_user TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, open_scope TEXT, PRIMARY KEY (channel_id, thread_ts))`);
    old.run(`CREATE TABLE agent_grants (id TEXT PRIMARY KEY, persona TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, role TEXT NOT NULL, deny INTEGER NOT NULL DEFAULT 0, dm_only INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, note TEXT)`);
    old.run(`INSERT INTO accounts VALUES ('a1', 'https://idp.example.com', 's1', 'a@example.com', 1, 1)`);
    old.run(`INSERT INTO one_on_one_locks VALUES ('C0EXAMPLE', '1.1', 'U0EXAMPLE', 'U0EXAMPLE', 1, NULL)`);
    old.run(`INSERT INTO agent_grants VALUES ('g1', 'scout', 'user', 'U0EXAMPLE', 'manager', 0, 0, 'U0ADMIN', 1, NULL, NULL)`);
    old.close();

    const db = await openDb({ dialect: "sqlite", path });
    try {
      expect(await cols(db, "accounts")).toContain("email_proven");
      expect(await cols(db, "agent_grants")).toEqual(expect.arrayContaining(["subject_ref", "subject_user_id"]));
      expect(await cols(db, "one_on_one_locks")).toContain("team_id");
      const a = await db.one<{ email: string; email_proven: number }>("SELECT email, email_proven FROM accounts WHERE id = 'a1'");
      expect(a).toEqual({ email: "a@example.com", email_proven: 0 });
      const l = await db.one<{ locked_user: string; team_id: string | null }>("SELECT locked_user, team_id FROM one_on_one_locks");
      expect(l).toEqual({ locked_user: "U0EXAMPLE", team_id: null });
      const g = await db.one<{ role: string; subject_ref: string | null }>("SELECT role, subject_ref FROM agent_grants");
      expect(g).toEqual({ role: "manager", subject_ref: null });
      expect(await db.one("SELECT jti FROM link_token_uses")).toBeNull();
    } finally {
      await db.close();
    }
  });

  test("pg: migrating from 0039 to 0040 keeps existing rows with NULL or default values", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations();
      await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version < "0040") });
      await db.run(`INSERT INTO agent_grants (id, persona, subject_kind, subject_id, role, created_by, created_at) VALUES ('g1', 'scout', 'user', 'U0EXAMPLE', 'manager', 'U0ADMIN', 1)`);
      await db.run(`INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at) VALUES ('C0EXAMPLE', '1.1', 'U0EXAMPLE', 'U0EXAMPLE', 1)`);
      await db.run(`INSERT INTO accounts (id, issuer, subject, email, created_at, updated_at) VALUES ('a1', 'https://idp.example.com', 's1', 'a@example.com', 1, 1)`);
      const r = await runMigrations(db, { log: () => {}, migrations: all });
      expect(r.applied).toEqual(["0040"]);
      expect(await db.one("SELECT 1 AS x FROM agent_grants WHERE id = 'g1' AND role = 'manager' AND subject_ref IS NULL AND subject_user_id IS NULL")).not.toBeNull();
      expect(await db.one("SELECT 1 AS x FROM one_on_one_locks WHERE locked_user = 'U0EXAMPLE' AND team_id IS NULL")).not.toBeNull();
      expect(await db.one("SELECT 1 AS x FROM accounts WHERE id = 'a1' AND email_proven = FALSE")).not.toBeNull();
      // Rerunning is a no-op.
      expect((await runMigrations(db, { log: () => {}, migrations: all })).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
