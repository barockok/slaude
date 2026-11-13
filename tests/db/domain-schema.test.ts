import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type DbClient, openDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

/** Unique keys and CHECKs of the domain tables (0038) hold on both dialects; the drift test sees columns only. */
async function ins(db: DbClient, sql: string, params: unknown[]): Promise<boolean> {
  try {
    await db.run(sql, params as never);
    return true;
  } catch {
    return false;
  }
}

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`domain schema (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
      await db.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u1', 1, 1)`);
    });
    afterAll(async () => {
      await db.close();
    });
    const binding = (id: string, service: string, workspace: string, value: string, state = "observed") =>
      ins(
        db,
        `INSERT INTO bindings (id, user_id, service, kind, workspace, value, state, created_at, updated_at)
         VALUES (?, 'u1', ?, 'user', ?, ?, ?, 1, 1)`,
        [id, service, workspace, value, state],
      );

    test("a binding is unique per service, kind, workspace and value", async () => {
      expect(await binding("b1", "slack", "T0EXAMPLE", "U0EXAMPLE")).toBe(true);
      expect(await binding("b2", "slack", "T0EXAMPLE", "U0EXAMPLE")).toBe(false);
      expect(await binding("b3", "slack", "T0OTHER", "U0EXAMPLE")).toBe(true);
    });
    test("a slack binding needs a workspace; email does not", async () => {
      expect(await binding("b4", "slack", "", "U0NOWORK")).toBe(false);
      expect(await binding("b5", "email", "", "a@example.com")).toBe(true);
    });
    test("state is one of declared, observed, verified", async () => {
      expect(await binding("b6", "email", "", "b@example.com", "guessed")).toBe(false);
      expect(await binding("b7", "email", "", "c@example.com", "verified")).toBe(true);
    });
    test("a binding needs an existing user", async () => {
      const ok = await ins(
        db,
        `INSERT INTO bindings (id, user_id, service, kind, workspace, value, created_at, updated_at)
         VALUES ('b8', 'nobody', 'email', 'address', '', 'd@example.com', 1, 1)`,
        [],
      );
      expect(ok).toBe(false);
    });
    test("a boundary is unique per service, workspace and value, and slack needs a workspace", async () => {
      const b = (id: string, ws: string, v: string) =>
        ins(db, `INSERT INTO boundaries (id, service, workspace, value, created_at, updated_at) VALUES (?, 'slack', ?, ?, 1, 1)`, [id, ws, v]);
      expect(await b("c1", "T0EXAMPLE", "C0EXAMPLE")).toBe(true);
      expect(await b("c2", "T0EXAMPLE", "C0EXAMPLE")).toBe(false);
      expect(await b("c3", "", "C0NOWORK")).toBe(false);
    });
    test("an alias is keyed by the old id", async () => {
      const a = (old: string) => ins(db, `INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, 'u1', 1)`, [old]);
      expect(await a("old1")).toBe(true);
      expect(await a("old1")).toBe(false);
    });
  });
}
