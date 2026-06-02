import { db } from "./schema";

export interface OneOnOneLockRow {
  channel_id: string;
  thread_ts: string;
  locked_user: string;
  created_by: string;
  created_at: number;
}

/** Lock a thread to a single speaker. Upserts: re-locking the same thread replaces. */
export function lock(input: { channelId: string; threadTs: string; lockedUser: string; createdBy: string }): void {
  db.run(
    `INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET locked_user = excluded.locked_user, created_by = excluded.created_by, created_at = excluded.created_at`,
    [input.channelId, input.threadTs, input.lockedUser, input.createdBy, Date.now()],
  );
}

export function unlock(channelId: string, threadTs: string): void {
  db.run("DELETE FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export function find(channelId: string, threadTs: string): OneOnOneLockRow | null {
  const row = db.query("SELECT * FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?").get(channelId, threadTs) as any;
  return row ? (row as OneOnOneLockRow) : null;
}

export function _wipeForTests(): void {
  db.run("DELETE FROM one_on_one_locks");
}
