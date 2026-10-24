/**
 * Saved environments (per person) and the thread → environment binding
 * (environments spec §3, §9). Secrets and sandbox endpoints are stored as
 * crypto.ts envelopes; config may hold an address, so nothing here is logged.
 */
import { randomUUID } from "node:crypto";
import { db } from "./schema";
import { decrypt, encrypt } from "./crypto";
import type { ProvisionedEndpoint, StoredEnv } from "../remote/kinds/types";

interface EnvRow {
  id: string;
  team_id: string;
  user_id: string;
  name: string;
  kind: string;
  config: string;
  secrets: string | null;
  default_dir: string | null;
  created_at: number;
  updated_at: number;
}

export interface BindingRow {
  channel_id: string;
  thread_ts: string;
  env_id: string;
  /** Absolute directory, resolved at pre-flight. */
  dir: string;
  /** 1 when binding the environment created the thread's /1on1 lock. */
  lock_by_env: number;
  /** Encrypted ProvisionedEndpoint; null when not provisioned. */
  endpoint: string | null;
  generation: number;
  last_used_at: number;
  created_at: number;
}

/** Environment names: short, no spaces, safe to show in a thread and a prompt. */
export const ENV_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function toEnv(r: EnvRow): StoredEnv {
  return {
    id: r.id,
    teamId: r.team_id,
    userId: r.user_id,
    name: r.name,
    kind: r.kind,
    config: JSON.parse(r.config) as Record<string, string>,
    secrets: r.secrets ? (JSON.parse(decrypt(r.secrets)) as Record<string, string>) : {},
    defaultDir: r.default_dir,
    updatedAt: Number(r.updated_at),
  };
}

const sealSecrets = (s: Record<string, string> | undefined): string | null =>
  s && Object.keys(s).length > 0 ? encrypt(JSON.stringify(s)) : null;

export class EnvNameTakenError extends Error {
  constructor(name: string) {
    super(`you already have an environment named \`${name}\``);
  }
}

export async function createEnv(i: {
  teamId: string;
  userId: string;
  name: string;
  kind: string;
  config: Record<string, string>;
  secrets?: Record<string, string>;
  defaultDir?: string | null;
}): Promise<StoredEnv> {
  if (!ENV_NAME_RE.test(i.name)) throw new Error("invalid environment name");
  if (await findEnvByName(i.teamId, i.userId, i.name)) throw new EnvNameTakenError(i.name);
  const now = Date.now();
  const id = randomUUID();
  const r = await db.run(
    `INSERT INTO environments (id, team_id, user_id, name, kind, config, secrets, default_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, user_id, name) DO NOTHING`,
    [id, i.teamId, i.userId, i.name, i.kind, JSON.stringify(i.config), sealSecrets(i.secrets), i.defaultDir ?? null, now, now],
  );
  if (r.changes === 0) throw new EnvNameTakenError(i.name);
  const env = await getEnv(id);
  if (!env) throw new Error("environment insert did not persist");
  return env;
}

/** Update fields of an environment. `updated_at` always moves, so the
 *  environment's hash (and every warm session's fingerprint) changes. */
export async function updateEnv(
  id: string,
  p: { name?: string; config?: Record<string, string>; secrets?: Record<string, string>; defaultDir?: string | null },
): Promise<StoredEnv | null> {
  const cur = await getEnv(id);
  if (!cur) return null;
  if (p.name !== undefined && p.name !== cur.name) {
    if (!ENV_NAME_RE.test(p.name)) throw new Error("invalid environment name");
    if (await findEnvByName(cur.teamId, cur.userId, p.name)) throw new EnvNameTakenError(p.name);
  }
  await db.run(
    `UPDATE environments SET name = ?, config = ?, secrets = ?, default_dir = ?, updated_at = ? WHERE id = ?`,
    [
      p.name ?? cur.name,
      JSON.stringify(p.config ?? cur.config),
      p.secrets !== undefined ? sealSecrets(p.secrets) : sealSecrets(cur.secrets),
      p.defaultDir !== undefined ? p.defaultDir : cur.defaultDir,
      Math.max(Date.now(), cur.updatedAt + 1),
      id,
    ],
  );
  return getEnv(id);
}

export async function getEnv(id: string): Promise<StoredEnv | null> {
  const r = await db.one<EnvRow>("SELECT * FROM environments WHERE id = ?", [id]);
  return r ? toEnv(r) : null;
}

export async function findEnvByName(teamId: string, userId: string, name: string): Promise<StoredEnv | null> {
  const r = await db.one<EnvRow>("SELECT * FROM environments WHERE team_id = ? AND user_id = ? AND name = ?", [teamId, userId, name]);
  return r ? toEnv(r) : null;
}

export async function listEnvs(teamId: string, userId: string): Promise<StoredEnv[]> {
  const rows = await db.query<EnvRow>("SELECT * FROM environments WHERE team_id = ? AND user_id = ? ORDER BY name", [teamId, userId]);
  return rows.map(toEnv);
}

/** The owner's tailcat environment for an address, if one exists. */
export async function findTailcatEnvByAddr(teamId: string, userId: string, addr: string): Promise<StoredEnv | null> {
  const all = await listEnvs(teamId, userId);
  return all.find((e) => e.kind === "tailcat" && e.config.addr === addr) ?? null;
}

/** `prefix`, else `prefix-2`, `prefix-3`… — the first name the owner has free. */
export async function freeName(teamId: string, userId: string, prefix: string): Promise<string> {
  const taken = new Set((await listEnvs(teamId, userId)).map((e) => e.name));
  if (!taken.has(prefix)) return prefix;
  for (let n = 2; ; n++) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

/** Delete an environment and every binding to it. Returns the removed bindings
 *  so the caller can end remote mode in those threads. */
export async function deleteEnv(id: string): Promise<BindingRow[]> {
  const bindings = await bindingsForEnv(id);
  await db.run("DELETE FROM env_bindings WHERE env_id = ?", [id]);
  await db.run("DELETE FROM environments WHERE id = ?", [id]);
  return bindings;
}

// ── bindings ──────────────────────────────────────────────────────────────

export async function bind(i: { channelId: string; threadTs: string; envId: string; dir: string; lockByEnv: boolean }): Promise<void> {
  const now = Date.now();
  await db.run(
    `INSERT INTO env_bindings (channel_id, thread_ts, env_id, dir, lock_by_env, endpoint, generation, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET env_id = excluded.env_id, dir = excluded.dir, lock_by_env = excluded.lock_by_env,
                   endpoint = NULL, generation = 0, last_used_at = excluded.last_used_at, created_at = excluded.created_at`,
    [i.channelId, i.threadTs, i.envId, i.dir, i.lockByEnv ? 1 : 0, now, now],
  );
  await db.run("DELETE FROM remote_targets WHERE channel_id = ? AND thread_ts = ?", [i.channelId, i.threadTs]);
}

/** The thread's binding. A row left in the pre-environment `remote_targets`
 *  table is converted on first read: its address becomes a tailcat environment
 *  of the owner's (reused when one has the same address). */
export async function findBinding(channelId: string, threadTs: string): Promise<BindingRow | null> {
  const row = await db.one<BindingRow>("SELECT * FROM env_bindings WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  if (row) return row;
  return convertLegacy(channelId, threadTs);
}

interface LegacyRow {
  team_id: string;
  user_id: string;
  addr: string;
  dir: string;
  lock_by_remote: number;
  created_at: number;
}

async function convertLegacy(channelId: string, threadTs: string): Promise<BindingRow | null> {
  const old = await db.one<LegacyRow>("SELECT * FROM remote_targets WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  if (!old) return null;
  let env = await findTailcatEnvByAddr(old.team_id, old.user_id, old.addr);
  for (let attempt = 0; !env && attempt < 3; attempt++) {
    try {
      env = await createEnv({
        teamId: old.team_id, userId: old.user_id, kind: "tailcat",
        name: await freeName(old.team_id, old.user_id, "tailcat"),
        config: { addr: old.addr },
      });
    } catch (e) {
      // Another replica converted the same owner's row at once: look again.
      if (!(e instanceof EnvNameTakenError)) throw e;
      env = await findTailcatEnvByAddr(old.team_id, old.user_id, old.addr);
    }
  }
  if (!env) return null;
  await db.run(
    `INSERT INTO env_bindings (channel_id, thread_ts, env_id, dir, lock_by_env, endpoint, generation, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(channel_id, thread_ts) DO NOTHING`,
    [channelId, threadTs, env.id, old.dir, old.lock_by_remote, Date.now(), Number(old.created_at)],
  );
  await db.run("DELETE FROM remote_targets WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  return db.one<BindingRow>("SELECT * FROM env_bindings WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

/** Record the pre-flight-resolved directory, keeping a running sandbox. */
export async function setBindingDir(channelId: string, threadTs: string, envId: string, dir: string): Promise<void> {
  await db.run("UPDATE env_bindings SET dir = ? WHERE channel_id = ? AND thread_ts = ? AND env_id = ?", [dir, channelId, threadTs, envId]);
}

export async function clearBinding(channelId: string, threadTs: string): Promise<BindingRow | null> {
  const row = await findBinding(channelId, threadTs);
  if (!row) return null;
  await db.run("DELETE FROM env_bindings WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  return row;
}

export async function bindingsForEnv(envId: string): Promise<BindingRow[]> {
  return db.query<BindingRow>("SELECT * FROM env_bindings WHERE env_id = ?", [envId]);
}

export async function touchBinding(channelId: string, threadTs: string): Promise<void> {
  await db.run("UPDATE env_bindings SET last_used_at = ? WHERE channel_id = ? AND thread_ts = ?", [Date.now(), channelId, threadTs]);
}

export function readEndpoint(b: Pick<BindingRow, "endpoint">): ProvisionedEndpoint | null {
  return b.endpoint ? (JSON.parse(decrypt(b.endpoint)) as ProvisionedEndpoint) : null;
}

/** Claim the right to provision a binding whose sandbox is missing: bumps the
 *  generation only if nobody else did since `gen` was read. True = this caller
 *  provisions; false = another replica is (or already did). */
export async function claimProvision(channelId: string, threadTs: string, gen: number): Promise<boolean> {
  const r = await db.run(
    "UPDATE env_bindings SET generation = ? WHERE channel_id = ? AND thread_ts = ? AND generation = ? AND endpoint IS NULL",
    [gen + 1, channelId, threadTs, gen],
  );
  return r.changes === 1;
}

/** Store the sandbox endpoint for the generation this caller claimed. False when
 *  the binding moved on meanwhile (unbound, rebound, or claimed again). */
export async function storeEndpoint(channelId: string, threadTs: string, gen: number, ep: ProvisionedEndpoint): Promise<boolean> {
  const r = await db.run(
    "UPDATE env_bindings SET endpoint = ?, last_used_at = ? WHERE channel_id = ? AND thread_ts = ? AND generation = ?",
    [encrypt(JSON.stringify(ep)), Date.now(), channelId, threadTs, gen],
  );
  return r.changes === 1;
}

/** Claim a provisioned binding's sandbox for teardown (idle sweep): clears the
 *  endpoint only if it is still the one read. True = this caller tears it down. */
export async function claimTeardown(channelId: string, threadTs: string, gen: number): Promise<boolean> {
  const r = await db.run(
    "UPDATE env_bindings SET endpoint = NULL WHERE channel_id = ? AND thread_ts = ? AND generation = ? AND endpoint IS NOT NULL",
    [channelId, threadTs, gen],
  );
  return r.changes === 1;
}

/** Provisioned bindings whose sandbox has been idle since before `cutoff`. */
export async function idleProvisioned(cutoff: number): Promise<BindingRow[]> {
  return db.query<BindingRow>("SELECT * FROM env_bindings WHERE endpoint IS NOT NULL AND last_used_at < ?", [cutoff]);
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM env_bindings");
  await db.run("DELETE FROM environments");
}
