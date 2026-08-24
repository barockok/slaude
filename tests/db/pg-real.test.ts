import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openDb, type DbClient } from "../../src/db/client";
import { runMigrations, appliedVersions, MIGRATE_LOCK_KEY } from "../../src/db/migrate";
import { redactPgUrl, openBunSql } from "../../src/db/drivers/pg";

/**
 * Tests against a REAL Postgres server (Bun.sql driver) — the races and type
 * mappings PGLite cannot model. Gated on SLAUDE_PG_TEST_URL (falls back to
 * SLAUDE_PG_URL); skipped when neither is set. The role must be allowed to
 * CREATE/DROP DATABASE: every test runs in its own scratch database.
 */
const BASE_URL = process.env.SLAUDE_PG_TEST_URL ?? process.env.SLAUDE_PG_URL ?? "";
const enabled = BASE_URL.length > 0;

function scratchName() {
  return `slaude_scratch_${randomBytes(6).toString("hex")}`;
}

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withScratchDb<T>(fn: (mk: () => Promise<DbClient>, url: string) => Promise<T>): Promise<T> {
  const admin = await openBunSql(BASE_URL);
  const name = scratchName();
  await admin.exec(`CREATE DATABASE ${name}`);
  const url = withDbName(BASE_URL, name);
  const opened: DbClient[] = [];
  try {
    return await fn(async () => {
      const c = await openBunSql(url);
      opened.push(c);
      return c;
    }, url);
  } finally {
    for (const c of opened) await c.close().catch(() => {});
    await admin.exec(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.close();
  }
}

describe.skipIf(!enabled)("db against real Postgres", () => {
  test("two concurrent runMigrations on an empty database both succeed", async () => {
    // The empty-database bootstrap race (CREATE TABLE IF NOT EXISTS is not
    // concurrency-safe: the loser dies on pg_type_typname_nsp_index) is the
    // exact failure the advisory lock exists for. Three fresh databases to
    // shake out scheduling luck.
    for (let round = 0; round < 3; round++) {
      await withScratchDb(async (mk) => {
        const [a, b] = await Promise.all([mk(), mk()]);
        const [ra, rb] = await Promise.all([
          runMigrations(a!, { log: () => {} }),
          runMigrations(b!, { log: () => {} }),
        ]);
        // Between them every migration ran exactly once.
        const all = [...ra.applied, ...rb.applied].sort();
        expect(all).toEqual(await appliedVersions(a!));
        expect(ra.applied.length + rb.applied.length).toBe(all.length);
        expect((await a!.query("SELECT * FROM tenants")).length).toBe(1);
      });
    }
  }, 60_000);

  test("int8 columns come back as JS numbers (parity with PGLite/sqlite)", async () => {
    await withScratchDb(async (mk) => {
      const db = await mk();
      await runMigrations(db, { log: () => {} });
      const now = Date.now();
      await db.run("INSERT INTO seen_events (event_id, ts) VALUES (?, ?)", ["e1", now]);
      const row = await db.one<{ ts: number }>("SELECT ts FROM seen_events WHERE event_id = ?", ["e1"]);
      expect(typeof row!.ts).toBe("number");
      expect(row!.ts).toBe(now);
      // BIGSERIAL ids too
      await db.run("INSERT INTO memory_turns (session_id, ts, user_text, assistant_text) VALUES (?, ?, ?, ?)", ["s", now, "u", "a"]);
      const t = await db.one<{ id: number; ts: number }>("SELECT id, ts FROM memory_turns");
      expect(typeof t!.id).toBe("number");
      expect(typeof t!.ts).toBe("number");
    });
  }, 30_000);

  test("driver contract: run().changes, ON CONFLICT, transaction rollback, exec.simple", async () => {
    await withScratchDb(async (mk) => {
      const db = await mk();
      await runMigrations(db, { log: () => {} });
      const now = Date.now();
      expect((await db.run("INSERT INTO seen_events (event_id, ts) VALUES (?, ?) ON CONFLICT DO NOTHING", ["x", now])).changes).toBe(1);
      expect((await db.run("INSERT INTO seen_events (event_id, ts) VALUES (?, ?) ON CONFLICT DO NOTHING", ["x", now])).changes).toBe(0);
      await expect(
        db.transaction(async (tx) => {
          await tx.run("DELETE FROM seen_events");
          await tx.transaction(async (inner) => {
            await inner.run("INSERT INTO seen_events (event_id, ts) VALUES (?, ?)", ["y", now]);
          });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await db.query("SELECT * FROM seen_events")).length).toBe(1);
      // multi-statement exec
      await db.exec("DELETE FROM seen_events; DELETE FROM memory_turns;");
      expect((await db.query("SELECT * FROM seen_events")).length).toBe(0);
      // advisory lock round-trip (idempotent double-unlock)
      const unlock = await db.advisoryLock!(101, 202);
      await unlock();
      await unlock();
    });
  }, 30_000);

  test("contended migration lock: logs a wait, and a timeout fails loudly", async () => {
    await withScratchDb(async (mk) => {
      const holder = await mk();
      const other = await mk();
      const unlock = await holder.advisoryLock!(...MIGRATE_LOCK_KEY);
      try {
        // Bounded wait: fails loudly, naming the tuning knob.
        const logs: string[] = [];
        const err = await runMigrations(other, { log: (m) => logs.push(m), lockTimeoutMs: 1200 }).then(
          () => null,
          (e: Error) => e.message,
        );
        expect(err).toContain("migrations not started");
        expect(err).toContain("SLAUDE_MIGRATE_LOCK_TIMEOUT_SEC");
        expect(logs.some((l) => l.includes("waiting for migration lock"))).toBe(true);
        // Unbounded wait: blocks until the holder releases, then completes.
        const pending = runMigrations(other, { log: () => {}, lockTimeoutMs: 0 });
        await Bun.sleep(300);
        await unlock();
        const done = await pending;
        expect(done.applied.length).toBeGreaterThanOrEqual(5);
      } finally {
        await unlock();
      }
    });
  }, 30_000);

  test("connect failure names SLAUDE_PG_URL with the password redacted", async () => {
    const bad = withDbName(BASE_URL, "definitely_missing_db_xyz");
    const err = await openBunSql(bad).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain("SLAUDE_PG_URL=");
    expect(err).toContain("definitely_missing_db_xyz");
    const u = new URL(BASE_URL);
    if (u.password) expect(err!).not.toContain(`:${u.password}@`);
  }, 30_000);
});

describe("redactPgUrl", () => {
  test("hides the password, tolerates garbage", () => {
    expect(redactPgUrl("postgres://user:hunter2@host:5432/db")).toBe("postgres://user:***@host:5432/db");
    expect(redactPgUrl("postgres://host/db")).toBe("postgres://host/db");
    expect(redactPgUrl("::not a url::")).toBe("<unparseable url>");
  });
});
