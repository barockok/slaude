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
  "persona_overrides", // persona_overrides + persona_sync_state: personas-as-code, Postgres-only like personas
  "persona_sync_state",
  "schema_migrations",
  "node_revocations", // gateway-side node credential revocation; sqlite skips revocation
]);

// Shared tables that intentionally carry no tenant_id on Postgres: dedup and
// gate rows are keyed by globally-unique ids (Slack event ids, toolUseIDs)
// and are purged/resolved too fast to need tenant scoping (spec §4).
// accounts + slack_identities join this list on purpose. An account is a
// person's identity at the deployment's own identity provider, so it is
// deployment-global rather than tenant-scoped: the design has one account
// holding several Slack identities, one per workspace the person is in. The
// binding row already carries team_id, which IS the workspace dimension, so a
// tenant_id beside it would be a second copy of the same fact and a fresh
// source of drift.
// mcp_credentials joins for the same reason in both of its owner kinds: a
// person's row reaches tenancy through accounts, which is deployment-global,
// and an agent's row already carries its tenant explicitly in agent_tenant.
// portal_oauth_flows joins for the same reason as accounts: it hangs off an
// account, which is deployment-global, and it holds one authorization for a few
// minutes before deleting itself.
// remote_keys joins too: a person's SSH key is keyed by (team_id, user_id), the
// same workspace-scoped identity slack_identities uses, so tenant_id would only
// duplicate team_id.
const NO_TENANT_TABLES = new Set([
  "pending_gates",
  "seen_events",
  "accounts",
  "slack_identities",
  "mcp_credentials",
  "portal_oauth_flows",
  "slack_oauth_flows",
  "remote_keys",
]);

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
