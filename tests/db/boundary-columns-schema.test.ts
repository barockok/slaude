import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { MIGRATIONS_DIR, loadMigrations, runMigrations } from "../../src/db/migrate";

/**
 * Domain sessions, slice D (rc.22): migrations 0042 to 0050 add a nullable,
 * soft-reference `boundary_id` (and an opaque `locator` where a thread key
 * exists) beside the Slack columns, one table per file, sessions last. Nothing
 * else about the tables changes: no key, no index, no foreign key. An rc.21
 * binary that never names the columns must keep writing.
 */
const PAIR = ["one_on_one_locks", "mention_only_threads", "ignores", "cron_jobs", "commitments", "env_bindings", "sessions"];
const BOUNDARY_ONLY = ["proactive_posts", "channel_wake_state"];
const ALL = [...PAIR, ...BOUNDARY_ONLY];
const FILES: Array<[string, string]> = [
  ["0042", "one_on_one_locks"],
  ["0043", "mention_only_threads"],
  ["0044", "ignores"],
  ["0045", "cron_jobs"],
  ["0046", "commitments"],
  ["0047", "env_bindings"],
  ["0048", "proactive_posts"],
  ["0049", "channel_wake_state"],
  ["0050", "sessions"],
];

const cols = async (db: DbClient, table: string): Promise<string[]> =>
  db.dialect === "sqlite"
    ? (await db.query<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name)
    : (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`, [table])).map((r) => r.column_name);

/** One rc.21-shaped insert per table: names no new column. */
async function oldInsert(db: DbClient, table: string, row: Record<string, unknown>): Promise<void> {
  const r = { ...row };
  if ((await cols(db, table)).includes("tenant_id")) r.tenant_id = "default";
  const names = Object.keys(r);
  await db.run(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => r[n]) as never);
}

const ROWS: Record<string, Record<string, unknown>> = {
  one_on_one_locks: { channel_id: "C0EXAMPLE", thread_ts: "1.1", locked_user: "U0EXAMPLE", created_by: "U0EXAMPLE", created_at: 1 },
  mention_only_threads: { channel_id: "C0EXAMPLE", thread_ts: "1.1", created_by: "U0EXAMPLE", created_at: 1 },
  ignores: { id: "i1", target_type: "thread", channel_id: "C0EXAMPLE", thread_ts: "1.1", created_by: "U0EXAMPLE", created_at: 1 },
  cron_jobs: { id: "j1", slack_team_id: "T0EXAMPLE", slack_channel_id: "C0EXAMPLE", slack_thread_ts: "1.1", channel_id: "C0EXAMPLE", thread_ts: "1.1", created_by: "U0EXAMPLE", cron_expr: "* * * * *", prompt: "p", next_run_at: 1 },
  commitments: { agent_id: "a", source: "s", slug: "x", channel_id: "C0EXAMPLE", thread_ts: "1.1", beneficiary: "U0EXAMPLE", due_text: "d", due_kind: "k", next_check_at: 1, expires_at: 2, created_at: 1 },
  env_bindings: { channel_id: "C0EXAMPLE", thread_ts: "1.1", env_id: "e", dir: "/d", last_used_at: 1, created_at: 1 },
  proactive_posts: { id: "p1", agent_id: "a", audience: "u", recipient: "U0EXAMPLE", topic: "t", text_hash: "h", channel_id: "C0EXAMPLE", posted_at: 1 },
  channel_wake_state: { agent_id: "a", channel_id: "C0EXAMPLE", updated_at: 1 },
  sessions: { id: "s1", created_at: 1, updated_at: 1, model: "m", working_dir: "/w", slack_team_id: "T0EXAMPLE", slack_channel_id: "C0EXAMPLE", slack_thread_ts: "1.1" },
};

async function expectNullPair(db: DbClient, table: string): Promise<void> {
  const have = await cols(db, table);
  const row = await db.one<Record<string, unknown>>(`SELECT * FROM ${table}`);
  expect(row).not.toBeNull();
  expect(row!.boundary_id ?? null).toBeNull();
  if (PAIR.includes(table)) expect(row!.locator ?? null).toBeNull();
  else expect(have).not.toContain("locator");
}

describe("migration files 0042 to 0050", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^00(4[2-9]|50)_/.test(f)).sort();

  test("nine files, one table each, sessions last", () => {
    expect(files).toHaveLength(9);
    expect(files.map((f) => f.slice(0, 4))).toEqual(FILES.map(([v]) => v));
    FILES.forEach(([, table], i) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, files[i]!), "utf8");
      const stmts = sql.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      expect(stmts[0]).toBe("SET LOCAL lock_timeout = '2s';");
      const want = [`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS boundary_id TEXT;`];
      if (PAIR.includes(table)) want.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS locator TEXT;`);
      expect(stmts.slice(1)).toEqual(want);
    });
  });

  test("no index, key, default, not-null or foreign key, and audit_events is not named", () => {
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8").split("\n").filter((l) => !l.startsWith("--")).join("\n");
      expect(sql).not.toMatch(/INDEX|REFERENCES|DEFAULT|NOT NULL|PRIMARY|UNIQUE|audit_events/i);
    }
  });
});

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`boundary columns (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });

    test("the columns exist on the right tables only", async () => {
      for (const t of PAIR) expect(await cols(db, t)).toEqual(expect.arrayContaining(["boundary_id", "locator"]));
      for (const t of BOUNDARY_ONLY) {
        const c = await cols(db, t);
        expect(c).toContain("boundary_id");
        expect(c).not.toContain("locator");
      }
      const audit = await cols(db, "audit_events");
      expect(audit).not.toContain("boundary_id");
      expect(audit).not.toContain("locator");
    });

    test("an rc.21 writer inserts without the new columns and the pair reads NULL", async () => {
      for (const t of ALL) {
        await oldInsert(db, t, ROWS[t]!);
        await expectNullPair(db, t);
      }
    });

    test("the new columns carry no foreign key", async () => {
      if (dialect === "sqlite") {
        for (const t of ALL) {
          const fks = await db.query<{ from: string }>(`PRAGMA foreign_key_list(${t})`);
          expect(fks.map((f) => f.from)).not.toContain("boundary_id");
        }
      } else {
        const r = await db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM information_schema.key_column_usage k
           JOIN information_schema.table_constraints c ON c.constraint_name = k.constraint_name AND c.table_schema = k.table_schema
           WHERE c.constraint_type = 'FOREIGN KEY' AND k.table_schema = 'public' AND k.column_name IN ('boundary_id', 'locator')`,
        );
        expect(Number(r[0]!.n)).toBe(0);
      }
    });

    test("no index mentions the new columns and the sessions keys are unchanged", async () => {
      if (dialect === "sqlite") {
        for (const t of ALL) {
          for (const ix of await db.query<{ name: string }>(`PRAGMA index_list(${t})`)) {
            const names = (await db.query<{ name: string | null }>(`PRAGMA index_info(${ix.name})`)).map((c) => c.name);
            expect(names).not.toContain("boundary_id");
            expect(names).not.toContain("locator");
          }
        }
        const uniq = await db.query<{ name: string; unique: number }>(`PRAGMA index_list(sessions)`);
        const keys = [];
        for (const ix of uniq.filter((i) => i.unique)) keys.push((await db.query<{ name: string }>(`PRAGMA index_info(${ix.name})`)).map((c) => c.name).sort());
        expect(keys).toContainEqual(["persona_id", "slack_channel_id", "slack_team_id", "slack_thread_ts"]);
      } else {
        const ix = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY (?)`, [ALL]);
        for (const r of ix) expect(r.indexdef).not.toMatch(/boundary_id|locator/);
      }
    });
  });
}

describe("upgrade from rc.21 (0041) keeps existing rows", () => {
  test("pg: 0042 to 0050 apply in order on top of rc.21 data, rows untouched, rerun is a no-op", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations().filter((m) => m.version <= "0050"); // this file owns 0042 to 0050; later migrations have their own tests
      const lines: string[] = [];
      await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version <= "0041") });
      for (const t of ALL) {
        expect(await cols(db, t)).not.toContain("boundary_id");
        await oldInsert(db, t, ROWS[t]!);
      }
      const before = await db.one<{ before: string }>(`SELECT indexdef AS before FROM pg_indexes WHERE tablename = 'sessions' AND indexdef LIKE '%UNIQUE%' ORDER BY indexname LIMIT 1`);
      const r = await runMigrations(db, { log: (m) => lines.push(m), migrations: all });
      expect(r.applied).toEqual(FILES.map(([v]) => v));
      expect(lines.filter((l) => /migration 00(4[2-9]|50)_boundary/.test(l))).toHaveLength(9);
      for (const t of ALL) await expectNullPair(db, t);
      expect((await db.one<{ slack_thread_ts: string }>(`SELECT slack_thread_ts FROM sessions WHERE id = 's1'`))!.slack_thread_ts).toBe("1.1");
      const after = await db.one<{ before: string }>(`SELECT indexdef AS before FROM pg_indexes WHERE tablename = 'sessions' AND indexdef LIKE '%UNIQUE%' ORDER BY indexname LIMIT 1`);
      expect(after).toEqual(before);
      expect((await runMigrations(db, { log: () => {}, migrations: all })).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });

  test("pg: SET LOCAL lock_timeout does not leak out of the migration transaction", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(db, { log: () => {} });
      const row = await db.one<Record<string, string>>(`SHOW lock_timeout`);
      expect(Object.values(row!)[0]).toBe("0");
    } finally {
      await db.close();
    }
  });

  test("pg: a failing last file leaves the earlier files applied and a retry finishes", async () => {
    // A real held lock needs a second connection, which PGLite does not have;
    // a failing 0050 body stands in for the lock-timeout error the same way:
    // that one transaction rolls back, earlier files stay.
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations().filter((m) => m.version <= "0050"); // this file owns 0042 to 0050; later migrations have their own tests
      const broken = all.map((m) => (m.version === "0050" ? { ...m, sql: `SET LOCAL lock_timeout = '2s';\nDO $$ BEGIN RAISE EXCEPTION 'canceling statement due to lock timeout'; END $$;` } : m));
      await expect(runMigrations(db, { log: () => {}, migrations: broken })).rejects.toThrow(/lock timeout/);
      const applied = (await db.query<{ version: string }>(`SELECT version FROM schema_migrations WHERE version >= '0042' ORDER BY version`)).map((r) => r.version);
      expect(applied).toEqual(FILES.slice(0, 8).map(([v]) => v));
      expect(await cols(db, "sessions")).not.toContain("boundary_id");
      expect(await cols(db, "channel_wake_state")).toContain("boundary_id");
      expect((await runMigrations(db, { log: () => {}, migrations: all })).applied).toEqual(["0050"]);
      expect(await cols(db, "sessions")).toEqual(expect.arrayContaining(["boundary_id", "locator"]));
    } finally {
      await db.close();
    }
  });

  test("sqlite: an rc.21 file gains the columns, rows keep their values", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "slaude-boundary-")), "old.sqlite");
    const first = await openDb({ dialect: "sqlite", path });
    for (const t of ALL) await oldInsert(first, t, ROWS[t]!);
    await first.close();
    // Make it look like rc.21: drop the new columns.
    const raw = new Database(path);
    for (const t of ALL) {
      raw.run(`ALTER TABLE ${t} DROP COLUMN boundary_id`);
      if (PAIR.includes(t)) raw.run(`ALTER TABLE ${t} DROP COLUMN locator`);
    }
    raw.close();
    const db = await openDb({ dialect: "sqlite", path });
    try {
      for (const t of ALL) await expectNullPair(db, t);
      expect((await db.one<{ slack_thread_ts: string }>(`SELECT slack_thread_ts FROM sessions WHERE id = 's1'`))!.slack_thread_ts).toBe("1.1");
    } finally {
      await db.close();
    }
  });

  test("sqlite: the persona_id rebuild of a very old sessions table still ends with the columns", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "slaude-boundary-old-")), "old.sqlite");
    const raw = new Database(path);
    raw.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, model TEXT NOT NULL, working_dir TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', claude_started INTEGER NOT NULL DEFAULT 0, slack_team_id TEXT, slack_channel_id TEXT, slack_thread_ts TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', engaged INTEGER NOT NULL DEFAULT 1, UNIQUE(slack_team_id, slack_channel_id, slack_thread_ts))`);
    raw.run(`INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ('s1', 1, 1, 'm', '/w', 'T0EXAMPLE', 'C0EXAMPLE', '1.1')`);
    raw.close();
    const db = await openDb({ dialect: "sqlite", path });
    try {
      expect(await cols(db, "sessions")).toEqual(expect.arrayContaining(["persona_id", "boundary_id", "locator"]));
      const row = await db.one<{ persona_id: string; boundary_id: string | null; locator: string | null }>(`SELECT persona_id, boundary_id, locator FROM sessions WHERE id = 's1'`);
      expect(row).toEqual({ persona_id: "default", boundary_id: null, locator: null });
    } finally {
      await db.close();
    }
  });
});

describe("migrate-sqlite does not carry the new columns", () => {
  test("a pair is copied as NULL, since the boundaries it points at are not copied", async () => {
    const { exportSqliteToPg } = await import("../../src/cli/migrate-sqlite");
    const src = await openDb({ dialect: "sqlite", path: ":memory:" });
    const dst = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await src.run(
        `INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts, boundary_id, locator) VALUES ('s1', 1, 1, 'm', '/w', 'T0EXAMPLE', 'C0EXAMPLE', '1.1', 'b-example', '1.1')`,
      );
      await src.run(
        `INSERT INTO ignores (id, target_type, channel_id, thread_ts, created_by, created_at, boundary_id, locator) VALUES ('i1', 'thread', 'C0EXAMPLE', '1.1', 'U0EXAMPLE', 1, 'b-example', '1.1')`,
      );
      await exportSqliteToPg(src, dst, { log: () => {} });
      expect(await dst.one(`SELECT 1 AS x FROM sessions WHERE id = 's1' AND slack_thread_ts = '1.1' AND boundary_id IS NULL AND locator IS NULL`)).not.toBeNull();
      expect(await dst.one(`SELECT 1 AS x FROM ignores WHERE id = 'i1' AND thread_ts = '1.1' AND boundary_id IS NULL AND locator IS NULL`)).not.toBeNull();
    } finally {
      await src.close();
      await dst.close();
    }
  });
});
