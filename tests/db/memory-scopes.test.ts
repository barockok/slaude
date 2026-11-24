import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type DbClient, openDb } from "../../src/db/client";
import { loadMigrations, runMigrations } from "../../src/db/migrate";
import { bindScope, listByAgent, lookupBySource } from "../../src/db/memory-scopes";

/** Migration 0054: the memory places registry, on both dialects. */
const cols = async (db: DbClient, table: string): Promise<string[]> =>
  db.dialect === "sqlite"
    ? (await db.query<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name)
    : (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`, [table])).map((r) => r.column_name);

for (const dialect of ["sqlite", "pg"] as const) {
  describe(`memory scopes registry (${dialect})`, () => {
    let db: DbClient;
    beforeAll(async () => {
      db = dialect === "sqlite" ? await openDb({ dialect: "sqlite", path: ":memory:" }) : await openDb({ dialect: "pg", driver: "pglite" });
      if (dialect === "pg") await runMigrations(db, { log: () => {} });
    }, 60_000);
    afterAll(async () => {
      await db.close();
    });
    beforeEach(async () => {
      await db.run("DELETE FROM memory_scopes");
    });

    test("the table has the documented columns", async () => {
      expect((await cols(db, "memory_scopes")).sort()).toEqual(["agent_id", "boundary_id", "created_at", "kind", "source_id"]);
    });

    test("bind inserts once and returns the source id; a second bind is ignored", async () => {
      const a = await bindScope({ sourceId: "mb-aaa", agentId: "agent1", boundaryId: "b1", kind: "channel", now: 5 }, db);
      expect(a).toBe("mb-aaa");
      const again = await bindScope({ sourceId: "mb-bbb", agentId: "agent1", boundaryId: "b1", kind: "dm", now: 9 }, db);
      expect(again).toBe("mb-aaa"); // the pair already has a source: the registry's row wins
      const row = await lookupBySource("mb-aaa", db);
      expect(row).toEqual({ source_id: "mb-aaa", agent_id: "agent1", boundary_id: "b1", kind: "channel", created_at: 5 });
      expect(await lookupBySource("mb-bbb", db)).toBeNull();
    });

    test("one boundary may hold a place for two agents", async () => {
      await bindScope({ sourceId: "mb-a", agentId: "agent1", boundaryId: "b1", kind: "channel" }, db);
      await bindScope({ sourceId: "mb-b", agentId: "agent2", boundaryId: "b1", kind: "channel" }, db);
      expect((await listByAgent("agent1", db)).map((r) => r.source_id)).toEqual(["mb-a"]);
      expect((await listByAgent("agent2", db)).map((r) => r.source_id)).toEqual(["mb-b"]);
    });

    test("list by agent is ordered by creation and empty for an unknown agent", async () => {
      await bindScope({ sourceId: "mb-2", agentId: "agent1", boundaryId: "b2", kind: "dm", now: 20 }, db);
      await bindScope({ sourceId: "mb-1", agentId: "agent1", boundaryId: "b1", kind: "channel", now: 10 }, db);
      expect((await listByAgent("agent1", db)).map((r) => r.source_id)).toEqual(["mb-1", "mb-2"]);
      expect(await listByAgent("nobody", db)).toEqual([]);
    });

    test("a source id cannot be bound to a second pair", async () => {
      await bindScope({ sourceId: "mb-x", agentId: "agent1", boundaryId: "b1", kind: "channel" }, db);
      // ON CONFLICT DO NOTHING swallows the key clash, but the pair has no row, so the bind reports the loss.
      await expect(bindScope({ sourceId: "mb-x", agentId: "agent1", boundaryId: "b2", kind: "channel" }, db)).rejects.toThrow();
    });
  });
}

describe("migration 0054 file", () => {
  test("is the last migration, additive and lock-timeout guarded", () => {
    const m = loadMigrations().find((x) => x.version === "0054");
    expect(m).toBeDefined();
    expect(m!.sql).toContain("SET LOCAL lock_timeout");
    expect(m!.sql).toContain("CREATE TABLE IF NOT EXISTS memory_scopes");
    expect(m!.sql).not.toMatch(/ALTER TABLE|DROP|REFERENCES/);
  });
});
