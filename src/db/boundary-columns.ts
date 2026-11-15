/**
 * Domain sessions, slice D: the `boundary_id` and `locator` a writer stores
 * beside the Slack columns. Cache only (`boundaryForCached`): no query, no await,
 * never throws. An unknown boundary, a missing team or the kill switch gives
 * `{ boundaryId: null, locator: null }` and the fill completes the row later.
 * The locator is only ever set together with its boundary, so a row either
 * carries the whole pair or none of it.
 */
import { boundaryForCached, locatorOf } from "../domain/boundary-for";

export interface Pair {
  boundaryId: string | null;
  locator: string | null;
}

const NONE: Pair = { boundaryId: null, locator: null };

/** The pair for a thread-scoped row. `thread` is the opaque key stored verbatim. */
export function pairFor(team: string | null | undefined, channel: string | null | undefined, thread: string | null | undefined): Pair {
  try {
    const b = boundaryForCached(team, channel);
    if (!b) return NONE;
    const locator = locatorOf(thread);
    return locator ? { boundaryId: b.id, locator } : NONE;
  } catch {
    return NONE;
  }
}

/** The boundary id for a channel-scoped row (no thread key). */
export function boundaryOnly(team: string | null | undefined, channel: string | null | undefined): string | null {
  try {
    return boundaryForCached(team, channel)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The session key a cron job runs under (`src/gateway/slack/cron-scheduler.ts`):
 * `cron:<id>` for a channel-target job, else the job's Slack thread, else
 * `cron:<id>`. The legacy `channel_id` / `thread_ts` pair is the delivery
 * target and is never the locator.
 */
export function cronLocator(job: { id: string; target?: string | null; slackThreadTs?: string | null }): string {
  if (job.target === "channel") return `cron:${job.id}`;
  return job.slackThreadTs || `cron:${job.id}`;
}
