import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, getDb, dbDialect, getSqliteRaw, __resetDbForTests } from "../../src/db/client";
import * as SO from "../../src/db/soul-overrides";
import * as OneOnOne from "../../src/db/one-on-one";
import { appliedVersions } from "../../src/db/migrate";

/**
 * Exercises the process-wide facade end to end on the dialect the suite is
 * NOT already running on, then restores the original singleton so later test
 * files see the DB they expect.
 */
const original = process.env.SLAUDE_DB;
const flipTo = (original ?? "sqlite").toLowerCase() === "pg" ? "sqlite" : "pg";

describe(`db facade (flipped to ${flipTo})`, () => {
  beforeAll(async () => {
    await __resetDbForTests();
    SO.__resetCacheForTests();
    process.env.SLAUDE_DB = flipTo;
  });

  afterAll(async () => {
    await __resetDbForTests();
    SO.__resetCacheForTests();
    if (original === undefined) delete process.env.SLAUDE_DB;
    else process.env.SLAUDE_DB = original;
    // re-open lazily on next use; nothing else to do
  });

  test("lazy open applies migrations (pg) or bootstrap (sqlite) and reports dialect", async () => {
    expect(dbDialect()).toBe(flipTo);
    expect(db.dialect).toBe(flipTo);
    const client = await getDb();
    expect(client.dialect).toBe(flipTo);
    expect(db.driver).toBe(client.driver);
    if (flipTo === "pg") {
      expect(getSqliteRaw()).toBeNull();
      expect((await appliedVersions(client)).length).toBeGreaterThanOrEqual(5);
    } else {
      expect(getSqliteRaw()).not.toBeNull();
    }
    // second call returns the same singleton
    expect(await getDb()).toBe(client);
  });

  test("facade query/one/run/exec/transaction route to the active client", async () => {
    await db.run("DELETE FROM mention_only_threads");
    expect((await db.run(
      "INSERT INTO mention_only_threads (channel_id, thread_ts, created_by, created_at) VALUES (?, ?, ?, ?)",
      ["C1", "1.0", "U1", Date.now()],
    )).changes).toBe(1);
    expect(await db.one<{ created_by: string }>("SELECT created_by FROM mention_only_threads WHERE channel_id = ?", ["C1"]))
      .toEqual({ created_by: "U1" });
    expect((await db.query("SELECT * FROM mention_only_threads")).length).toBe(1);
    await expect(
      db.transaction(async (tx) => {
        await tx.run("DELETE FROM mention_only_threads");
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect((await db.query("SELECT * FROM mention_only_threads")).length).toBe(1);
    await db.exec("DELETE FROM mention_only_threads");
    expect((await db.query("SELECT * FROM mention_only_threads")).length).toBe(0);
  });

  test("one_on_one_locks: lock / open / relock / unlock", async () => {
    await OneOnOne._wipeForTests();
    await OneOnOne.lock({ channelId: "C9", threadTs: "9.0", lockedUser: "U9", createdBy: "U9" });
    expect((await OneOnOne.find("C9", "9.0"))?.open_scope).toBeNull();
    await OneOnOne.setOpen("C9", "9.0", "billing only");
    expect((await OneOnOne.find("C9", "9.0"))?.open_scope).toBe("billing only");
    await OneOnOne.setLocked("C9", "9.0");
    expect((await OneOnOne.find("C9", "9.0"))?.open_scope).toBeNull();
    // re-lock replaces the owner and clears any open scope
    await OneOnOne.setOpen("C9", "9.0", "x");
    await OneOnOne.lock({ channelId: "C9", threadTs: "9.0", lockedUser: "U8", createdBy: "U8" });
    const row = await OneOnOne.find("C9", "9.0");
    expect(row?.locked_user).toBe("U8");
    expect(row?.open_scope).toBeNull();
    await OneOnOne.unlock("C9", "9.0");
    expect(await OneOnOne.find("C9", "9.0")).toBeNull();
  });

  test("soul overrides: listSync is coherent with upsert/clear/refresh", async () => {
    await SO.clear();
    SO.__resetCacheForTests();
    if (flipTo === "pg") {
      // cold cache on pg: empty now, filled once the kicked-off refresh lands
      expect(SO.listSync()).toEqual([]);
      await Bun.sleep(20);
    }
    expect(SO.listSync()).toEqual([]);
    await SO.upsert({ field: "blockedUsers", value: "U1", action: "add", created_by: "UM" });
    expect(SO.listSync().map((r) => [r.field, r.value, r.action])).toEqual([["blockedUsers", "U1", "add"]]);
    // a write that bypasses the module is invisible until refresh()
    await db.run("DELETE FROM soul_overrides");
    expect(SO.listSync().length).toBe(1);
    expect(await SO.refresh()).toEqual([]);
    expect(SO.listSync()).toEqual([]);
    // listSync hands out copies
    await SO.upsert({ field: "trustedChannels", value: "C1", action: "add", created_by: "UM" });
    const a = SO.listSync();
    a[0]!.value = "mutated";
    expect(SO.listSync()[0]!.value).toBe("C1");
    await SO.clear("trustedChannels");
    expect(await SO.list()).toEqual([]);
  });

  test("close + reset lets the next call re-resolve config", async () => {
    await __resetDbForTests();
    SO.__resetCacheForTests();
    expect(dbDialect()).toBe(flipTo);
    expect((await getDb()).dialect).toBe(flipTo);
  });
});

describe("SLAUDE_MIGRATE_ON_BOOT=0", () => {
  const originalDb = process.env.SLAUDE_DB;
  const originalUrl = process.env.SLAUDE_PG_URL;
  const originalDir = process.env.SLAUDE_PGLITE_DIR;
  const originalMigrate = process.env.SLAUDE_MIGRATE_ON_BOOT;

  afterAll(async () => {
    await __resetDbForTests();
    if (originalDb === undefined) delete process.env.SLAUDE_DB;
    else process.env.SLAUDE_DB = originalDb;
    if (originalUrl === undefined) delete process.env.SLAUDE_PG_URL;
    else process.env.SLAUDE_PG_URL = originalUrl;
    if (originalDir === undefined) delete process.env.SLAUDE_PGLITE_DIR;
    else process.env.SLAUDE_PGLITE_DIR = originalDir;
    if (originalMigrate === undefined) delete process.env.SLAUDE_MIGRATE_ON_BOOT;
    else process.env.SLAUDE_MIGRATE_ON_BOOT = originalMigrate;
  });

  test("opts a pg boot out of applying migrations", async () => {
    await __resetDbForTests();
    process.env.SLAUDE_DB = "pg";
    // Force an isolated in-memory PGLite regardless of the outer run's real
    // Postgres — that DB is a shared, persistent service across the whole CI
    // job, so schema_migrations already exists there from earlier tests and
    // its absence can only prove anything against a database this test knows
    // is untouched.
    delete process.env.SLAUDE_PG_URL;
    delete process.env.SLAUDE_PGLITE_DIR;
    process.env.SLAUDE_MIGRATE_ON_BOOT = "0";
    const client = await getDb();
    expect(client.dialect).toBe("pg");
    expect(client.driver).toBe("pglite");
    // schema_migrations is only created by runMigrations — its absence proves
    // the run was skipped, not merely that it applied zero files.
    await expect(appliedVersions(client)).rejects.toThrow();
  });
});
