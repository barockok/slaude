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
    // Rows carry the minting process's boot-time identity.
    expect(row.instanceId).toBe(PendingGates.INSTANCE_ID);
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

  test("purgeSettledOlderThan drops only old settled rows", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await PendingGates.create({ id: "old_done", kind: "perm", sessionId: "S1" });
    await PendingGates.resolve("old_done", "approved", "U1");
    await PendingGates.create({ id: "new_done", kind: "perm", sessionId: "S1" });
    await PendingGates.resolve("new_done", "denied", "U1");
    await PendingGates.create({ id: "still_open", kind: "perm", sessionId: "S1" });
    // Age the settled row past the horizon.
    await db.run(`UPDATE pending_gates SET resolved_at = ? WHERE id = 'old_done'`, [now - day - 1000]);

    expect(await PendingGates.purgeSettledOlderThan(day, now)).toBe(1);
    expect(await PendingGates.get("old_done")).toBeNull();
    expect((await PendingGates.get("new_done"))!.status).toBe("denied");
    // Pending rows are never purged, no matter how old.
    await db.run(`UPDATE pending_gates SET created_at = ? WHERE id = 'still_open'`, [now - 30 * day]);
    expect(await PendingGates.purgeSettledOlderThan(day, now)).toBe(0);
    expect((await PendingGates.get("still_open"))!.status).toBe("pending");
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

describe("pending-gates resolve payload patch", () => {
  test("patch merges into payload atomically with the status flip", async () => {
    await PendingGates.create({
      id: "tu_patch",
      kind: "perm",
      sessionId: "S9",
      payload: { toolName: "Bash", channel: "C1" },
    });
    const row = await PendingGates.resolve("tu_patch", "approved", "U9", { decision: "always" });
    expect(row?.status).toBe("approved");
    expect(row?.payload).toEqual({ toolName: "Bash", channel: "C1", decision: "always" });
    // Durable — a later read sees the merged payload.
    const read = await PendingGates.get("tu_patch");
    expect(read?.payload).toEqual({ toolName: "Bash", channel: "C1", decision: "always" });
    // A losing (already-settled) resolve with a patch changes nothing.
    const lost = await PendingGates.resolve("tu_patch", "denied", "U0", { decision: "allow" });
    expect(lost).toBeNull();
    expect((await PendingGates.get("tu_patch"))?.payload).toEqual({ toolName: "Bash", channel: "C1", decision: "always" });
  });
});
