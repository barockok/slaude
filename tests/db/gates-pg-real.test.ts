import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { __resetDbForTests } from "../../src/db/client";
import { openBunSql } from "../../src/db/drivers/pg";
import * as PendingGates from "../../src/db/pending-gates";
import * as SeenEvents from "../../src/db/seen-events";

/**
 * M2 repos against a REAL Postgres server: the atomic-claim races that PGLite
 * (single connection) cannot exercise. Gated on SLAUDE_PG_TEST_URL /
 * SLAUDE_PG_URL like pg-real.test.ts; the facade is pointed at a scratch
 * database for the duration and restored after.
 */
const BASE_URL = process.env.SLAUDE_PG_TEST_URL ?? process.env.SLAUDE_PG_URL ?? "";
const enabled = BASE_URL.length > 0;

const SCRATCH = `slaude_scratch_${randomBytes(6).toString("hex")}`;
const origDb = process.env.SLAUDE_DB;
const origUrl = process.env.SLAUDE_PG_URL;

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!enabled)("gate repos against real Postgres", () => {
  beforeAll(async () => {
    const admin = await openBunSql(BASE_URL);
    await admin.exec(`CREATE DATABASE ${SCRATCH}`);
    await admin.close();
    await __resetDbForTests();
    process.env.SLAUDE_DB = "pg";
    process.env.SLAUDE_PG_URL = withDbName(BASE_URL, SCRATCH);
  });

  afterAll(async () => {
    await __resetDbForTests();
    if (origDb === undefined) delete process.env.SLAUDE_DB;
    else process.env.SLAUDE_DB = origDb;
    if (origUrl === undefined) delete process.env.SLAUDE_PG_URL;
    else process.env.SLAUDE_PG_URL = origUrl;
    const admin = await openBunSql(BASE_URL);
    await admin.exec(`DROP DATABASE ${SCRATCH} WITH (FORCE)`);
    await admin.close();
  });

  test("concurrent tryInsert on one event id: exactly one replica wins", async () => {
    for (let round = 0; round < 5; round++) {
      const id = `C1:${round}.${Date.now()}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () => SeenEvents.tryInsert(id)),
      );
      expect(results.filter(Boolean).length).toBe(1);
    }
  }, 30_000);

  test("concurrent resolve on one gate: exactly one click wins", async () => {
    for (let round = 0; round < 5; round++) {
      const id = `gate_${round}_${Date.now()}`;
      await PendingGates.create({ id, kind: "approval", sessionId: "S1" });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          PendingGates.resolve(id, i % 2 ? "approved" : "denied", `U${i}`),
        ),
      );
      const winners = results.filter((r) => r !== null);
      expect(winners.length).toBe(1);
      const final = (await PendingGates.get(id))!;
      expect(final.status).toBe(winners[0]!.status);
      expect(final.resolvedBy).toBe(winners[0]!.resolvedBy);
    }
  }, 30_000);

  test("payload survives the JSONB roundtrip on the wire driver", async () => {
    const payload = { toolName: "Bash", input: { command: "ls -la" }, n: 42, deep: { a: [1, 2] } };
    const row = await PendingGates.create({ kind: "perm", sessionId: "S1", payload });
    expect((await PendingGates.get(row.id))!.payload).toEqual(payload);
  }, 30_000);

  test("sweepExpired races a click: the row settles exactly once", async () => {
    const now = Date.now();
    const id = `sweep_${now}`;
    await PendingGates.create({ id, kind: "approval", sessionId: "S1", expiresAt: now - 1 });
    const [swept, clicked] = await Promise.all([
      PendingGates.sweepExpired(now),
      PendingGates.resolve(id, "approved", "U_CLICK"),
    ]);
    const sweptRow = swept.find((r) => r.id === id) ?? null;
    // One of the two settles the row; never both.
    expect([sweptRow, clicked].filter(Boolean).length).toBe(1);
    const final = (await PendingGates.get(id))!;
    expect(final.status).toBe((sweptRow ?? clicked)!.status);
  }, 30_000);
});
