/**
 * Slack event dedup, durable across restarts and shared across replicas.
 *
 * One row per delivered event id; `tryInsert` is the atomic claim (INSERT OR
 * IGNORE / ON CONFLICT DO NOTHING) — exactly one caller per id wins. Rows are
 * only meaningful for Slack's retry window, so callers purge rows older than
 * an hour opportunistically via `maybePurge`.
 */
import { db } from "./schema";

export const MAX_AGE_MS = 60 * 60 * 1000; // 1h — beyond any Slack retry window

/** Claim an event id. True = first sighting (process it); false = duplicate. */
export async function tryInsert(eventId: string, now: number = Date.now()): Promise<boolean> {
  const sql =
    db.dialect === "sqlite"
      ? `INSERT OR IGNORE INTO seen_events (event_id, ts) VALUES (?, ?)`
      : `INSERT INTO seen_events (event_id, ts) VALUES (?, ?) ON CONFLICT DO NOTHING`;
  const r = await db.run(sql, [eventId, now]);
  return r.changes > 0;
}

/** Drop rows older than `maxAgeMs`. Returns how many were purged. */
export async function purgeOlderThan(
  maxAgeMs: number = MAX_AGE_MS,
  now: number = Date.now(),
): Promise<number> {
  const r = await db.run(`DELETE FROM seen_events WHERE ts < ?`, [now - maxAgeMs]);
  return r.changes;
}

let lastPurgeAt = 0;

/** Opportunistic purge: runs `purgeOlderThan` at most once per `intervalMs`.
 *  Cheap enough to call from the hot inbound path. */
export async function maybePurge(now: number = Date.now(), intervalMs = 5 * 60 * 1000): Promise<void> {
  if (now - lastPurgeAt < intervalMs) return;
  lastPurgeAt = now;
  await purgeOlderThan(MAX_AGE_MS, now);
}

/** Test hook: reset the purge clock so maybePurge fires deterministically. */
export function __resetPurgeClockForTests(): void {
  lastPurgeAt = 0;
}
