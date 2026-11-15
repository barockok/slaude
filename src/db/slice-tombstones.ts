/**
 * Operator tombstones for the read-time memory union (slice F, task 4).
 *
 * A row says "this user's union drops this `user-` slice name" (`source_id`), or
 * "this user gets no union at all" (`'*'`). It exists because a merge undo only
 * reaches back seven days and an operator may need to revoke later. The table
 * has no foreign key on purpose: it must survive a merge deleting the user row.
 * A read matches the live user id plus every `user_aliases.old_id` that points
 * at it, so a tombstone keyed on a merged-away id still applies to the survivor.
 * A source-level row (`user_id = '*'`, a source name) applies to EVERY reader: it
 * survives a person relinking their ids to another account, which makes a new user.
 *
 * Slack ids are never shown: `maskSource` prints a source name as its prefix,
 * its length and a short hash the operator can compare with what they typed.
 */
import { db, type DbClient } from "./schema";
import * as Domain from "./domain";
import { invalidateActors } from "../refs/actor";

export interface TombstoneRow {
  user_id: string;
  source_id: string;
  created_by: string;
  reason: string;
  created_at: number;
}

export const ALL_SOURCES = "*";
const SOURCE_RE = /^user-[a-z0-9]+$/;

export const isTombstoneSource = (s: string): boolean => s === ALL_SOURCES || (s.length <= 32 && SOURCE_RE.test(s));

/** The `user_id` of a source-level row: no union of ANY reader may include `source_id`. */
export const ALL_READERS = "*";

/**
 * A source name without the Slack id inside it: the prefix and the length only. (A short hash of
 * an enumerable id would let anyone with the output confirm a guess, so there is none.)
 */
export function maskSource(source: string): string {
  if (source === ALL_SOURCES) return ALL_SOURCES;
  const dash = source.indexOf("-");
  const head = dash >= 0 ? source.slice(0, dash + 1) : "";
  return `${head}${"*".repeat(3)} (${source.length - head.length})`;
}

export type AddResult = { ok: true; created: boolean } | { ok: false; error: string };

/** Add a tombstone. Idempotent: an existing row (same user and source) is left as it is. */
export async function addTombstone(i: { userId: string; sourceId: string; createdBy: string; reason: string }, c: DbClient = db): Promise<AddResult> {
  const reason = i.reason.trim();
  if (!reason) return { ok: false, error: "a reason is required" };
  if (!isTombstoneSource(i.sourceId)) return { ok: false, error: "the source must be a user- slice name or *" };
  if (!i.userId.trim()) return { ok: false, error: "a user id is required" };
  if (i.userId === ALL_READERS) {
    // A source-level row: one name for every reader. Needs a name, never `*` for both.
    if (i.sourceId === ALL_SOURCES) return { ok: false, error: "an all-readers tombstone needs a source name" };
  } else {
    const known = (await Domain.getUser(i.userId, c)) ?? (await c.one("SELECT old_id FROM user_aliases WHERE old_id = ?", [i.userId]));
    if (!known) return { ok: false, error: "no such user" };
  }
  const r = await c.run(
    `INSERT INTO slice_tombstones (user_id, source_id, created_by, reason, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, source_id) DO NOTHING`,
    [i.userId, i.sourceId, i.createdBy, reason, Date.now()],
  );
  invalidateActors(); // drops the short resolver window in this process
  return { ok: true, created: (r.changes ?? 0) > 0 };
}

/** Remove one tombstone. True when a row was removed. */
export async function removeTombstone(userId: string, sourceId: string, c: DbClient = db): Promise<boolean> {
  const r = await c.run("DELETE FROM slice_tombstones WHERE user_id = ? AND source_id = ?", [userId, sourceId]);
  invalidateActors();
  return (r.changes ?? 0) > 0;
}

export async function listTombstones(c: DbClient = db): Promise<TombstoneRow[]> {
  const rows = await c.query<TombstoneRow>("SELECT * FROM slice_tombstones ORDER BY created_at, user_id, source_id");
  return rows.map((r) => ({ ...r, created_at: Number(r.created_at) }));
}

export interface TombstoneSet {
  /** A `*` row: no union at all. */
  all: boolean;
  /** `user-` names dropped from the union. */
  names: Set<string>;
}

/**
 * The tombstones that apply to a live user: rows keyed on its id or on any id
 * merged into it, plus the source-level rows (`user_id = '*'`) that name a slice
 * no reader may include. Throws on a database error: the resolver treats that as a
 * failure and falls back to the legacy own slice (Rule T).
 */
export async function tombstonesFor(liveUserId: string, c: DbClient = db): Promise<TombstoneSet> {
  const rows = await c.query<{ source_id: string }>(
    `SELECT source_id FROM slice_tombstones
     WHERE user_id = ? OR user_id IN (SELECT old_id FROM user_aliases WHERE user_id = ?)
        OR (user_id = '*' AND source_id <> '*')`,
    [liveUserId, liveUserId],
  );
  const names = new Set<string>();
  let all = false;
  for (const r of rows) {
    if (r.source_id === ALL_SOURCES) all = true;
    else names.add(r.source_id);
  }
  return { all, names };
}
