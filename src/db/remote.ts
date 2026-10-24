import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";
import * as Envs from "./environments";

/** A thread's remote binding in the pre-environment shape, kept for the
 *  `/remote` alias and the lock transitions. Backed by env_bindings. */
export interface RemoteTargetRow {
  channel_id: string;
  thread_ts: string;
  team_id: string;
  /** The environment's owner. */
  user_id: string;
  /** tailcat address for a tailcat environment, "" otherwise. Sensitive: never echo, never log. */
  addr: string;
  /** Absolute directory on the remote, resolved at pre-flight. */
  dir: string;
  /** 1 when binding the environment created the thread's 1on1 lock (so `/remote off` releases it). */
  lock_by_remote: number;
  created_at: number;
  env_id: string;
  kind: string;
}

export interface RemoteKeyPair {
  privateKey: string;
  publicKey: string;
}

/** `/remote <addr>`: bind the thread to the owner's tailcat environment for
 *  that address, creating one (named tailcat, tailcat-2, …) when none exists. */
export async function setTarget(i: {
  channelId: string; threadTs: string; teamId: string; userId: string;
  addr: string; dir: string; lockByRemote: boolean;
}): Promise<void> {
  let env = await Envs.findTailcatEnvByAddr(i.teamId, i.userId, i.addr);
  if (!env) {
    env = await Envs.createEnv({
      teamId: i.teamId, userId: i.userId, kind: "tailcat",
      name: await Envs.freeName(i.teamId, i.userId, "tailcat"),
      config: { addr: i.addr },
      defaultDir: i.dir,
    });
  }
  await Envs.bind({ channelId: i.channelId, threadTs: i.threadTs, envId: env.id, dir: i.dir, lockByEnv: i.lockByRemote });
}

async function toTargetRow(b: Envs.BindingRow | null): Promise<RemoteTargetRow | null> {
  if (!b) return null;
  const env = await Envs.getEnv(b.env_id);
  if (!env) return null;
  return {
    channel_id: b.channel_id,
    thread_ts: b.thread_ts,
    team_id: env.teamId,
    user_id: env.userId,
    addr: env.kind === "tailcat" ? (env.config.addr ?? "") : "",
    dir: b.dir,
    lock_by_remote: Number(b.lock_by_env),
    created_at: Number(b.created_at),
    env_id: env.id,
    kind: env.kind,
  };
}

export async function findTarget(channelId: string, threadTs: string): Promise<RemoteTargetRow | null> {
  return toTargetRow(await Envs.findBinding(channelId, threadTs));
}

/** Remove a thread's binding. Returns the removed row (null when there was none). */
export async function clearTarget(channelId: string, threadTs: string): Promise<RemoteTargetRow | null> {
  const row = await findTarget(channelId, threadTs);
  await Envs.clearBinding(channelId, threadTs);
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

/** Store a pair, overwriting any existing one (replaces an unusable key). */
export async function replaceKey(teamId: string, userId: string, pair: RemoteKeyPair): Promise<RemoteKeyPair> {
  await db.run(
    `INSERT INTO remote_keys (team_id, user_id, public_key, private_key, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, user_id)
     DO UPDATE SET public_key = excluded.public_key, private_key = excluded.private_key, created_at = excluded.created_at`,
    [teamId, userId, pair.publicKey, encrypt(pair.privateKey), Date.now()],
  );
  const stored = await getKey(teamId, userId);
  if (!stored) throw new Error("remote key replace did not persist");
  return stored;
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM remote_targets");
  await db.run("DELETE FROM remote_keys");
  await Envs._wipeForTests();
}
