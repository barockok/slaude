import { db } from "./schema";

export interface MentionOnlyRow {
  channel_id: string;
  thread_ts: string;
  created_by: string;
  created_at: number;
}

/** Mark a thread mention-only: the agent replies only to messages that @-mention it,
 *  never to plain thread follow-ups. Upsert — re-setting refreshes created_by. */
export async function set(input: { channelId: string; threadTs: string; createdBy: string }): Promise<void> {
  await db.run(
    `INSERT INTO mention_only_threads (channel_id, thread_ts, created_by, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET created_by = excluded.created_by, created_at = excluded.created_at`,
    [input.channelId, input.threadTs, input.createdBy, Date.now()],
  );
}

export async function clear(channelId: string, threadTs: string): Promise<void> {
  await db.run("DELETE FROM mention_only_threads WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export async function find(channelId: string, threadTs: string): Promise<MentionOnlyRow | null> {
  return db.one<MentionOnlyRow>("SELECT * FROM mention_only_threads WHERE channel_id = ? AND thread_ts = ?", [
    channelId,
    threadTs,
  ]);
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM mention_only_threads");
}
