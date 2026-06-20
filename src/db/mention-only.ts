import { db } from "./schema";

export interface MentionOnlyRow {
  channel_id: string;
  thread_ts: string;
  created_by: string;
  created_at: number;
}

/** Mark a thread mention-only: the agent replies only to messages that @-mention it,
 *  never to plain thread follow-ups. Upsert — re-setting refreshes created_by. */
export function set(input: { channelId: string; threadTs: string; createdBy: string }): void {
  db.run(
    `INSERT INTO mention_only_threads (channel_id, thread_ts, created_by, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET created_by = excluded.created_by, created_at = excluded.created_at`,
    [input.channelId, input.threadTs, input.createdBy, Date.now()],
  );
}

export function clear(channelId: string, threadTs: string): void {
  db.run("DELETE FROM mention_only_threads WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export function find(channelId: string, threadTs: string): MentionOnlyRow | null {
  const row = db.query("SELECT * FROM mention_only_threads WHERE channel_id = ? AND thread_ts = ?").get(channelId, threadTs) as any;
  return row ? (row as MentionOnlyRow) : null;
}

export function _wipeForTests(): void {
  db.run("DELETE FROM mention_only_threads");
}
