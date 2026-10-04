import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/client";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("personas-as-code schema", () => {
  test("personas gains the desired-layer columns; the override and sync tables exist", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      const cols = async (t: string) =>
        (await pg.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ?`, [t],
        )).map((r) => r.column_name).sort();

      expect(await cols("personas")).toEqual(expect.arrayContaining(
        ["slack_user_id", "user_token", "origin", "source_revision", "tombstoned_at"]));
      expect(await cols("persona_overrides")).toEqual(
        ["field", "persona_name", "set_at", "set_by", "tenant_id", "value"]);
      expect(await cols("persona_sync_state")).toEqual(
        ["committed_at", "override_version", "revision", "synced_at", "synced_by", "tenant_id"]);
    } finally {
      await pg.close();
    }
  });

  test("0014: personas.provider_json exists and provider_creds accepts auth_token, still refusing other kinds", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      const col = await pg.one<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='personas' AND column_name='provider_json'`);
      expect(col).toEqual({ data_type: "jsonb", is_nullable: "YES" });
      const ins = (id: string, kind: string) => pg.run(
        `INSERT INTO provider_creds (id, tenant_id, persona_id, kind, value, created_at, updated_at) VALUES (?, 'default', NULL, ?, 'v', 0, 0)`, [id, kind]);
      await ins("c1", "auth_token");
      await ins("c2", "api_key");
      await expect(ins("c3", "password")).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  test("0017: personas.kb_sources is a nullable jsonb, null on existing rows, and the migration is idempotent", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      const col = await pg.one<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='personas' AND column_name='kb_sources'`);
      expect(col).toEqual({ data_type: "jsonb", is_nullable: "YES" });
      await pg.run(`INSERT INTO personas (id, tenant_id, name, soul_md, created_at, updated_at) VALUES ('p1','default','ana','',0,0)`);
      expect((await pg.one<{ kb_sources: unknown }>(`SELECT kb_sources FROM personas WHERE id='p1'`))!.kb_sources).toBeNull();
      const sql = readFileSync(join(MIGRATIONS_DIR, "0017_personas_kb_sources.sql"), "utf8");
      await pg.exec(sql); // a re-run (no schema_migrations guard) is a no-op
    } finally {
      await pg.close();
    }
  });

  test("origin defaults to 'git' and is constrained", async () => {
    const pg = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      await runMigrations(pg, { log: () => {} });
      await pg.run(
        `INSERT INTO personas (id, tenant_id, name, soul_md, created_at, updated_at) VALUES ('p1','default','ana','',0,0)`);
      expect((await pg.one<{ origin: string }>(`SELECT origin FROM personas WHERE id='p1'`))!.origin).toBe("git");
      await expect(pg.run(`UPDATE personas SET origin = 'other' WHERE id='p1'`)).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
});
