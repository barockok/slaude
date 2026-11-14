/**
 * Call-site helpers for the shadow seam (slice C, tasks 13 to 18). A site calls
 * one of these instead of the legacy reader and uses the value it returns,
 * which IS the legacy value: the helper computes it synchronously from the same
 * grants and the same function the site called before, then hands the identical
 * inputs to the seam (`decide.ts`) in the background.
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
 * A site that decides with the internal answer is task 20, not this file.
 */
import { env } from "../config/env";
import { m } from "../metrics";
import type { AdmitResult } from "./admission";
import { admit } from "./admission";
import { decideAdmit, decideApprovers, decideCheck, decideDenied, decideList, decideRole, decideSame, showAdmit, showRole } from "./decide";
import type { EngineActor } from "./authority";
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

/** Admission: `admit()` over the grants, shadowed. */
export function admitAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string;
  channelId: string;
  isDM: boolean;
  grants: readonly Grant[];
}): AdmitResult {
  const legacy = admit({ grants: o.grants, userId: o.userId, channelId: o.channelId, isDM: o.isDM });
  shadow(o.site, showAdmit(legacy), o.teamId, () => decideAdmit({ ...o, teamId: o.teamId! }));
  return legacy;
}

/** A user's role over the grants, shadowed. */
export function roleAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string;
  channelId?: string | null;
  grants: readonly Grant[];
}): Role | null {
  const legacy = roleFromGrants(o.grants, o.userId, o.channelId);
  shadow(o.site, showRole(legacy), o.teamId, () => decideRole({ ...o, teamId: o.teamId! }));
  return legacy;
}

/** Who holds one of `roles` (Slack ids), shadowed. */
export function approversAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  grants: readonly Grant[];
  roles: readonly Role[];
  channelId?: string | null;
}): string[] {
  const legacy = usersWithRole(o.grants, o.roles, o.channelId);
  shadow(o.site, `${legacy.length}`, o.teamId, () => decideApprovers({ ...o, teamId: o.teamId! }));
  return legacy;
}

/**
 * Whether two Slack ids are the same person at a lock or manager compare,
 * shadowed. The returned value is the string compare the site made before
 * (`a === b`). `otherTeamId` is the lock's workspace; a lock with none is read
 * as the speaker's own workspace for the shadow only.
 */
export function sameAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string | null | undefined;
  otherUserId: string | null | undefined;
  otherTeamId?: string | null;
}): boolean {
  const legacy = o.userId === o.otherUserId;
  const known = !!o.teamId && !!o.userId && !!o.otherUserId;
  shadow(o.site, legacy ? "same" : "different", known ? o.teamId : null, () =>
    decideSame({
      site: o.site,
      persona: o.persona,
      a: { teamId: o.teamId!, slackUserId: o.userId! },
      b: { teamId: o.otherTeamId || o.teamId!, slackUserId: o.otherUserId! },
    }),
  );
  return legacy;
}

/** Whether a deny grant reaches the user (`isDenied`), shadowed. */
export function deniedAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string;
  grants: readonly Grant[];
}): boolean {
  const legacy = isDenied(o.grants, o.userId);
  shadow(o.site, legacy ? "denied" : "clear", o.teamId, () => decideDenied({ ...o, teamId: o.teamId! }));
  return legacy;
}

/**
 * A check the site already made with its own legacy reader (an allowlist, a
 * soul field), shadowed against `internal`, the engine's twin over `grants`.
 * `legacy` is returned as given. `grants` is read lazily, in the background, so
 * a site that has none loaded pays nothing in the foreground.
 */
export function checkAt<T extends boolean | string>(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  userId: string | null | undefined;
  legacy: T;
  grants: () => Promise<readonly Grant[]> | readonly Grant[];
  fresh?: boolean;
  internal: (i: { grants: Grant[]; actor: EngineActor }) => T;
}): T {
  const known = !!o.teamId && !!o.userId;
  shadow(o.site, String(o.legacy), known ? o.teamId : null, async () =>
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
    }),
  );
  return o.legacy;
}

/**
 * A list of Slack ids a site already built its own way (the soul's managers, a
 * digest recipient), shadowed against who the persona's grants name for
 * `roles`. `legacy` is returned as given. `grants` is read lazily, in the
 * background, and only when a workspace is known.
 */
export function listAt(o: {
  site: SiteId;
  persona: string | null | undefined;
  teamId: string | null | undefined;
  legacy: string[];
  roles: readonly Role[];
  channelId?: string | null;
  grants: () => Promise<readonly Grant[]> | readonly Grant[];
}): string[] {
  shadow(o.site, `${o.legacy.length}`, o.teamId, async () =>
    decideList({ site: o.site, persona: o.persona, teamId: o.teamId!, grants: await o.grants(), roles: o.roles, channelId: o.channelId, legacy: o.legacy }),
  );
  return o.legacy;
}
