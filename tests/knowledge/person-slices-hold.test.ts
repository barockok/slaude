/**
 * Review fixes for the union: the hold on an ADDED binding (a mistaken link), the
 * authoritative link table (Rule P2: a missed unlink projection cannot keep a union
 * alive), and source-level tombstones that survive a relink to another account.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";
import { addTombstone, tombstonesFor } from "../../src/db/slice-tombstones";
import { personSlices } from "../../src/knowledge/person-slices";
import { TEAM, nameOf, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

const HOUR = 3_600_000;
const age = (value: string, ms: number) => db.run("UPDATE bindings SET verified_at = ? WHERE service = 'slack' AND value = ?", [Date.now() - ms, value]);

beforeEach(async () => {
  await resetWorld();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS;
  spyOn(console, "warn").mockRestore();
});

describe("the hold on the added binding", () => {
  async function pair() {
    const u = await newUser();
    await slack(u, "U0AEXAMPLE");
    await slack(u, "U1AEXAMPLE");
    return u;
  }

  test("a fresh added binding is held for 24 hours by default, then joins", async () => {
    delete process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS;
    await pair();
    await age("U0AEXAMPLE", 100 * HOUR); // the acting binding's age does not matter
    const held = await personSlices(TEAM, "U0AEXAMPLE");
    expect(held.reads).toEqual([nameOf("U0AEXAMPLE")]);
    expect(held.dropped.held).toBe(1);
    await age("U1AEXAMPLE", 23 * HOUR);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(1);
    await age("U1AEXAMPLE", 25 * HOUR);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE"), nameOf("U1AEXAMPLE")]);
  });

  test("the hold is per added binding: the old id is readable by the new one only once the OLD id's own age passes", async () => {
    delete process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS;
    await pair();
    await age("U0AEXAMPLE", 48 * HOUR); // old
    // U1 (fresh) reads U0 (old, added) at once; U0 does not read U1 (fresh, added) yet.
    expect((await personSlices(TEAM, "U1AEXAMPLE")).reads).toEqual([nameOf("U1AEXAMPLE"), nameOf("U0AEXAMPLE")]);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]);
  });

  test("SLAUDE_PERSON_SLICES_HOLD_HOURS sets the window, 0 disables it", async () => {
    await pair();
    process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "1";
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(1);
    await age("U1AEXAMPLE", 2 * HOUR);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(2);
    process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "0";
    await age("U1AEXAMPLE", 0);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(2);
    process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "garbage";
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(1); // unknown reads as the 24 hour default
  });

  test("a binding with no verified_at is held, never trusted", async () => {
    await pair();
    process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "1";
    await db.run("UPDATE bindings SET verified_at = NULL WHERE value = 'U1AEXAMPLE'");
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(1);
  });

  test("a tombstone can revoke it after the hold, and a wrong-human link is unreadable during the hold", async () => {
    // Human X proves U0A on an account. A mistaken link then puts human Y's U1A on the same account.
    const u = await pair();
    process.env.SLAUDE_PERSON_SLICES_HOLD_HOURS = "24";
    await age("U0AEXAMPLE", 72 * HOUR);
    await age("U1AEXAMPLE", 1 * HOUR);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]); // Y's slice is closed to the account's other id
    await age("U1AEXAMPLE", 30 * HOUR);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(2);
    await addTombstone({ userId: u, sourceId: nameOf("U1AEXAMPLE"), createdBy: "op", reason: "mistaken link" });
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]);
  });
});

describe("Rule P2: the authoritative link table", () => {
  test("a verified binding with no link contributes nothing, on either side", async () => {
    const u = await newUser();
    await slack(u, "U0AEXAMPLE");
    await slack(u, "U1AEXAMPLE", "verified", TEAM, { link: false });
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]); // added side
    expect((await personSlices(TEAM, "U1AEXAMPLE")).reads).toEqual([nameOf("U1AEXAMPLE")]); // reader side
  });

  test("an unlink whose projection failed cuts the union on the next read", async () => {
    const a = await Accounts.upsertAccount({ issuer: "https://idp.example.com", subject: "s1", email: "s1@example.com" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0AEXAMPLE", accountId: a.id, via: "test" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U1AEXAMPLE", accountId: a.id, via: "test" });
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(2);
    const bad = spyOn(Domain, "findBinding").mockRejectedValue(new Error("projection down"));
    try {
      expect(await Accounts.unlinkSlackIdentity(TEAM, "U1AEXAMPLE", a.id)).toBe(true);
    } finally {
      bad.mockRestore();
    }
    // The verified binding outlived the link row (the projection was swallowed) ...
    expect((await Domain.findBinding({ service: "slack", kind: "user", workspace: TEAM, value: "U1AEXAMPLE" }))!.state).toBe("verified");
    // ... and the union is cut anyway, for the unlinked id and for the one that remains.
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]);
    expect((await personSlices(TEAM, "U1AEXAMPLE")).reads).toEqual([nameOf("U1AEXAMPLE")]);
  });

  test("a link to an account of a DIFFERENT user does not count for this one", async () => {
    const u = await newUser();
    await slack(u, "U0AEXAMPLE");
    await slack(u, "U1AEXAMPLE", "verified", TEAM, { link: false });
    const other = await newUser();
    await slack(other, "U9AEXAMPLE"); // makes the other user's account
    await db.run("INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via) VALUES (?, 'U1AEXAMPLE', ?, 1, 'test')", [TEAM, `acc-${other}`]);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]);
  });
});

describe("source-level tombstones", () => {
  test("an all-readers row removes the name for every reader, and survives a relink that makes a new user", async () => {
    const u = await newUser();
    await slack(u, "U0AEXAMPLE");
    await slack(u, "U1AEXAMPLE");
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toHaveLength(2);
    expect((await addTombstone({ userId: "*", sourceId: nameOf("U1AEXAMPLE"), createdBy: "op", reason: "mistaken link" })).ok).toBe(true);
    expect((await personSlices(TEAM, "U0AEXAMPLE")).reads).toEqual([nameOf("U0AEXAMPLE")]);
    // The person relinks everything to another account: a brand new user. The row still applies.
    const v = await newUser();
    await slack(v, "U2AEXAMPLE");
    await slack(v, "U1AEXAMPLE", "verified", "T1EXAMPLE");
    expect((await personSlices(TEAM, "U2AEXAMPLE")).reads).toEqual([nameOf("U2AEXAMPLE")]);
    expect((await tombstonesFor(v)).names).toEqual(new Set([nameOf("U1AEXAMPLE")]));
  });

  test("('*','*') is refused and a source-level row needs a reason", async () => {
    expect((await addTombstone({ userId: "*", sourceId: "*", createdBy: "op", reason: "x" })).ok).toBe(false);
    expect((await addTombstone({ userId: "*", sourceId: "user-u1aexample", createdBy: "op", reason: " " })).ok).toBe(false);
  });
});

describe("the link audit under the union", () => {
  afterEach(() => {
    delete process.env.SLAUDE_PERSON_SLICES;
  });
  const events = () => db.query<{ action: string; target_id: string; details: unknown; summary: string }>("SELECT action, target_id, details, summary FROM audit_events WHERE action = 'slice.union_link'");

  test("a new link writes one event with account ids only; a replay and the off mode write none", async () => {
    await db.run("DELETE FROM audit_events");
    const a = await Accounts.upsertAccount({ issuer: "https://idp.example.com", subject: "s1", email: "s1@example.com" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0AEXAMPLE", accountId: a.id, via: "test" });
    expect(await events()).toEqual([]); // off by default
    process.env.SLAUDE_PERSON_SLICES = "union";
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U1AEXAMPLE", accountId: a.id, via: "test" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U1AEXAMPLE", accountId: a.id, via: "test" }); // replay: not created
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe(a.id);
    expect(JSON.stringify(rows[0]).toUpperCase()).not.toContain("U1AEXAMPLE");
    expect(rows[0]!.summary).toContain("hour hold");
  });
});

afterAll(async () => {
  await cleanWorld();
});
