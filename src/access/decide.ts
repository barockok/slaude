/**
 * The access seam (slice C, task 10): every site that decides admit, role,
 * approvers or "same person" goes through one of these, naming itself with a
 * `site` id. Behind it sit two paths: the legacy string readers
 * (`admission.ts`, `role.ts`) and the authority engine (`authority.ts`) over a
 * resolved acting user.
 *
 * `SLAUDE_ACCESS_SOURCE` (read on every call):
 *  - `legacy`: the string path only; no resolver is called.
 *  - `shadow` (default): the legacy answer is returned. The internal-id answer
 *    is computed after it inside a try; a disagreement is counted
 *    (`slaude_access_shadow_total{site,outcome=mismatch}`) and logged once per
 *    (site, persona, reason) per minute with INTERNAL ids only; an error in the
 *    new path counts `new_error` and never changes the answer.
 *  - `internal` (the flip, task 20): the internal-id answer is returned and the
 *    legacy answer is the reverse shadow (a difference counts
 *    `slaude_access_shadow_total{outcome=legacy_disagrees}`). When the resolver
 *    cannot answer the call falls back by what was asked (D10): ordinary access
 *    (admit, deny, same person, recipient lists) uses the legacy string result,
 *    with a Slack deny still applying; every privileged answer (manager, approver,
 *    approvers, an allowlist or soul-field check) is refused and never taken from
 *    legacy. Such a call counts `slaude_access_decision_total{source="fallback_legacy"}`.
 *    Privileged questions read the resolver fresh (D9). The default stays `shadow`.
 *
 * Under `legacy` and `shadow` nothing in this file lets the internal answer out.
 */
import * as Domain from "../db/domain";
import { env } from "../config/env";
import { m } from "../metrics";
import * as Actor from "../refs/actor";
import type { ActorKey } from "../refs/actor";
import { admit, type AdmitResult } from "./admission";
import { admitInternal, grantSubject, isDeniedInternal, resolveGrantSubjects, roleInternal, usersWithRoleInternal, type EngineActor, type EngineOpts, type Principal, type SubjectLookup } from "./authority";
import type { Grant } from "./grants";
import { isDenied, roleFromGrants, usersWithRole, type Role } from "./role";

const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();

/** Forget which mismatches were logged (tests). */
export function __resetDecide(): void {
  lastLogged.clear();
  slackCache.clear();
  liveCache.clear();
}

export function logOncePerMinute(key: string, line: () => string): void {
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_EVERY_MS) return;
  if (lastLogged.size > 500) lastLogged.clear();
  lastLogged.set(key, now);
  console.warn(line());
}

/** Which path to run. */
const mode = (): "legacy" | "shadow" | "internal" => env.access.source();

/** The engine options the environment sets (D2). */
const engineOpts = (): EngineOpts => (mode() === "internal" ? { privilegedNeedsVerified: env.access.privilegedNeedsVerified() } : {});

interface Internal<T> {
  value: T;
  /** The internal user id the acting Slack id resolved to, for the log line. */
  userId?: string;
}

/** Return the answer of the configured source; in shadow mode also run `compute` and record how it compares. */
async function decide<T>(o: {
  site: string;
  persona: string | null | undefined;
  legacy: T;
  show: (v: T) => string;
  compute: () => Promise<Internal<T>>;
  /** Why two answers differ, for the log; defaults to `legacy->internal`. */
  reason?: (legacy: T, next: T) => string | null;
  /**
   * What `internal` returns when the internal path cannot answer (resolver down,
   * engine error): the legacy result for ordinary questions, a refusal for
   * privileged ones (D10). Never throws.
   */
  onFailure?: (legacy: T) => T;
}): Promise<T> {
  const md = mode();
  const persona = o.persona || "default";
  const differs = (legacy: T, next: T): string | null =>
    o.reason ? o.reason(legacy, next) : o.show(legacy) === o.show(next) ? null : `${o.show(legacy)}->${o.show(next)}`;
  if (md === "internal") {
    let next: Internal<T>;
    try {
      next = await withDeadline(o.compute(), env.access.timeoutMs());
    } catch (e) {
      const name = e instanceof Error ? e.name : "error";
      m.accessShadowTotal.inc({ site: o.site, outcome: "new_error" });
      let v = o.legacy;
      try {
        v = o.onFailure ? o.onFailure(o.legacy) : o.legacy;
      } catch {
        /* a fallback must not throw; keep the legacy value for an ordinary question */
      }
      m.accessDecisionTotal.inc({ source: "fallback_legacy", site: o.site, result: o.show(v) });
      logOncePerMinute(`${o.site}|${persona}|fallback:${name}`, () => `[access] internal fallback site=${o.site} persona=${persona} kind=${name}`);
      return v;
    }
    m.accessDecisionTotal.inc({ source: "internal", site: o.site, result: o.show(next.value) });
    try {
      const why = differs(o.legacy, next.value);
      if (why === null) m.accessShadowTotal.inc({ site: o.site, outcome: "match" });
      else {
        m.accessShadowTotal.inc({ site: o.site, outcome: "legacy_disagrees" });
        logOncePerMinute(`${o.site}|${persona}|${why}`, () => `[access] legacy disagrees site=${o.site} persona=${persona} reason=${why} user=${next.userId ?? "none"}`);
      }
    } catch {
      /* the reverse shadow is advisory */
    }
    return next.value;
  }
  m.accessDecisionTotal.inc({ source: "legacy", site: o.site, result: o.show(o.legacy) });
  if (md === "legacy") return o.legacy;
  try {
    const next = await o.compute();
    const why = differs(o.legacy, next.value);
    if (why === null) {
      m.accessShadowTotal.inc({ site: o.site, outcome: "match" });
    } else {
      m.accessShadowTotal.inc({ site: o.site, outcome: "mismatch" });
      logOncePerMinute(`${o.site}|${persona}|${why}`, () => `[access] shadow mismatch site=${o.site} persona=${persona} reason=${why} user=${next.userId ?? "none"}`);
    }
  } catch (e) {
    if (e instanceof LookupCap) {
      m.accessShadowTotal.inc({ site: o.site, outcome: "dropped" });
      return o.legacy;
    }
    m.accessShadowTotal.inc({ site: o.site, outcome: "new_error" });
    const name = e instanceof Error ? e.name : "error";
    logOncePerMinute(`${o.site}|${persona}|error:${name}`, () => `[access] shadow error site=${o.site} persona=${persona} kind=${name}`);
  }
  return o.legacy;
}

/** The most distinct subjects one shadow resolves; a persona with more is dropped, not allowed to flood the database. */
export const MAX_LOOKUPS_PER_CALL = 40;
/** The same bound when the answer is used (`internal`): a larger persona must still be decided, so this is generous. */
export const MAX_LOOKUPS_INTERNAL = 500;
/** How long a resolved subject is shared between shadows (matches the actor cache). */
const LOOKUP_TTL_MS = 5_000;
const LOOKUP_CACHE_MAX = 5_000;
type SlackFound = { userId: string; state: Domain.State } | null;
const slackCache = new Map<string, { until: number; v: SlackFound }>();
const liveCache = new Map<string, { until: number; v: string }>();
Actor.onActorsInvalidated(() => {
  slackCache.clear();
  liveCache.clear();
});
/** Forget shared lookups (tests). */
export function __resetLookups(): void {
  slackCache.clear();
  liveCache.clear();
}
class LookupCap extends Error {
  constructor() {
    super("too many subjects to resolve");
    this.name = "LookupCap";
  }
}
function cached<V>(map: Map<string, { until: number; v: V }>, key: string): { v: V } | undefined {
  const hit = map.get(key);
  return hit && Date.now() < hit.until ? hit : undefined;
}
function remember<V>(map: Map<string, { until: number; v: V }>, key: string, v: V): void {
  if (map.size >= LOOKUP_CACHE_MAX) map.clear();
  map.set(key, { until: Date.now() + LOOKUP_TTL_MS, v });
}

/**
 * Look up what the grants' Slack and user subjects point at, so the engine can
 * match by user. Resolved subjects are shared between shadows for a few
 * seconds, and one call resolves at most MAX_LOOKUPS_PER_CALL distinct
 * subjects (past that it throws LookupCap and the shadow is counted dropped).
 */
async function lookupFor(grants: readonly Grant[], teamId: string, skipSlackId?: string, o: { fresh?: boolean; cap?: number } = {}): Promise<SubjectLookup> {
  const slackFound = new Map<string, SlackFound>();
  const live = new Map<string, string>();
  let budget = o.cap ?? MAX_LOOKUPS_PER_CALL;
  // A privileged question in the live path never serves the shared 5 s lookups (D9). Shadow always may: it must not raise the database load.
  const useCache = !o.fresh || mode() !== "internal";
  // Plan the distinct subjects first, then resolve them a few at a time.
  const slackKeys = new Map<string, { ws: string; id: string }>();
  const liveIds = new Set<string>();
  const userRefs: string[] = [];
  for (const g of grants) {
    if (g.subjectKind !== "user") continue;
    const s = grantSubject(g);
    if (!s) continue;
    if (s.service === "slack") {
      if (g.subjectId !== skipSlackId) {
        const ws = s.workspace ?? teamId;
        slackKeys.set(`${ws}/${g.subjectId}`, { ws, id: g.subjectId });
      }
      if (s.userId) userRefs.push(s.userId);
    } else if (s.service === "user") userRefs.push(s.userId);
  }
  const spend = () => {
    if (--budget < 0) throw new LookupCap();
  };
  const slackTasks = [...slackKeys].map(([k, v]) => async () => {
    const hit = useCache ? cached(slackCache, k) : undefined;
    if (hit) return void slackFound.set(k, hit.v);
    spend();
    const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: v.ws, value: v.id });
    const r = b ? { userId: b.user_id, state: b.state } : null;
    if (useCache) remember(slackCache, k, r);
    slackFound.set(k, r);
  });
  await pool(slackTasks, LOOKUP_CONCURRENCY);
  for (const f of slackFound.values()) if (f) liveIds.add(f.userId);
  for (const id of userRefs) liveIds.add(id);
  const liveTasks = [...liveIds].map((id) => async () => {
    const hit = useCache ? cached(liveCache, id) : undefined;
    if (hit) return void live.set(id, hit.v);
    spend();
    const v = (await Domain.resolveUserId(id)) ?? id;
    if (useCache) remember(liveCache, id, v);
    live.set(id, v);
  });
  await pool(liveTasks, LOOKUP_CONCURRENCY);
  return { slack: (ws, id) => slackFound.get(`${ws}/${id}`) ?? null, live: (id) => live.get(id) ?? id };
}

/** Subjects resolved at once per call. */
export const LOOKUP_CONCURRENCY = 8;
/** Run `tasks` with at most `n` in flight; the first failure rejects. */
async function pool(tasks: Array<() => Promise<void>>, n: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}

/** The resolver did not answer within the deadline: a resolver failure (D10). */
class AccessTimeout extends Error {
  constructor() {
    super("access decision deadline exceeded");
    this.name = "AccessTimeout";
  }
}
/** `p`, or a rejection after `ms` (the work is not cancelled; its late result is dropped). */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      m.actorResolveFailuresTotal.inc();
      reject(new AccessTimeout());
    }, ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

interface EngineInput {
  actor: EngineActor;
  grants: Grant[];
  opts: EngineOpts;
  userId?: string;
}

async function engineInput(o: { teamId: string; userId: string; grants: readonly Grant[]; fresh: boolean }): Promise<EngineInput> {
  const live = mode() === "internal";
  const opts = engineOpts();
  // `fresh` (a privileged question, D9) only matters when the answer is used; the shadow keeps the 5 s cache, as rc.19 did for the database load.
  const acting = await Actor.actingUser(o.teamId, o.userId, { fresh: o.fresh && live });
  const actor: EngineActor = { teamId: o.teamId, slackUserId: o.userId, acting };
  if (!acting) return { actor, grants: [...o.grants], opts };
  try {
    const lookup = await lookupFor(o.grants, o.teamId, o.userId, { fresh: o.fresh && live, cap: live ? MAX_LOOKUPS_INTERNAL : MAX_LOOKUPS_PER_CALL });
    return { actor, grants: resolveGrantSubjects(o.grants, o.teamId, lookup), opts, userId: acting.userId };
  } catch (e) {
    // The records could not be read: when the answer is used this is a resolver failure (D10).
    if (live && !(e instanceof LookupCap) && !(e instanceof Actor.ActorResolveError)) {
      m.actorResolveFailuresTotal.inc();
      throw new Actor.ActorResolveError(e);
    }
    throw e;
  }
}

export const showAdmit = (r: AdmitResult) => (r.ok ? "ok" : r.reason);
export const showRole = (r: Role | null) => r ?? "none";

/** A privileged role is refused (never taken from legacy) when the resolver cannot say who is acting: it drops to member. */
const demote = (r: Role | null): Role | null => (r === "manager" || r === "approver" ? "member" : r);

/** Whether a message reaches the persona. Ordinary check: the resolver may serve its 5 s cache. */
export async function decideAdmit(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  userId: string;
  channelId: string;
  isDM: boolean;
  grants: readonly Grant[];
}): Promise<AdmitResult> {
  return decide({
    site: o.site,
    persona: o.persona,
    legacy: admit({ grants: o.grants, userId: o.userId, channelId: o.channelId, isDM: o.isDM }),
    show: showAdmit,
    compute: async () => {
      const i = await engineInput({ teamId: o.teamId, userId: o.userId, grants: o.grants, fresh: false });
      return { value: admitInternal({ grants: i.grants, actor: i.actor, channelId: o.channelId, isDM: o.isDM, opts: i.opts }), userId: i.userId };
    },
    // Ordinary admission: the legacy string result for this call, a Slack deny still applying, a workspace grant for its own workspace only.
    onFailure: () => admit({ grants: o.grants, userId: o.userId, channelId: o.channelId, isDM: o.isDM, teamId: o.teamId }),
  });
}

/** A user's role over grants. A role can be privileged, so the resolver is read fresh (D9). */
export async function decideRole(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  userId: string;
  channelId?: string | null;
  grants: readonly Grant[];
}): Promise<Role | null> {
  return decide({
    site: o.site,
    persona: o.persona,
    legacy: roleFromGrants(o.grants, o.userId, o.channelId),
    show: showRole,
    compute: async () => {
      const i = await engineInput({ teamId: o.teamId, userId: o.userId, grants: o.grants, fresh: true });
      return { value: roleInternal(i.grants, i.actor, o.channelId, i.opts), userId: i.userId };
    },
    // Manager and approver are never taken from legacy when the resolver is down.
    onFailure: () => demote(roleFromGrants(o.grants, o.userId, o.channelId, o.teamId)),
  });
}

/**
 * The Slack ids a list of principals stands for: a Slack subject is its own id;
 * an `email:` subject is the user holding that VERIFIED email, and a `user:`
 * subject that user; both then give their Slack ids in the workspace. A
 * privileged list keeps only verified Slack bindings for those (Rule D); an
 * ordinary one also takes observed ones (to reach the person, Rule F). Reads the
 * records fresh.
 */
async function principalIds(people: readonly Principal[], teamId: string, privileged: boolean): Promise<{ slackIds: string[]; userIds: string[]; ids: string[] }> {
  const direct: string[] = [];
  const users: string[] = [];
  for (const p of people) {
    if (p.slackId) {
      direct.push(p.slackId);
      continue;
    }
    const u = p.email ? await Actor.userOfVerifiedEmail(p.email) : p.userId ? ((await Domain.resolveUserId(p.userId)) ?? p.userId) : null;
    if (u && !users.includes(u)) users.push(u);
  }
  const ids = [...direct];
  for (const u of users) for (const id of await Actor.slackIdsFor(u, teamId, { verifiedOnly: privileged })) if (!ids.includes(id)) ids.push(id);
  return { slackIds: direct, userIds: users, ids };
}

/**
 * A list of Slack ids a site holds (managers, approvers, a recipient), compared
 * with who the grants name for `roles`. `legacy` is returned as the caller made
 * it; the shadow compares the people the grants name. Under `internal` the
 * people the grants name are returned, as Slack ids (see {@link principalIds}).
 * `refuseOnFailure` (a privileged list): an outage returns no one instead of
 * the legacy list.
 */
export async function decideList(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
  legacy: string[];
  refuseOnFailure?: boolean;
}): Promise<string[]> {
  const privileged = o.roles.some((r) => r !== "member");
  return decide<string[]>({
    site: o.site,
    persona: o.persona,
    legacy: o.legacy,
    show: (ids) => `${ids.length}`,
    compute: async () => {
      const live = mode() === "internal";
      const lookup = await lookupFor(o.grants, o.teamId, undefined, live ? { fresh: privileged, cap: MAX_LOOKUPS_INTERNAL } : {});
      const grants = resolveGrantSubjects(o.grants, o.teamId, lookup);
      const people = usersWithRoleInternal(grants, o.roles, o.channelId, { teamId: o.teamId });
      if (live) return { value: (await principalIds(people, o.teamId, privileged)).ids };
      // The internal list as legacy-shaped ids: Slack people only; the others are what differs.
      return { value: people.map((p) => p.slackId ?? `~${p.key.split(":")[0]}`) };
    },
    onFailure: (legacy) => (o.refuseOnFailure ? [] : legacy),
    reason: (before, after) => {
      const a = new Set(before);
      const b = new Set(after);
      const extra = [...b].filter((x) => !a.has(x));
      const missing = [...a].filter((x) => !b.has(x));
      if (!extra.length && !missing.length) return null;
      const kinds = (xs: string[], sign: string) => {
        const k = new Map<string, number>();
        for (const x of xs) k.set(x.startsWith("~") ? x.slice(1) : "slack", (k.get(x.startsWith("~") ? x.slice(1) : "slack") ?? 0) + 1);
        return [...k].map(([n, c]) => `${sign}${n}:${c}`);
      };
      return [...kinds(extra, "+"), ...kinds(missing, "-")].join(",");
    },
  });
}

/** Who holds one of `roles`: the legacy Slack ids are returned; the shadow compares the people the grants name. Privileged: an outage returns no one. */
export async function decideApprovers(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
}): Promise<string[]> {
  return decideList({ ...o, legacy: usersWithRole(o.grants, o.roles, o.channelId), refuseOnFailure: true });
}

/** Approvers split for a card: direct Slack ids, and the user ids that `email:` and `user:` entries name. */
export interface ApproverSplit {
  slackIds: string[];
  userIds: string[];
}

/**
 * Who may approve, for a card that stores an allowlist (task 21). Under
 * `legacy` and `shadow` the legacy Slack ids are returned with no user ids.
 * Under `internal`: `slackIds` are the Slack subjects the grants name, `userIds`
 * the live users that `email:` (verified email) and `user:` entries name. A click
 * from such a user is decided at click time (their Slack binding must be
 * verified); the ids to reach them are `Actor.slackIdsFor`. An outage returns
 * no one.
 */
export async function decideApproverSplit(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
  legacy?: string[];
}): Promise<ApproverSplit> {
  const legacy = o.legacy ?? usersWithRole(o.grants, o.roles, o.channelId);
  if (mode() !== "internal") {
    await decideList({ ...o, legacy, refuseOnFailure: true });
    return { slackIds: legacy, userIds: [] };
  }
  let out: ApproverSplit = { slackIds: [], userIds: [] };
  await decide<string[]>({
    site: o.site,
    persona: o.persona,
    legacy,
    show: (ids) => `${ids.length}`,
    compute: async () => {
      const lookup = await lookupFor(o.grants, o.teamId, undefined, { fresh: true, cap: MAX_LOOKUPS_INTERNAL });
      const people = usersWithRoleInternal(resolveGrantSubjects(o.grants, o.teamId, lookup), o.roles, o.channelId, { teamId: o.teamId });
      const r = await principalIds(people, o.teamId, true);
      out = { slackIds: r.slackIds, userIds: r.userIds };
      return { value: [...r.slackIds, ...r.userIds] };
    },
    onFailure: () => {
      out = { slackIds: [], userIds: [] };
      return [];
    },
    reason: (before, after) => {
      const a = new Set(before);
      const extra = after.filter((x) => !a.has(x));
      const missing = before.filter((x) => !after.includes(x));
      return extra.length || missing.length ? `+${extra.length},-${missing.length}` : null;
    },
  });
  return out;
}

/** Whether two Slack identities are the same person (initiator, lock owner). Legacy: the same id string. Rule G under `internal`. */
export async function decideSame(o: { site: string; persona: string | null | undefined; a: ActorKey; b: ActorKey }): Promise<boolean> {
  return decide({
    site: o.site,
    persona: o.persona,
    legacy: !!o.a.slackUserId && o.a.slackUserId === o.b.slackUserId,
    show: (v) => (v ? "same" : "different"),
    compute: async () => ({ value: await Actor.sameUser(o.a, o.b) }),
  });
}

/**
 * A boolean or small-valued check the legacy way over some grants, with a
 * caller-supplied internal twin. For sites whose legacy answer is not one of
 * admit, role or approvers (an allowlist click, a soul-field reader, a deny
 * filter). `legacy` is already computed by the caller; it is what comes back
 * unless the source is `internal`.
 * `internal` receives the grants resolved to people, the acting user and the
 * engine options. `fresh` reads the resolver without its cache (privileged
 * questions, D9). `onFailure` is the answer when the resolver cannot say who is
 * acting (default: the legacy value for a deny, a refusal for anything else).
 */
export async function decideCheck<T>(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  userId: string;
  grants: readonly Grant[];
  fresh: boolean;
  legacy: T;
  show: (v: T) => string;
  internal: (i: { grants: Grant[]; actor: EngineActor; opts: EngineOpts }) => T;
  onFailure?: (legacy: T) => T;
}): Promise<T> {
  return decide({
    site: o.site,
    persona: o.persona,
    legacy: o.legacy,
    show: o.show,
    compute: async () => {
      const i = await engineInput({ teamId: o.teamId, userId: o.userId, grants: o.grants, fresh: o.fresh });
      return { value: o.internal({ grants: i.grants, actor: i.actor, opts: i.opts }), userId: i.userId };
    },
    onFailure: o.onFailure ?? ((legacy) => (typeof legacy === "boolean" ? (false as T) : legacy)),
  });
}

/** Whether a deny grant reaches the user. A deny applies from observed bindings too (Rule C), so the resolver may serve its cache. A resolver failure never removes a Slack deny. */
export async function decideDenied(o: { site: string; persona: string | null | undefined; teamId: string; userId: string; grants: readonly Grant[] }): Promise<boolean> {
  return decideCheck({
    site: o.site,
    persona: o.persona,
    teamId: o.teamId,
    userId: o.userId,
    grants: o.grants,
    fresh: false,
    legacy: isDenied(o.grants, o.userId),
    show: (v) => (v ? "denied" : "clear"),
    internal: ({ grants, actor, opts }) => isDeniedInternal(grants, actor, opts),
    onFailure: (legacy) => legacy,
  });
}
