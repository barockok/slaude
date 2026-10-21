import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

/** The guests column lands on both dialects: the sqlite bootstrap and pg
 *  migration 0018 (PGLite here; the real-Postgres leg runs the same files).
 *  schema-drift.test.ts guards the two staying in step. */
describe("one_on_one_locks.guests migration", () => {
  const row = ["C1", "1.0", "U0OWNER", "U0OWNER", 1, '["U0QA"]'];
  const insert =
    "INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at, guests) VALUES (?, ?, ?, ?, ?, ?)";

  test("sqlite: column exists and round-trips", async () => {
    const lite = await openDb({ dialect: "sqlite", path: ":memory:" });
    try {
      const cols = (await lite.query<{ name: string }>("PRAGMA table_info(one_on_one_locks)")).map((c) => c.name);
      expect(cols).toContain("guests");
      await lite.run(insert, row);
      expect(await lite.one<{ guests: string }>("SELECT guests FROM one_on_one_locks")).toEqual({ guests: '["U0QA"]' });
    } finally {
      await lite.close();
    }
  });

  test("pg (PGLite): migration adds the column; existing rows read NULL", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      const cols = await pg.query<{ column_name: string; data_type: string }>(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'one_on_one_locks'",
      );
      expect(cols.find((c) => c.column_name === "guests")?.data_type).toBe("text");
      await pg.run(insert, row);
      await pg.run(
        "INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        ["C1", "2.0", "U0OWNER", "U0OWNER", 1],
      );
      const rows = await pg.query<{ thread_ts: string; guests: string | null }>(
        "SELECT thread_ts, guests FROM one_on_one_locks ORDER BY thread_ts",
      );
      expect(rows).toEqual([
        { thread_ts: "1.0", guests: '["U0QA"]' },
        { thread_ts: "2.0", guests: null },
      ]);
      // Idempotent: a second run applies nothing and keeps the data.
      await runMigrations(pg, { log: () => {} });
      expect((await pg.query("SELECT 1 FROM one_on_one_locks")).length).toBe(2);
    } finally {
      await pg.close();
    }
  });
});
