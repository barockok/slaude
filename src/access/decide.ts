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
 *  - `internal`: reserved for the access flip (task 20). Until then it behaves
 *    as `shadow`: the legacy answer is returned.
 *
 * Nothing in this file lets the internal answer out. That is the whole point of
 * this release.
 */
import * as Domain from "../db/domain";
import { env } from "../config/env";
import { m } from "../metrics";
import * as Actor from "../refs/actor";
import type { ActorKey } from "../refs/actor";
import { admit, type AdmitResult } from "./admission";
import { admitInternal, grantSubject, isDeniedInternal, resolveGrantSubjects, roleInternal, usersWithRoleInternal, type EngineActor, type SubjectLookup } from "./authority";
import type { Grant } from "./grants";
import { isDenied, roleFromGrants, usersWithRole, type Role } from "./role";

const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();

/** Forget which mismatches were logged (tests). */
export function __resetDecide(): void {
  lastLogged.clear();
}

function logOncePerMinute(key: string, line: () => string): void {
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_EVERY_MS) return;
  if (lastLogged.size > 500) lastLogged.clear();
  lastLogged.set(key, now);
  console.warn(line());
}

/** Which path to run: `internal` is not live yet, so it shadows. */
function mode(): "legacy" | "shadow" {
  return env.access.source() === "legacy" ? "legacy" : "shadow";
}

interface Internal<T> {
  value: T;
  /** The internal user id the acting Slack id resolved to, for the log line. */
  userId?: string;
}

/** Return `legacy`; in shadow mode also run `compute` and record how it compares. */
async function decide<T>(o: {
  site: string;
  persona: string | null | undefined;
  legacy: T;
  show: (v: T) => string;
  compute: () => Promise<Internal<T>>;
  /** Why two answers differ, for the log; defaults to `legacy->internal`. */
  reason?: (legacy: T, next: T) => string | null;
}): Promise<T> {
  m.accessDecisionTotal.inc({ source: "legacy", site: o.site, result: o.show(o.legacy) });
  if (mode() === "legacy") return o.legacy;
  const persona = o.persona || "default";
  try {
    const next = await o.compute();
    const why = o.reason ? o.reason(o.legacy, next.value) : o.show(o.legacy) === o.show(next.value) ? null : `${o.show(o.legacy)}->${o.show(next.value)}`;
    if (why === null) {
      m.accessShadowTotal.inc({ site: o.site, outcome: "match" });
    } else {
      m.accessShadowTotal.inc({ site: o.site, outcome: "mismatch" });
      logOncePerMinute(`${o.site}|${persona}|${why}`, () => `[access] shadow mismatch site=${o.site} persona=${persona} reason=${why} user=${next.userId ?? "none"}`);
    }
  } catch (e) {
    m.accessShadowTotal.inc({ site: o.site, outcome: "new_error" });
    const name = e instanceof Error ? e.name : "error";
    logOncePerMinute(`${o.site}|${persona}|error:${name}`, () => `[access] shadow error site=${o.site} persona=${persona} kind=${name}`);
  }
  return o.legacy;
}

/** Look up, once, what the grants' Slack and user subjects point at, so the engine can match by user. */
async function lookupFor(grants: readonly Grant[], teamId: string, skipSlackId?: string): Promise<SubjectLookup> {
  const slackFound = new Map<string, { userId: string; state: Domain.State } | null>();
  const live = new Map<string, string>();
  const liveOf = async (id: string) => {
    if (!live.has(id)) live.set(id, (await Domain.resolveUserId(id)) ?? id);
  };
  for (const g of grants) {
    if (g.subjectKind !== "user") continue;
    const s = grantSubject(g);
    if (!s) continue;
    if (s.service === "slack") {
      if (g.subjectId !== skipSlackId) {
        const ws = s.workspace ?? teamId;
        const k = `${ws}/${g.subjectId}`;
        if (!slackFound.has(k)) {
          const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: ws, value: g.subjectId });
          slackFound.set(k, b ? { userId: b.user_id, state: b.state } : null);
        }
        const f = slackFound.get(k);
        if (f) await liveOf(f.userId);
      }
      if (s.userId) await liveOf(s.userId);
    } else if (s.service === "user") {
      await liveOf(s.userId);
    }
  }
  return { slack: (ws, id) => slackFound.get(`${ws}/${id}`) ?? null, live: (id) => live.get(id) ?? id };
}

interface EngineInput {
  actor: EngineActor;
  grants: Grant[];
  userId?: string;
}

async function engineInput(o: { teamId: string; userId: string; grants: readonly Grant[]; fresh: boolean }): Promise<EngineInput> {
  const acting = await Actor.actingUser(o.teamId, o.userId, { fresh: o.fresh });
  const actor: EngineActor = { teamId: o.teamId, slackUserId: o.userId, acting };
  if (!acting) return { actor, grants: [...o.grants] };
  const lookup = await lookupFor(o.grants, o.teamId, o.userId);
  return { actor, grants: resolveGrantSubjects(o.grants, o.teamId, lookup), userId: acting.userId };
}

export const showAdmit = (r: AdmitResult) => (r.ok ? "ok" : r.reason);
export const showRole = (r: Role | null) => r ?? "none";

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
      return { value: admitInternal({ grants: i.grants, actor: i.actor, channelId: o.channelId, isDM: o.isDM }), userId: i.userId };
    },
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
      return { value: roleInternal(i.grants, i.actor, o.channelId), userId: i.userId };
    },
  });
}

/**
 * A list of Slack ids a site holds (managers, approvers, a recipient), compared
 * with who the grants name for `roles`. `legacy` is returned as the caller made
 * it; the shadow compares the people the grants name.
 */
export async function decideList(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
  legacy: string[];
}): Promise<string[]> {
  return decide<string[]>({
    site: o.site,
    persona: o.persona,
    legacy: o.legacy,
    show: (ids) => `${ids.length}`,
    compute: async () => {
      const lookup = await lookupFor(o.grants, o.teamId);
      const grants = resolveGrantSubjects(o.grants, o.teamId, lookup);
      const people = usersWithRoleInternal(grants, o.roles, o.channelId, { teamId: o.teamId });
      // The internal list as legacy-shaped ids: Slack people only; the others are what differs.
      return { value: people.map((p) => p.slackId ?? `~${p.key.split(":")[0]}`) };
    },
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

/** Who holds one of `roles`: the legacy Slack ids are returned; the shadow compares the people the grants name. */
export async function decideApprovers(o: {
  site: string;
  persona: string | null | undefined;
  teamId: string;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
}): Promise<string[]> {
  return decideList({ ...o, legacy: usersWithRole(o.grants, o.roles, o.channelId) });
}

/** Whether two Slack identities are the same person (initiator, lock owner). Legacy: the same id string. */
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
 * filter). `legacy` is already computed by the caller; it is what comes back.
 * `internal` receives the grants resolved to people and the acting user.
 * `fresh` reads the resolver without its cache (privileged questions, D9).
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
  internal: (i: { grants: Grant[]; actor: EngineActor }) => T;
}): Promise<T> {
  return decide({
    site: o.site,
    persona: o.persona,
    legacy: o.legacy,
    show: o.show,
    compute: async () => {
      const i = await engineInput({ teamId: o.teamId, userId: o.userId, grants: o.grants, fresh: o.fresh });
      return { value: o.internal({ grants: i.grants, actor: i.actor }), userId: i.userId };
    },
  });
}

/** Whether a deny grant reaches the user. A deny applies from observed bindings too (Rule C), so the resolver may serve its cache. */
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
    internal: ({ grants, actor }) => isDeniedInternal(grants, actor),
  });
}
