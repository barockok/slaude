import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/client";
import { exportSqliteToPg, EXPORT_TABLES, main } from "../../src/cli/migrate-sqlite";

async function seededSqlite() {
  const dir = mkdtempSync(join(tmpdir(), "slaude-mig-"));
  const src = await openDb({ dialect: "sqlite", path: join(dir, "db.sqlite") });
  const now = Date.now();
  await src.run(
    `INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["s1", now, now, "m", "/w", "T1", "C1", "1.0"],
  );
  await src.run(
    `INSERT INTO ignores (id, target_type, user_id, created_by, created_at) VALUES (?, 'user', ?, ?, ?)`,
    ["i1", "U1", "UM", now],
  );
  await src.run(
    `INSERT INTO cron_jobs (id, channel_id, created_by, cron_expr, prompt, next_run_at, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ["j1", "C1", "UM", "* * * * *", "hi", now],
  );
  await src.run(
    `INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["C1", "1.0", "U1", "U1", now],
  );
  await src.run(
    `INSERT INTO mention_only_threads (channel_id, thread_ts, created_by, created_at) VALUES (?, ?, ?, ?)`,
    ["C1", "2.0", "U1", now],
  );
  await src.run(
    `INSERT INTO soul_overrides (field, value, action, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
    ["blockedUsers", "U9", "add", "UM", now],
  );
  await src.run(
    `INSERT INTO kb_ingest_jobs (id, label, status, triggered_by, started_at, heartbeat_at) VALUES (?, ?, 'completed', ?, ?, ?)`,
    ["k1", "lbl", "UM", now, now],
  );
  for (let i = 0; i < 3; i++) {
    await src.run(
      `INSERT INTO memory_turns (session_id, ts, user_text, assistant_text) VALUES (?, ?, ?, ?)`,
      ["s1", now + i, `u${i}`, `a${i}`],
    );
  }
  await src.run(`INSERT INTO memory_facts (session_id, scope, ts, fact) VALUES (?, 'global', ?, ?)`, [null, now, "f"]);
  // skill_usage exists in sqlite but is intentionally not exported
  await src.run(`INSERT INTO skill_usage (skill, uses) VALUES ('x', 1)`);
  return { dir, src };
}

describe("cli/migrate-sqlite", () => {
  test("copies every table, is idempotent, and advances serial sequences", async () => {
    const { src } = await seededSqlite();
    const dst = await openDb({ dialect: "pg", driver: "pglite" });
    const logs: string[] = [];
    try {
      const dry = await exportSqliteToPg(src, dst, { dryRun: true, log: (m) => logs.push(m) });
      expect(dry.dryRun).toBe(true);
      expect(dry.tables.map((t) => t.table)).toEqual([...EXPORT_TABLES]);
      expect((await dst.query("SELECT * FROM sessions")).length).toBe(0);

      const first = await exportSqliteToPg(src, dst, { log: (m) => logs.push(m) });
      const byTable = Object.fromEntries(first.tables.map((t) => [t.table, t]));
      expect(byTable.sessions).toMatchObject({ source: 1, inserted: 1, skipped: 0 });
      expect(byTable.memory_turns).toMatchObject({ source: 3, inserted: 3, skipped: 0 });
      expect(byTable.memory_facts).toMatchObject({ source: 1, inserted: 1 });
      for (const t of EXPORT_TABLES) expect(byTable[t]!.inserted).toBe(byTable[t]!.source);

      const sess = await dst.one<any>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
      expect(sess.slack_thread_ts).toBe("1.0");
      expect(sess.tenant_id).toBe("default"); // pg-only column takes its default
      expect(sess.engaged).toBe(1);

      // serial sequence moved past the copied ids: a fresh insert gets id 4
      const r = await dst.query<{ id: number }>(
        "INSERT INTO memory_turns (session_id, ts, user_text, assistant_text) VALUES (?, ?, ?, ?) RETURNING id",
        ["s1", 1, "u", "a"],
      );
      expect(r[0]!.id).toBe(4);

      const again = await exportSqliteToPg(src, dst, { log: (m) => logs.push(m) });
      for (const t of again.tables) {
        expect(t.inserted).toBe(0);
        expect(t.skipped).toBe(t.source);
      }
      expect(logs.some((l) => l.includes("[copy] sessions: 1 inserted"))).toBe(true);
    } finally {
      await src.close();
      await dst.close();
    }
  });

  test("rejects wrong dialects", async () => {
    const a = await openDb({ dialect: "sqlite", path: ":memory:" });
    const b = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await expect(exportSqliteToPg(b, b)).rejects.toThrow(/source must be sqlite/);
      await expect(exportSqliteToPg(a, a)).rejects.toThrow(/target must be Postgres/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("main: --help, missing target, and a PGLite-dir run", async () => {
    const { dir, src } = await seededSqlite();
    await src.close();
    const prevUrl = process.env.SLAUDE_PG_URL;
    const prevDir = process.env.SLAUDE_PGLITE_DIR;
    delete process.env.SLAUDE_PG_URL;
    delete process.env.SLAUDE_PGLITE_DIR;
    try {
      expect(await main(["--help"])).toBe(0);
      expect(await main(["--from", join(dir, "db.sqlite")])).toBe(2);
      await expect(main(["--bogus"])).rejects.toThrow(/unknown argument/);
      process.env.SLAUDE_PGLITE_DIR = join(dir, "pglite");
      expect(await main(["--from", join(dir, "db.sqlite"), "--dry-run"])).toBe(0);
      expect(await main(["--from", join(dir, "db.sqlite")])).toBe(0);
      const check = await openDb({ dialect: "pg", driver: "pglite", dataDir: join(dir, "pglite") });
      try {
        expect((await check.query("SELECT * FROM cron_jobs")).length).toBe(1);
      } finally {
        await check.close();
      }
    } finally {
      if (prevUrl === undefined) delete process.env.SLAUDE_PG_URL; else process.env.SLAUDE_PG_URL = prevUrl;
      if (prevDir === undefined) delete process.env.SLAUDE_PGLITE_DIR; else process.env.SLAUDE_PGLITE_DIR = prevDir;
    }
  });
});
