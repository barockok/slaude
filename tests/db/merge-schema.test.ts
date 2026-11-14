import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type DbClient, openDb } from "../../src/db/client";
import { loadMigrations, runMigrations } from "../../src/db/migrate";

/**
 * Migration 0041 (slice C, rc.21): merge ledger, proposals, vetoes. Keys and
 * CHECKs hold on both dialects (the drift test sees columns only).
 */
async function ins(db: DbClient, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await db.run(sql, params as never);
    return true;
  } catch {
    return false;
  }
}

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`merge schema (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    });
    afterAll(async () => {
      await db.close();
    });

    const merge = (id: string, loser: string, state = "applied", extra: { kind?: string; notice?: string; survivor?: string } = {}) =>
      ins(
        db,
        `INSERT INTO user_merges (id, created_at, kind, survivor_id, loser_id, state, undo_until, notice_state)
         VALUES (?, 1, ?, ?, ?, ?, 2, ?)`,
        [id, extra.kind ?? "proof", extra.survivor ?? "s1", loser, state, extra.notice ?? "pending"],
      );

    test("a loser is merged once while applied, and again after an undo", async () => {
      expect(await merge("m1", "l1")).toBe(true);
      expect(await merge("m2", "l1")).toBe(false);
      expect(await merge("m3", "l2")).toBe(true);
      await db.run(`UPDATE user_merges SET state = 'undone' WHERE id = 'm1'`);
      expect(await merge("m4", "l1")).toBe(true);
      // Two undone rows for one loser are fine.
      expect(await merge("m5", "l9", "undone")).toBe(true);
      expect(await merge("m6", "l9", "undone")).toBe(true);
    });

    test("ledger CHECKs: kind, state, notice_state, survivor differs from loser", async () => {
      expect(await merge("c1", "l10", "applied", { kind: "magic" })).toBe(false);
      expect(await merge("c2", "l11", "gone")).toBe(false);
      expect(await merge("c3", "l12", "applied", { notice: "later" })).toBe(false);
      expect(await merge("c4", "s1", "applied", { survivor: "s1" })).toBe(false);
      expect(await merge("c5", "l13", "applied", { kind: "console", notice: "sent" })).toBe(true);
    });

    const proposal = (id: string, a: string, b: string, reason: string, state = "open") =>
      ins(db, `INSERT INTO merge_proposals (id, created_at, user_a, user_b, reason, state) VALUES (?, 1, ?, ?, ?, ?)`, [id, a, b, reason, state]);

    test("a pair has one proposal per reason", async () => {
      expect(await proposal("p1", "a", "b", "conflict")).toBe(true);
      expect(await proposal("p2", "a", "b", "conflict")).toBe(false);
      expect(await proposal("p3", "a", "b", "two-emails")).toBe(true);
      expect(await proposal("p4", "a", "c", "conflict")).toBe(true);
    });

    test("proposal CHECKs: reason, state, a pair of two different users", async () => {
      expect(await proposal("p5", "d", "e", "alias")).toBe(false);
      expect(await proposal("p6", "d", "e", "conflict", "weird")).toBe(false);
      expect(await proposal("p7", "d", "d", "conflict")).toBe(false);
      expect(await proposal("p8", "d", "e", "conflict", "dismissed")).toBe(true);
    });

    test("a veto is unique per (Slack binding, oidc binding)", async () => {
      const veto = (id: string, s: string, o: string) =>
        ins(db, `INSERT INTO merge_vetoes (id, slack_binding_id, oidc_binding_id, created_by, created_at) VALUES (?, ?, ?, 'op', 1)`, [id, s, o]);
      expect(await veto("v1", "sb1", "ob1")).toBe(true);
      expect(await veto("v2", "sb1", "ob1")).toBe(false);
      expect(await veto("v3", "sb1", "ob2")).toBe(true);
      expect(await veto("v4", "sb2", "ob1")).toBe(true);
    });
  });
}

describe("upgrade from 0040", () => {
  test("pg: 0041 applies on top of 0040 data, touches nothing else, and reruns as a no-op", async () => {
    const db = await openDb({ dialect: "pg", driver: "pglite" });
    try {
      const all = loadMigrations();
      await runMigrations(db, { log: () => {}, migrations: all.filter((m) => m.version < "0041") });
      await db.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u1', 1, 1)`);
      const r = await runMigrations(db, { log: () => {}, migrations: all });
      expect(r.applied).toEqual(["0041"]);
      expect(await db.one("SELECT 1 AS x FROM users WHERE id = 'u1'")).not.toBeNull();
      expect(await db.one("SELECT COUNT(*) AS n FROM user_merges")).toEqual({ n: 0 });
      expect((await runMigrations(db, { log: () => {}, migrations: all })).applied).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
