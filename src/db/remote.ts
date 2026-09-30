import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";

export interface RemoteTargetRow {
  channel_id: string;
  thread_ts: string;
  team_id: string;
  user_id: string;
  /** tailcat address. Sensitive: never echo, never log. */
  addr: string;
  /** Absolute directory on the remote, resolved at pre-flight. */
  dir: string;
  /** 1 when `/remote` created the thread's 1on1 lock (so `/remote off` releases it). */
  lock_by_remote: number;
  created_at: number;
}

export interface RemoteKeyPair {
  privateKey: string;
  publicKey: string;
}

export async function setTarget(i: {
  channelId: string; threadTs: string; teamId: string; userId: string;
  addr: string; dir: string; lockByRemote: boolean;
}): Promise<void> {
  await db.run(
    `INSERT INTO remote_targets (channel_id, thread_ts, team_id, user_id, addr, dir, lock_by_remote, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET team_id = excluded.team_id, user_id = excluded.user_id, addr = excluded.addr,
                   dir = excluded.dir, lock_by_remote = excluded.lock_by_remote, created_at = excluded.created_at`,
    [i.channelId, i.threadTs, i.teamId, i.userId, i.addr, i.dir, i.lockByRemote ? 1 : 0, Date.now()],
  );
}

export async function findTarget(channelId: string, threadTs: string): Promise<RemoteTargetRow | null> {
  return db.one<RemoteTargetRow>(
    "SELECT * FROM remote_targets WHERE channel_id = ? AND thread_ts = ?",
    [channelId, threadTs],
  );
}

/** Remove a thread's target. Returns the removed row (null when there was none). */
export async function clearTarget(channelId: string, threadTs: string): Promise<RemoteTargetRow | null> {
  const row = await findTarget(channelId, threadTs);
  if (!row) return null;
  await db.run("DELETE FROM remote_targets WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  return row;
}

export async function getKey(teamId: string, userId: string): Promise<RemoteKeyPair | null> {
  const row = await db.one<{ public_key: string; private_key: string }>(
    "SELECT public_key, private_key FROM remote_keys WHERE team_id = ? AND user_id = ?",
    [teamId, userId],
  );
  if (!row) return null;
  return { publicKey: row.public_key, privateKey: decrypt(row.private_key) };
}

/** Store a pair unless one exists; always returns the stored pair (first writer wins). */
export async function putKeyIfAbsent(teamId: string, userId: string, pair: RemoteKeyPair): Promise<RemoteKeyPair> {
  await db.run(
    `INSERT INTO remote_keys (team_id, user_id, public_key, private_key, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, user_id) DO NOTHING`,
    [teamId, userId, pair.publicKey, encrypt(pair.privateKey), Date.now()],
  );
  const stored = await getKey(teamId, userId);
  if (!stored) throw new Error("remote key insert did not persist");
  return stored;
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM remote_targets");
  await db.run("DELETE FROM remote_keys");
}
