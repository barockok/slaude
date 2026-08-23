import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../src/db/schema";
import * as PendingGates from "../../src/db/pending-gates";

beforeEach(async () => {
  await db.run("DELETE FROM pending_gates");
});

describe("pending-gates repo", () => {
  test("create → get roundtrip with payload and defaults", async () => {
    const row = await PendingGates.create({
      id: "tu_1",
      kind: "perm",
      sessionId: "S1",
      payload: { toolName: "Bash", channel: "C1" },
    });
    expect(row).toMatchObject({
      id: "tu_1",
      sessionId: "S1",
      kind: "perm",
      status: "pending",
      payload: { toolName: "Bash", channel: "C1" },
      resolvedBy: null,
      resolvedAt: null,
      expiresAt: null,
    });
    expect(typeof row.createdAt).toBe("number");
    expect(await PendingGates.get("tu_1")).toEqual(row);
    expect(await PendingGates.get("missing")).toBeNull();
  });

  test("create with generated id and empty payload", async () => {
    const row = await PendingGates.create({ kind: "approval", sessionId: "S2" });
    expect(row.id.length).toBeGreaterThan(0);
    expect(row.payload).toEqual({});
  });

  test("resolve is a one-winner guard: second click loses", async () => {
    await PendingGates.create({ id: "g1", kind: "approval", sessionId: "S1" });
    const first = await PendingGates.resolve("g1", "approved", "U_APPROVER");
    expect(first).toMatchObject({ id: "g1", status: "approved", resolvedBy: "U_APPROVER" });
    expect(typeof first!.resolvedAt).toBe("number");
    // Duplicate click — already settled, caller must treat as stale.
    expect(await PendingGates.resolve("g1", "denied", "U_LATE")).toBeNull();
    expect((await PendingGates.get("g1"))!.status).toBe("approved");
    // Unknown id — stale too.
    expect(await PendingGates.resolve("nope", "denied", "U")).toBeNull();
  });

  test("two concurrent resolves: exactly one wins", async () => {
    await PendingGates.create({ id: "race", kind: "perm", sessionId: "S1" });
    const [a, b] = await Promise.all([
      PendingGates.resolve("race", "approved", "U_A"),
      PendingGates.resolve("race", "denied", "U_B"),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    const final = (await PendingGates.get("race"))!;
    const winner = (a ?? b)!;
    expect(final.status).toBe(winner.status);
    expect(final.resolvedBy).toBe(winner.resolvedBy);
  });

  test("sweepExpired expires overdue pending rows only", async () => {
    const now = Date.now();
    await PendingGates.create({ id: "due", kind: "approval", sessionId: "S1", expiresAt: now - 1 });
    await PendingGates.create({ id: "later", kind: "approval", sessionId: "S1", expiresAt: now + 60_000 });
    await PendingGates.create({ id: "open", kind: "perm", sessionId: "S1" }); // no deadline
    await PendingGates.create({ id: "done", kind: "approval", sessionId: "S1", expiresAt: now - 1 });
    await PendingGates.resolve("done", "approved", "U1"); // settled before the sweep

    const swept = await PendingGates.sweepExpired(now);
    expect(swept.map((r) => r.id)).toEqual(["due"]);
    expect(swept[0]).toMatchObject({ status: "expired", resolvedBy: "system" });
    expect((await PendingGates.get("later"))!.status).toBe("pending");
    expect((await PendingGates.get("open"))!.status).toBe("pending");
    expect((await PendingGates.get("done"))!.status).toBe("approved");
    // Expired row can no longer be resolved by a late click.
    expect(await PendingGates.resolve("due", "approved", "U_LATE")).toBeNull();
  });

  test("unparseable payload maps to an empty object", async () => {
    if (db.dialect !== "sqlite") return; // Postgres JSONB rejects bad JSON at insert
    await db.run(
      `INSERT INTO pending_gates (id, session_id, kind, payload, status, created_at)
       VALUES ('bad', 'S1', 'perm', 'not-json', 'pending', ?)`,
      [Date.now()],
    );
    expect((await PendingGates.get("bad"))!.payload).toEqual({});
  });
});
