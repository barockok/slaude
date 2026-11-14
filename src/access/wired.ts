/**
 * Call-site helpers for the access seam (slice C, tasks 13 to 20). A site awaits
 * one of these instead of the legacy reader and uses the value it returns.
 *
 * Under `SLAUDE_ACCESS_SOURCE=legacy|shadow` (the default is `shadow`) that
 * value IS the legacy value: the helper computes it from the same grants and
 * the same function the site called before and returns it without waiting for
 * anything, then hands the identical inputs to the seam (`decide.ts`) in the
 * background. Under `internal` (task 20) the helper awaits the seam and returns
 * the internal-id answer; when the seam cannot answer, the fallback is the
 * legacy result for ordinary questions and a refusal for privileged ones
 * (`decide.ts`). The calls are async only so that the one `internal` path can
 * wait on the database; they never throw.
 *
 * Why background: the seam's shadow path reads the database (acting user,
 * bindings). Nothing a site returns may wait for it, throw because of it, or
 * change because of it. So:
 *  - the legacy value is returned before any shadow work starts;
 *  - the shadow runs on a detached promise whose failure is swallowed (the seam
 *    already counts `new_error`; anything it misses is dropped here);
 *  - with `SLAUDE_ACCESS_SOURCE=legacy` no shadow work is started at all, only
 *    the per-site decision counter moves, synchronously;
 *  - at most MAX_INFLIGHT shadows run at once per process: a resolver that has
 *    stalled costs a counted drop (`outcome="dropped"`), not unbounded memory;
 *  - without a workspace (no team id on the event) the engine cannot name the
 *    acting identity, so the shadow is skipped and counted `no_team`.
 *
 * Under shadow, everything below applies. Under `internal`, a call with no
 * workspace cannot name the acting identity: ordinary questions get the legacy
 * answer and privileged ones a refusal (counted `source="fallback_legacy"` and
 * `outcome="no_team"`).
 */
import { env } from "../config/env";
import { m } from "../metrics";
import type { AdmitResult } from "./admission";
import { admit } from "./admission";
import { decideAdmit, decideApproverSplit, decideApprovers, decideCheck, decideDenied, decideList, decideRole, decideSame, showAdmit, showRole, type ApproverSplit } from "./decide";
import type { EngineActor, EngineOpts } from "./authority";
import type { Grant } from "./grants";
import { isDenied, roleFromGrants, usersWithRole, type Role } from "./role";
import type { SiteId } from "./sites";

/** Shadows in flight at once, per process. */
export const MAX_INFLIGHT = 16;

const pending = new Set<Promise<void>>();

/** Resolve when every shadow started so far has finished (tests; never called on a hot path). */
export async function settleShadows(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/**
 * Record the decision and start the shadow. Never throws and never waits: the
 * caller already holds its legacy answer.
 */
function shadow(site: SiteId, result: string, teamId: string | null | undefined, run: () => Promise<unknown>): void {
  try {
    if (env.access.source() === "legacy") {
      m.accessDecisionTotal.inc({ source: "legacy", site, result });
      return;
    }
    if (!teamId) {
      m.accessDecisionTotal.inc({ source: "legacy", site, result });
      m.accessShadowTotal.inc({ site, outcome: "no_team" });
      return;
    }
    if (pending.size >= MAX_INFLIGHT) {
      m.accessDecisionTotal.inc({ source: "legacy", site, result });
      m.accessShadowTotal.inc({ site, outcome: "dropped" });
      return;
    }
    const p: Promise<void> = Promise.resolve()
      .then(run)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pending.delete(p);
      });
    pending.add(p);
  } catch {
    /* counting must never fail a decision */
  }
}

/** Whether the answer comes from the internal path (read on every call). */
export const isInternal = (): boolean => env.access.source() === "internal";

/**
 * Under `internal`: await the seam. A call with no workspace, or a seam that
 * threw (it does not), answers `unanswered`: the legacy value for an ordinary
 * question, a refusal for a privileged one. Under the other sources: record the
 * decision, start the shadow, return `legacy` at once.
 */
async function route<T>(o: { site: SiteId; legacy: T; show: (v: T) => string; teamId: string | null | undefined; unanswered: T; run: () => Promise<T> }): Promise<T> {
  if (!isInternal()) {
    shadow(o.site, o.show(o.legacy), o.teamId, o.run);
    return o.legacy;
  }
  try {
    if (!o.teamId) {
      m.accessShadowTotal.inc({ site: o.site, outcome: "no_team" });
      m.accessDecisionTotal.inc({ source: "fallback_legacy", site: o.site, result: o.show(o.unanswered) });
      return o.unanswered;
    }
    return await o.run();
  } catch {
    try {
      m.accessDecisionTotal.inc({ source: "fallback_legacy", site: o.site, result: o.show(o.unanswered) });
    } catch {
      /* counting must never fail a decision */
    }
    return o.unanswered;
  }
}

const demote = (r: Role | null): Role | null => (r === "manager" || r === "approver" ? "member" : r);

/** Admission: `admit()` over the grants. */
export async function admitAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string;
  channelId: string;
  isDM: boolean;
  grants: readonly Grant[];
}): Promise<AdmitResult> {
  const legacy = admit({ grants: o.grants, userId: o.userId, channelId: o.channelId, isDM: o.isDM });
  return route({
    site: o.site,
    legacy,
    show: showAdmit,
    teamId: o.teamId,
    unanswered: legacy,
    run: () => decideAdmit({ ...o, teamId: o.teamId! }),
  });
}

/** A user's role over the grants. */
export async function roleAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string;
  channelId?: string | null;
  grants: readonly Grant[];
}): Promise<Role | null> {
  const legacy = roleFromGrants(o.grants, o.userId, o.channelId);
  return route({ site: o.site, legacy, show: showRole, teamId: o.teamId, unanswered: demote(legacy), run: () => decideRole({ ...o, teamId: o.teamId! }) });
}

/** Who holds one of `roles` (Slack ids). Under `internal` an outage, or no workspace, returns no one. */
export async function approversAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
}): Promise<string[]> {
  const legacy = usersWithRole(o.grants, o.roles, o.channelId);
  return route({ site: o.site, legacy, show: (ids) => `${ids.length}`, teamId: o.teamId, unanswered: [], run: () => decideApprovers({ ...o, teamId: o.teamId! }) });
}

/**
 * Who holds one of `roles`, split for a card's allowlist: direct Slack ids and
 * the user ids that `email:` and `user:` entries name. Legacy and shadow:
 * the legacy ids and no user ids.
 */
export async function approverSplitAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
  /** The ids the site would use without the seam, when they are not `usersWithRole` over `grants` (an agent.yaml file's managers). */
  legacy?: string[];
}): Promise<ApproverSplit> {
  const legacy = { slackIds: o.legacy ?? usersWithRole(o.grants, o.roles, o.channelId), userIds: [] as string[] };
  return route({
    site: o.site,
    legacy,
    show: (r) => `${r.slackIds.length + r.userIds.length}`,
    teamId: o.teamId,
    unanswered: { slackIds: [], userIds: [] },
    run: () => decideApproverSplit({ ...o, teamId: o.teamId! }),
  });
}

/**
 * Whether two Slack ids are the same person at a lock or manager compare. The
 * legacy answer is the string compare (`a === b`); under `internal` it is Rule G
 * (`sameUser`). `otherTeamId` is the lock's workspace; a lock with none is read
 * as the speaker's own workspace.
 */
export async function sameAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string | null | undefined;
  otherUserId: string | null | undefined;
  otherTeamId?: string | null;
}): Promise<boolean> {
  const legacy = o.userId === o.otherUserId;
  const known = !!o.teamId && !!o.userId && !!o.otherUserId;
  return route({
    site: o.site,
    legacy,
    show: (v) => (v ? "same" : "different"),
    teamId: known ? o.teamId : null,
    unanswered: legacy,
    run: () =>
      decideSame({
        site: o.site,
        persona: o.persona,
        a: { teamId: o.teamId!, slackUserId: o.userId! },
        b: { teamId: o.otherTeamId || o.teamId!, slackUserId: o.otherUserId! },
      }),
  });
}

/** Whether a deny grant reaches the user (`isDenied`). A resolver outage never removes a Slack deny. */
export async function deniedAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string;
  grants: readonly Grant[];
}): Promise<boolean> {
  const legacy = isDenied(o.grants, o.userId);
  return route({ site: o.site, legacy, show: (v) => (v ? "denied" : "clear"), teamId: o.teamId, unanswered: legacy, run: () => decideDenied({ ...o, teamId: o.teamId! }) });
}

/**
 * A check the site already made with its own legacy reader (an allowlist, a
 * soul field), against `internal`, the engine's twin over `grants`. `legacy` is
 * what comes back unless the source is `internal`. `grants` is read lazily. Under
 * `internal` an outage, or no workspace, answers `onFailure` (default false: a
 * privileged refusal).
 */
export async function checkAt<T extends boolean | string>(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string | null | undefined;
  legacy: T;
  grants: () => Promise<readonly Grant[]> | readonly Grant[];
  fresh?: boolean;
  internal: (i: { grants: Grant[]; actor: EngineActor; opts: EngineOpts }) => T;
  /** The answer when the internal path cannot say who is acting. Default: false for a boolean, the legacy value otherwise. */
  onFailure?: T;
}): Promise<T> {
  const known = !!o.teamId && !!o.userId;
  const unanswered = (o.onFailure ?? (typeof o.legacy === "boolean" ? false : o.legacy)) as T;
  return route({
    site: o.site,
    legacy: o.legacy,
    show: String,
    teamId: known ? o.teamId : null,
    unanswered,
    run: async () =>
      decideCheck<T>({
        site: o.site,
        persona: o.persona,
        teamId: o.teamId!,
        userId: o.userId!,
        grants: await o.grants(),
        fresh: o.fresh ?? true,
        legacy: o.legacy,
        show: String,
        internal: o.internal,
        onFailure: () => unanswered,
      }),
  });
}

/**
 * A list of Slack ids a site already built its own way (the soul's managers, a
 * digest recipient), against who the persona's grants name for `roles`. `legacy`
 * is what comes back unless the source is `internal`; then it is the grants'
 * people as Slack ids. `refuseOnFailure`: an outage returns no one instead of
 * `legacy` (a privileged list). `grants` is read lazily, and only when a
 * workspace is known.
 */
export async function listAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  legacy: string[];
  roles: readonly Role[];
  channelId?: string | null;
  refuseOnFailure?: boolean;
  grants: () => Promise<readonly Grant[]> | readonly Grant[];
}): Promise<string[]> {
  return route({
    site: o.site,
    legacy: o.legacy,
    show: (ids) => `${ids.length}`,
    teamId: o.teamId,
    unanswered: o.refuseOnFailure ? [] : o.legacy,
    run: async () =>
      decideList({ site: o.site, persona: o.persona, teamId: o.teamId!, grants: await o.grants(), roles: o.roles, channelId: o.channelId, legacy: o.legacy, refuseOnFailure: o.refuseOnFailure }),
  });
}

/**
 * True when the speaker is the same person as any of `others` (a list of
 * managers, approvers). Compares one at a time and stops at the first match, as
 * `Array.some` did over the string compare.
 */
export async function someSameAt(others: readonly string[], of: (other: string) => Parameters<typeof sameAt>[0]): Promise<boolean> {
  for (const other of others) if (await sameAt(of(other))) return true;
  return false;
}

/**
 * {@link sameAt} for a site with no workspace on the call that cannot await
 * (a sync function). With no workspace the engine cannot name either identity,
 * so the answer is the string compare in every mode; the decision is counted
 * (`no_team`) like any other. Not for a site that has a team.
 */
export function sameNoTeam(o: { site: SiteId; persona: string | null | undefined; userId: string | null | undefined; otherUserId: string | null | undefined }): boolean {
  void sameAt({ ...o, teamId: null });
  return o.userId === o.otherUserId;
}
