/**
 * In-row boundary parity (domain sessions, slice D, rc.23).
 *
 * After the legacy lookup has returned a session row, `checkRow` compares the
 * `boundary_id` and `locator` that row already carries with what the boundary
 * cache says for the row's own team and channel. No second query, no sampling,
 * nothing awaited, never throws, never changes the row: the Slack columns stay
 * authoritative. Outcomes are counted in `slaude_boundary_check_total{site,outcome}`:
 *
 *  - match: the row's boundary equals the cached one and `locator` equals the thread column.
 *  - both_none: the row has none and the cache knows the boundary does not exist.
 *  - null_row: the row has none but a boundary exists (the fill has not reached it).
 *  - unresolved: the row has none and the cache does not know.
 *  - mismatch: the row's boundary differs from the cached one (gate-failing).
 *  - locator_mismatch: the row has a boundary and `locator` differs from the thread column (gate-failing).
 *  - unverified: the row has the pair and the cache does not know (counted, not failing).
 *
 * A brand new thread has no row from the find, so it counts nothing there; the
 * check after create sees the row that was just written.
 */
import { env } from "../config/env";
import { m } from "../metrics";
import { boundaryForCached } from "./boundary-for";

export type CheckOutcome = "match" | "both_none" | "null_row" | "unresolved" | "mismatch" | "locator_mismatch" | "unverified";

export interface CheckRow {
  slack_team_id?: string | null;
  slack_channel_id?: string | null;
  slack_thread_ts?: string | null;
  boundary_id?: string | null;
  locator?: string | null;
}

/** Pure classification: `cached` is what `boundaryForCached` answered. */
export function classifyRow(row: CheckRow, cached: { id: string } | null | undefined): CheckOutcome {
  if (!row.boundary_id) {
    if (cached === undefined) return "unresolved";
    return cached === null ? "both_none" : "null_row";
  }
  if (row.locator !== (row.slack_thread_ts ?? null)) return "locator_mismatch";
  if (cached === undefined) return "unverified";
  return cached !== null && cached.id === row.boundary_id ? "match" : "mismatch";
}

/** Count one outcome for a row the caller already holds. Synchronous and silent on any failure. */
export function checkRow(site: string, row: CheckRow | null | undefined): void {
  try {
    if (!row || !env.boundary.write() || env.role() === "node") return;
    const outcome = classifyRow(row, boundaryForCached(row.slack_team_id, row.slack_channel_id));
    m.boundaryCheckTotal.inc({ site, outcome });
  } catch {
    /* a check never reaches the caller */
  }
}
