import { env } from "../../config/env";
import * as CronJobs from "../../db/cron-jobs";
import * as OneOnOne from "../../db/one-on-one";
import * as Remote from "../../db/remote";
import { activeRemoteTarget } from "../../remote/active";
import { generateSshKeyPair, isValidSshKeyPair } from "../../remote/keygen";
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
  /** Privately offer the user a Connect button that opens the address/directory
   *  modal. Absent where the surface has no ephemeral blocks or modals. */
  offerConnect?(): Promise<void>;
  reload(): void;
}

export interface RemoteCommandDeps {
  preflight: typeof preflight;
  ping: typeof tailcatPing;
  cleanup: typeof remoteCleanup;
  generateKeyPair(comment: string): { privateKey: string; publicKey: string };
  /** False for a stored pair ssh2 cannot use (e.g. one written by the defective generator). */
  validKey(pair: Remote.RemoteKeyPair): boolean;
  /** Active cron jobs firing into this thread that someone other than `userId` created. */
  listForeignThreadCrons(channelId: string, threadTs: string, userId: string): Promise<number>;
}

const defaultDeps: RemoteCommandDeps = {
  preflight,
  ping: tailcatPing,
  cleanup: remoteCleanup,
  generateKeyPair: generateSshKeyPair,
  validKey: (p) => isValidSshKeyPair(p.privateKey, p.publicKey),
  listForeignThreadCrons: CronJobs.countForeignThreadJobs,
};

const REPLACED_NOTE = ":warning: Your previous key was invalid and has been replaced — update `--ssh-authorized-keys` with the new key below.";

function setupText(publicKey: string, replaced = false): string {
  return [
    ...(replaced ? [REPLACED_NOTE, ""] : []),
    "*Set up `/remote` on your machine* (only you can see this):",
    "1. Install tailcat: https://github.com/tailscale/tailcat",
    "2. Once, for an address that survives restarts: `tailcat genkey --key=default`",
    "3. Start the server (keep it running):",
    "```",
    `tailcat serve --key=default --ssh-authorized-keys="${publicKey.trim()}" ssh`,
    "```",
    "4. In the thread, send `/remote` and click *Connect your machine*. Enter the address it prints and a directory in the form (only you see it).",
    "",
    ":warning: Commands run as the account that runs `tailcat serve`, with everything that account can reach. Use a separate account or a container for repos you don't trust.",
  ].join("\n");
}

/** The user's stored key, creating one on first use and replacing one that
 *  does not parse. `fresh` means the user must (re)install the public key. */
async function usableKey(teamId: string, userId: string, deps: RemoteCommandDeps): Promise<{ key: Remote.RemoteKeyPair; fresh: boolean; replaced: boolean }> {
  const stored = await Remote.getKey(teamId, userId);
  if (!stored) return { key: await Remote.putKeyIfAbsent(teamId, userId, deps.generateKeyPair(`slaude:${userId}`)), fresh: true, replaced: false };
  if (deps.validKey(stored)) return { key: stored, fresh: false, replaced: false };
  return { key: await Remote.replaceKey(teamId, userId, deps.generateKeyPair(`slaude:${userId}`)), fresh: true, replaced: true };
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
      // Offer the form only to someone who could turn it on here: no lock, or their own.
      const lock = await OneOnOne.find(channelId, threadTs);
      if (ctx.offerConnect && (!lock || lock.locked_user === userId)) await ctx.offerConnect();
      return;
    }
    const path = await deps.ping(t.addr);
    await ctx.reply(`Remote mode: *on* — <@${t.userId}>'s machine, \`${t.dir}\`, path: *${path}*.`);
    return;
  }

  if (hit.action === "key") {
    const { key, replaced } = await usableKey(teamId, userId, deps);
    await ctx.sayPrivately(setupText(key.publicKey, replaced));
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
  // A job someone else scheduled here would fire on this user's machine once the
  // thread runs remotely (its runs resolve to the lock owner).
  const foreignCrons = await deps.listForeignThreadCrons(channelId, threadTs, userId);
  if (foreignCrons > 0) {
    await ctx.reply(
      `:x: ${foreignCrons} cron job${foreignCrons === 1 ? "" : "s"} created by someone else ${foreignCrons === 1 ? "fires" : "fire"} in this thread and would run on your machine. Check \`/cron-list\` and remove ${foreignCrons === 1 ? "it" : "them"} (or ask the owner to) before turning remote mode on.`,
    );
    return;
  }
  const existing = await Remote.findTarget(channelId, threadTs);
  const dir = hit.dir ?? (existing?.user_id === userId ? existing.dir : undefined);
  if (!dir) {
    await ctx.reply("Send `/remote` and click *Connect your machine*, or use `/remote <tailcat-address> <directory>`.");
    return;
  }
  if (!isRemoteDir(dir)) {
    await ctx.reply(":x: The directory must be an absolute path or start with `~/`.");
    return;
  }
  const { key, fresh, replaced } = await usableKey(teamId, userId, deps);
  if (fresh) {
    await ctx.sayPrivately(setupText(key.publicKey, replaced));
    await ctx.reply(
      replaced
        ? "Your stored key was invalid, so I made a new one and sent you setup steps privately. Restart `tailcat serve` with it, then send `/remote` again."
        : "First time here. I sent you setup steps privately. Run them, then send `/remote` again.",
    );
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

// ── Connect form: ephemeral button → modal → submission ────────────────────
// The address never appears in the thread: the user types it into a modal only
// they see. Slack signs every interaction and a user cannot edit a value we
// posted, so the button value and the modal's private_metadata are trusted as
// written; handlers still bind them to the clicking user and to a max age.

export const REMOTE_OPEN_ACTION = "slaude_remote:open";
export const REMOTE_CONNECT_VIEW = "slaude_remote:connect";
const ADDR_BLOCK = "remote_addr";
const DIR_BLOCK = "remote_dir";
/** A Connect button (and the modal it opens) is good for this long. */
export const REMOTE_OFFER_TTL_MS = 15 * 60_000;

/** What a Connect button and its modal carry: which thread, for whom, since when. */
export interface RemoteOffer {
  sessionId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  apiAppId?: string;
  issuedAt: number;
}

export function encodeRemoteOffer(o: RemoteOffer): string {
  return JSON.stringify({ s: o.sessionId, tm: o.teamId, c: o.channelId, t: o.threadTs, u: o.userId, a: o.apiAppId, i: o.issuedAt });
}

export type DecodedOffer =
  | { ok: true; offer: RemoteOffer }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired"; offer: RemoteOffer };

/** `invalid` for anything malformed or meant for another user (ignore it
 *  silently); `expired` past REMOTE_OFFER_TTL_MS (tell the user to resend). */
export function decodeRemoteOffer(raw: string | undefined, clicker: string | undefined, now = Date.now()): DecodedOffer {
  if (!raw || !clicker) return { ok: false, reason: "invalid" };
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  if (!v || !str(v.s) || !str(v.tm) || !str(v.c) || !str(v.t) || !str(v.u) || typeof v.i !== "number") return { ok: false, reason: "invalid" };
  if (v.u !== clicker) return { ok: false, reason: "invalid" };
  const offer: RemoteOffer = { sessionId: v.s, teamId: v.tm, channelId: v.c, threadTs: v.t, userId: v.u, apiAppId: str(v.a) ? v.a : undefined, issuedAt: v.i };
  // A small allowance for clock skew between replicas; anything further ahead is not ours.
  if (v.i - now > 60_000) return { ok: false, reason: "invalid" };
  if (now - v.i > REMOTE_OFFER_TTL_MS) return { ok: false, reason: "expired", offer };
  return { ok: true, offer };
}

export function remoteOfferBlocks(offer: RemoteOffer): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Run this thread's shell and file tools on your machine. Start `tailcat serve` first (`/remote key` shows how)." },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: REMOTE_OPEN_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Connect your machine" },
          value: encodeRemoteOffer(offer),
        },
      ],
    },
  ];
}

export function remoteConnectModal(offer: RemoteOffer, initialDir?: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: REMOTE_CONNECT_VIEW,
    private_metadata: encodeRemoteOffer(offer),
    title: { type: "plain_text", text: "Connect your machine" },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: ADDR_BLOCK,
        label: { type: "plain_text", text: "tailcat address" },
        hint: { type: "plain_text", text: "The address that tailcat serve prints. It is never posted in the thread." },
        element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "address printed by tailcat serve" } },
      },
      {
        type: "input",
        block_id: DIR_BLOCK,
        label: { type: "plain_text", text: "Directory" },
        hint: { type: "plain_text", text: "Absolute path, or starting with ~/" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "~/code/my-repo" },
          ...(initialDir ? { initial_value: initialDir } : {}),
        },
      },
    ],
  };
}

/** The two fields of a submitted Connect modal, trimmed. */
export function readRemoteConnectValues(view: { state?: { values?: any } }): { addr: string; dir: string } {
  const values = view.state?.values ?? {};
  const field = (block: string) => String(values?.[block]?.value?.value ?? "").trim();
  return { addr: field(ADDR_BLOCK), dir: field(DIR_BLOCK) };
}
