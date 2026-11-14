/**
 * The specification of intended differences between the legacy string readers
 * (`admit`, `roleFromGrants`, `isDenied`) and the authority engine.
 *
 * Part 1 pins hand-derived rows. Part 2 runs the whole product of identities x
 * grants x contexts: any row where legacy and engine disagree must carry a tag
 * from the closed list below, and a tag may only explain a difference. A new
 * difference needs a new tag here, reviewed, not an edited expectation.
 */
import { describe, expect, test } from "bun:test";
import { admit } from "../../src/access/admission";
import { admitInternal, isDeniedInternal, resolveGrantSubjects, roleInternal, type EngineActor, type SubjectLookup } from "../../src/access/authority";
import type { Grant } from "../../src/access/grants";
import { isDenied, roleFromGrants } from "../../src/access/role";
import type { ActingUser } from "../../src/refs/actor";

const T1 = "T0EXAMPLE";
const T2 = "T0OTHER";
const SELF = "U0EXAMPLE";
const SIB = "U0SECOND";

/** The closed list of intended differences. */
export const TAGS = [
  "email-grant-now-active",
  "email-grant-pending",
  "user-ref-now-active",
  "workspace-grant-team-checked",
  "slack-entry-team-checked",
  "grant-via-other-binding",
] as const;
type Tag = (typeof TAGS)[number];

const acting = (userId: string, slack: "observed" | "verified" | "declared", emails: ActingUser["emails"] = []): ActingUser => ({
  userId, slackBinding: { id: `b-${userId}`, state: slack }, verified: slack === "verified", emails,
});

interface Identity {
  name: string;
  actor: EngineActor;
  /** The Slack id the grants name as "this person". */
  named: string;
  mail: string;
  lookup: SubjectLookup;
}

const dir = (entries: Record<string, { userId: string; state: "observed" | "verified" | "declared" }>, aliases: Record<string, string> = {}): SubjectLookup => ({
  slack: (ws, id) => entries[`${ws}/${id}`] ?? null,
  live: (id) => aliases[id] ?? id,
});
const u1World = dir({ [`${T1}/${SELF}`]: { userId: "u1", state: "verified" }, [`${T1}/${SIB}`]: { userId: "u1", state: "observed" } }, { "u-old": "u1" });
const lone = (ws: string, id: string, userId: string, state: "observed" | "verified") => dir({ [`${ws}/${id}`]: { userId, state } });

const IDENTITIES: Identity[] = [
  { name: "unseen", actor: { teamId: T1, slackUserId: SELF, acting: null }, named: SELF, mail: "a@example.com", lookup: dir({}) },
  { name: "observed", actor: { teamId: T1, slackUserId: SELF, acting: acting("u1", "observed", [{ address: "a@example.com", verified: false }]) }, named: SELF, mail: "a@example.com", lookup: lone(T1, SELF, "u1", "observed") },
  { name: "verified with verified email", actor: { teamId: T1, slackUserId: SELF, acting: acting("u1", "verified", [{ address: "a@example.com", verified: true }]) }, named: SELF, mail: "a@example.com", lookup: lone(T1, SELF, "u1", "verified") },
  { name: "observed Slack with verified email", actor: { teamId: T1, slackUserId: SELF, acting: acting("u1", "observed", [{ address: "a@example.com", verified: true }]) }, named: SELF, mail: "a@example.com", lookup: lone(T1, SELF, "u1", "observed") },
  { name: "two Slack ids, acting on the observed one", actor: { teamId: T1, slackUserId: SIB, acting: acting("u1", "observed", [{ address: "a@example.com", verified: true }]) }, named: SELF, mail: "a@example.com", lookup: u1World },
  { name: "two Slack ids, acting on the verified one", actor: { teamId: T1, slackUserId: SELF, acting: acting("u1", "verified", [{ address: "a@example.com", verified: true }]) }, named: SIB, mail: "a@example.com", lookup: u1World },
  { name: "alias old id", actor: { teamId: T1, slackUserId: SELF, acting: acting("u1", "verified", [{ address: "a@example.com", verified: true }]) }, named: SELF, mail: "a@example.com", lookup: u1World },
  { name: "same U id in another workspace", actor: { teamId: T2, slackUserId: SELF, acting: acting("u2", "observed") }, named: SELF, mail: "a@example.com", lookup: lone(T2, SELF, "u2", "observed") },
  { name: "guest, named by nothing", actor: { teamId: T1, slackUserId: "U0GUEST", acting: acting("u4", "observed") }, named: "U0NOBODY", mail: "g@example.com", lookup: lone(T1, "U0GUEST", "u4", "observed") },
  { name: "declared-only email", actor: { teamId: T1, slackUserId: SELF, acting: acting("u3", "observed", []) }, named: SELF, mail: "c@example.com", lookup: lone(T1, SELF, "u3", "observed") },
];
const byName = (n: string) => IDENTITIES.find((i) => i.name === n)!;

const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}): Grant => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });
const mail = (address: string, role: Grant["role"], o: Partial<Grant> = {}): Grant =>
  g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address }, ...o });

interface Ctx { name: string; isDM: boolean; channelId: string; roleChannel?: string }
const CTX: Ctx[] = [
  { name: "DM", isDM: true, channelId: "D0DM", roleChannel: "D0DM" },
  { name: "channel", isDM: false, channelId: "C0CHAN", roleChannel: "C0CHAN" },
  { name: "scoped channel", isDM: false, channelId: "C0SCOPED", roleChannel: "C0SCOPED" },
  { name: "no channel", isDM: false, channelId: "", roleChannel: undefined },
];

/** Every grant shape, built for an identity. */
const KINDS: Array<{ key: string; build: (i: Identity) => Grant[] }> = [
  { key: "soul manager by Slack", build: (i) => [slack(i.named, "manager", { source: "soul" })] },
  { key: "soul manager by email", build: (i) => [mail(i.mail, "manager", { source: "soul" })] },
  { key: "soul approver by Slack", build: (i) => [slack(i.named, "approver", { source: "soul" })] },
  { key: "soul approver by email", build: (i) => [mail(i.mail, "approver", { source: "soul" })] },
  { key: "channel-scoped approver", build: (i) => [slack(i.named, "approver", { source: "soul", channelId: "C0SCOPED" })] },
  { key: "stored member by Slack", build: (i) => [slack(i.named, "member")] },
  { key: "stored member by email", build: (i) => [mail(i.mail, "member")] },
  { key: "deny by Slack", build: (i) => [slack(i.named, "member", { deny: true }), slack(i.named, "manager", { source: "soul" })] },
  { key: "deny by email", build: (i) => [mail(i.mail, "member", { deny: true }), slack(i.named, "member")] },
  { key: "trusted channel", build: () => [g({ subjectKind: "channel", subjectId: "C0CHAN", source: "soul" })] },
  { key: "dm-only member", build: (i) => [slack(i.named, "member", { source: "soul", dmOnly: true })] },
  { key: "workspace grant, right team", build: () => [g({ subjectKind: "workspace", subjectId: T1 })] },
  { key: "workspace grant, other team", build: () => [g({ subjectKind: "workspace", subjectId: T2 })] },
  { key: "Slack manager written with a workspace", build: (i) => [slack(i.named, "manager", { source: "soul", subject: { service: "slack", workspace: T1 } })] },
  { key: "user reference by alias", build: () => [g({ subjectKind: "user", subjectId: "user:u-old", role: "member", subject: { service: "user", userId: "u-old" } })] },
];

interface Answer { admit: string; role: string | null; denied: boolean }
function legacy(i: Identity, grants: Grant[], c: Ctx): Answer {
  const a = admit({ grants, userId: i.actor.slackUserId, channelId: c.channelId, isDM: c.isDM });
  return { admit: a.ok ? "ok" : a.reason, role: roleFromGrants(grants, i.actor.slackUserId, c.roleChannel), denied: isDenied(grants, i.actor.slackUserId) };
}
function engine(i: Identity, grants: Grant[], c: Ctx): Answer {
  const resolved = resolveGrantSubjects(grants, i.actor.teamId, i.lookup);
  const a = admitInternal({ grants: resolved, actor: i.actor, channelId: c.channelId, isDM: c.isDM });
  return { admit: a.ok ? "ok" : a.reason, role: roleInternal(resolved, i.actor, c.roleChannel), denied: isDeniedInternal(resolved, i.actor) };
}

/** Why a difference is intended, by grant kind and identity. Null means it is not. */
function explain(kind: string, i: Identity): Tag | null {
  if (kind.includes("email")) return "email-grant-now-active";
  if (kind === "user reference by alias") return "user-ref-now-active";
  if (kind.startsWith("workspace grant")) return "workspace-grant-team-checked";
  if (kind === "Slack manager written with a workspace" && i.name === "same U id in another workspace") return "slack-entry-team-checked";
  if (i.name.startsWith("two Slack ids")) return "grant-via-other-binding";
  return null;
}

describe("golden decision table, part 1: pinned rows", () => {
  type Row = { name: string; id: string; grants: (i: Identity) => Grant[]; ctx: string; legacy: Answer; next: Answer; tag?: Tag };
  const A = (admit: string, role: string | null, denied = false): Answer => ({ admit, role, denied });
  const rows: Row[] = [
    { name: "Slack manager is unchanged for an unseen id", id: "unseen", grants: (i) => [slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("ok", "manager"), next: A("ok", "manager") },
    { name: "Slack manager is unchanged for an observed id (D2)", id: "observed", grants: (i) => [slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("ok", "manager"), next: A("ok", "manager") },
    { name: "email manager works for a verified user", id: "verified with verified email", grants: (i) => [mail(i.mail, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("ok", "manager"), tag: "email-grant-now-active" },
    { name: "email manager is pending while the Slack binding is only observed", id: "observed Slack with verified email", grants: (i) => [mail(i.mail, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "email manager does nothing for an unproven email", id: "observed", grants: (i) => [mail(i.mail, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "email manager does nothing for an unseen id", id: "unseen", grants: (i) => [mail(i.mail, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "a declared-only email never grants", id: "declared-only email", grants: (i) => [mail(i.mail, "member")], ctx: "DM", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "stored email member admits a verified email on an observed Slack binding (ordinary)", id: "observed Slack with verified email", grants: (i) => [mail(i.mail, "member")], ctx: "DM", legacy: A("whitelist", null), next: A("ok", "member"), tag: "email-grant-now-active" },
    { name: "stored email member does not admit an unproven email", id: "observed", grants: (i) => [mail(i.mail, "member")], ctx: "channel", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "email approver by a verified user", id: "verified with verified email", grants: (i) => [mail(i.mail, "approver", { source: "soul" })], ctx: "no channel", legacy: A("whitelist", null), next: A("whitelist", "approver"), tag: "email-grant-now-active" },
    { name: "a deny by email blocks a verified user over a Slack member grant", id: "verified with verified email", grants: (i) => [mail(i.mail, "member", { deny: true }), slack(i.named, "member")], ctx: "channel", legacy: A("ok", "member"), next: A("blocked_user", null, true), tag: "email-grant-now-active" },
    { name: "a deny by email applies from an observed email", id: "observed", grants: (i) => [mail(i.mail, "member", { deny: true }), slack(i.named, "member")], ctx: "channel", legacy: A("ok", "member"), next: A("blocked_user", null, true), tag: "email-grant-now-active" },
    { name: "a deny by a declared-only email never applies (D11)", id: "declared-only email", grants: (i) => [mail(i.mail, "member", { deny: true }), slack(i.named, "member")], ctx: "channel", legacy: A("ok", "member"), next: A("ok", "member") },
    { name: "a deny by email cannot find an unseen id", id: "unseen", grants: (i) => [mail(i.mail, "member", { deny: true }), slack(i.named, "member")], ctx: "channel", legacy: A("ok", "member"), next: A("ok", "member") },
    { name: "a Slack deny beats a manager grant for an observed id (Rule C)", id: "observed", grants: (i) => [slack(i.named, "member", { deny: true }), slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("blocked_user", null, true), next: A("blocked_user", null, true) },
    { name: "a channel-scoped approver in its channel", id: "verified with verified email", grants: (i) => [slack(i.named, "approver", { source: "soul", channelId: "C0SCOPED" })], ctx: "scoped channel", legacy: A("whitelist", "approver"), next: A("whitelist", "approver") },
    { name: "a channel-scoped approver elsewhere has no role", id: "verified with verified email", grants: (i) => [slack(i.named, "approver", { source: "soul", channelId: "C0SCOPED" })], ctx: "channel", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "a grant naming a verified Slack id admits the observed one on the same record (ordinary)", id: "two Slack ids, acting on the observed one", grants: (i) => [slack(i.named, "member")], ctx: "DM", legacy: A("whitelist", null), next: A("ok", "member"), tag: "grant-via-other-binding" },
    { name: "a manager grant naming the verified id does not make the observed id a manager", id: "two Slack ids, acting on the observed one", grants: (i) => [slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("whitelist", null) },
    { name: "a manager grant naming the observed id makes the verified id a manager", id: "two Slack ids, acting on the verified one", grants: (i) => [slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("ok", "manager"), tag: "grant-via-other-binding" },
    { name: "a stored user reference reaches the live user after an alias", id: "alias old id", grants: () => [g({ subjectKind: "user", subjectId: "user:u-old", role: "member", subject: { service: "user", userId: "u-old" } })], ctx: "DM", legacy: A("whitelist", null), next: A("ok", "member"), tag: "user-ref-now-active" },
    { name: "a workspace grant for another team no longer admits", id: "verified with verified email", grants: () => [g({ subjectKind: "workspace", subjectId: T2 })], ctx: "channel", legacy: A("ok", "member"), next: A("whitelist", null), tag: "workspace-grant-team-checked" },
    { name: "a workspace grant for the right team admits", id: "verified with verified email", grants: () => [g({ subjectKind: "workspace", subjectId: T1 })], ctx: "channel", legacy: A("ok", "member"), next: A("ok", "member") },
    { name: "a workspace grant for the user's own team admits there", id: "same U id in another workspace", grants: () => [g({ subjectKind: "workspace", subjectId: T2 })], ctx: "channel", legacy: A("ok", "member"), next: A("ok", "member") },
    { name: "a bare Slack entry still matches the same id in another workspace", id: "same U id in another workspace", grants: (i) => [slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("ok", "manager"), next: A("ok", "manager") },
    { name: "a workspace-qualified Slack entry does not match another workspace", id: "same U id in another workspace", grants: (i) => [slack(i.named, "manager", { source: "soul", subject: { service: "slack", workspace: T1 } })], ctx: "DM", legacy: A("ok", "manager"), next: A("whitelist", null), tag: "slack-entry-team-checked" },
    { name: "a dm-only member is a member in a DM and has no channel access", id: "observed", grants: (i) => [slack(i.named, "member", { source: "soul", dmOnly: true })], ctx: "channel", legacy: A("whitelist", "member"), next: A("whitelist", "member") },
    { name: "a trusted channel admits a guest", id: "guest, named by nothing", grants: () => [g({ subjectKind: "channel", subjectId: "C0CHAN", source: "soul" })], ctx: "channel", legacy: A("ok", "member"), next: A("ok", "member") },
    { name: "a guest named by nothing has nothing in a DM", id: "guest, named by nothing", grants: (i) => [slack(i.named, "manager", { source: "soul" })], ctx: "DM", legacy: A("whitelist", null), next: A("whitelist", null) },
  ];
  for (const r of rows) {
    test(r.name, () => {
      const i = byName(r.id);
      const c = CTX.find((x) => x.name === r.ctx)!;
      const grants = r.grants(i);
      expect(legacy(i, grants, c)).toEqual(r.legacy);
      expect(engine(i, grants, c)).toEqual(r.next);
      expect(r.tag !== undefined).toBe(JSON.stringify(r.legacy) !== JSON.stringify(r.next));
      if (r.tag) expect(TAGS).toContain(r.tag);
    });
  }
});

describe("golden decision table, part 2: the whole product", () => {
  test("every difference between legacy and the engine is an explained one", () => {
    const unexplained: string[] = [];
    let compared = 0;
    let differing = 0;
    const seen = new Set<Tag>();
    for (const i of IDENTITIES) {
      for (const k of KINDS) {
        const grants = k.build(i);
        for (const c of CTX) {
          compared++;
          const l = legacy(i, grants, c);
          const n = engine(i, grants, c);
          if (JSON.stringify(l) === JSON.stringify(n)) continue;
          differing++;
          const tag = explain(k.key, i);
          if (!tag) unexplained.push(`${i.name} | ${k.key} | ${c.name}: legacy ${JSON.stringify(l)} engine ${JSON.stringify(n)}`);
          else seen.add(tag);
        }
      }
    }
    expect(unexplained).toEqual([]);
    expect(compared).toBe(IDENTITIES.length * KINDS.length * CTX.length);
    expect(differing).toBeGreaterThan(0);
    // The tags in use are all in the closed list; email-grant-pending only labels results that stay equal.
    for (const t of seen) expect(TAGS).toContain(t);
    expect([...seen].sort()).toEqual(["email-grant-now-active", "grant-via-other-binding", "slack-entry-team-checked", "user-ref-now-active", "workspace-grant-team-checked"]);
  });

  test("Slack-only grants for the acting workspace never differ, whatever the identity state", () => {
    for (const i of IDENTITIES.filter((x) => x.actor.teamId === T1 && !x.name.startsWith("two Slack ids") && x.actor.slackUserId === x.named)) {
      for (const k of KINDS.filter((x) => !/email|alias|other team|written with a workspace|workspace grant/.test(x.key))) {
        for (const c of CTX) {
          expect(engine(i, k.build(i), c)).toEqual(legacy(i, k.build(i), c));
        }
      }
    }
  });
});

describe("Rule D: the privileged flag", () => {
  const grants = [slack(SELF, "manager", { source: "soul" })];
  test("off by default: a direct Slack manager stands whatever the acting state", () => {
    for (const name of ["unseen", "observed", "verified with verified email"]) {
      const i = byName(name);
      expect(roleInternal(grants, i.actor, "C0CHAN")).toBe("manager");
    }
  });
  test("on: a direct Slack manager needs the verified acting binding, and an unseen id has none", () => {
    const on = { privilegedNeedsVerified: true };
    expect(roleInternal(grants, byName("verified with verified email").actor, "C0CHAN", on)).toBe("manager");
    expect(roleInternal(grants, byName("observed").actor, "C0CHAN", on)).toBeNull();
    expect(roleInternal(grants, byName("unseen").actor, "C0CHAN", on)).toBeNull();
  });
  test("on: ordinary access of a direct Slack entry is unchanged", () => {
    const member = [slack(SELF, "member")];
    expect(roleInternal(member, byName("observed").actor, "C0CHAN", { privilegedNeedsVerified: true })).toBe("member");
  });
});
