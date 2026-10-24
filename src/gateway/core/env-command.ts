/**
 * `/env`: saved, per-person execution environments for a thread's shell and
 * file tools (environments spec §8). `/remote` is an alias over the same core
 * (remote-command.ts). Addresses and other config values are never echoed in a
 * thread: they appear only in private replies or not at all.
 */
import { env as config } from "../../config/env";
import * as CronJobs from "../../db/cron-jobs";
import * as Envs from "../../db/environments";
import * as OneOnOne from "../../db/one-on-one";
import * as Remote from "../../db/remote";
import { activeRemoteTarget, boundEnv } from "../../remote/active";
import { connectInfoForBinding, ensureProvisioned, releaseBinding, userMachineConnectInfo } from "../../remote/env-runtime";
import { generateSshKeyPair, isValidSshKeyPair } from "../../remote/keygen";
import { getKind, listKinds, trustOf, type EnvironmentKind, type StoredEnv } from "../../remote/kinds";
import { preflight, remoteCleanup } from "../../remote/preflight";
import { isRemoteDir } from "../../remote/shell";
import type { ConnectInfo } from "../../remote/transport";
import { RemoteError } from "../../remote/types";
import type { SlashHit } from "../slack/commands";

export type EnvHit = Extract<SlashHit, { kind: "env" }>;

export interface RemoteCommandCtx {
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  /** The thread's session id — the key of its remote background-job directory. */
  sessionId: string;
  isManager: boolean;
  reply(text: string): Promise<void>;
  sayPrivately(text: string): Promise<void>;
  /** Privately offer the user a Connect button that opens the tailcat
   *  address/directory modal (`/remote`). Absent where the surface has no
   *  ephemeral blocks or modals. */
  offerConnect?(): Promise<void>;
  /** Privately show the user's environments with Use buttons and an
   *  "Add environment" button (`/env`). Absent where there are no modals. */
  offerPicker?(envs: StoredEnv[]): Promise<void>;
  /** Open the add form in a modal for one kind (or the kind picker). */
  offerAdd?(): Promise<void>;
  reload(): void;
  /** Reboot the session of another thread (an environment deleted or edited
   *  under it). Optional: without it those threads pick up the change on
   *  their next message, through the session fingerprint. */
  reloadThread?(channelId: string, threadTs: string): Promise<void>;
}
export type EnvCommandCtx = RemoteCommandCtx;

export interface EnvCommandDeps {
  preflight: typeof preflight;
  cleanup: typeof remoteCleanup;
  /** Health word for a bound environment (default: the kind's own check). */
  status(env: StoredEnv, info: ConnectInfo | null): Promise<string>;
  provision: typeof ensureProvisioned;
  generateKeyPair(comment: string): { privateKey: string; publicKey: string };
  /** False for a stored pair ssh2 cannot use (e.g. one written by the defective generator). */
  validKey(pair: Remote.RemoteKeyPair): boolean;
  /** Active cron jobs firing into this thread that someone other than `userId` created. */
  listForeignThreadCrons(channelId: string, threadTs: string, userId: string): Promise<number>;
}

export const defaultEnvDeps: EnvCommandDeps = {
  preflight,
  cleanup: remoteCleanup,
  status: async (env, info) => (getKind(env.kind) ? getKind(env.kind)!.status(env, info).catch(() => "unreachable") : "unknown kind"),
  provision: ensureProvisioned,
  generateKeyPair: generateSshKeyPair,
  validKey: (p) => isValidSshKeyPair(p.privateKey, p.publicKey),
  listForeignThreadCrons: CronJobs.countForeignThreadJobs,
};

const REPLACED_NOTE = ":warning: Your previous key was invalid and has been replaced. Install the new key below wherever you installed the old one.";

/** The user's stored key, creating one on first use and replacing one that
 *  does not parse. `fresh` means the user must (re)install the public key. */
export async function usableKey(teamId: string, userId: string, deps: Pick<EnvCommandDeps, "generateKeyPair" | "validKey">): Promise<{ key: Remote.RemoteKeyPair; fresh: boolean; replaced: boolean }> {
  const stored = await Remote.getKey(teamId, userId);
  if (!stored) return { key: await Remote.putKeyIfAbsent(teamId, userId, deps.generateKeyPair(`slaude:${userId}`)), fresh: true, replaced: false };
  if (deps.validKey(stored)) return { key: stored, fresh: false, replaced: false };
  return { key: await Remote.replaceKey(teamId, userId, deps.generateKeyPair(`slaude:${userId}`)), fresh: true, replaced: true };
}

export function setupText(kind: EnvironmentKind, publicKey: string, replaced = false): string {
  return [...(replaced ? [REPLACED_NOTE, ""] : []), kind.setupGuide(publicKey)].join("\n");
}

// ── status cache ─────────────────────────────────────────────────────────

/** sessionId → remote on?, cached briefly for the status line. Bounded; cleared
 *  whenever remote starts or ends for a session. */
const statusCache = new Map<string, { on: boolean; at: number }>();
const STATUS_CACHE_MAX = 500;

export function forgetRemoteStatus(sessionId: string): void {
  statusCache.delete(sessionId);
}

/** Never throws: a failed lookup means "no marker". */
export async function remoteStatusOn(
  sessionId: string,
  channel: string,
  thread: string,
  lookup: typeof activeRemoteTarget = activeRemoteTarget,
): Promise<boolean> {
  if (!config.remote.enabled()) return false;
  const c = statusCache.get(sessionId);
  if (c && Date.now() - c.at < 30_000) return c.on;
  let on = false;
  try {
    on = !!(await lookup(channel, thread));
  } catch {
    return false;
  }
  if (statusCache.size >= STATUS_CACHE_MAX) {
    const oldest = statusCache.keys().next().value;
    if (oldest !== undefined) statusCache.delete(oldest);
  }
  statusCache.set(sessionId, { on, at: Date.now() });
  return on;
}

// ── ending remote mode ───────────────────────────────────────────────────

/** Clear the thread's binding. With a sessionId, also start best-effort
 *  cleanup of that session's background jobs on a user machine, or tear down a
 *  sandbox (not awaited: the laptop may be asleep). `lockByRemote` tells the
 *  caller whether binding the environment had created the lock.
 *  `userMachineOnly` (lock transitions): leave a provisioned sandbox bound,
 *  since it does not depend on the lock (spec §4). */
export async function endRemoteForThread(
  channelId: string,
  threadTs: string,
  opts: { sessionId?: string; cleanup?: typeof remoteCleanup; userMachineOnly?: boolean } = {},
): Promise<{ ended: boolean; lockByRemote: boolean }> {
  if (opts.userMachineOnly) {
    const b = await boundEnv(channelId, threadTs);
    if (b && trustOf(b.env) === "provisioned") return { ended: false, lockByRemote: false };
  }
  const gone = await Envs.clearBinding(channelId, threadTs);
  if (opts.sessionId) forgetRemoteStatus(opts.sessionId);
  if (gone) void releaseBinding(gone, { sessionId: opts.sessionId, cleanup: opts.cleanup });
  return { ended: !!gone, lockByRemote: gone?.lock_by_env === 1 };
}

// ── binding ──────────────────────────────────────────────────────────────

/** Bind the thread to one of the user's environments (spec §4 rules). Shared
 *  by `/env use`, `/env add` (which uses the new environment at once), the
 *  picker's Use button and the `/remote` alias. True when the thread now runs
 *  in it. */
export async function useEnvironment(
  env: StoredEnv,
  dirArg: string | undefined,
  ctx: EnvCommandCtx,
  deps: EnvCommandDeps,
): Promise<boolean> {
  const { channelId, threadTs, teamId, userId } = ctx;
  const kind = getKind(env.kind);
  if (!kind) {
    await ctx.reply(`:x: Environment kind \`${env.kind}\` is not available on this deployment.`);
    return false;
  }
  if (env.userId !== userId || env.teamId !== teamId) {
    await ctx.reply(":x: You can only use your own environments.");
    return false;
  }
  const trust = trustOf(env);
  const lock = await OneOnOne.find(channelId, threadTs);
  if (lock && lock.locked_user !== userId) {
    await ctx.reply(`:lock: This thread is a 1on1 with <@${lock.locked_user}>; only its owner can choose its environment.`);
    return false;
  }
  if (trust === "user-machine") {
    if (lock && lock.open_scope !== null) {
      await ctx.reply(":lock: This 1on1 is open to guests. Run `/1on1 lock` first — a personal environment needs the thread locked to you.");
      return false;
    }
    // A job someone else scheduled here would fire on this user's machine once
    // the thread runs remotely (its runs resolve to the lock owner).
    const foreignCrons = await deps.listForeignThreadCrons(channelId, threadTs, userId);
    if (foreignCrons > 0) {
      await ctx.reply(
        `:x: ${foreignCrons} cron job${foreignCrons === 1 ? "" : "s"} created by someone else ${foreignCrons === 1 ? "fires" : "fire"} in this thread and would run on your machine. Check \`/cron-list\` and remove ${foreignCrons === 1 ? "it" : "them"} (or ask the owner to) before choosing a personal environment.`,
      );
      return false;
    }
  }
  const existing = await boundEnv(channelId, threadTs);
  const dir = dirArg ?? (existing?.env.id === env.id ? existing.binding.dir : undefined) ?? env.defaultDir ?? undefined;
  if (!dir) {
    await ctx.reply(`:x: Which directory? Use \`/env use ${env.name} <directory>\`, or set a default with \`/env edit ${env.name} dir=<directory>\`.`);
    return false;
  }
  if (!isRemoteDir(dir)) {
    await ctx.reply(":x: The directory must be an absolute path or start with `~/`.");
    return false;
  }

  if (trust === "user-machine") {
    const { key, fresh, replaced } = await usableKey(teamId, userId, deps);
    if (fresh) {
      await ctx.sayPrivately(setupText(kind, key.publicKey, replaced));
      await ctx.reply(
        replaced
          ? "Your stored key was invalid, so I made a new one and sent you setup steps privately. Install it, then try again."
          : "First time here. I sent you setup steps privately. Run them, then try again.",
      );
      return false;
    }
    let info: ConnectInfo;
    try {
      info = await userMachineConnectInfo(env);
    } catch (e) {
      await ctx.reply(`:x: Couldn't use \`${env.name}\`: ${e instanceof RemoteError ? e.message : (e as Error).message}`);
      return false;
    }
    const pf = await deps.preflight({ info, dir });
    if (!pf.ok) {
      await ctx.reply(`:x: Couldn't use \`${env.name}\`: ${pf.error}`);
      return false;
    }
    if (pf.hostKey && kind.pinnedKey) {
      await Envs.updateEnv(env.id, { config: { ...env.config, [kind.pinnedKey]: pf.hostKey } });
      await ctx.sayPrivately(`:key: Pinned \`${env.name}\`'s host key: \`${pf.hostKey}\`. If it ever changes, connecting stops with REMOTE_HOST_CHANGED.`);
    }
    // Moving off another environment: its jobs or sandbox go with it.
    if (existing && existing.env.id !== env.id) await endRemoteForThread(channelId, threadTs, { sessionId: ctx.sessionId, cleanup: deps.cleanup });
    // Inherit "we created the lock" only from this user's own binding: a stale
    // one from someone else must never make another person's lock releasable.
    let lockByEnv = existing?.env.userId === userId && existing.binding.lock_by_env === 1;
    if (!lock) {
      await OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
      lockByEnv = true;
    }
    await Envs.bind({ channelId, threadTs, envId: env.id, dir: pf.dir, lockByEnv });
    forgetRemoteStatus(ctx.sessionId);
    ctx.reload();
    await ctx.reply(
      `:satellite: Environment *${env.name}* (${kind.label}) — my shell and file tools now run on <@${userId}>'s machine in \`${pf.dir}\`. The thread is locked to you. \`/env off\` to switch back.`,
    );
    return true;
  }

  // Provisioned: a sandbox for this thread. Bind first (the sandbox is keyed
  // on the binding), then start it and resolve the directory in it.
  // Already on this sandbox: keep it (re-binding would orphan the running one).
  const same = existing?.env.id === env.id;
  if (existing && !same) await endRemoteForThread(channelId, threadTs, { sessionId: ctx.sessionId, cleanup: deps.cleanup });
  if (!same) await Envs.bind({ channelId, threadTs, envId: env.id, dir, lockByEnv: false });
  const fail = async (why: string) => {
    // A sandbox that was already running here stays; a new binding is undone.
    const gone = same ? null : await Envs.clearBinding(channelId, threadTs);
    if (gone) await releaseBinding(gone);
    await ctx.reply(`:x: Couldn't start \`${env.name}\`: ${why}`);
    return false;
  };
  try {
    await deps.provision(channelId, threadTs);
    const b = await boundEnv(channelId, threadTs);
    if (!b || b.env.id !== env.id) return fail("the thread's environment changed meanwhile");
    const pf = await deps.preflight({ info: await connectInfoForBinding(b.binding, b.env), dir });
    if (!pf.ok) return fail(pf.error);
    await Envs.setBindingDir(channelId, threadTs, env.id, pf.dir);
    forgetRemoteStatus(ctx.sessionId);
    ctx.reload();
    await ctx.reply(`:package: Environment *${env.name}* (${kind.label}) — my shell and file tools now run in a sandbox, in \`${pf.dir}\`. Anyone in this thread can use it. \`/env off\` to switch back and remove it.`);
    return true;
  } catch (e) {
    return fail(e instanceof RemoteError ? e.message : (e as Error).message);
  }
}

// ── /env ─────────────────────────────────────────────────────────────────

const listLine = (e: StoredEnv, current?: string) =>
  `• *${e.name}* — ${getKind(e.kind)?.label ?? e.kind}${e.defaultDir ? `, default dir \`${e.defaultDir}\`` : ""}${current === e.id ? " _(this thread)_" : ""}`;

function kindsHelp(): string {
  return listKinds().map((k) => `• \`${k.kind}\` — ${k.label}: ${k.fields.map((f) => `\`${f.id}=…\`${f.optional ? " (optional)" : ""}`).join(" ")}`).join("\n");
}

/** Who may end the thread's environment: its owner or the manager; for a
 *  sandbox in a thread that is not locked, anyone the thread admits. */
async function mayTurnOff(ctx: EnvCommandCtx, b: { env: StoredEnv }): Promise<boolean> {
  if (b.env.userId === ctx.userId || ctx.isManager) return true;
  if (trustOf(b.env) !== "provisioned") return false;
  const lock = await OneOnOne.find(ctx.channelId, ctx.threadTs);
  return !lock || lock.open_scope !== null;
}

export async function handleEnvCommand(hit: EnvHit, ctx: EnvCommandCtx, deps: EnvCommandDeps = defaultEnvDeps): Promise<void> {
  if (!config.remote.enabled()) {
    await ctx.reply(":no_entry: `/env` is not enabled on this deployment.");
    return;
  }
  const { channelId, threadTs, teamId, userId } = ctx;

  if (hit.action === "status") {
    const t = await activeRemoteTarget(channelId, threadTs);
    const b = await boundEnv(channelId, threadTs);
    if (!t || !b) {
      await ctx.reply("Environment: *server* — tools run on the server.");
    } else {
      let info: ConnectInfo | null = null;
      try { info = await connectInfoForBinding(b.binding, b.env); } catch {}
      const health = await deps.status(b.env, info);
      const whose = trustOf(b.env) === "provisioned" ? "a sandbox" : `<@${b.env.userId}>'s machine`;
      await ctx.reply(`Environment: *${b.env.name}* (${getKind(b.env.kind)?.label ?? b.env.kind}) — ${whose}, \`${b.binding.dir}\`, ${health}.`);
    }
    const mine = await Envs.listEnvs(teamId, userId);
    if (ctx.offerPicker) await ctx.offerPicker(mine);
    else if (mine.length) await ctx.sayPrivately(`*Your environments:*\n${mine.map((e) => listLine(e, b?.env.id)).join("\n")}\n\`/env use <name> [dir]\` to switch.`);
    return;
  }

  if (hit.action === "list") {
    const b = await boundEnv(channelId, threadTs);
    const mine = await Envs.listEnvs(teamId, userId);
    await ctx.sayPrivately(
      mine.length
        ? `*Your environments:*\n${mine.map((e) => listLine(e, b?.env.id)).join("\n")}\n\`/env use <name> [dir]\` to switch, \`/env add\` to add one.`
        : `You have no environments yet. \`/env add\` to add one. Kinds:\n${kindsHelp()}`,
    );
    return;
  }

  if (hit.action === "key") {
    const kind = getKind(hit.kindName ?? "tailcat");
    if (!kind) {
      await ctx.reply(`:x: Unknown environment kind. Kinds:\n${kindsHelp()}`);
      return;
    }
    const { key, replaced } = await usableKey(teamId, userId, deps);
    await ctx.sayPrivately(setupText(kind, key.publicKey, replaced));
    await ctx.reply("Sent you the setup steps privately.");
    return;
  }

  if (hit.action === "off") {
    const b = await boundEnv(channelId, threadTs);
    if (!b) {
      // A binding whose environment or kind is gone still has to be removable.
      if (await Envs.findBinding(channelId, threadTs)) {
        await endRemoteForThread(channelId, threadTs, { sessionId: ctx.sessionId, cleanup: deps.cleanup });
        ctx.reload();
        await ctx.reply(":house: Environment *server* — tools run on the server again.");
        return;
      }
      await ctx.reply("This thread already runs on the server.");
      return;
    }
    if (!(await mayTurnOff(ctx, b))) {
      await ctx.reply(`Only <@${b.env.userId}> or the manager can switch this thread's environment off.`);
      return;
    }
    const { lockByRemote } = await endRemoteForThread(channelId, threadTs, { sessionId: ctx.sessionId, cleanup: deps.cleanup });
    // Only release a lock that is still this environment owner's: a stale row never unlocks someone else.
    if (lockByRemote && b.env.userId === (await OneOnOne.find(channelId, threadTs))?.locked_user) await OneOnOne.unlock(channelId, threadTs);
    forgetRemoteStatus(ctx.sessionId);
    ctx.reload();
    await ctx.reply(`:house: Environment *server* — tools run on the server again.${lockByRemote ? " 1on1 released." : ""}`);
    return;
  }

  if (hit.action === "use") {
    const e = await Envs.findEnvByName(teamId, userId, hit.name);
    if (!e) {
      await ctx.reply(`:x: You have no environment named \`${hit.name}\`. \`/env list\` shows yours.`);
      return;
    }
    await useEnvironment(e, hit.dir, ctx, deps);
    return;
  }

  if (hit.action === "add") {
    if (!hit.kindName) {
      if (ctx.offerAdd) await ctx.offerAdd();
      else await ctx.reply(`Usage: \`/env add <kind> <name> key=value… [dir=<directory>]\` (values are not echoed). Kinds:\n${kindsHelp()}`);
      return;
    }
    await addEnvironment({ kindName: hit.kindName, name: hit.name ?? "", fields: hit.fields ?? {}, dir: hit.dir, use: true }, ctx, deps);
    return;
  }

  if (hit.action === "edit") {
    const e = await Envs.findEnvByName(teamId, userId, hit.name);
    if (!e) {
      await ctx.reply(`:x: You have no environment named \`${hit.name}\`.`);
      return;
    }
    await editEnvironment(e, { fields: hit.fields ?? {}, newName: hit.newName, dir: hit.dir }, ctx);
    return;
  }

  if (hit.action === "rm") {
    const e = await Envs.findEnvByName(teamId, userId, hit.name);
    if (!e) {
      await ctx.reply(`:x: You have no environment named \`${hit.name}\`.`);
      return;
    }
    await removeEnvironment(e, ctx, deps);
  }
}

/** Create an environment from form or argument values and (when `use`) bind
 *  the thread to it. Replies go to the thread, never with the values. */
export async function addEnvironment(
  i: { kindName: string; name: string; fields: Record<string, string>; dir?: string; use: boolean },
  ctx: EnvCommandCtx,
  deps: EnvCommandDeps = defaultEnvDeps,
): Promise<StoredEnv | null> {
  const kind = getKind(i.kindName);
  if (!kind) {
    await ctx.reply(`:x: Unknown environment kind \`${i.kindName.replace(/[^a-z0-9-]/gi, "").slice(0, 32)}\`. Kinds:\n${kindsHelp()}`);
    return null;
  }
  const name = i.name.trim().toLowerCase();
  if (!Envs.ENV_NAME_RE.test(name)) {
    await ctx.reply(":x: Name the environment with up to 32 lowercase letters, digits, `.`, `_` or `-` (e.g. `laptop`).");
    return null;
  }
  const parsed = kind.parse(i.fields);
  if (!parsed.ok) {
    await ctx.reply(`:x: ${parsed.error}`);
    return null;
  }
  if (kind.trust === "provisioned" && parsed.secrets && Object.keys(parsed.secrets).length > 0) {
    // Allowed, but then it is treated as personal (spec §4): say so.
    await ctx.sayPrivately(`\`${name}\` carries secrets, so it is treated as personal: using it locks the thread to you.`);
  }
  if (i.dir !== undefined && !isRemoteDir(i.dir)) {
    await ctx.reply(":x: The directory must be an absolute path or start with `~/`.");
    return null;
  }
  let created: StoredEnv;
  try {
    created = await Envs.createEnv({
      teamId: ctx.teamId, userId: ctx.userId, name, kind: kind.kind,
      config: parsed.config, secrets: parsed.secrets, defaultDir: i.dir ?? null,
    });
  } catch (e) {
    if (e instanceof Envs.EnvNameTakenError) {
      await ctx.reply(`:x: ${e.message}. Pick another name or \`/env edit ${name}\`.`);
      return null;
    }
    throw e;
  }
  await ctx.reply(`:heavy_plus_sign: Saved environment *${name}* (${kind.label}).`);
  if (i.use && i.dir) await useEnvironment(created, i.dir, ctx, deps);
  else if (i.use) await ctx.reply(`\`/env use ${name} <directory>\` to run this thread in it.`);
  return created;
}

/** Change an environment's name, default directory or kind fields. Threads
 *  bound to it reboot onto the new config (its hash changes). */
export async function editEnvironment(
  e: StoredEnv,
  p: { fields: Record<string, string>; newName?: string; dir?: string },
  ctx: EnvCommandCtx,
): Promise<StoredEnv | null> {
  const kind = getKind(e.kind);
  if (!kind) {
    await ctx.reply(`:x: Environment kind \`${e.kind}\` is not available on this deployment.`);
    return null;
  }
  if (!Object.keys(p.fields).length && p.newName === undefined && p.dir === undefined) {
    await ctx.reply(`Usage: \`/env edit ${e.name} key=value… [name=<new name>] [dir=<directory>]\`. Fields: ${kind.fields.map((f) => `\`${f.id}\``).join(", ")}.`);
    return null;
  }
  let config = e.config;
  let unpinned = false;
  if (Object.keys(p.fields).length) {
    // Re-validate the whole config: a partial edit keeps the other fields. Any
    // other change drops a pinned host key (it may have pinned the old host).
    const merged = { ...e.config, ...p.fields };
    const changed = Object.keys(p.fields).some((k) => k !== kind.pinnedKey && p.fields[k] !== e.config[k]);
    if (kind.pinnedKey && p.fields[kind.pinnedKey] === undefined && changed && merged[kind.pinnedKey]) {
      delete merged[kind.pinnedKey];
      unpinned = true;
    }
    const parsed = kind.parse(merged);
    if (!parsed.ok) {
      await ctx.reply(`:x: ${parsed.error}`);
      return null;
    }
    config = parsed.config;
  }
  const newName = p.newName?.trim().toLowerCase();
  if (newName !== undefined && !Envs.ENV_NAME_RE.test(newName)) {
    await ctx.reply(":x: Name the environment with up to 32 lowercase letters, digits, `.`, `_` or `-`.");
    return null;
  }
  if (p.dir !== undefined && p.dir !== "" && !isRemoteDir(p.dir)) {
    await ctx.reply(":x: The directory must be an absolute path or start with `~/`.");
    return null;
  }
  let updated: StoredEnv | null;
  try {
    updated = await Envs.updateEnv(e.id, { config, name: newName, defaultDir: p.dir === undefined ? undefined : p.dir || null });
  } catch (err) {
    if (err instanceof Envs.EnvNameTakenError) {
      await ctx.reply(`:x: ${err.message}.`);
      return null;
    }
    throw err;
  }
  for (const b of await Envs.bindingsForEnv(e.id)) {
    if (b.channel_id === ctx.channelId && b.thread_ts === ctx.threadTs) ctx.reload();
    else await ctx.reloadThread?.(b.channel_id, b.thread_ts);
  }
  await ctx.reply(
    `:pencil2: Updated environment *${updated?.name ?? e.name}*. Threads using it switch on their next message.` +
      (unpinned ? ` Its host key pin was dropped: run \`/env use ${updated?.name ?? e.name}\` to pin the new host's key before it can connect.` : ""),
  );
  return updated;
}

/** Delete an environment; every thread bound to it goes back to the server. */
export async function removeEnvironment(e: StoredEnv, ctx: EnvCommandCtx, deps: EnvCommandDeps = defaultEnvDeps): Promise<void> {
  const bindings = await Envs.bindingsForEnv(e.id);
  for (const b of bindings) {
    const here = b.channel_id === ctx.channelId && b.thread_ts === ctx.threadTs;
    const { lockByRemote } = await endRemoteForThread(b.channel_id, b.thread_ts, here ? { sessionId: ctx.sessionId, cleanup: deps.cleanup } : {});
    if (lockByRemote && e.userId === (await OneOnOne.find(b.channel_id, b.thread_ts))?.locked_user) await OneOnOne.unlock(b.channel_id, b.thread_ts);
    if (here) {
      forgetRemoteStatus(ctx.sessionId);
      ctx.reload();
    } else await ctx.reloadThread?.(b.channel_id, b.thread_ts);
  }
  await Envs.deleteEnv(e.id);
  await ctx.reply(`:wastebasket: Removed environment *${e.name}*.${bindings.length ? ` ${bindings.length} thread${bindings.length === 1 ? "" : "s"} switched back to the server.` : ""}`);
}
