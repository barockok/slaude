import { utils } from "ssh2";
import { env } from "../../config/env";
import * as OneOnOne from "../../db/one-on-one";
import * as Remote from "../../db/remote";
import { activeRemoteTarget } from "../../remote/active";
import { preflight, remoteCleanup } from "../../remote/preflight";
import { isRemoteDir, isTailcatAddr } from "../../remote/shell";
import { tailcatPing } from "../../remote/tailcat";
import type { SlashHit } from "../slack/commands";

type RemoteHit = Extract<SlashHit, { kind: "remote" }>;

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
  reload(): void;
}

export interface RemoteCommandDeps {
  preflight: typeof preflight;
  ping: typeof tailcatPing;
  cleanup: typeof remoteCleanup;
  generateKeyPair(comment: string): { privateKey: string; publicKey: string };
}

const defaultDeps: RemoteCommandDeps = {
  preflight,
  ping: tailcatPing,
  cleanup: remoteCleanup,
  generateKeyPair: (comment) => {
    const k = utils.generateKeyPairSync("ed25519", { comment });
    return { privateKey: k.private, publicKey: k.public };
  },
};

function setupText(publicKey: string): string {
  return [
    "*Set up `/remote` on your machine* (only you can see this):",
    "1. Install tailcat: https://github.com/tailscale/tailcat",
    "2. Once, for an address that survives restarts: `tailcat genkey --key=default`",
    "3. Start the server (keep it running):",
    "```",
    `tailcat serve --key=default --ssh-authorized-keys="${publicKey.trim()}" ssh`,
    "```",
    "4. In the thread: `/remote <the address it prints> <directory>`",
    "",
    ":warning: Commands run as the account that runs `tailcat serve`, with everything that account can reach. Use a separate account or a container for repos you don't trust.",
  ].join("\n");
}

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
  if (!env.remote.enabled()) return false;
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

/** Clear the thread's remote target. With a sessionId, also start best-effort
 *  cleanup of that session's background jobs on the remote (not awaited: the
 *  laptop may be asleep). `lockByRemote` tells the caller whether /remote had
 *  created the lock. */
export async function endRemoteForThread(
  channelId: string,
  threadTs: string,
  opts: { sessionId?: string; cleanup?: typeof remoteCleanup } = {},
): Promise<{ ended: boolean; lockByRemote: boolean }> {
  const gone = await Remote.clearTarget(channelId, threadTs);
  if (opts.sessionId) forgetRemoteStatus(opts.sessionId);
  if (gone && opts.sessionId) {
    // Best effort: a key failure (decrypt) must never block the caller's unlock.
    try {
      const key = await Remote.getKey(gone.team_id, gone.user_id);
      if (key) void Promise.resolve((opts.cleanup ?? remoteCleanup)({ addr: gone.addr, privateKey: key.privateKey, sessionKey: opts.sessionId })).catch(() => {});
    } catch {}
  }
  return { ended: !!gone, lockByRemote: gone?.lock_by_remote === 1 };
}

export async function handleRemoteCommand(hit: RemoteHit, ctx: RemoteCommandCtx, deps: RemoteCommandDeps = defaultDeps): Promise<void> {
  if (!env.remote.enabled()) {
    await ctx.reply(":no_entry: `/remote` is not enabled on this deployment.");
    return;
  }
  const { channelId, threadTs, teamId, userId } = ctx;

  if (hit.action === "status") {
    const t = await activeRemoteTarget(channelId, threadTs);
    if (!t) {
      await ctx.reply("Remote mode: *off* — tools run on the server.");
      return;
    }
    const path = await deps.ping(t.addr);
    await ctx.reply(`Remote mode: *on* — <@${t.userId}>'s machine, \`${t.dir}\`, path: *${path}*.`);
    return;
  }

  if (hit.action === "key") {
    const key = (await Remote.getKey(teamId, userId)) ?? (await Remote.putKeyIfAbsent(teamId, userId, deps.generateKeyPair(`slaude:${userId}`)));
    await ctx.sayPrivately(setupText(key.publicKey));
    await ctx.reply("Sent you the `/remote` setup privately.");
    return;
  }

  if (hit.action === "off") {
    const t = await Remote.findTarget(channelId, threadTs);
    if (!t) {
      await ctx.reply("Remote mode is not on in this thread.");
      return;
    }
    if (t.user_id !== userId && !ctx.isManager) {
      await ctx.reply(`Only <@${t.user_id}> or the manager can turn remote mode off.`);
      return;
    }
    const { lockByRemote } = await endRemoteForThread(channelId, threadTs, { sessionId: ctx.sessionId, cleanup: deps.cleanup });
    // Only release a lock that is still this target owner's: a stale row never unlocks someone else.
    if (lockByRemote && t.user_id === (await OneOnOne.find(channelId, threadTs))?.locked_user) await OneOnOne.unlock(channelId, threadTs);
    forgetRemoteStatus(ctx.sessionId);
    ctx.reload();
    await ctx.reply(`:house: Remote mode *off* — tools run on the server again.${lockByRemote ? " 1on1 released." : ""}`);
    return;
  }

  // action === "on"
  if (hit.action !== "on") return;
  if (!isTailcatAddr(hit.addr)) {
    await ctx.reply(":x: That doesn't look like a tailcat address.");
    return;
  }
  const lock = await OneOnOne.find(channelId, threadTs);
  if (lock && lock.locked_user !== userId) {
    await ctx.reply(`:lock: This thread is a 1on1 with <@${lock.locked_user}>; only its owner can use \`/remote\` here.`);
    return;
  }
  if (lock && lock.open_scope !== null) {
    await ctx.reply(":lock: This 1on1 is open to guests. Run `/1on1 lock` first — remote mode needs the thread locked to you.");
    return;
  }
  const existing = await Remote.findTarget(channelId, threadTs);
  const dir = hit.dir ?? (existing?.user_id === userId ? existing.dir : undefined);
  if (!dir) {
    await ctx.reply("Usage: `/remote <tailcat-address> <directory>`");
    return;
  }
  if (!isRemoteDir(dir)) {
    await ctx.reply(":x: The directory must be an absolute path or start with `~/`.");
    return;
  }
  const key = await Remote.getKey(teamId, userId);
  if (!key) {
    const fresh = await Remote.putKeyIfAbsent(teamId, userId, deps.generateKeyPair(`slaude:${userId}`));
    await ctx.sayPrivately(setupText(fresh.publicKey));
    await ctx.reply("First time here — I sent you setup steps privately. Run them, then `/remote <address> <directory>` again.");
    return;
  }
  const pf = await deps.preflight({ addr: hit.addr, dir, privateKey: key.privateKey });
  if (!pf.ok) {
    await ctx.reply(`:x: Couldn't use your machine: ${pf.error}`);
    return;
  }
  // Inherit "we created the lock" only from this user's own row: a stale row from
  // someone else must never make another person's lock releasable by /remote off.
  let lockByRemote = existing?.user_id === userId && existing.lock_by_remote === 1;
  if (!lock) {
    await OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
    lockByRemote = true;
  }
  await Remote.setTarget({ channelId, threadTs, teamId, userId, addr: hit.addr, dir: pf.dir, lockByRemote });
  forgetRemoteStatus(ctx.sessionId);
  ctx.reload();
  await ctx.reply(`:satellite: Remote mode *on* — my shell and file tools now run on <@${userId}>'s machine in \`${pf.dir}\`. The thread is locked to you. \`/remote off\` to switch back.`);
}
