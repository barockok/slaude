/**
 * Operator tombstones (slice F, task 4): a revoke for the read-time memory union
 * that outlives the merge undo window. Keyed by user id with no foreign key; a
 * read matches the live id plus the user_aliases.old_id values of that user.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { cleanWorld } from "../helpers/person-world";
import { addTombstone, listTombstones, maskSource, removeTombstone, tombstonesFor } from "../../src/db/slice-tombstones";

beforeEach(async () => {
  await db.run("DELETE FROM slice_tombstones");
  await Accounts._wipeForTests();
});

const user = async () => (await Domain.ensureUser({})).id;

describe("slice tombstones", () => {
  test("add, list and remove", async () => {
    const u = await user();
    expect((await addTombstone({ userId: u, sourceId: "user-u0example", createdBy: "cli:op", reason: "left the team" })).ok).toBe(true);
    const rows = await listTombstones();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: u, source_id: "user-u0example", created_by: "cli:op", reason: "left the team" });
    expect(await removeTombstone(u, "user-u0example")).toBe(true);
    expect(await removeTombstone(u, "user-u0example")).toBe(false);
    expect(await listTombstones()).toEqual([]);
  });

  test("a reason is required, and so is a known user", async () => {
    const u = await user();
    expect(await addTombstone({ userId: u, sourceId: "user-u0example", createdBy: "op", reason: "   " })).toEqual({ ok: false, error: "a reason is required" });
    expect((await addTombstone({ userId: "no-such-user", sourceId: "user-u0example", createdBy: "op", reason: "x" })).ok).toBe(false);
    expect(await listTombstones()).toEqual([]);
  });

  test("'*' is accepted; only user- names and '*' are", async () => {
    const u = await user();
    expect((await addTombstone({ userId: u, sourceId: "*", createdBy: "op", reason: "no union" })).ok).toBe(true);
    for (const bad of ["agent", "agent-abc", "shared", "public", "kb-x", "profile-t0-u0", "user-", "User-ABC", "user-a b", ""]) {
      expect((await addTombstone({ userId: u, sourceId: bad, createdBy: "op", reason: "x" })).ok).toBe(false);
    }
  });

  test("adding twice is idempotent (one row, the first reason stays)", async () => {
    const u = await user();
    await addTombstone({ userId: u, sourceId: "user-u0example", createdBy: "op", reason: "first" });
    const again = await addTombstone({ userId: u, sourceId: "user-u0example", createdBy: "op2", reason: "second" });
    expect(again).toEqual({ ok: true, created: false });
    expect((await listTombstones())[0]!.reason).toBe("first");
  });

  test("tombstonesFor reports names and the all flag for the live user", async () => {
    const u = await user();
    await addTombstone({ userId: u, sourceId: "user-u1example", createdBy: "op", reason: "x" });
    expect(await tombstonesFor(u)).toEqual({ all: false, names: new Set(["user-u1example"]) });
    await addTombstone({ userId: u, sourceId: "*", createdBy: "op", reason: "x" });
    expect((await tombstonesFor(u)).all).toBe(true);
    expect(await tombstonesFor(await user())).toEqual({ all: false, names: new Set() });
  });

  test("a tombstone keyed on a merged-away user id still matches the survivor through user_aliases", async () => {
    const survivor = await user();
    const loser = await user();
    await addTombstone({ userId: loser, sourceId: "user-u2example", createdBy: "op", reason: "x" });
    expect((await tombstonesFor(survivor)).names.size).toBe(0);
    // The merge engine deletes the loser row and records the alias.
    await db.run("DELETE FROM users WHERE id = ?", [loser]);
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, 1)", [loser, survivor]);
    expect((await tombstonesFor(survivor)).names).toEqual(new Set(["user-u2example"]));
    // The row itself survived the user delete (no foreign key).
    expect(await listTombstones()).toHaveLength(1);
  });

  test("an old id from the other side of a chain does not match someone else", async () => {
    const a = await user();
    const b = await user();
    await addTombstone({ userId: a, sourceId: "user-u3example", createdBy: "op", reason: "x" });
    expect((await tombstonesFor(b)).names.size).toBe(0);
  });

  test("maskSource shows no Slack id", () => {
    expect(maskSource("*")).toBe("*");
    const m = maskSource("user-u0example");
    expect(m).not.toContain("u0example");
    // Prefix and length only: no hash of an enumerable id.
    expect(m).toMatch(/^user-\*+ \(\d+\)$/);
    expect(maskSource("user-u0example")).toBe(m);
  });
});

afterAll(async () => {
  await cleanWorld();
});
