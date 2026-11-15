/**
 * Person slices (slice F, task 5): every row is a rule of the plan. Placeholders only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { addTombstone } from "../../src/db/slice-tombstones";
import { legacyPersonSlices, personSlices, personSlicesDetailed } from "../../src/knowledge/person-slices";
import { userSourceId } from "../../src/knowledge/scope";
import { TEAM, TEAM2, nameOf, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

beforeEach(async () => {
  await resetWorld();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  spyOn(console, "warn").mockRestore();
});

const reads = async (id: string, team: string | null = TEAM) => (await personSlices(team, id)).reads;

describe("person slices resolver", () => {
  test("legacyPersonSlices is the own slice only and touches no database", () => {
    expect(legacyPersonSlices("U0EXAMPLE")).toEqual({ own: "user-u0example", reads: ["user-u0example"], via: "legacy", dropped: { conflict: 0, tombstoned: 0 } });
  });

  test("an unknown id, and a missing workspace, give legacy", async () => {
    expect(await reads("U0NOBODY")).toEqual([nameOf("U0NOBODY")]);
    expect((await personSlicesDetailed(TEAM, "U0NOBODY")).status).toBe("no_user");
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    expect(await reads("U0EXAMPLE", null)).toEqual([nameOf("U0EXAMPLE")]);
  });

  test("an observed acting id gets legacy even with verified siblings (Rule P, reader side)", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE", "observed");
    await slack(u, "U1EXAMPLE", "verified");
    expect(await reads("U0EXAMPLE")).toEqual([nameOf("U0EXAMPLE")]);
  });

  test("a verified acting id with an observed second id gets own only (the console-merge case)", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE", "verified");
    await slack(u, "U1EXAMPLE", "observed");
    await slack(u, "U2EXAMPLE", "declared");
    expect(await reads("U0EXAMPLE")).toEqual([nameOf("U0EXAMPLE")]);
  });

  test("verified with verified gives own plus the other, own first, both ways", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    expect(await reads("U0EXAMPLE")).toEqual([nameOf("U0EXAMPLE"), nameOf("U1EXAMPLE")]);
    expect(await reads("U1EXAMPLE")).toEqual([nameOf("U1EXAMPLE"), nameOf("U0EXAMPLE")]);
    expect((await personSlices(TEAM, "U0EXAMPLE")).via).toBe("union");
  });

  test("a verified second id in another workspace counts; the same id in two workspaces adds nothing new", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE", "verified", TEAM2);
    await slack(u, "U0EXAMPLE", "verified", TEAM2);
    expect(await reads("U0EXAMPLE")).toEqual([nameOf("U0EXAMPLE"), nameOf("U1EXAMPLE")]);
  });

  test("a name claimed by another live user is dropped (Rule Q), in any state or workspace, for both users", async () => {
    const a = await newUser();
    const b = await newUser();
    await slack(a, "U0AEXAMPLE");
    await slack(a, "U0XEXAMPLE");
    await slack(b, "U0BEXAMPLE");
    await slack(b, "U0XEXAMPLE", "verified", TEAM2);
    const ra = await personSlices(TEAM, "U0AEXAMPLE");
    expect(ra.reads).toEqual([nameOf("U0AEXAMPLE")]);
    expect(ra.dropped.conflict).toBe(1);
    expect((await personSlices(TEAM, "U0BEXAMPLE")).reads).toEqual([nameOf("U0BEXAMPLE")]);
    // An observed claim by a third user on an added id is enough as well; a claim on the acting id's own name never removes the own slice.
    const c = await newUser();
    await slack(c, "U0AEXAMPLE", "observed", TEAM2);
    await slack(a, "U0YEXAMPLE");
    await slack(c, "U0YEXAMPLE", "observed", TEAM2);
    await slack(a, "U0ZEXAMPLE");
    expect(await reads("U0AEXAMPLE")).toEqual([nameOf("U0AEXAMPLE"), nameOf("U0ZEXAMPLE")]);
  });

  test("the claim compares the slice name, so a lower-case twin of an id also conflicts", async () => {
    const a = await newUser();
    const b = await newUser();
    await slack(a, "U0AEXAMPLE");
    await slack(a, "U0XEXAMPLE");
    await slack(b, "u0xexample", "observed", TEAM2);
    expect(await reads("U0AEXAMPLE")).toEqual([nameOf("U0AEXAMPLE")]);
  });

  test("a tombstone drops one name, '*' drops all", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    await slack(u, "U2EXAMPLE");
    await addTombstone({ userId: u, sourceId: nameOf("U1EXAMPLE"), createdBy: "op", reason: "x" });
    const r = await personSlices(TEAM, "U0EXAMPLE");
    expect(r.reads).toEqual([nameOf("U0EXAMPLE"), nameOf("U2EXAMPLE")]);
    expect(r.dropped.tombstoned).toBe(1);
    await addTombstone({ userId: u, sourceId: "*", createdBy: "op", reason: "x" });
    const all = await personSlices(TEAM, "U0EXAMPLE");
    expect(all.reads).toEqual([nameOf("U0EXAMPLE")]);
    expect(all.via).toBe("legacy");
  });

  test("a tombstone does not touch another user, and the next read sees a removal", async () => {
    const u = await newUser();
    const other = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    await addTombstone({ userId: other, sourceId: nameOf("U1EXAMPLE"), createdBy: "op", reason: "x" });
    expect(await reads("U0EXAMPLE")).toHaveLength(2);
    await addTombstone({ userId: u, sourceId: nameOf("U1EXAMPLE"), createdBy: "op", reason: "x" });
    expect(await reads("U0EXAMPLE")).toHaveLength(1);
    await db.run("DELETE FROM slice_tombstones WHERE user_id = ?", [u]);
    expect(await reads("U0EXAMPLE")).toHaveLength(2);
  });

  test("unlink changes access on the next read (a binding that goes away leaves the union)", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    const second = await slack(u, "U1EXAMPLE");
    expect(await reads("U0EXAMPLE")).toHaveLength(2);
    await db.run("DELETE FROM bindings WHERE id = ?", [second]);
    expect(await reads("U0EXAMPLE")).toHaveLength(1);
    // A demotion (account deletion) does the same.
    const third = await slack(u, "U2EXAMPLE");
    expect(await reads("U0EXAMPLE")).toHaveLength(2);
    await db.run("UPDATE bindings SET state = 'observed' WHERE id = ?", [third]);
    expect(await reads("U0EXAMPLE")).toHaveLength(1);
  });

  test("a resolver error gives legacy and counts a failure, never a wider set", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    const bad = spyOn(Domain, "bindingsOf").mockImplementation(async () => {
      throw new Error("boom");
    });
    try {
      const r = await personSlicesDetailed(TEAM, "U0EXAMPLE");
      expect(r.status).toBe("error");
      expect(r.slices.reads).toEqual([nameOf("U0EXAMPLE")]);
    } finally {
      bad.mockRestore();
    }
  });

  test("a tombstone read failure gives legacy (Rule T)", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    await db.run("ALTER TABLE slice_tombstones RENAME TO slice_tombstones_x");
    try {
      const r = await personSlicesDetailed(TEAM, "U0EXAMPLE");
      expect(r.status).toBe("error");
      expect(r.slices.reads).toEqual([nameOf("U0EXAMPLE")]);
    } finally {
      await db.run("ALTER TABLE slice_tombstones_x RENAME TO slice_tombstones");
    }
  });

  test("a slow resolver is cut at the bound and gives legacy", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    const slow = spyOn(Domain, "bindingsOf").mockImplementation(() => new Promise(() => {}));
    try {
      const t0 = Date.now();
      const r = await personSlicesDetailed(TEAM, "U0EXAMPLE", { timeoutMs: 30 });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r.status).toBe("error");
      expect(r.slices.reads).toEqual([nameOf("U0EXAMPLE")]);
    } finally {
      slow.mockRestore();
    }
  });

  test("the output never contains a non user- name, and every added name comes from a verified binding", async () => {
    // Seeded random worlds: ids with odd characters, mixed states, two workspaces.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ids = ["U0AEXAMPLE", "U0BEXAMPLE", "U0C-EXAMPLE", "u0dexample", "U0EEXAMPLE", "U0F_EXAMPLE", "UAGENT", "SHARED", "PUBLIC", "KB-X"];
    for (let round = 0; round < 25; round++) {
      await resetWorld();
      const users = [await newUser(), await newUser(), await newUser()];
      const held: Array<{ user: string; value: string; state: Domain.State }> = [];
      for (const id of ids) {
        if (rnd() < 0.3) continue;
        const user = users[Math.floor(rnd() * users.length)]!;
        const state = (["observed", "verified", "verified", "declared"] as const)[Math.floor(rnd() * 4)]!;
        const team = rnd() < 0.7 ? TEAM : TEAM2;
        if (await Domain.findBinding({ service: "slack", kind: "user", workspace: team, value: id })) continue;
        await slack(user, id, state, team);
        held.push({ user, value: id, state });
      }
      for (const h of held) {
        const r = await personSlices(TEAM, h.value);
        for (const name of r.reads) expect(name).toMatch(/^user-[a-z0-9]*$/);
        expect(r.reads[0]).toBe(userSourceId(h.value));
        const added = r.reads.slice(1);
        const verifiedNames = new Set(held.filter((x) => x.user === h.user && x.state === "verified").map((x) => userSourceId(x.value)));
        for (const name of added) expect(verifiedNames.has(name)).toBe(true);
        const mine = held.find((x) => x.value === h.value);
        if (added.length > 0) expect(mine!.state).toBe("verified");
        for (const name of added) {
          const claimedElsewhere = held.some((x) => x.user !== h.user && userSourceId(x.value) === name);
          expect(claimedElsewhere).toBe(false);
        }
      }
    }
  });
});

afterAll(async () => {
  await cleanWorld();
});
