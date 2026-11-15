/**
 * The person-slices seam (slice F). `SLAUDE_PERSON_SLICES`, read on every
 * call:
 *  - `off` (default): nothing runs, no counter moves, no database call.
 *  - `shadow`: the caller keeps its legacy scope. In the background (never
 *    awaited by the caller) the verified-only union is computed and compared
 *    with the legacy own slice; the outcome is counted
 *    (`slaude_person_slices_shadow_total{site,outcome}`) and a disagreement is
 *    logged once per (site, reason) per minute with COUNTS ONLY: no Slack id,
 *    no slice name.
 *
 * Under shadow `decidePersonSlices` never waits for the resolver; at most
 * MAX_INFLIGHT shadows run per process, the rest count `dropped`. Under `union` it
 * awaits the bounded resolver and hands the person's slices to the caller.
 *
 * Outcomes: `match` (own slice only), `would_widen` (a verified second id adds
 * a slice: expected for a person who linked two ids, tagged
 * `verified-second-id`), `would_narrow` (the legacy own slice is missing from
 * the union: a bug), `no_user` (no record yet, or no workspace), `error`.
 */
import { env } from "../config/env";
import { personSlicesDetailed, type PersonSlicesResult } from "../knowledge/person-slices";
import { m } from "../metrics";
import { onActorsInvalidated } from "../refs/actor";
import type { PersonSlices } from "../knowledge/scope";
import type { SliceSiteId } from "./sites";

export const MAX_INFLIGHT = 16;
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();
const pending = new Set<Promise<void>>();

/**
 * One resolver run per (team, id) per short window: a KB tool call builds its scope and its gate
 * separately (two gate constructions), and a turn builds several. Concurrent and back-to-back calls
 * share one answer for COALESCE_MS; any link, unlink, merge or undo (`invalidateActors`) drops it.
 */
export const COALESCE_MS = 300;
const recent = new Map<string, { at: number; run: Promise<PersonSlicesResult> }>();
onActorsInvalidated(() => recent.clear());
function coalesced(teamId: string, slackUserId: string): Promise<PersonSlicesResult> {
  const key = `${teamId}\u0000${slackUserId}`;
  const now = Date.now();
  const hit = recent.get(key);
  if (hit && now - hit.at < COALESCE_MS) return hit.run;
  if (recent.size > 500) recent.clear();
  const run = personSlicesDetailed(teamId, slackUserId);
  const entry = { at: now, run };
  recent.set(key, entry);
  // A failure is never shared: the next call tries again.
  void run.then((r) => {
    if (r.status === "error" && recent.get(key) === entry) recent.delete(key);
  });
  return entry.run;
}

/** Forget which lines were logged (tests). */
export function __resetSliceDecide(): void {
  lastLogged.clear();
  recent.clear();
}

/** Resolve when every shadow started so far has finished (tests; never on a hot path). */
export async function settlePersonSliceShadows(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

function logOnce(key: string, line: () => string): void {
  const now = Date.now();
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_EVERY_MS) return;
  if (lastLogged.size > 500) lastLogged.clear();
  lastLogged.set(key, now);
  console.warn(line());
}

export type ShadowOutcome = "match" | "would_widen" | "would_narrow" | "no_user" | "error";

/** Pure: how a resolver result compares with the legacy own slice. */
export function outcomeOf(r: PersonSlicesResult): ShadowOutcome {
  if (r.status === "no_user") return "no_user";
  if (r.status === "error") return "error";
  if (!r.slices.reads.includes(r.slices.own)) return "would_narrow";
  return r.slices.reads.length > 1 ? "would_widen" : "match";
}

function record(site: SliceSiteId, r: PersonSlicesResult): void {
  const outcome = outcomeOf(r);
  m.personSlicesShadowTotal.inc({ site, outcome });
  const d = r.slices.dropped;
  if (outcome === "would_widen") {
    logOnce(`${site}|widen`, () => `[slices] shadow site=${site} outcome=would_widen reason=verified-second-id added=${r.slices.reads.length - 1} dropped_conflict=${d.conflict} dropped_tombstoned=${d.tombstoned}`);
  } else if (outcome === "would_narrow") {
    logOnce(`${site}|narrow`, () => `[slices] shadow site=${site} outcome=would_narrow reason=own-slice-missing reads=${r.slices.reads.length}`);
  } else if (outcome === "error") {
    logOnce(`${site}|error`, () => `[slices] shadow site=${site} outcome=error reason=resolver-failure-or-timeout`);
  } else if (outcome === "match" && (d.conflict > 0 || d.tombstoned > 0)) {
    logOnce(`${site}|dropped`, () => `[slices] shadow site=${site} outcome=match reason=names-dropped dropped_conflict=${d.conflict} dropped_tombstoned=${d.tombstoned}`);
  }
}

/**
 * The seam. Never throws.
 *  - `off`: returns undefined, nothing runs.
 *  - `shadow`: starts the background comparison, returns undefined at once (legacy scope).
 *  - `union` (rc.23): awaits the bounded resolver and returns the person's slices for the
 *    caller to attach to its gate input (READS only). A resolver error, the 250 ms bound or
 *    an unreadable tombstone table returns undefined (the caller keeps the legacy own
 *    slice, never a wider set) and counts `error`. The outcome is counted like in shadow.
 */
export async function decidePersonSlices(o: { site: SliceSiteId; teamId: string | null | undefined; slackUserId: string | null | undefined }): Promise<PersonSlices | undefined> {
  try {
    const mode = env.slices.mode();
    if (mode === "off") return undefined;
    if (!o.slackUserId || !o.teamId) {
      m.personSlicesShadowTotal.inc({ site: o.site, outcome: "no_user" });
      return undefined;
    }
    if (mode === "union") {
      const r = await coalesced(o.teamId, o.slackUserId);
      record(o.site, r);
      return r.status === "ok" && r.slices.via === "union" ? r.slices : undefined;
    }
    if (pending.size >= MAX_INFLIGHT) {
      m.personSlicesShadowTotal.inc({ site: o.site, outcome: "dropped" });
      return undefined;
    }
    const p: Promise<void> = Promise.resolve()
      .then(async () => {
        const r = await personSlicesDetailed(o.teamId, o.slackUserId!);
        record(o.site, r);
        // The in-flight slot stays taken until the queries themselves finish, even when the bound cut the wait,
        // so MAX_INFLIGHT bounds database load and not just the number of waiters.
        await r.done;
      })
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pending.delete(p);
      });
    pending.add(p);
    return undefined;
  } catch {
    /* the seam must never fail a decision: legacy */
    return undefined;
  }
}

/**
 * The person slices of a turn's `runAs` identity, for the memory scope. Rule S for runAs: `runAs` is
 * the speaker (or there is no speaker), and when a lock exists it is the lock owner's, so the team is
 * the lock's workspace when the lock names one, else the turn's. `memoryScopeFor` itself returns
 * nothing for a runAs that is not the speaker or the lock owner, so a person attached here is only
 * ever read in those two cases. Never throws.
 */
export async function runAsPersonFor(g: { teamId: string | null; lockedUser: string | null; lockedTeamId?: string | null }, runAsUser: string | null | undefined): Promise<PersonSlices | undefined> {
  if (!runAsUser) return undefined;
  const teamId = g.lockedUser ? (g.lockedTeamId ?? g.teamId) : g.teamId;
  return decidePersonSlices({ site: "memory.claims_run_as", teamId, slackUserId: runAsUser });
}
