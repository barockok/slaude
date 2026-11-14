/**
 * Slice C task 20, the flip and its failure modes. Under SLAUDE_ACCESS_SOURCE=internal
 * the internal-id answer is returned; when the resolver cannot answer (D10):
 *  - ordinary access (admission, a deny, "same person", recipient lists) uses the
 *    legacy string result for that call, a Slack deny still applying;
 *  - every privileged answer (manager, approver, an approver list, an allowlist
 *    or soul-field check) is refused, never taken from legacy;
 *  - an unseen actor (no binding) gets the legacy result for ordinary access, and
 *    privileged only through direct Slack entries, never through `email:` or `user:`;
 *  - privileged questions read the resolver fresh (D9).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { roleInternal } from "../../src/access/authority";
import { __resetDecide, decideAdmit, decideApprovers, decideDenied, decideRole, decideSame } from "../../src/access/decide";
import type { Grant } from "../../src/access/grants";
import { __setGrantsReader, loadGrants } from "../../src/access/role";
import { admitAt, approverSplitAt, approversAt, checkAt, deniedAt, listAt, roleAt, sameAt, settleShadows } from "../../src/access/wired";
import * as Domain from "../../src/db/domain";
import { metrics } from "../../src/metrics";
import * as Actor from "../../src/refs/actor";

const T1 = "T0EXAMPLE";
const T2 = "T0OTHER";
const SELF = "U0EXAMPLE";
const OTHER = "U0SECOND";

const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}) => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });
const email = (address: string, role: Grant["role"], o: Partial<Grant> = {}) =>
  g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address }, ...o });
const userRef = (id: string, role: Grant["role"]) => g({ subjectKind: "user", subjectId: `user:${id}`, role, subject: { service: "user", userId: id } });
const workspace = (team: string) => g({ subjectKind: "workspace", subjectId: team, role: "member" });

function raw(text: string, name: string, labels: Record<string, string>): number {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return text
    .split("\n")
    .filter((l) => l.startsWith(name + "{") && want.every((w) => l.includes(w)))
    .reduce((sum, l) => sum + Number(l.split(" ").pop()), 0);
}
let baseline = "";
const count = (name: string, labels: Record<string, string> = {}): number => raw(metrics.render(), name, labels) - raw(baseline, name, labels);
const plain = (name: string, text = metrics.render()): number => {
  const line = text.split("\n").find((l) => l.startsWith(name + " "));
  return line ? Number(line.split(" ").pop()) : 0;
};
const plainCount = (name: string): number => plain(name) - plain(name, baseline);

let saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  await settleShadows();
  baseline = metrics.render();
  saved = { src: process.env.SLAUDE_ACCESS_SOURCE, pnv: process.env.SLAUDE_PRIVILEGED_NEEDS_VERIFIED };
  process.env.SLAUDE_ACCESS_SOURCE = "internal";
  delete process.env.SLAUDE_PRIVILEGED_NEEDS_VERIFIED;
  await Domain._wipeForTests();
  Actor.invalidateActors();
  __resetDecide();
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await settleShadows();
  for (const [k, v] of [["SLAUDE_ACCESS_SOURCE", saved.src], ["SLAUDE_PRIVILEGED_NEEDS_VERIFIED", saved.pnv]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __setGrantsReader(null);
  mock.restore();
});

/** A person: a Slack binding in `state`, optionally with an email binding in `mailState`. */
async function person(o: { slack?: string; team?: string; state?: "observed" | "verified"; mail?: string; mailState?: "observed" | "verified" } = {}) {
  const s = await Domain.ensureBinding({ service: "slack", kind: "user", workspace: o.team ?? T1, value: o.slack ?? SELF, state: o.state ?? "verified", source: "test" });
  if (o.mail) await Domain.ensureBinding({ service: "email", kind: "address", workspace: "", value: o.mail, state: o.mailState ?? "verified", source: "test", userId: s.userId });
  return s;
}
/** The resolver cannot read the records (a database error inside the real lookup, so the real counters move). */
const breakDb = () => spyOn(Domain, "findBinding").mockRejectedValue(new Error("db down"));

const admitArgs = (grants: Grant[], over: Partial<Parameters<typeof decideAdmit>[0]> = {}) => ({
  site: "test.admit", persona: "scout", teamId: T1, userId: SELF, channelId: "D0DM", isDM: true, grants, ...over,
});
const roleArgs = (grants: Grant[], over: Partial<Parameters<typeof decideRole>[0]> = {}) => ({ site: "test.role", persona: "scout", teamId: T1, userId: SELF, channelId: null, grants, ...over });

describe("the default and the flip", () => {
  test("an unset source is shadow, not internal", async () => {
    delete process.env.SLAUDE_ACCESS_SOURCE;
    await person({ mail: "a@example.com" });
    // An email member grant for a linked person: shadow keeps the legacy answer.
    expect(await decideAdmit(admitArgs([email("a@example.com", "member")]))).toEqual({ ok: false, reason: "whitelist" });
  });

  test("internal returns the engine result and counts the reverse shadow", async () => {
    await person({ mail: "a@example.com" });
    expect(await decideAdmit(admitArgs([email("a@example.com", "member")]))).toEqual({ ok: true });
    expect(count("slaude_access_decision_total", { source: "internal", site: "test.admit", result: "ok" })).toBe(1);
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "legacy_disagrees" })).toBe(1);
    expect(count("slaude_access_decision_total", { source: "legacy", site: "test.admit" })).toBe(0);
  });

  test("agreement with legacy is a match", async () => {
    await person();
    expect(await decideAdmit(admitArgs([slack(SELF, "member")]))).toEqual({ ok: true });
    expect(count("slaude_access_shadow_total", { site: "test.admit", outcome: "match" })).toBe(1);
  });

  test("the legacy line names internal ids only", async () => {
    const u = await person({ mail: "a@example.com" });
    await decideAdmit(admitArgs([email("a@example.com", "member")]));
    const lines = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("legacy disagrees");
    expect(lines[0]).toContain(`user=${u.userId}`);
    for (const secret of [SELF, "a@example.com", T1, "example.com"]) expect(lines[0]).not.toContain(secret);
  });
});

describe("the resolver throws", () => {
  test("ordinary admission falls back to legacy for that call, and a Slack deny still applies", async () => {
    breakDb();
    expect(await decideAdmit(admitArgs([slack(SELF, "member")]))).toEqual({ ok: true });
    expect(await decideAdmit(admitArgs([slack(SELF, "member"), slack(SELF, "member", { deny: true })]))).toEqual({ ok: false, reason: "blocked_user" });
    expect(await decideAdmit(admitArgs([slack(OTHER, "member")]))).toEqual({ ok: false, reason: "whitelist" });
    expect(count("slaude_access_decision_total", { source: "fallback_legacy", site: "test.admit" })).toBe(3);
    expect(plainCount("slaude_actor_resolve_failures_total")).toBeGreaterThanOrEqual(3);
  });

  test("the fallback still checks a workspace grant against the team (D12)", async () => {
    breakDb();
    expect(await decideAdmit(admitArgs([workspace(T2)], { isDM: false, channelId: "C0CHAN" }))).toEqual({ ok: false, reason: "whitelist" });
    expect(await decideAdmit(admitArgs([workspace(T1)], { isDM: false, channelId: "C0CHAN" }))).toEqual({ ok: true });
  });

  test("a privileged role is refused, never taken from legacy", async () => {
    breakDb();
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).toBe("member");
    expect(await decideRole(roleArgs([slack(SELF, "approver")]))).toBe("member");
    expect(await decideRole(roleArgs([slack(SELF, "member")]))).toBe("member");
    expect(await decideRole(roleArgs([slack(SELF, "manager"), slack(SELF, "manager", { deny: true })]))).toBeNull();
    expect(count("slaude_access_decision_total", { source: "fallback_legacy", site: "test.role", result: "member" })).toBe(3);
  });

  test("an approver list is empty, a privileged check is false", async () => {
    breakDb();
    const grants = [slack("U0A1", "approver"), slack("U0M1", "manager")];
    expect(await decideApprovers({ site: "test.approvers", persona: "scout", teamId: T1, grants, roles: ["approver", "manager"], channelId: null })).toEqual([]);
    expect(await approversAt({ site: "gateway.proposal_managers", persona: "scout", teamId: T1, grants, roles: ["manager"] })).toEqual([]);
    expect(await approverSplitAt({ site: "approval.resolve_approvers", persona: "scout", teamId: T1, grants, roles: ["approver"] })).toEqual({ slackIds: [], userIds: [] });
    const ok = await checkAt({ site: "model_auth.can_change", persona: "scout", teamId: T1, userId: SELF, legacy: true as boolean, grants: () => grants, internal: () => true });
    expect(ok).toBe(false);
  });

  test("a deny is never removed by an outage, and same person is the string compare", async () => {
    breakDb();
    expect(await decideDenied({ site: "test.denied", persona: "scout", teamId: T1, userId: SELF, grants: [slack(SELF, "member", { deny: true })] })).toBe(true);
    expect(await decideDenied({ site: "test.denied", persona: "scout", teamId: T1, userId: SELF, grants: [slack(OTHER, "member", { deny: true })] })).toBe(false);
    expect(await decideSame({ site: "test.same", persona: "scout", a: { teamId: T1, slackUserId: SELF }, b: { teamId: T1, slackUserId: SELF } })).toBe(true);
    expect(await decideSame({ site: "test.same", persona: "scout", a: { teamId: T1, slackUserId: SELF }, b: { teamId: T1, slackUserId: OTHER } })).toBe(false);
  });

  test("a recipient list that is not authority keeps the legacy list", async () => {
    breakDb();
    expect(await listAt({ site: "gateway.background_managers", persona: "scout", teamId: T1, legacy: [SELF], roles: ["manager"], grants: () => [slack(SELF, "manager")] })).toEqual([SELF]);
  });

  test("a failure in the engine itself falls back the same way and throws into no caller", async () => {
    await person();
    const Authority = await import("../../src/access/authority");
    spyOn(Authority, "roleInternal").mockImplementation(() => {
      throw new Error("engine bug");
    });
    spyOn(Authority, "admitInternal").mockImplementation(() => {
      throw new Error("engine bug");
    });
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).toBe("member");
    expect(await decideAdmit(admitArgs([slack(SELF, "member")]))).toEqual({ ok: true });
    expect(count("slaude_access_shadow_total", { site: "test.role", outcome: "new_error" })).toBe(1);
  });

  test("the wired helpers answer the same and never reject", async () => {
    breakDb();
    const grants = [slack(SELF, "manager")];
    expect(await roleAt({ site: "gateway.cron.role", persona: "scout", teamId: T1, userId: SELF, grants })).toBe("member");
    expect(await admitAt({ site: "gateway.admit", persona: "scout", teamId: T1, userId: SELF, channelId: "D0DM", isDM: true, grants })).toEqual({ ok: true });
    expect(await deniedAt({ site: "approval.click_denied", persona: "scout", teamId: T1, userId: SELF, grants: [slack(SELF, "member", { deny: true })] })).toBe(true);
    expect(await sameAt({ site: "gateway.mcp_slash.lock_owner", persona: "scout", teamId: T1, userId: SELF, otherUserId: SELF, otherTeamId: T1 })).toBe(true);
  });
});

describe("the actor is not known yet (actingUser returns null)", () => {
  test("ordinary access is the legacy string result", async () => {
    expect(await decideAdmit(admitArgs([slack(SELF, "member")]))).toEqual({ ok: true });
    expect(await decideAdmit(admitArgs([slack(OTHER, "member")]))).toEqual({ ok: false, reason: "whitelist" });
    expect(await decideAdmit(admitArgs([slack(SELF, "member"), slack(SELF, "member", { deny: true })]))).toEqual({ ok: false, reason: "blocked_user" });
  });

  test("a direct Slack manager entry is still a manager; email and user entries are refused", async () => {
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).toBe("manager");
    expect(await decideRole(roleArgs([email("a@example.com", "manager")]))).toBeNull();
    expect(await decideRole(roleArgs([userRef("u-1", "manager")]))).toBeNull();
    expect(await decideAdmit(admitArgs([email("a@example.com", "member")]))).toEqual({ ok: false, reason: "whitelist" });
    expect(count("slaude_access_decision_total", { source: "fallback_legacy" })).toBe(0);
  });
});

describe("privileged questions read fresh (D9); ordinary ones may use the cache", () => {
  test("role and approvers read fresh, admission does not", async () => {
    await person({ mail: "a@example.com" });
    const spy = spyOn(Actor, "actingUser");
    await decideRole(roleArgs([email("a@example.com", "manager")]));
    expect(spy.mock.calls.at(-1)![2]).toMatchObject({ fresh: true });
    await decideAdmit(admitArgs([email("a@example.com", "member")]));
    expect(spy.mock.calls.at(-1)![2]).toMatchObject({ fresh: false });
    const ok = await checkAt({ site: "ingest_auth.can_trigger", persona: "scout", teamId: T1, userId: SELF, legacy: false, grants: () => [email("a@example.com", "manager")], internal: ({ grants, actor, opts }) => roleInternal(grants, actor, undefined, opts) === "manager" });
    expect(ok).toBe(true);
    expect(spy.mock.calls.at(-1)![2]).toMatchObject({ fresh: true });
  });

  test("an unlink is seen at once by a privileged check, while ordinary admission may serve its cache for 5 s", async () => {
    const s = await person({ mail: "a@example.com" });
    const grants = [email("a@example.com", "manager"), email("a@example.com", "member")];
    expect(await decideRole(roleArgs(grants))).toBe("manager");
    expect(await decideAdmit(admitArgs(grants))).toEqual({ ok: true });
    // The Slack binding drops to observed without telling this process (no invalidation).
    const { db } = await import("../../src/db/schema");
    await db.run("UPDATE bindings SET state = 'observed' WHERE id = ?", [s.binding.id]);
    expect(await decideRole(roleArgs(grants))).toBe("member");
    expect(await decideAdmit(admitArgs(grants))).toEqual({ ok: true });
  });
});

describe("SLAUDE_PRIVILEGED_NEEDS_VERIFIED (D2)", () => {
  test("off: a direct Slack manager entry keeps today's behaviour for an observed binding", async () => {
    await person({ state: "observed" });
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).toBe("manager");
  });

  test("on: it needs the verified Slack binding; an unseen actor is not verified either", async () => {
    process.env.SLAUDE_PRIVILEGED_NEEDS_VERIFIED = "1";
    await person({ state: "observed" });
    // Not a manager; a manager grant alone gives no member access (the engine's Rule A).
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).toBeNull();
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).not.toBe("manager");
    expect(await decideRole(roleArgs([slack(SELF, "manager")], { userId: OTHER }))).toBeNull();
    await Domain._wipeForTests();
    Actor.invalidateActors();
    await person({ state: "verified" });
    expect(await decideRole(roleArgs([slack(SELF, "manager")]))).toBe("manager");
  });

  test("email and user entries need the verified Slack binding whatever the flag says", async () => {
    await person({ state: "observed", mail: "a@example.com" });
    expect(await decideRole(roleArgs([email("a@example.com", "manager")]))).toBeNull();
    expect(await decideRole(roleArgs([email("a@example.com", "manager"), email("a@example.com", "member")]))).toBe("member");
  });
});

describe("a call with no workspace", () => {
  test("ordinary questions get the legacy answer, privileged ones a refusal", async () => {
    const grants = [slack(SELF, "manager")];
    expect(await admitAt({ site: "gateway.admit", persona: "scout", teamId: null, userId: SELF, channelId: "D0DM", isDM: true, grants })).toEqual({ ok: true });
    expect(await roleAt({ site: "gateway.cron.role", persona: "scout", teamId: undefined, userId: SELF, grants })).toBe("member");
    expect(await approversAt({ site: "rule_tool.approvers", persona: "scout", teamId: null, grants, roles: ["manager"] })).toEqual([]);
    expect(await sameAt({ site: "restraint.manager_recipient", persona: null, teamId: null, userId: SELF, otherUserId: SELF })).toBe(true);
    expect(count("slaude_access_shadow_total", { outcome: "no_team" })).toBe(4);
  });
});

describe("grants read failure is unchanged", () => {
  test("a failed stored-grant read leaves the soul-derived grants, and internal still decides", async () => {
    __setGrantsReader(async () => {
      throw new Error("grants down");
    });
    const grants = await loadGrants("scout");
    expect(Array.isArray(grants)).toBe(true);
    expect(plain("slaude_grants_read_failures_total")).toBeGreaterThanOrEqual(1);
    expect(await decideAdmit(admitArgs(grants))).toEqual({ ok: false, reason: "whitelist" });
  });
});

describe("workspace grants compare the team only under internal (D12)", () => {
  const grants = [workspace(T2)];
  const channel = { isDM: false, channelId: "C0CHAN" };
  test("internal: a grant for another workspace admits nobody here", async () => {
    await person();
    expect(await decideAdmit(admitArgs(grants, channel))).toEqual({ ok: false, reason: "whitelist" });
    expect(await decideAdmit(admitArgs([workspace(T1)], channel))).toEqual({ ok: true });
  });
  for (const mode of ["shadow", "legacy"] as const) {
    test(`${mode}: the legacy reader is unchanged and admits everyone`, async () => {
      process.env.SLAUDE_ACCESS_SOURCE = mode;
      expect(await decideAdmit(admitArgs(grants, channel))).toEqual({ ok: true });
    });
  }
});
