/**
 * The authority engine (slice C, task 9): admit, role and approvers decided
 * from effective grants and a resolved acting user, by internal identity
 * instead of by Slack id string. PURE: no database, no clock, no environment.
 * The thin seam `decide.ts` resolves the inputs and picks which answer is used;
 * nothing here is live until that seam is told to use it.
 *
 * Rules (plan, "Rules"):
 *  A  ordinary access (member, deny, channel, dm) flows from grants naming any
 *     binding of the acting user; privileged access (manager, approver) only
 *     when the acting Slack binding itself is verified.
 *  B  `slack:` entry: the acting Slack binding (any state), or another Slack
 *     binding of the same user that is observed or verified. `email:`: a
 *     verified email binding of the acting user. `user:`: the acting user.
 *     A declared binding never matches.
 *  C  a deny applies from observed or verified bindings and from the acting
 *     Slack id itself, never from a declared binding.
 *  D  a direct `slack:user:` privileged entry keeps today's behaviour (any
 *     acting state) unless `privilegedNeedsVerified` is set (D2); `email:` and
 *     `user:` entries always need the verified acting Slack binding.
 *
 * Differences from the legacy readers are deliberate and listed in
 * tests/access/golden-decision-table.test.ts under a closed list of tags.
 */
import type { State } from "../db/domain";
import type { ActingUser } from "../refs/actor";
import type { AdmitResult } from "./admission";
import type { Grant, GrantSubject } from "./grants";
import type { Role } from "./role";

/** Who is acting: the Slack identity, and what the resolver knew about it (null = unseen). */
export interface EngineActor {
  teamId: string;
  slackUserId: string;
  acting: ActingUser | null;
}

export interface EngineOpts {
  /** D2: a direct `slack:user:` privileged entry also needs the acting Slack binding verified. Default off. */
  privilegedNeedsVerified?: boolean;
}

interface Match {
  /** Counts for member-level access. */
  ordinary: boolean;
  /** Counts as a deny. */
  deny: boolean;
  /** Counts for manager and approver. */
  privileged: boolean;
}
const NONE: Match = { ordinary: false, deny: false, privileged: false };

const SLACK_ID = /^[UW][A-Z0-9]+$/;

/** The subject of a grant: its own, else read from the stored text (a bare Slack id, or a hand-written typed form). */
function subjectOf(g: Grant): GrantSubject | null {
  if (g.subject && g.subject.service !== "slack") return g.subject;
  if (g.subjectId.startsWith("email:")) return { service: "email", address: g.subjectId.slice("email:".length) };
  if (g.subjectId.startsWith("user:")) return { service: "user", userId: g.subjectId.slice("user:".length) };
  if (SLACK_ID.test(g.subjectId) || g.subjectKind !== "user") return g.subject ?? { service: "slack" };
  return null;
}

function matchActor(g: Grant, a: EngineActor, opts: EngineOpts): Match {
  if (g.subjectKind !== "user") return NONE;
  const s = subjectOf(g);
  if (!s) return NONE;
  const acting = a.acting;
  switch (s.service) {
    case "slack": {
      if (g.subjectId === a.slackUserId && (!s.workspace || s.workspace === a.teamId)) {
        // The acting binding itself, whatever its state: Slack signed the request.
        return { ordinary: true, deny: true, privileged: !opts.privilegedNeedsVerified || acting?.verified === true };
      }
      // Another binding of the same user, named and resolved, never a declared one.
      if (acting && s.userId && s.userId === acting.userId && (s.state === "observed" || s.state === "verified")) {
        return { ordinary: true, deny: true, privileged: acting.verified };
      }
      return NONE;
    }
    case "email": {
      const e = acting?.emails.find((m) => m.address === s.address);
      if (!acting || !e) return NONE;
      return { ordinary: e.verified, deny: true, privileged: e.verified && acting.verified };
    }
    case "user":
      if (acting && s.userId === acting.userId) return { ordinary: true, deny: true, privileged: acting.verified };
      return NONE;
  }
}

/** A person the grants name, for listings: a Slack id, an email or an internal user. */
export interface Principal {
  key: string;
  slackId?: string;
  email?: string;
  userId?: string;
}

function principalOf(g: Grant): Principal | null {
  if (g.subjectKind !== "user") return null;
  const s = subjectOf(g);
  if (!s) return null;
  if (s.service === "slack") return { key: `slack:${g.subjectId}`, slackId: g.subjectId, ...(s.userId ? { userId: s.userId } : {}) };
  if (s.service === "email") return { key: `email:${s.address}`, email: s.address };
  return { key: `user:${s.userId}`, userId: s.userId };
}

/** Matching by who the grants name (no acting user): the same subject, or the same resolved user. */
function matchPrincipal(g: Grant, p: Principal): Match {
  const q = principalOf(g);
  if (!q) return NONE;
  const same = q.key === p.key || (!!p.userId && !!q.userId && p.userId === q.userId);
  return same ? { ordinary: true, deny: true, privileged: true } : NONE;
}

const writtenWorkspace = (g: Grant): string | undefined => (g.subject?.service === "slack" ? g.subject.workspace : undefined);

const channelOk = (g: Grant, channelId: string | null | undefined, teamId: string | undefined): boolean => {
  const w = writtenWorkspace(g);
  return g.subjectKind === "channel" && !!channelId && g.subjectId === channelId && (!w || !teamId || w === teamId);
};

const workspaceOk = (g: Grant, teamId: string | undefined): boolean => g.subjectKind === "workspace" && (teamId === undefined || g.subjectId === teamId);

/** The role over grants for whoever `match` selects: the engine twin of `roleFromGrants`. */
function roleCore(grants: readonly Grant[], channelId: string | null | undefined, teamId: string | undefined, match: (g: Grant) => Match): Role | null {
  const hits = grants.map((g) => ({ g, m: match(g) })).filter((x) => x.g.subjectKind === "user");
  if (hits.some((x) => x.g.deny && x.m.deny)) return null;
  const live = hits.filter((x) => !x.g.deny);
  if (live.some((x) => x.g.role === "manager" && x.m.privileged)) return "manager";
  const scoped = !!channelId && grants.some((g) => g.source === "soul" && g.role === "approver" && g.channelId === channelId);
  const approver = live.some(
    (x) => x.g.role === "approver" && x.m.privileged && (x.g.source === "console" || (scoped ? x.g.channelId === channelId : !x.g.channelId)),
  );
  if (approver) return "approver";
  if (live.some((x) => x.g.role === "member" && x.m.ordinary)) return "member";
  const viaChannel = grants.some((g) => !g.deny && channelOk(g, channelId, teamId));
  const viaWorkspace = grants.some((g) => !g.deny && workspaceOk(g, teamId));
  return viaChannel || viaWorkspace ? "member" : null;
}

/** The acting user's role on a persona over its grants (engine twin of `roleFromGrants`). */
export function roleInternal(grants: readonly Grant[], actor: EngineActor, channelId?: string | null, opts: EngineOpts = {}): Role | null {
  if (!actor.slackUserId) return null;
  return roleCore(grants, channelId, actor.teamId, (g) => matchActor(g, actor, opts));
}

/** True when a deny grant reaches the acting user (engine twin of `isDenied`). */
export function isDeniedInternal(grants: readonly Grant[], actor: EngineActor, opts: EngineOpts = {}): boolean {
  return grants.some((g) => g.deny && matchActor(g, actor, opts).deny);
}

/** Whether a message from the acting user reaches the persona (engine twin of `admit`). */
export function admitInternal(o: { grants: readonly Grant[]; actor: EngineActor; channelId: string; isDM: boolean; opts?: EngineOpts }): AdmitResult {
  const opts = o.opts ?? {};
  const hits = o.grants.map((g) => ({ g, m: matchActor(g, o.actor, opts) })).filter((x) => x.g.subjectKind === "user");
  if (hits.some((x) => x.g.deny && x.m.deny)) return { ok: false, reason: "blocked_user" };
  const live = hits.filter((x) => !x.g.deny);
  if (live.some((x) => x.g.role === "manager" && x.m.privileged)) return { ok: true };
  if (o.isDM) {
    return live.some((x) => x.g.role === "member" && x.m.ordinary) ? { ok: true } : { ok: false, reason: "whitelist" };
  }
  const channel = o.grants.some((g) => !g.deny && channelOk(g, o.channelId, o.actor.teamId));
  const storedMember = live.some((x) => x.g.source === "console" && x.g.role === "member" && !x.g.dmOnly && x.m.ordinary);
  const workspace = o.grants.some((g) => !g.deny && workspaceOk(g, o.actor.teamId));
  return channel || storedMember || workspace ? { ok: true } : { ok: false, reason: "whitelist" };
}

/**
 * Every person the grants name whose role on `channelId` is one of `roles`
 * (engine twin of `usersWithRole`). Slack subjects written for another
 * workspace than `teamId` are left out. The result names people as the grants
 * do (a Slack id, an email, a user); the caller maps them to Slack ids to DM
 * through the resolver (Rule F). Whether a listed person can act is decided
 * per click by {@link roleInternal}, which checks the verified binding.
 */
export function usersWithRoleInternal(grants: readonly Grant[], roles: readonly Role[], channelId?: string | null, o: { teamId?: string } = {}): Principal[] {
  const seen = new Map<string, Principal>();
  for (const g of grants) {
    if (g.deny || g.subjectKind !== "user") continue;
    const s = subjectOf(g);
    if (s?.service === "slack" && s.workspace && o.teamId && s.workspace !== o.teamId) continue;
    const p = principalOf(g);
    if (p && !seen.has(p.key)) seen.set(p.key, p);
  }
  const out: Principal[] = [];
  for (const p of seen.values()) {
    const r = roleCore(grants, channelId, o.teamId, (g) => matchPrincipal(g, p));
    if (r !== null && roles.includes(r)) out.push(p);
  }
  return out;
}

/** What the seam looked up so grants can be matched by user: the binding a Slack subject names and alias targets. */
export interface SubjectLookup {
  slack(workspace: string, slackUserId: string): { userId: string; state: State } | null;
  /** The live user id for an id that may be an alias. */
  live(userId: string): string;
}

/**
 * Fill `subject.userId` and `subject.state` on Slack grants from the lookup, and
 * point `user:` subjects (and any stored user id) at the live user. A bare Slack
 * id means the acting workspace. Pure; returns new grants.
 */
export function resolveGrantSubjects(grants: readonly Grant[], teamId: string, lookup: SubjectLookup): Grant[] {
  return grants.map((g) => {
    if (g.subjectKind !== "user") return g;
    const s = subjectOf(g);
    if (!s) return g;
    if (s.service === "user") return { ...g, subject: { service: "user", userId: lookup.live(s.userId) } };
    if (s.service !== "slack") return g;
    const found = lookup.slack(s.workspace ?? teamId, g.subjectId);
    if (found) return { ...g, subject: { ...s, userId: lookup.live(found.userId), state: found.state } };
    return s.userId ? { ...g, subject: { ...s, userId: lookup.live(s.userId) } } : g;
  });
}
