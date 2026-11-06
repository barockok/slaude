import * as AgentGrants from "../db/agent-grants";
import { m } from "../metrics";
import { effectiveGrants, grantFromRow, type Grant, type GrantRole } from "./grants";

export type Role = GrantRole;

/**
 * A user's role on a persona over already loaded grants. Sync and pure.
 *
 *  - any deny for the user -> null;
 *  - manager grant -> "manager";
 *  - approver: channel aware with replace semantics. When the soul scopes
 *    approvers to `channelId`, only those (and stored approver grants, which
 *    are never channel scoped) count; otherwise the global ones. Without a
 *    channel, only global approvers count;
 *  - a user member grant (dm-only included), a grant on `channelId`, or a
 *    workspace grant -> "member";
 *  - else null.
 */
export function roleFromGrants(grants: readonly Grant[], userId: string, channelId?: string | null): Role | null {
  if (!userId) return null;
  const mine = grants.filter((g) => g.subjectKind === "user" && g.subjectId === userId);
  if (mine.some((g) => g.deny)) return null;
  if (mine.some((g) => g.role === "manager")) return "manager";
  const scoped = !!channelId && grants.some((g) => g.source === "soul" && g.role === "approver" && g.channelId === channelId);
  const approver = mine.some(
    (g) => g.role === "approver" && (g.source === "console" || (scoped ? g.channelId === channelId : !g.channelId)),
  );
  if (approver) return "approver";
  if (mine.some((g) => g.role === "member")) return "member";
  const viaChannel = !!channelId && grants.some((g) => !g.deny && g.subjectKind === "channel" && g.subjectId === channelId);
  const viaWorkspace = grants.some((g) => !g.deny && g.subjectKind === "workspace");
  return viaChannel || viaWorkspace ? "member" : null;
}

/** Stored grants are cached per persona for this long; create and revoke in
 *  this process invalidate at once. */
const TTL_MS = 5_000;
const FAILURE_LOG_EVERY_MS = 60_000;

type Reader = (persona: string, now: number) => Promise<Grant[]>;
const defaultReader: Reader = async (persona, now) => (await AgentGrants.listForPersona(persona, now)).map(grantFromRow);
let reader: Reader = defaultReader;
const cache = new Map<string, { at: number; grants: Grant[] }>();
let generation = 0;
let lastFailureLog = -Infinity;

const key = (persona: string | null | undefined) => (persona ? persona : "default");

/** Drop cached stored grants for one persona, or for all. */
export function invalidateGrants(persona?: string | null): void {
  generation++;
  if (persona) cache.delete(key(persona));
  else cache.clear();
}
AgentGrants.onGrantsChanged((p) => invalidateGrants(p));

/**
 * A persona's stored grants, cached. A failed read degrades to none (so access
 * is soul-only, today's behaviour): it is counted in
 * slaude_grants_read_failures_total, logged at most once a minute, and not
 * cached, so the next call retries.
 */
async function storedGrants(persona: string): Promise<Grant[]> {
  const now = Date.now();
  const hit = cache.get(persona);
  if (hit && now - hit.at < TTL_MS) return hit.grants;
  const gen = generation;
  try {
    const grants = await reader(persona, now);
    if (gen === generation) cache.set(persona, { at: now, grants });
    return grants;
  } catch (e) {
    m.grantsReadFailuresTotal.inc();
    if (now - lastFailureLog >= FAILURE_LOG_EVERY_MS) {
      lastFailureLog = now;
      console.error(`[access] agent_grants read failed persona=${persona}; using soul-derived grants only: ${(e as Error)?.message ?? e}`);
    }
    return [];
  }
}

/** A persona's effective grants: soul-derived plus stored (cached). Never throws. */
export async function loadGrants(persona: string | null | undefined): Promise<Grant[]> {
  const p = key(persona);
  return effectiveGrants(p, await storedGrants(p));
}

/** `roleFromGrants` over {@link loadGrants}. */
export async function roleOf(persona: string | null | undefined, userId: string, channelId?: string | null): Promise<Role | null> {
  return roleFromGrants(await loadGrants(persona), userId, channelId);
}

/** Test seam: replace the stored-grant read (null restores). Clears the cache. */
export function __setGrantsReader(f: Reader | null): void {
  reader = f ?? defaultReader;
  lastFailureLog = -Infinity;
  invalidateGrants();
}
