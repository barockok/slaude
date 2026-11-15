/**
 * The person-slices seam (slice F, rc.22). `SLAUDE_PERSON_SLICES`, read on every
 * call:
 *  - `off` (default): nothing runs, no counter moves, no database call.
 *  - `shadow`: the caller keeps its legacy scope. In the background (never
 *    awaited by the caller) the verified-only union is computed and compared
 *    with the legacy own slice; the outcome is counted
 *    (`slaude_person_slices_shadow_total{site,outcome}`) and a disagreement is
 *    logged once per (site, reason) per minute with COUNTS ONLY: no Slack id,
 *    no slice name.
 *
 * `decidePersonSlices` never throws and never waits for the resolver. At most
 * MAX_INFLIGHT shadows run per process; the rest count `dropped`. It returns
 * nothing in rc.22 (legacy is authoritative): the union value is only handed to
 * a caller when rc.23 honours `union`.
 *
 * Outcomes: `match` (own slice only), `would_widen` (a verified second id adds
 * a slice: expected for a person who linked two ids, tagged
 * `verified-second-id`), `would_narrow` (the legacy own slice is missing from
 * the union: a bug), `no_user` (no record yet, or no workspace), `error`.
 */
import { env } from "../config/env";
import { personSlicesDetailed, type PersonSlicesResult } from "../knowledge/person-slices";
import { m } from "../metrics";
import type { SliceSiteId } from "./sites";

export const MAX_INFLIGHT = 16;
const LOG_EVERY_MS = 60_000;
const lastLogged = new Map<string, number>();
const pending = new Set<Promise<void>>();

/** Forget which lines were logged (tests). */
export function __resetSliceDecide(): void {
  lastLogged.clear();
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
 * Record the decision and start the shadow. Never throws and never waits: the
 * caller already holds its legacy scope. Nothing is returned in rc.22.
 */
export function decidePersonSlices(o: { site: SliceSiteId; teamId: string | null | undefined; slackUserId: string | null | undefined }): void {
  try {
    if (env.slices.mode() !== "shadow") return;
    if (!o.slackUserId || !o.teamId) {
      m.personSlicesShadowTotal.inc({ site: o.site, outcome: "no_user" });
      return;
    }
    if (pending.size >= MAX_INFLIGHT) {
      m.personSlicesShadowTotal.inc({ site: o.site, outcome: "dropped" });
      return;
    }
    const p: Promise<void> = Promise.resolve()
      .then(async () => record(o.site, await personSlicesDetailed(o.teamId, o.slackUserId!)))
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pending.delete(p);
      });
    pending.add(p);
  } catch {
    /* a shadow must never fail a decision */
  }
}
