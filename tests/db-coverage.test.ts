import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db, ensureCronPauseColumn } from "../src/db/schema";
import { findById, findByPrefix } from "../src/db/cron-jobs";

// Covers the ambiguous-prefix guard in src/db/cron-jobs.ts.

afterAll(() => {
  db.run("DELETE FROM cron_jobs WHERE id LIKE 'abcdef12%'");
});

describe("cron-jobs findByPrefix", () => {
  const insert = (id: string) =>
    db.run(
      `INSERT INTO cron_jobs (id, channel_id, created_by, cron_expr, prompt, next_run_at, active)
       VALUES (?, 'C1', 'U1', '* * * * *', 'p', 0, 1)`,
      [id],
    );

  test("throws on an ambiguous 8-char prefix instead of picking one", () => {
    insert("abcdef12-aaaa-aaaa");
    insert("abcdef12-bbbb-bbbb");
    expect(() => findByPrefix("abcdef12")).toThrow(/matches multiple jobs/);
  });

  test("unique 8-char prefix resolves; non-8-char falls back to findById", () => {
    db.run("DELETE FROM cron_jobs WHERE id = 'abcdef12-bbbb-bbbb'");
    expect(findByPrefix("abcdef12")?.id).toBe("abcdef12-aaaa-aaaa");
    expect(findByPrefix("abcdef12-aaaa-aaaa")?.id).toBe("abcdef12-aaaa-aaaa"); // full id path
    expect(findByPrefix("00000000")).toBeNull(); // 8 chars, no match
    expect(findById("nope")).toBeNull();
  });
});

describe("cron_jobs schema migrations", () => {
  test("ensureCronPauseColumn adds missing paused column", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.run(`
        CREATE TABLE cron_jobs (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          cron_expr TEXT NOT NULL,
          prompt TEXT NOT NULL,
          next_run_at INTEGER NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        )
      `);
      ensureCronPauseColumn(legacy);
      const cols = legacy.query("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("paused");
      expect(() => ensureCronPauseColumn(legacy)).not.toThrow();
    } finally {
      legacy.close();
    }
  });

  test("adds paused to legacy cron_jobs tables", async () => {
    const home = mkdtempSync(join(tmpdir(), "slaude-schema-migration-"));
    try {
      const script = `
        import { Database } from "bun:sqlite";
        import { mkdirSync } from "node:fs";
        const home = process.env.SLAUDE_HOME;
        mkdirSync(home, { recursive: true });
        const seed = new Database(home + "/db.sqlite", { create: true });
        seed.run(\`
          CREATE TABLE cron_jobs (
            id TEXT PRIMARY KEY,
            slack_team_id TEXT,
            slack_channel_id TEXT,
            slack_thread_ts TEXT,
            channel_id TEXT NOT NULL,
            thread_ts TEXT,
            created_by TEXT NOT NULL,
            cron_expr TEXT NOT NULL,
            prompt TEXT NOT NULL,
            next_run_at INTEGER NOT NULL,
            last_run_at INTEGER,
            last_result TEXT,
            target TEXT NOT NULL DEFAULT 'thread',
            when_active TEXT NOT NULL DEFAULT 'fire',
            active INTEGER NOT NULL DEFAULT 1
          )
        \`);
        seed.close();
        const { db } = await import("./src/db/schema");
        const cols = db.query("PRAGMA table_info(cron_jobs)").all().map((c) => c.name);
        console.log(JSON.stringify(cols));
      `;
      const proc = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        env: { ...process.env, SLAUDE_HOME: home, SLAUDE_DB_PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const cols = JSON.parse(stdout.trim());
      expect(cols).toContain("paused");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
