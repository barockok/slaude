/**
 * The golden decision table's inputs (identities, grant kinds, contexts) and the
 * two sides it compares, shared by the pure table test and the seam test.
 */
import { admit } from "../../src/access/admission";
import { admitInternal, isDeniedInternal, resolveGrantSubjects, roleInternal, type EngineActor, type SubjectLookup } from "../../src/access/authority";
import type { Grant } from "../../src/access/grants";
import { isDenied, roleFromGrants } from "../../src/access/role";
import type { ActingUser } from "../../src/refs/actor";

export const T1 = "T0EXAMPLE";
export const T2 = "T0OTHER";
export const SELF = "U0EXAMPLE";
export const SIB = "U0SECOND";

/** The closed list of intended differences. */
export const TAGS = [
  "email-grant-now-active",
  "email-grant-pending",
  "user-ref-now-active",
  "workspace-grant-team-checked",
  "slack-entry-team-checked",
  "grant-via-other-binding",
] as const;
export type Tag = (typeof TAGS)[number];

export const acting = (userId: string, slack: "observed" | "verified" | "declared", emails: ActingUser["emails"] = []): ActingUser => ({
  userId, slackBinding: { id: `b-${userId}`, state: slack }, verified: slack === "verified", emails,
});

export interface Identity {
  name: string;
  actor: EngineActor;
  /** The Slack id the grants name as "this person". */
  named: string;
  mail: string;
  lookup: SubjectLookup;
}

export const dir = (entries: Record<string, { userId: string; state: "observed" | "verified" | "declared" }>, aliases: Record<string, string> = {}): SubjectLookup => ({
  slack: (ws, id) => entries[`${ws}/${id}`] ?? null,
  live: (id) => aliases[id] ?? id,
});
export const u1World = dir({ [`${T1}/${SELF}`]: { userId: "u1", state: "verified" }, [`${T1}/${SIB}`]: { userId: "u1", state: "observed" } }, { "u-old": "u1" });
export const lone = (ws: string, id: string, userId: string, state: "observed" | "verified") => dir({ [`${ws}/${id}`]: { userId, state } });

export const IDENTITIES: Identity[] = [
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
export const byName = (n: string) => IDENTITIES.find((i) => i.name === n)!;

export const g = (o: Partial<Grant> & Pick<Grant, "subjectKind" | "subjectId">): Grant => ({ role: "member", deny: false, dmOnly: false, source: "console", ...o });
export const slack = (id: string, role: Grant["role"], o: Partial<Grant> = {}): Grant => g({ subjectKind: "user", subjectId: id, role, subject: { service: "slack" }, ...o });
export const mail = (address: string, role: Grant["role"], o: Partial<Grant> = {}): Grant =>
  g({ subjectKind: "user", subjectId: `email:${address}`, role, subject: { service: "email", address }, ...o });

export interface Ctx { name: string; isDM: boolean; channelId: string; roleChannel?: string }
export const CTX: Ctx[] = [
  { name: "DM", isDM: true, channelId: "D0DM", roleChannel: "D0DM" },
  { name: "channel", isDM: false, channelId: "C0CHAN", roleChannel: "C0CHAN" },
  { name: "scoped channel", isDM: false, channelId: "C0SCOPED", roleChannel: "C0SCOPED" },
  { name: "no channel", isDM: false, channelId: "", roleChannel: undefined },
];

/** Every grant shape, built for an identity. */
export const KINDS: Array<{ key: string; build: (i: Identity) => Grant[] }> = [
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

export interface Answer { admit: string; role: string | null; denied: boolean }
export function legacy(i: Identity, grants: Grant[], c: Ctx): Answer {
  const a = admit({ grants, userId: i.actor.slackUserId, channelId: c.channelId, isDM: c.isDM });
  return { admit: a.ok ? "ok" : a.reason, role: roleFromGrants(grants, i.actor.slackUserId, c.roleChannel), denied: isDenied(grants, i.actor.slackUserId) };
}
export function engine(i: Identity, grants: Grant[], c: Ctx): Answer {
  const resolved = resolveGrantSubjects(grants, i.actor.teamId, i.lookup);
  const a = admitInternal({ grants: resolved, actor: i.actor, channelId: c.channelId, isDM: c.isDM });
  return { admit: a.ok ? "ok" : a.reason, role: roleInternal(resolved, i.actor, c.roleChannel), denied: isDeniedInternal(resolved, i.actor) };
}

/** Why a difference is intended, by grant kind and identity. Null means it is not. */
export function explain(kind: string, i: Identity): Tag | null {
  if (kind.includes("email")) return "email-grant-now-active";
  if (kind === "user reference by alias") return "user-ref-now-active";
  if (kind.startsWith("workspace grant")) return "workspace-grant-team-checked";
  if (kind === "Slack manager written with a workspace" && i.name === "same U id in another workspace") return "slack-entry-team-checked";
  if (i.name.startsWith("two Slack ids")) return "grant-via-other-binding";
  return null;
}

