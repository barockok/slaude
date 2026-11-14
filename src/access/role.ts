import * as AgentGrants from "../db/agent-grants";
import { m } from "../metrics";
import { USER_ID_RE } from "../refs/ids";
import { managedPersonaDefinition } from "../persona/registry";
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

/**
 * True when `userId` holds a user deny grant in `grants` (a soul blocked user
 * or a stored deny row). A deny removes every role, so such a user may never
 * approve, whatever list names them.
 */
export function isDenied(grants: readonly Grant[], userId: string): boolean {
  return grants.some((g) => g.deny && g.subjectKind === "user" && g.subjectId === userId);
}

/**
 * Every user whose {@link roleFromGrants} on `channelId` is one of `roles`,
 * over already loaded grants (soul-derived and stored user grants). Sync.
 */
export function usersWithRole(grants: readonly Grant[], roles: readonly Role[], channelId?: string | null): string[] {
  // Only Slack user ids: the result is used to DM people and to match clicks, and
  // an `email:` or `user:` subject is neither. Until the access flip (slice C,
  // rc.20) such a subject must also never empty an allowlist, so it is dropped here.
  const users = new Set(grants.filter((g) => g.subjectKind === "user" && !g.deny && USER_ID_RE.test(g.subjectId)).map((g) => g.subjectId));
  return [...users].filter((u) => {
    const r = roleFromGrants(grants, u, channelId);
    return r !== null && roles.includes(r);
  });
}

/**
 * Stored grants are cached per persona for TTL_MS. A create or revoke in this
 * process invalidates at once; other replicas (and direct database edits) see
 * the change only when their entry expires, so a grant or a revoke can take up
 * to TTL_MS to apply across the cluster. A failed read caches the soul-only
 * result (no stored grants) for FAILURE_TTL_MS, so a database outage costs one
 * query per persona per FAILURE_TTL_MS rather than one per message.
 */
const TTL_MS = 5_000;
const FAILURE_TTL_MS = 2_000;
const FAILURE_LOG_EVERY_MS = 60_000;

type Reader = (persona: string, now: number) => Promise<Grant[]>;
const defaultReader: Reader = async (persona, now) => (await AgentGrants.listForPersona(persona, now)).map(grantFromRow);
let reader: Reader = defaultReader;
const cache = new Map<string, { until: number; grants: Grant[] }>();
/** One read in flight per persona: a burst of messages shares it. */
const inflight = new Map<string, Promise<Grant[]>>();
let generation = 0;
let lastFailureLog = -Infinity;

const key = (persona: string | null | undefined) => (persona ? persona : "default");

/** Drop cached stored grants for one persona, or for all. A read already in
 *  flight finishes but neither caches its result nor serves later callers. */
export function invalidateGrants(persona?: string | null): void {
  generation++;
  if (persona) {
    cache.delete(key(persona));
    inflight.delete(key(persona));
  } else {
    cache.clear();
    inflight.clear();
  }
}
// Registered at import: any module that reads grants through here also gets
// invalidated by create/revoke in the same process, with no wiring by callers.
// Revoke passes null (it does not read the row back), which clears every persona.
AgentGrants.onGrantsChanged((p) => invalidateGrants(p));

/**
 * A persona's stored grants, cached. A failed read degrades to none (so access
 * is soul-only, today's behaviour): it is counted in
 * slaude_grants_read_failures_total, logged at most once a minute, and cached
 * for FAILURE_TTL_MS.
 */
function storedGrants(persona: string): Promise<Grant[]> {
  const now = Date.now();
  const hit = cache.get(persona);
  if (hit && now < hit.until) return Promise.resolve(hit.grants);
  const pending = inflight.get(persona);
  if (pending) return pending;
  const gen = generation;
  const p = (async () => {
    let grants: Grant[];
    let ttl = TTL_MS;
    try {
      grants = await reader(persona, now);
    } catch (e) {
      m.grantsReadFailuresTotal.inc();
      if (now - lastFailureLog >= FAILURE_LOG_EVERY_MS) {
        lastFailureLog = now;
        console.error(`[access] agent_grants read failed persona=${persona}; using soul-derived grants only: ${(e as Error)?.message ?? e}`);
      }
      grants = [];
      ttl = FAILURE_TTL_MS;
    }
    if (gen === generation) cache.set(persona, { until: Date.now() + ttl, grants });
    return grants;
  })();
  inflight.set(persona, p);
  void p.finally(() => {
    if (inflight.get(persona) === p) inflight.delete(persona);
  });
  return p;
}

/**
 * A persona's effective grants: soul-derived plus stored (cached). Never
 * throws. `personaName` is the persona NAME (agent_grants is keyed by name;
 * null/undefined/"" mean "default"). Pass the result to `admit()` or
 * `roleFromGrants()`.
 */
export async function loadGrants(personaName: string | null | undefined): Promise<Grant[]> {
  const p = key(personaName);
  return effectiveGrants(p, await storedGrants(p));
}

/**
 * Who may approve for a NAMED persona, as the approval gate resolves it: every
 * user whose role on it (channel aware) is approver or manager, with no scope
 * keyword matching (phase 1); when it has none, the default persona's
 * managers (never for an agent.yaml persona); else nobody (an empty list). Not for the default persona, whose
 * gate matches soul approvers by scope per request.
 */
export async function approversFor(personaName: string, channelId?: string | null): Promise<string[]> {
  const own = usersWithRole(await loadGrants(personaName), ["approver", "manager"], channelId);
  // An agent.yaml persona has exactly the approvers its file names.
  if (own.length || managedPersonaDefinition(personaName)) return own;
  return usersWithRole(await loadGrants("default"), ["manager"]);
}

/** `roleFromGrants` over {@link loadGrants}; `personaName` is the persona NAME. */
export async function roleOf(personaName: string | null | undefined, userId: string, channelId?: string | null): Promise<Role | null> {
  return roleFromGrants(await loadGrants(personaName), userId, channelId);
}

/** Test seam: replace the stored-grant read (null restores). Clears the cache. */
export function __setGrantsReader(f: Reader | null): void {
  reader = f ?? defaultReader;
  lastFailureLog = -Infinity;
  invalidateGrants();
}
