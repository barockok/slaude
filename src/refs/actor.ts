/**
 * The acting user (slice C, task 6): who a Slack (team, user id) is in the
 * domain records, for the access engine. Read only: it never creates a record
 * (first sight does), so an id nobody has seen gives null and the caller keeps
 * the legacy string answer for ordinary access.
 *
 * Authority (Rules A and B in the plan) and identity of a speaker (Rule G)
 * are different questions: `actingUser` feeds the first, `sameUser` answers
 * the second and never lets an observed binding join a verified one.
 *
 * Ordinary checks use a 5 s per-process cache, dropped in process on link,
 * unlink, merge, undo and grant change. Privileged checks pass `fresh: true`
 * and always read the database (D9). A database error throws
 * `ActorResolveError`; callers decide the failure mode (D10).
 */
import * as Domain from "../db/domain";
import type { State } from "../db/domain";
import * as AgentGrants from "../db/agent-grants";
import type { DbClient } from "../db/schema";
import { m } from "../metrics";

export interface ActingUser {
  /** Live user id, alias resolved. */
  userId: string;
  slackBinding: { id: string; state: State };
  /** `slackBinding.state === "verified"`. */
  verified: boolean;
  /** Observed and verified email bindings (a declared one never counts). */
  emails: { address: string; verified: boolean }[];
}

/** One Slack identity: a workspace and a user id in it. */
export interface ActorKey {
  teamId: string;
  slackUserId: string;
}

export interface ActorCtx {
  tx?: DbClient;
  /** Read the database even when the cache holds an answer (privileged checks). */
  fresh?: boolean;
}

export class ActorResolveError extends Error {
  constructor(cause: unknown) {
    super(`acting user lookup failed: ${(cause as Error)?.message ?? cause}`);
    this.name = "ActorResolveError";
    this.cause = cause;
  }
}

const TTL_MS = 5_000;
/** Most entries the actor cache holds; past it the oldest go first (insertion order). */
export let ACTOR_CACHE_MAX = 5_000;
/** Lower the bound (tests). */
export function __setActorCacheMax(n: number): void {
  ACTOR_CACHE_MAX = n;
}
const cache = new Map<string, { until: number; actor: ActingUser }>();
const invalidationHooks: Array<() => void> = [];
/** Run `f` whenever the cache is dropped (other short caches that derive from the same records). */
export function onActorsInvalidated(f: () => void): void {
  invalidationHooks.push(f);
}
/** Cached entries (tests). */
export const actorCacheSize = (): number => cache.size;
let generation = 0;
const keyOf = (teamId: string, slackUserId: string) => `${teamId}\0${slackUserId}`;

/** Drop every cached answer (call after link, unlink, merge, undo or a grant change). */
export function invalidateActors(): void {
  generation++;
  cache.clear();
  for (const f of invalidationHooks) f();
}
// A grant change also drops the cache, so a pending console edit never serves a stale actor.
AgentGrants.onGrantsChanged(() => invalidateActors());

async function read(teamId: string, slackUserId: string, tx: DbClient | undefined): Promise<ActingUser | null> {
  const binding = await Domain.findBinding({ service: "slack", kind: "user", workspace: teamId, value: slackUserId }, tx);
  if (!binding) return null;
  const userId = (await Domain.resolveUserId(binding.user_id, tx)) ?? binding.user_id;
  const mails = await Domain.bindingsOf(userId, { service: "email", kind: "address", states: ["observed", "verified"] }, tx);
  return {
    userId,
    slackBinding: { id: binding.id, state: binding.state },
    verified: binding.state === "verified",
    emails: mails.map((b) => ({ address: b.value, verified: b.state === "verified" })),
  };
}

/** The user acting as this Slack identity, or null when no binding exists yet. */
export async function actingUser(teamId: string, slackUserId: string, ctx: ActorCtx = {}): Promise<ActingUser | null> {
  const k = keyOf(teamId, slackUserId);
  const now = Date.now();
  if (!ctx.fresh && !ctx.tx) {
    const hit = cache.get(k);
    if (hit && now < hit.until) {
      m.actorResolveTotal.inc({ result: "cached" });
      return hit.actor;
    }
  }
  const gen = generation;
  let actor: ActingUser | null;
  try {
    actor = await read(teamId, slackUserId, ctx.tx);
  } catch (e) {
    m.actorResolveTotal.inc({ result: "error" });
    m.actorResolveFailuresTotal.inc();
    throw new ActorResolveError(e);
  }
  m.actorResolveTotal.inc({ result: actor ? "found" : "unseen" });
  // An unseen id is not cached (first sight may create it a moment later); a
  // read that raced an invalidation is not cached either.
  if (actor && !ctx.tx && gen === generation) {
    cache.delete(k);
    cache.set(k, { until: now + TTL_MS, actor });
    // Bound the cache: drop expired entries first, then the oldest.
    if (cache.size > ACTOR_CACHE_MAX) {
      for (const [key, v] of cache) if (v.until <= now) cache.delete(key);
      for (const key of cache.keys()) {
        if (cache.size <= ACTOR_CACHE_MAX) break;
        cache.delete(key);
      }
    }
  }
  return actor;
}

/**
 * The Slack ids to DM or match for a user in one workspace: observed and
 * verified bindings, verified first. A declared binding is a name in a
 * definition and is not used to reach anyone.
 */
export async function slackIdsFor(userId: string, teamId: string, ctx: { tx?: DbClient } = {}): Promise<string[]> {
  try {
    const live = await Domain.resolveUserId(userId, ctx.tx);
    if (!live) return [];
    const rows = await Domain.bindingsOf(live, { service: "slack", kind: "user", workspace: teamId, states: ["observed", "verified"] }, ctx.tx);
    const rank = (s: State) => (s === "verified" ? 0 : 1);
    return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.state) - rank(b.r.state) || a.i - b.i).map((x) => x.r.value);
  } catch (e) {
    m.actorResolveFailuresTotal.inc();
    throw new ActorResolveError(e);
  }
}

/**
 * Rule G: the same person for an identity check (initiator, lock owner,
 * permission card, memory and knowledge scope). True for the same binding, or
 * for two different Slack bindings of one user when BOTH are verified. An
 * observed binding never joins a verified one, and two observed bindings are
 * the same person only if they are the same binding. Always reads fresh.
 */
export async function sameUser(a: ActorKey, b: ActorKey, ctx: { tx?: DbClient } = {}): Promise<boolean> {
  if (a.teamId === b.teamId && a.slackUserId === b.slackUserId) return true;
  const [x, y] = await Promise.all([
    actingUser(a.teamId, a.slackUserId, { fresh: true, tx: ctx.tx }),
    actingUser(b.teamId, b.slackUserId, { fresh: true, tx: ctx.tx }),
  ]);
  return !!x && !!y && x.verified && y.verified && x.userId === y.userId;
}
