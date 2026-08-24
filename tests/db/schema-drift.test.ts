import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

/**
 * Cross-dialect drift guard: the sqlite bootstrap (drivers/sqlite.ts) and the
 * Postgres migrations (src/db/migrations/*.sql) must describe the same tables
 * with the same columns, except for the deltas listed explicitly below. A new
 * column added on one side only fails here until it is either mirrored or
 * allowlisted on purpose.
 */

// Tables that exist only on Postgres (multi-tenant / cross-replica state).
const PG_ONLY_TABLES = new Set([
  "tenants",
  "slack_apps",
  "personas",
  "provider_creds",
  "schema_migrations",
]);

// Shared tables that intentionally carry no tenant_id on Postgres: dedup and
// gate rows are keyed by globally-unique ids (Slack event ids, toolUseIDs)
// and are purged/resolved too fast to need tenant scoping (spec §4).
const NO_TENANT_TABLES = new Set(["pending_gates", "seen_events"]);

// Tables that exist only on sqlite (legacy; dropped from the pg schema).
const SQLITE_ONLY_TABLES = new Set(["skill_usage"]);

// Per-table columns that exist only on Postgres.
const PG_ONLY_COLUMNS = new Set(["tenant_id"]);

describe("schema drift: sqlite bootstrap vs pg migrations", () => {
  test("shared tables carry identical column sets (modulo allowlist)", async () => {
    const lite = await openDb({ dialect: "sqlite", path: ":memory:" });
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });

      const liteTables = (
        await lite.query<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
      ).map((r) => r.name);
      const pgTables = (
        await pg.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
        )
      ).map((r) => r.table_name);

      // Table-set diff, minus the intended one-sided tables.
      const liteSet = new Set(liteTables.filter((t) => !SQLITE_ONLY_TABLES.has(t)));
      const pgSet = new Set(pgTables.filter((t) => !PG_ONLY_TABLES.has(t)));
      expect([...liteSet].sort()).toEqual([...pgSet].sort());

      // Every pg-only / sqlite-only entry in the allowlists actually exists —
      // a stale allowlist row is drift too.
      for (const t of PG_ONLY_TABLES) expect(pgTables).toContain(t);
      for (const t of SQLITE_ONLY_TABLES) expect(liteTables).toContain(t);

      // Column-set diff per shared table.
      for (const table of [...liteSet].sort()) {
        const liteCols = (
          await lite.query<{ name: string }>(`PRAGMA table_info(${table})`)
        ).map((r) => r.name).sort();
        const pgCols = (
          await pg.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ?`,
            [table],
          )
        ).map((r) => r.column_name);
        const pgShared = pgCols.filter((c) => !PG_ONLY_COLUMNS.has(c)).sort();
        // Label mismatches with the table name so the failure is readable.
        expect({ table, columns: pgShared }).toEqual({ table, columns: liteCols });
        // The allowlisted pg-only column really is there (except tables where
        // it genuinely does not apply — see NO_TENANT_TABLES).
        if (!NO_TENANT_TABLES.has(table)) expect(pgCols).toContain("tenant_id");
        else expect(pgCols).not.toContain("tenant_id");
      }
    } finally {
      await lite.close();
      await pg.close();
    }
  });
});
