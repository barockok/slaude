import { db } from "./schema";

export interface OneOnOneLockRow {
  channel_id: string;
  thread_ts: string;
  locked_user: string;
  created_by: string;
  created_at: number;
  /** Non-null = open mode: guests may speak; scope injected as a constraint. Null = locked. */
  open_scope: string | null;
  /** Named guests heard in a LOCKED 1on1 (`/1on1 invite`). Absent or empty = none.
   *  Guests never change whose identity the session runs as. */
  guests?: string[];
}

/** The stored guests column (a JSON array in TEXT) as ids. Anything unreadable
 *  is no guests: a bad value must never admit anyone. */
export function parseGuests(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && /^[UW][A-Z0-9]+$/.test(u)) : [];
  } catch {
    return [];
  }
}

/** Lock a thread to a single speaker. Upserts: re-locking the same thread
 *  replaces it, clearing open mode and any guests. */
export async function lock(input: { channelId: string; threadTs: string; lockedUser: string; createdBy: string }): Promise<void> {
  await db.run(
    `INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at, open_scope, guests)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET locked_user = excluded.locked_user, created_by = excluded.created_by,
                   created_at = excluded.created_at, open_scope = NULL, guests = NULL`,
    [input.channelId, input.threadTs, input.lockedUser, input.createdBy, Date.now()],
  );
}

/** Open an existing lock to guests, injecting `scope` as a behavioural
 *  constraint. Open mode admits everyone, so named guests are cleared. */
export async function setOpen(channelId: string, threadTs: string, scope: string): Promise<void> {
  await db.run(
    `UPDATE one_on_one_locks SET open_scope = ?, guests = NULL WHERE channel_id = ? AND thread_ts = ?`,
    [scope, channelId, threadTs],
  );
}

/** Re-lock an open session back to initiator-only (clears open_scope and guests). */
export async function setLocked(channelId: string, threadTs: string): Promise<void> {
  await db.run(
    `UPDATE one_on_one_locks SET open_scope = NULL, guests = NULL WHERE channel_id = ? AND thread_ts = ?`,
    [channelId, threadTs],
  );
}

/** Replace a lock's named guests (deduplicated, in the given order). An empty
 *  list stores NULL. No-op when the thread has no lock. */
export async function setGuests(channelId: string, threadTs: string, guests: readonly string[]): Promise<void> {
  const ids = [...new Set(guests)];
  await db.run(
    `UPDATE one_on_one_locks SET guests = ? WHERE channel_id = ? AND thread_ts = ?`,
    [ids.length ? JSON.stringify(ids) : null, channelId, threadTs],
  );
}

export async function unlock(channelId: string, threadTs: string): Promise<void> {
  await db.run("DELETE FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export async function find(channelId: string, threadTs: string): Promise<OneOnOneLockRow | null> {
  const row = await db.one<Omit<OneOnOneLockRow, "guests"> & { guests?: unknown }>(
    "SELECT * FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?",
    [channelId, threadTs],
  );
  if (!row) return null;
  return { ...row, guests: parseGuests(row.guests) };
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM one_on_one_locks");
}
