import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { __resetDecide, decideAdmit, decideApprovers, decideRole, decideSame } from "../../src/access/decide";
import type { Grant } from "../../src/access/grants";
import * as Domain from "../../src/db/domain";
import { metrics } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";

const T1 = "T0EXAMPLE";
const SELF = "U0EXAMPLE";
const SIB = "U0SECOND";

const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}) => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });
const email = (address: string, role: Grant["role"], o: Partial<Grant> = {}) =>
  g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address }, ...o });

function raw(text: string, name: string, labels: Record<string, string>): number {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  const line = text.split("\n").find((l) => l.startsWith(name + "{") && want.every((w) => l.includes(w)));
  return line ? Number(line.split(" ").pop()) : 0;
}
/** Metrics are process-wide: count what this test added. */
let baseline = "";
const count = (name: string, labels: Record<string, string>): number => raw(metrics.render(), name, labels) - raw(baseline, name, labels);

let saved: string | undefined;
let warn: ReturnType<typeof spyOn>;
beforeEach(async () => {
  baseline = metrics.render();
  saved = process.env.SLAUDE_ACCESS_SOURCE;
  delete process.env.SLAUDE_ACCESS_SOURCE;
  await Domain._wipeForTests();
  Actor.invalidateActors();
  __resetDecide();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.SLAUDE_ACCESS_SOURCE;
  else process.env.SLAUDE_ACCESS_SOURCE = saved;
  warn.mockRestore();
  mock.restore();
});

/** A user with a verified Slack binding and a verified email. */
async function verifiedUser(slackId = SELF, address = "a@example.com") {
  const s = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: slackId, state: "verified", source: "test" });
  await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: address, state: "verified", source: "test", userId: s.userId });
  return s;
}

const admitArgs = (grants: Grant[], over: Partial<Parameters<typeof decideAdmit>[0]> = {}) => ({
  site: "test.admit", persona: "scout", teamId: T1, userId: SELF, channelId: "D0DM", isDM: true, grants, ...over,
});

describe("SLAUDE_ACCESS_SOURCE", () => {
  test("legacy runs the string path only and never calls the resolver", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    const spy = spyOn(Actor, "actingUser");
    const r = await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(r).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();
    expect(count("slaude_access_decision_total", { source: "legacy", site: "test.admit", result: "ok" })).toBe(1);
  });

  test("an unknown value reads as legacy", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "bogus";
    const spy = spyOn(Actor, "actingUser");
    await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("the default is shadow and the source is read on every call", async () => {
    const spy = spyOn(Actor, "actingUser");
    await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(spy).toHaveBeenCalledTimes(1);
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("shadow", () => {
  test("agreement is counted as a match", async () => {
    await verifiedUser();
    const r = await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(r).toEqual({ ok: true });
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "match" })).toBe(1);
  });

  test("a seeded email grant for a linked user is a mismatch while the decision stays legacy", async () => {
    await verifiedUser();
    const r = await decideAdmit(admitArgs([email("a@example.com", "member")]));
    expect(r).toEqual({ ok: false, reason: "whitelist" });
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "mismatch" })).toBe(1);
    expect(count("slaude_access_decision_total", { source: "legacy", site: "test.admit", result: "whitelist" })).toBe(1);
  });

  test("the mismatch line names internal ids only: no Slack id, no email, no team", async () => {
    const u = await verifiedUser();
    await decideAdmit(admitArgs([email("a@example.com", "member")]));
    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("shadow mismatch");
    expect(lines[0]).toContain("site=test.admit");
    expect(lines[0]).toContain(`user=${u.userId}`);
    for (const secret of [SELF, "a@example.com", T1, "example.com"]) expect(lines[0]).not.toContain(secret);
  });

  test("the same mismatch is logged once a minute, then again", async () => {
    await verifiedUser();
    const realNow = Date.now;
    try {
      let t = 5_000_000;
      Date.now = () => t;
      const grants = [email("a@example.com", "member")];
      for (let k = 0; k < 3; k++) await decideAdmit(admitArgs(grants));
      expect(warn.mock.calls.length).toBe(1);
      // Still counted every time.
      expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "mismatch" })).toBe(3);
      t += 61_000;
      await decideAdmit(admitArgs(grants));
      expect(warn.mock.calls.length).toBe(2);
      // A different site is its own key.
      await decideAdmit(admitArgs(grants, { site: "test.other" }));
      expect(warn.mock.calls.length).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  test("an engine error never changes the legacy answer and is counted", async () => {
    spyOn(Actor, "actingUser").mockRejectedValue(new Actor.ActorResolveError(new Error("db down")));
    const r = await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(r).toEqual({ ok: true });
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "new_error" })).toBe(1);
    const denied = await decideAdmit(admitArgs([slack(SELF, "member", { deny: true })]));
    expect(denied).toEqual({ ok: false, reason: "blocked_user" });
  });

  test("an unseen id is compared on strings and agrees with legacy", async () => {
    const r = await decideAdmit(admitArgs([slack(SELF, "member")]));
    expect(r).toEqual({ ok: true });
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "match" })).toBe(1);
  });

  test("a grant naming the other Slack binding of the same user is found through the records", async () => {
    const u = await verifiedUser(SELF);
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: SIB, state: "observed", source: "test", userId: u.userId });
    const r = await decideAdmit(admitArgs([slack(SELF, "member")], { userId: SIB }));
    expect(r).toEqual({ ok: false, reason: "whitelist" }); // legacy
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "mismatch" })).toBe(1);
  });

  test("a user reference through an alias is found", async () => {
    const u = await verifiedUser();
    const { db } = await import("../../src/db/schema");
    await db.run("INSERT INTO user_aliases (old_id, user_id, merged_at) VALUES (?, ?, ?)", ["u-old", u.userId, 1]);
    const grants = [g({ subjectKind: "user", subjectId: "user:u-old", subject: { service: "user", userId: "u-old" } })];
    const role = await decideRole({ site: "test.role", persona: "scout", teamId: T1, userId: SELF, channelId: null, grants });
    expect(role).toBeNull();
    expect(count("slaude_access_shadow_total", { site: "test.role", outcome: "mismatch" })).toBe(1);
  });
});

describe("decideRole, decideApprovers, decideSame", () => {
  test("decideRole returns the legacy role and reads the resolver fresh", async () => {
    await verifiedUser();
    const spy = spyOn(Actor, "actingUser");
    const role = await decideRole({ site: "test.role", persona: "scout", teamId: T1, userId: SELF, channelId: "C0ONE", grants: [slack(SELF, "manager", { source: "soul" })] });
    expect(role).toBe("manager");
    // Shadow keeps the cache (it must not raise the database load); only the live path reads fresh (failure-modes.test.ts).
    expect(spy.mock.calls[0]![2]).toMatchObject({ fresh: false });
    expect(count("slaude_access_shadow_total", { site: "test.role", outcome: "match" })).toBe(1);
  });

  test("decideApprovers returns the legacy Slack ids; an email approver is a mismatch", async () => {
    await verifiedUser();
    const grants = [slack("U0A1", "approver"), email("a@example.com", "approver")];
    const ids = await decideApprovers({ site: "test.approvers", persona: "scout", teamId: T1, grants, roles: ["approver", "manager"], channelId: null });
    expect(ids).toEqual(["U0A1"]);
    expect(count("slaude_access_shadow_total", { site: "test.approvers", outcome: "mismatch" })).toBe(1);
  });

  test("decideApprovers agrees on Slack-only grants", async () => {
    const grants = [slack("U0A1", "approver"), slack("U0A2", "manager")];
    const ids = await decideApprovers({ site: "test.approvers", persona: "scout", teamId: T1, grants, roles: ["approver", "manager"], channelId: null });
    expect(ids.sort()).toEqual(["U0A1", "U0A2"]);
    expect(count("slaude_access_shadow_total", { site: "test.approvers", outcome: "match" })).toBe(1);
  });

  test("decideSame is string equality in legacy; Rule G is the shadow", async () => {
    const u = await verifiedUser(SELF);
    await Domain.ensureBinding({ service: "slack", kind: "user", workspace: T1, value: SIB, state: "verified", source: "test", userId: u.userId });
    const a = { teamId: T1, slackUserId: SELF };
    const b = { teamId: T1, slackUserId: SIB };
    expect(await decideSame({ site: "test.same", persona: "scout", a, b })).toBe(false); // legacy
    expect(count("slaude_access_shadow_total", { site: "test.same", outcome: "mismatch" })).toBe(1);
    expect(await decideSame({ site: "test.same", persona: "scout", a, b: a })).toBe(true);
    expect(count("slaude_access_shadow_total", { site: "test.same", outcome: "match" })).toBe(1);
  });

  test("decideSame with legacy source calls no resolver", async () => {
    process.env.SLAUDE_ACCESS_SOURCE = "legacy";
    const spy = spyOn(Actor, "sameUser");
    expect(await decideSame({ site: "test.same", persona: "scout", a: { teamId: T1, slackUserId: SELF }, b: { teamId: T1, slackUserId: SIB } })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
