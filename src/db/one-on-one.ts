import { db } from "./schema";

export interface OneOnOneLockRow {
  channel_id: string;
  thread_ts: string;
  locked_user: string;
  created_by: string;
  created_at: number;
  /** Non-null = open mode: guests may speak; scope injected as a constraint. Null = locked. */
  open_scope: string | null;
  /** The workspace the lock was taken in. NULL on rows from before migration 0040 (and on a lock whose team was unknown): see {@link lockOwnership}. */
  team_id?: string | null;
}

/**
 * Lock a thread to a single speaker. Upserts: re-locking the same thread replaces.
 * `teamId` is the workspace the locker spoke in; leave it out only when unknown
 * (stored NULL, read as unknown by {@link lockOwnership}).
 */
export async function lock(input: { channelId: string; threadTs: string; lockedUser: string; createdBy: string; teamId?: string | null }): Promise<void> {
  await db.run(
    `INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at, open_scope, team_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET locked_user = excluded.locked_user, created_by = excluded.created_by,
                   created_at = excluded.created_at, open_scope = NULL, team_id = excluded.team_id`,
    [input.channelId, input.threadTs, input.lockedUser, input.createdBy, Date.now(), input.teamId || null],
  );
}

/**
 * Whether `who` owns a lock, reading the lock's workspace. A Slack id is only
 * unique inside a workspace, so the same id in another workspace is `other`.
 * A row with no team is read as the tenant's single workspace when the caller
 * knows it (`singleTeam`), and as `unknown` otherwise: the caller then keeps
 * its legacy string answer. Pure; the gateway's live lock checks still compare
 * ids only until the access flip (slice C task 20), and feed this team to the
 * shadow seam instead.
 */
export function lockOwnership(
  lock: Pick<OneOnOneLockRow, "locked_user" | "team_id">,
  who: { teamId: string; userId: string },
  singleTeam?: string | null,
): "owner" | "other" | "unknown" {
  if (lock.locked_user !== who.userId) return "other";
  const team = lock.team_id || singleTeam || null;
  if (!team) return "unknown";
  return team === who.teamId ? "owner" : "other";
}

/** Open an existing lock to guests, injecting `scope` as a behavioural constraint. */
export async function setOpen(channelId: string, threadTs: string, scope: string): Promise<void> {
  await db.run(
    `UPDATE one_on_one_locks SET open_scope = ? WHERE channel_id = ? AND thread_ts = ?`,
    [scope, channelId, threadTs],
  );
}

/** Re-lock an open session back to initiator-only (clears open_scope). */
export async function setLocked(channelId: string, threadTs: string): Promise<void> {
  await db.run(
    `UPDATE one_on_one_locks SET open_scope = NULL WHERE channel_id = ? AND thread_ts = ?`,
    [channelId, threadTs],
  );
}

export async function unlock(channelId: string, threadTs: string): Promise<void> {
  await db.run("DELETE FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export async function find(channelId: string, threadTs: string): Promise<OneOnOneLockRow | null> {
  return db.one<OneOnOneLockRow>("SELECT * FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?", [
    channelId,
    threadTs,
  ]);
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM one_on_one_locks");
}
