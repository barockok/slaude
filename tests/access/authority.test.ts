import { describe, expect, test } from "bun:test";
import { admit } from "../../src/access/admission";
import { admitInternal, resolveGrantSubjects, roleInternal, usersWithRoleInternal, type EngineActor } from "../../src/access/authority";
import type { Grant } from "../../src/access/grants";
import { roleFromGrants, usersWithRole } from "../../src/access/role";

const T1 = "T0EXAMPLE";

const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}) => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });
const email = (address: string, role: Grant["role"], o: Partial<Grant> = {}) =>
  g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address }, ...o });

// ---------------------------------------------------------------- parity

/** mulberry32: a small seeded generator, so a failure replays. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = ["U0A1", "U0B2", "U0C3", "U0D4", "U0E5", "U0F6"];
const CHANNELS = ["C0ONE", "C0TWO", "C0THREE"];
const ROLES: Grant["role"][] = ["manager", "approver", "member"];

function world(r: () => number): { grants: Grant[]; actorId: string; actor: EngineActor; channel: string; isDM: boolean } {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const n = Math.floor(r() * 9);
  const grants: Grant[] = [];
  for (let k = 0; k < n; k++) {
    const t = r();
    if (t < 0.7) {
      const id = pick(USERS);
      const role = pick(ROLES);
      const source = r() < 0.5 ? "soul" : "console";
      const o: Partial<Grant> = { source, deny: r() < 0.15, dmOnly: r() < 0.2 };
      if (role === "approver" && source === "soul" && r() < 0.4) o.channelId = pick(CHANNELS);
      // Each Slack id is its own user here (one workspace, one binding each): no linking between ids.
      const subject = { service: "slack" as const, ...(r() < 0.5 ? { workspace: T1 } : {}), ...(r() < 0.5 ? { userId: `usr-${id}`, state: pick(["observed", "verified"] as const) } : {}) };
      grants.push(slack(id, role, { ...o, subject }));
    } else if (t < 0.9) {
      grants.push(g({ subjectKind: "channel", subjectId: pick(CHANNELS), source: r() < 0.5 ? "soul" : "console" }));
    } else {
      grants.push(g({ subjectKind: "workspace", subjectId: T1 }));
    }
  }
  const actorId = pick(USERS);
  const state = pick(["unseen", "observed", "verified"] as const);
  const acting = state === "unseen" ? null : { userId: `usr-${actorId}`, slackBinding: { id: `b-${actorId}`, state }, verified: state === "verified", emails: [] };
  const isDM = r() < 0.3;
  return { grants, actorId, actor: { teamId: T1, slackUserId: actorId, acting }, channel: isDM ? "D0DM" : pick(CHANNELS), isDM };
}

describe("parity: Slack-only worlds in one workspace", () => {
  test("5000 random worlds: admit, role, deny and usersWithRole equal the legacy readers", () => {
    const r = rng(20261114);
    const lookup = { slack: () => null, live: (id: string) => id };
    for (let c = 0; c < 5000; c++) {
      const w = world(r);
      const grants = resolveGrantSubjects(w.grants, T1, lookup);
      const ctx = `case ${c}`;
      const la = admit({ grants: w.grants, userId: w.actorId, channelId: w.channel, isDM: w.isDM });
      const na = admitInternal({ grants, actor: w.actor, channelId: w.channel, isDM: w.isDM });
      expect({ ctx, ...na }).toEqual({ ctx, ...la });
      const channel = w.isDM ? undefined : w.channel;
      expect({ ctx, role: roleInternal(grants, w.actor, channel) }).toEqual({ ctx, role: roleFromGrants(w.grants, w.actorId, channel) });
      for (const roles of [["approver", "manager"], ["manager"], ["member"], ["approver", "manager", "member"]] as const) {
        const legacy = usersWithRole(w.grants, roles, channel).sort();
        const next = usersWithRoleInternal(grants, roles, channel, { teamId: T1 }).map((p) => p.slackId!).sort();
        expect({ ctx, roles, ids: next }).toEqual({ ctx, roles, ids: legacy });
      }
    }
  });
});

// ---------------------------------------------------------------- unit

describe("usersWithRoleInternal", () => {
  test("names people as the grants do: Slack ids, emails, users", () => {
    const grants = [slack("U0A1", "approver"), email("a@example.com", "approver"), g({ subjectKind: "user", subjectId: "user:u9", role: "manager", subject: { service: "user", userId: "u9" } })];
    const p = usersWithRoleInternal(grants, ["approver", "manager"], undefined, { teamId: T1 });
    expect(p.map((x) => x.key).sort()).toEqual(["email:a@example.com", "slack:U0A1", "user:u9"]);
  });

  test("a deny by the same resolved user removes a person named another way", () => {
    const grants = [
      slack("U0A1", "approver", { subject: { service: "slack", userId: "u1", state: "verified" } }),
      slack("U0A2", "member", { deny: true, subject: { service: "slack", userId: "u1", state: "observed" } }),
    ];
    expect(usersWithRoleInternal(grants, ["approver"], undefined, { teamId: T1 })).toEqual([]);
  });

  test("a Slack subject written for another workspace is left out", () => {
    const grants = [slack("U0A1", "manager", { subject: { service: "slack", workspace: "T0OTHER" } }), slack("U0A2", "manager")];
    expect(usersWithRoleInternal(grants, ["manager"], undefined, { teamId: T1 }).map((p) => p.slackId)).toEqual(["U0A2"]);
  });

  test("a hand-inserted non-Slack subject is never a Slack id", () => {
    const grants = [g({ subjectKind: "user", subjectId: "whatsapp:phone:+628123456789", role: "approver" })];
    expect(usersWithRoleInternal(grants, ["approver"], undefined, { teamId: T1 })).toEqual([]);
  });
});

describe("resolveGrantSubjects", () => {
  const lookup = {
    slack: (ws: string, id: string) => (ws === T1 && id === "U0A1" ? { userId: "u-old", state: "observed" as const } : null),
    live: (id: string) => (id === "u-old" ? "u1" : id),
  };
  test("fills the user and state of a Slack subject and follows an alias", () => {
    const [x] = resolveGrantSubjects([slack("U0A1", "member")], T1, lookup);
    expect(x!.subject).toEqual({ service: "slack", userId: "u1", state: "observed" });
  });
  test("a bare Slack id means the acting workspace, a written one means that one", () => {
    const [a] = resolveGrantSubjects([slack("U0A1", "member", { subject: { service: "slack", workspace: "T0OTHER" } })], T1, lookup);
    expect((a!.subject as { userId?: string }).userId).toBeUndefined();
  });
  test("a user subject follows an alias; channel and workspace grants are untouched", () => {
    const u = g({ subjectKind: "user", subjectId: "user:u-old", subject: { service: "user", userId: "u-old" } });
    const ch = g({ subjectKind: "channel", subjectId: "C0ONE" });
    const out = resolveGrantSubjects([u, ch], T1, lookup);
    expect(out[0]!.subject).toEqual({ service: "user", userId: "u1" });
    expect(out[1]).toBe(ch);
  });
});

describe("engine edge cases", () => {
  const actor: EngineActor = { teamId: T1, slackUserId: "U0A1", acting: { userId: "u1", slackBinding: { id: "b", state: "verified" }, verified: true, emails: [{ address: "a@example.com", verified: true }] } };
  test("no grants, no role", () => {
    expect(roleInternal([], actor)).toBeNull();
    expect(admitInternal({ grants: [], actor, channelId: "C0ONE", isDM: false })).toEqual({ ok: false, reason: "whitelist" });
  });
  test("an empty Slack id has no role", () => {
    expect(roleInternal([slack("", "manager")], { ...actor, slackUserId: "" })).toBeNull();
  });
  test("an email grant whose address differs in case from a verified binding does not match (addresses are normalised on write)", () => {
    expect(roleInternal([email("A@example.com", "manager", { source: "soul" })], actor)).toBeNull();
  });
  test("an unnormalised email subject is never matched by an unseen actor", () => {
    expect(roleInternal([email("a@example.com", "manager", { source: "soul" })], { ...actor, acting: null })).toBeNull();
  });
});
