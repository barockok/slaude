import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { main } from "../../src/cli/domain";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { cleanWorld } from "../helpers/person-world";
import { listTombstones, tombstonesFor } from "../../src/db/slice-tombstones";

let user: string;
const run = async (args: string[]) => {
  const lines: string[] = [];
  const errs: string[] = [];
  const e = spyOn(console, "error").mockImplementation((s: unknown) => void errs.push(String(s)));
  const code = await main(["slice-tombstone", ...args], { out: (s) => lines.push(s) });
  e.mockRestore();
  return { code, lines, errs };
};

beforeEach(async () => {
  await db.run("DELETE FROM slice_tombstones");
  await db.run("DELETE FROM audit_events");
  await Accounts._wipeForTests();
  user = (await Domain.ensureUser({})).id;
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  spyOn(console, "log").mockRestore();
});

describe("slaude domain slice-tombstone", () => {
  test("add, list and remove, with an audit row for each change", async () => {
    const a = await run(["add", user, "user-u0example", "--reason", "left the team", "--by", "op@example.com"]);
    expect(a.code).toBe(0);
    expect(a.lines[0]).toContain("tombstone added");
    expect((await listTombstones())[0]).toMatchObject({ user_id: user, source_id: "user-u0example", created_by: expect.stringContaining("op@example.com [os:") });
    const l = await run(["list"]);
    expect(l.code).toBe(0);
    expect(l.lines[0]).toContain(`user=${user}`);
    expect(l.lines[0]).toContain("reason=left the team");
    const r = await run(["remove", user, "user-u0example", "--reason", "restored", "--by", "op@example.com"]);
    expect(r.code).toBe(0);
    expect(await listTombstones()).toEqual([]);
    const audits = await db.query<{ action: string; actor_kind: string; actor_id: string; target_id: string; details: unknown }>("SELECT action, actor_kind, actor_id, target_id, details FROM audit_events ORDER BY at, id");
    expect(audits.map((x) => x.action)).toEqual(["slice.tombstone_added", "slice.tombstone_removed"]);
    // --by is self-asserted, so the OS user is recorded beside it.
    expect(audits.every((x) => x.actor_kind === "operator" && x.actor_id.startsWith("op@example.com [os:"))).toBe(true);
    expect(JSON.stringify(audits[1]!.details)).toContain("restored");
    expect(audits[0]!.target_id).toBe(user);
  });

  test("a reason is required", async () => {
    const r = await run(["add", user, "user-u0example"]);
    expect(r.code).toBe(2);
    expect(r.errs.join("\n")).toContain("a reason is required");
    expect(await listTombstones()).toEqual([]);
    expect((await run(["add", user, "user-u0example", "--reason", "  "])).code).toBe(2);
  });

  test("'*' is accepted and applies to the whole union", async () => {
    expect((await run(["add", user, "*", "--reason", "no union"])).code).toBe(0);
    expect((await tombstonesFor(user)).all).toBe(true);
    expect((await run(["list"])).lines[0]).toContain("source=*");
  });

  test("a non user- source and an unknown user are refused", async () => {
    expect((await run(["add", user, "agent", "--reason", "x"])).code).toBe(2);
    expect((await run(["add", "no-such-user", "user-u0example", "--reason", "x"])).code).toBe(2);
  });

  test("output and audit rows show no Slack id", async () => {
    await run(["add", user, "user-u0example", "--reason", "gone", "--by", "op"]);
    const l = await run(["list"]);
    const j = await run(["list", "--json"]);
    const audits = JSON.stringify(await db.query("SELECT * FROM audit_events"));
    for (const text of [...l.lines, ...j.lines, audits]) expect(text.toLowerCase()).not.toContain("u0example");
  });

  test("remove requires a reason", async () => {
    await run(["add", user, "user-u0example", "--reason", "x"]);
    expect((await run(["remove", user, "user-u0example"])).code).toBe(2);
    expect(await listTombstones()).toHaveLength(1);
  });

  test("--source --all-readers adds and removes a source-level row for every reader, with no user id", async () => {
    const a = await run(["add", "--source", "user-u0example", "--all-readers", "--reason", "mistaken link"]);
    expect(a.code).toBe(0);
    expect(a.lines[0]).toContain("all-readers");
    expect((await tombstonesFor(user)).names).toEqual(new Set(["user-u0example"]));
    expect((await run(["list"])).lines[0]).toContain("all-readers");
    expect((await run(["add", "--source", "*", "--all-readers", "--reason", "x"])).code).toBe(2);
    expect((await run(["add", user, "--source", "user-u0example", "--all-readers", "--reason", "x"])).code).toBe(2);
    expect((await run(["remove", "--source", "user-u0example", "--all-readers"])).code).toBe(2);
    expect((await run(["remove", "--source", "user-u0example", "--all-readers", "--reason", "fixed"])).code).toBe(0);
    expect(await listTombstones()).toEqual([]);
  });

  test("removing what does not exist exits 1; bad usage exits 2", async () => {
    expect((await run(["remove", user, "user-u0example", "--reason", "x"])).code).toBe(1);
    expect((await run([])).code).toBe(2);
    expect((await run(["add", user])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
  });

  test("a tombstone keyed on a merged-away user id still matches the survivor", async () => {
    const survivor = (await Domain.ensureUser({})).id;
    expect((await run(["add", user, "user-u0example", "--reason", "x"])).code).toBe(0);
    await db.run("DELETE FROM users WHERE id = ?", [user]);
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, 1)", [user, survivor]);
    expect((await tombstonesFor(survivor)).names).toEqual(new Set(["user-u0example"]));
  });

  test("a node refuses", async () => {
    process.env.SLAUDE_ROLE = "node";
    try {
      expect((await run(["list"])).code).toBe(2);
    } finally {
      delete process.env.SLAUDE_ROLE;
    }
  });
});

afterAll(async () => {
  await cleanWorld();
});
