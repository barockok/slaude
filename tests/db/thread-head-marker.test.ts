import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbClient, openDb } from "../../src/db/client";
import { MIGRATIONS_DIR, loadMigrations, runMigrations } from "../../src/db/migrate";
import { THREAD_HEAD_EPOCH_MS, claimThreadHeadOn, hadFirstTurnBeforeThreadHead, releaseThreadHeadOn } from "../../src/db/sessions";

/**
 * Migration 0053 (rc.28): `sessions.thread_head_at`, a nullable column set once by compare-and-set
 * when a session's thread head is claimed for a turn's prompt. Both dialects.
 */
const cols = async (db: DbClient, table: string): Promise<string[]> =>
  db.dialect === "sqlite"
    ? (await db.query<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name)
    : (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`, [table])).map((r) => r.column_name);

const oldSession = (db: DbClient, id: string) =>
  db.run(
    `INSERT INTO sessions (id, created_at, updated_at, model, working_dir, slack_team_id, slack_channel_id, slack_thread_ts) VALUES (?, 1, 1, 'm', '/w', 'T0EXAMPLE', 'C0EXAMPLE', ?)`,
    [id, `${id}.1`],
  );

describe("migration file 0053", () => {
  test("one nullable column and a short lock timeout, no backfill, default, index or key", () => {
    const f = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("0053_"));
    expect(f).toHaveLength(1);
    const sql = readFileSync(join(MIGRATIONS_DIR, f[0]!), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    expect(sql).toEqual([
      "SET LOCAL lock_timeout = '2s';",
      "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thread_head_at BIGINT;",
    ]);
  });
});

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`thread head marker (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.run(`DELETE FROM sessions WHERE id IN ('s-old', 's-cas', 's-race')`);
      await db.close();
    });

    test("the column exists and an rc.27 insert leaves it NULL", async () => {
      expect(await cols(db, "sessions")).toContain("thread_head_at");
      await oldSession(db, "s-old");
      expect((await db.one<{ thread_head_at: number | null }>("SELECT thread_head_at FROM sessions WHERE id = 's-old'"))!.thread_head_at).toBeNull();
    });

    test("the claim succeeds once, then never again", async () => {
      await oldSession(db, "s-cas");
      expect(await claimThreadHeadOn(db, "s-cas", 1234)).toBe(true);
      expect(await claimThreadHeadOn(db, "s-cas", 5678)).toBe(false);
      expect(Number((await db.one<{ thread_head_at: number | string }>("SELECT thread_head_at FROM sessions WHERE id = 's-cas'"))!.thread_head_at)).toBe(1234);
    });

    test("two concurrent claims: exactly one wins", async () => {
      await oldSession(db, "s-race");
      const r = await Promise.all([claimThreadHeadOn(db, "s-race", 1), claimThreadHeadOn(db, "s-race", 2), claimThreadHeadOn(db, "s-race", 3)]);
      expect(r.filter(Boolean)).toHaveLength(1);
    });

    test("a release gives the marker back only to the claim that holds it", async () => {
      await oldSession(db, "s-rel");
      expect(await claimThreadHeadOn(db, "s-rel", 111)).toBe(true);
      expect(await releaseThreadHeadOn(db, "s-rel", 222)).toBe(false);
      expect(await releaseThreadHeadOn(db, "s-rel", 111)).toBe(true);
      expect(await claimThreadHeadOn(db, "s-rel", 333)).toBe(true);
      await db.run(`DELETE FROM sessions WHERE id = 's-rel'`);
    });

    test("an unknown session claims nothing", async () => {
      expect(await claimThreadHeadOn(db, "no-such", 1)).toBe(false);
    });

  });
}

describe("the epoch rule", () => {
  test("only a session created before the epoch that had started counts as past its first turn", () => {
    expect(hadFirstTurnBeforeThreadHead({ created_at: THREAD_HEAD_EPOCH_MS - 1, claude_started: 1 })).toBe(true);
    expect(hadFirstTurnBeforeThreadHead({ created_at: THREAD_HEAD_EPOCH_MS - 1, claude_started: 0 })).toBe(false);
    expect(hadFirstTurnBeforeThreadHead({ created_at: THREAD_HEAD_EPOCH_MS, claude_started: 1 })).toBe(false);
    expect(hadFirstTurnBeforeThreadHead({ created_at: String(THREAD_HEAD_EPOCH_MS - 5), claude_started: 1 })).toBe(true);
  });
});

describe("upgrade from 0052", () => {
  test("sqlite: an old file gains the column, rows keep their data and stay NULL (no backfill), a second open is a no-op", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "slaude-0053-")), "old.sqlite");
    const first = await openDb({ dialect: "sqlite", path });
    await oldSession(first, "s1");
    await oldSession(first, "s2");
    await first.run(`UPDATE sessions SET claude_started = 1 WHERE id = 's2'`);
    await first.close();
    // An rc.27 file has no such column: remove it, then open again.
    const raw = new Database(path);
    raw.run(`ALTER TABLE sessions DROP COLUMN thread_head_at`);
    expect((raw.query(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).some((c) => c.name === "thread_head_at")).toBe(false);
    raw.close();
    const db = await openDb({ dialect: "sqlite", path });
    try {
      expect((await cols(db, "sessions")).filter((c) => c === "thread_head_at")).toHaveLength(1);
      expect(await db.query<{ id: string; thread_head_at: number | null }>("SELECT id, thread_head_at FROM sessions ORDER BY id")).toEqual([
        { id: "s1", thread_head_at: null },
        { id: "s2", thread_head_at: null },
      ]);
    } finally {
      await db.close();
    }
    const again = await openDb({ dialect: "sqlite", path });
    try {
      expect((await cols(again, "sessions")).filter((c) => c === "thread_head_at")).toHaveLength(1);
    } finally {
      await again.close();
    }
  });

  test("pg: 0053 applies on top of 0052 data, keeps old rows, reruns as a no-op", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations();
      await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version < "0053") });
      await oldSession(db, "s1");
      await oldSession(db, "s2");
      await db.run(`UPDATE sessions SET claude_started = 1 WHERE id = 's2'`);
      const r = await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version <= "0053") });
      expect(r.applied).toEqual(["0053"]);
      const rows = (await db.query<{ id: string; model: string; thread_head_at: number | string | null }>("SELECT id, model, thread_head_at FROM sessions ORDER BY id")).map((r) => ({ ...r, thread_head_at: r.thread_head_at === null ? null : Number(r.thread_head_at) }));
      expect(rows).toEqual([
        { id: "s1", model: "m", thread_head_at: null },
        { id: "s2", model: "m", thread_head_at: null },
      ]);
      expect((await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version <= "0053") })).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
