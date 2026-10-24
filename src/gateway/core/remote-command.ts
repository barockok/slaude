/**
 * `/remote`: the pre-environment command, kept as an alias over `/env`
 * (env-command.ts). `/remote <tailcat-addr> [dir]` uses the owner's tailcat
 * environment for that address, re-points the thread's own tailcat
 * environment to it, or saves a new one; `off`, `key` and status map to
 * `/env`. The Connect form below is the private way to give the address.
 */
import { env } from "../../config/env";
import * as Envs from "../../db/environments";
import { activeRemoteTarget, boundEnv } from "../../remote/active";
import { connectInfoForBinding } from "../../remote/env-runtime";
import { isTailcatAddr } from "../../remote/shell";
import * as OneOnOne from "../../db/one-on-one";
import type { SlashHit } from "../slack/commands";
import {
  defaultEnvDeps,
  handleEnvCommand,
  useEnvironment,
  type EnvCommandDeps,
  type RemoteCommandCtx,
} from "./env-command";

export {
  endRemoteForThread,
  forgetRemoteStatus,
  remoteStatusOn,
  type RemoteCommandCtx,
} from "./env-command";

type RemoteHit = Extract<SlashHit, { kind: "remote" }>;
export type RemoteCommandDeps = EnvCommandDeps;

export async function handleRemoteCommand(hit: RemoteHit, ctx: RemoteCommandCtx, deps: RemoteCommandDeps = defaultEnvDeps): Promise<void> {
  if (!env.remote.enabled()) {
    await ctx.reply(":no_entry: `/remote` is not enabled on this deployment.");
    return;
  }
  const { channelId, threadTs, teamId, userId } = ctx;

  if (hit.action === "status") {
    const t = await activeRemoteTarget(channelId, threadTs);
    const b = t ? await boundEnv(channelId, threadTs) : null;
    if (!t || !b) {
      await ctx.reply("Remote mode: *off* — tools run on the server.");
      // Offer the form only to someone who could turn it on here: no lock, or their own.
      const lock = await OneOnOne.find(channelId, threadTs);
      if (ctx.offerConnect && (!lock || lock.locked_user === userId)) await ctx.offerConnect();
      return;
    }
    let info = null;
    try { info = await connectInfoForBinding(b.binding, b.env); } catch {}
    const path = await deps.status(b.env, info);
    const whose = t.env?.trust === "provisioned" ? "a sandbox" : `<@${t.userId}>'s machine`;
    await ctx.reply(`Remote mode: *on* — ${whose}, environment *${b.env.name}*, \`${t.dir}\`, path: *${path}*.`);
    return;
  }
  if (hit.action === "key") return handleEnvCommand({ kind: "env", action: "key", kindName: "tailcat" }, ctx, deps);
  if (hit.action === "off") {
    if (!(await Envs.findBinding(channelId, threadTs))) {
      await ctx.reply("Remote mode is not on in this thread.");
      return;
    }
    return handleEnvCommand({ kind: "env", action: "off" }, ctx, deps);
  }

  // action === "on"
  if (hit.action !== "on") return;
  if (!isTailcatAddr(hit.addr)) {
    await ctx.reply(":x: That doesn't look like a tailcat address.");
    return;
  }
  const current = await boundEnv(channelId, threadTs);
  const ownCurrent = current && current.env.userId === userId && current.env.teamId === teamId ? current : null;
  const dir = hit.dir ?? ownCurrent?.binding.dir;
  if (!dir) {
    await ctx.reply("Send `/remote` and click *Connect your machine*, or use `/remote <tailcat-address> <directory>`.");
    return;
  }
  // The same address → that environment. The thread's own tailcat environment
  // and a new address → re-point it (tailcat serve restarted with a new key).
  // Otherwise a new tailcat environment, kept only if it could be used.
  let target = await Envs.findTailcatEnvByAddr(teamId, userId, hit.addr);
  let undo: (() => Promise<unknown>) | null = null;
  if (!target && ownCurrent?.env.kind === "tailcat") {
    const prev = ownCurrent.env;
    target = await Envs.updateEnv(prev.id, { config: { ...prev.config, addr: hit.addr } });
    undo = () => Envs.updateEnv(prev.id, { config: prev.config });
  }
  if (!target) {
    target = await Envs.createEnv({
      teamId, userId, kind: "tailcat",
      name: await Envs.freeName(teamId, userId, "tailcat"),
      config: { addr: hit.addr },
      defaultDir: dir,
    });
    const id = target.id;
    undo = () => Envs.deleteEnv(id);
  }
  const ok = await useEnvironment(target, dir, ctx, deps);
  if (!ok && undo) await undo();
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
