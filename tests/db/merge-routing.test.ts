import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";
import * as Domain from "../../src/db/domain";
import { db } from "../../src/db/schema";

/**
 * Proof paths run through the merge engine (slice C, task 26): the observable
 * result of adopt, login and link is what it was in rc.19, plus a ledger row,
 * a `user.merged` audit event, and a proposal wherever a merge is refused.
 */
const ISS = "https://idp.example.com";
const TEAM = "T0EXAMPLE";
const mail = (value: string) => ({ service: "email", kind: "address", workspace: "", value });
const oidc = (subject: string) => ({ service: "oidc", kind: "subject", workspace: ISS, value: subject });
const slack = (value: string, team = TEAM) => ({ service: "slack", kind: "user", workspace: team, value });
const count = async (t: string, where = "1 = 1") => Number((await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))!.n);

beforeEach(async () => {
  await Accounts._wipeForTests();
  await db.run("DELETE FROM audit_events");
  await db.run("DELETE FROM link_token_uses");
  delete process.env.SLAUDE_AUTO_MERGE;
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_AUTO_MERGE;
  spyOn(console, "warn").mockRestore();
  spyOn(console, "log").mockRestore();
});

async function seenInSlack(value: string, extra: { email?: string } = {}) {
  const r = await Domain.ensureBinding({ ...slack(value), state: "observed", source: "test" });
  if (extra.email) await Domain.ensureBinding({ ...mail(extra.email), userId: r.userId, state: "observed", source: "test" });
  return r.userId;
}

describe("link", () => {
  test("a Slack binding held by an observed record merges through the engine, with a ledger row and an audit event", async () => {
    const seen = await seenInSlack("U0SEEN");
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" })).toEqual({ ok: true, created: true });
    const acctUser = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    const b = (await Domain.findBinding(slack("U0SEEN")))!;
    expect(b.user_id).toBe(acctUser);
    expect(b.state).toBe("verified");
    expect(await Domain.resolveUserId(seen)).toBe(acctUser);
    const ledger = await db.one<{ kind: string; survivor_id: string; loser_id: string; moved: string; proof: string }>("SELECT * FROM user_merges");
    expect(ledger).toMatchObject({ kind: "proof", survivor_id: acctUser, loser_id: seen });
    const oidcB = (await Domain.findBinding(oidc("sub-1")))!;
    expect(JSON.parse(ledger!.proof)).toEqual({ slack: b.id, oidc: oidcB.id });
    const moved = JSON.parse(ledger!.moved);
    expect(moved.raised).toEqual([{ binding_id: b.id, from_state: "observed", to_state: "verified", verified_at: expect.any(Number) }]);
    expect(await count("audit_events", "action = 'user.merged'")).toBe(1);
    expect(await count("audit_events", "action = 'user.adopted'")).toBe(1);
  });

  test("SLAUDE_AUTO_MERGE=off: nothing moves, a proposal is opened, the link itself still stands", async () => {
    process.env.SLAUDE_AUTO_MERGE = "off";
    const seen = await seenInSlack("U0SEEN");
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    expect((await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link" })).ok).toBe(true);
    expect((await Domain.findBinding(slack("U0SEEN")))?.user_id).toBe(seen);
    expect((await Domain.findBinding(slack("U0SEEN")))?.state).toBe("observed");
    expect(await count("user_merges")).toBe(0);
    expect(await db.one<{ reason: string; state: string }>("SELECT reason, state FROM merge_proposals")).toMatchObject({ reason: "conflict", state: "open" });
    expect(await Domain.getUser(seen)).not.toBeNull();
  });

  test("an unheld Slack id creates no merge", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0NEW", accountId: a.id, via: "signed-link" });
    expect(await count("user_merges")).toBe(0);
    expect((await Domain.findBinding(slack("U0NEW")))?.state).toBe("verified");
  });

  test("a verified holder is a conflict and a proposal, the existing result", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com", emailProven: true });
    await Domain.ensureBinding({ ...slack("U0X"), userId: (await Domain.findBinding(oidc("sub-2")))!.user_id, state: "verified", source: "test" });
    await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0X", accountId: a.id, via: "signed-link" });
    expect((await Domain.findBinding(slack("U0X")))?.user_id).toBe((await Domain.findBinding(oidc("sub-2")))!.user_id);
    expect(await count("user_merges")).toBe(0);
    expect(await count("merge_proposals")).toBe(1);
    void b;
  });

  test("a vetoed (Slack binding, account) pair is refused and the token is not spent", async () => {
    await seenInSlack("U0SEEN");
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: true });
    const sb = (await Domain.findBinding(slack("U0SEEN")))!;
    const ob = (await Domain.findBinding(oidc("sub-1")))!;
    await db.run("INSERT INTO merge_vetoes (id, slack_binding_id, oidc_binding_id, created_by, created_at) VALUES ('v1', ?, ?, 'op', 1)", [sb.id, ob.id]);
    const token = { jti: "veto-test", expiresAt: Date.now() + 60_000 };
    expect(await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: a.id, via: "signed-link", token })).toEqual({ ok: false, reason: "vetoed" });
    expect(await Accounts.accountForSlackUser(TEAM, "U0SEEN")).toBeNull();
    expect(await db.one("SELECT jti FROM link_token_uses WHERE jti = 'veto-test'")).toBeNull();
    expect((await Domain.findBinding(slack("U0SEEN")))?.user_id).toBe(sb.user_id);
    // Another account is not affected by the veto.
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com", emailProven: true });
    expect((await Accounts.linkSlackIdentity({ teamId: TEAM, slackUserId: "U0SEEN", accountId: other.id, via: "signed-link" })).ok).toBe(true);
  });
});

describe("login", () => {
  test("a proven email held by an observed record merges it into the account user, raising the email once", async () => {
    const seen = await seenInSlack("U0SEEN", { email: "alice@example.com" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "Alice@Example.com", emailProven: true });
    const acctUser = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    expect((await Domain.findBinding(mail("alice@example.com")))).toMatchObject({ user_id: acctUser, state: "verified" });
    expect((await Domain.findBinding(slack("U0SEEN")))?.user_id).toBe(acctUser);
    expect((await Domain.findBinding(slack("U0SEEN")))?.state).toBe("observed");
    expect(await Domain.resolveUserId(seen)).toBe(acctUser);
    const row = await db.one<{ kind: string; moved: string }>("SELECT kind, moved FROM user_merges");
    expect(row!.kind).toBe("proof");
    expect(JSON.parse(row!.moved).raised).toHaveLength(1);
  });

  test("an unproven email never merges anything", async () => {
    await seenInSlack("U0SEEN", { email: "alice@example.com" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com", emailProven: false });
    expect(await count("user_merges")).toBe(0);
    expect(await count("merge_proposals")).toBe(0);
  });

  test("a plus alias is a different address: never merged, no proposal", async () => {
    await seenInSlack("U0SEEN", { email: "alice@example.com" });
    await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice+work@example.com", emailProven: true });
    expect(await count("user_merges")).toBe(0);
    expect(await count("merge_proposals")).toBe(0);
    expect((await Domain.findBinding(mail("alice@example.com")))?.state).toBe("observed");
    expect((await Domain.findBinding(mail("alice+work@example.com")))?.state).toBe("verified");
  });

  test("a second, different verified email on one record is a two-emails proposal", async () => {
    // The account's user already holds a verified email from another source; a proven login brings a second one that an observed record holds.
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "one@example.com", emailProven: true });
    const acctUser = (await Domain.findBinding(oidc("sub-1")))!.user_id;
    await seenInSlack("U0SEEN", { email: "two@example.com" });
    const held = (await Domain.findBinding(mail("two@example.com")))!;
    const r = await Domain.adoptBinding({ ...mail("two@example.com"), toUserId: acctUser, state: "verified" });
    expect(r.conflict).toBe(true);
    expect(await db.one<{ reason: string }>("SELECT reason FROM merge_proposals")).toMatchObject({ reason: "two-emails" });
    expect((await Domain.findBinding(mail("two@example.com")))?.user_id).toBe(held.user_id);
    void a;
  });
});

describe("adoptBinding keeps its result shape", () => {
  test("adopted, movedBindingIds, binding and the user.adopted event are as before, with the user.merged event after it", async () => {
    const seen = await seenInSlack("U0SEEN", { email: "x@example.com" });
    const target = await Domain.ensureUser();
    const r = await Domain.adoptBinding({ ...slack("U0SEEN"), toUserId: target.id, state: "verified" });
    expect(r.adopted).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(r.movedBindingIds).toHaveLength(2);
    expect(r.binding).toMatchObject({ user_id: target.id, state: "verified" });
    expect(r.events.map((e) => e.action)).toEqual(["user.adopted", "user.merged"]);
    expect(r.events[0]).toEqual({ action: "user.adopted", userId: target.id, fromUserId: seen, bindingIds: r.movedBindingIds });
  });
});
