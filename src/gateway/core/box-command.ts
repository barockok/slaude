/**
 * `/box status` and `/box refresh` (box spec, "Refresh semantics").
 *
 * Both answer the sender alone. `status` reads; `refresh` moves the thread's
 * session to its box's current image and is allowed for whoever may start the
 * thread's session over: the agent's manager and the channel's approvers.
 *
 * Text only: digests are shown short, the image reference is not shown (a
 * registry path says where an organisation keeps its images), and nothing of
 * the policy but the tier and the size limits.
 */
import type { BoxPolicy } from "../../box/policy";
import type { BoxVersion } from "./box-registry";
import { refresh, type BoxRefreshDeps, type RefreshResult } from "./box-refresh";

export type BoxAction = "status" | "refresh";

export interface BoxCommandCtx {
  tenant: string;
  persona: string;
  sessionId: string;
  userId: string;
  channelId: string;
  threadTs: string;
}

export interface BoxCommandDeps extends BoxRefreshDeps {
  /** Whether boxes are switched on for this deployment and turns go to nodes. */
  enabled: () => boolean;
  /** The box the persona names (or the deployment default), for a session that has no pin yet. */
  boxNameFor: (persona: string) => string | null;
  /** Whether the sender may refresh: the same people who may start the session over. */
  mayRefresh: () => Promise<boolean>;
}

export interface BoxCommandReply {
  /** For the sender alone. */
  text: string;
  /** What the refresh did, when the command was one. */
  result?: RefreshResult;
}

export const BOX_REFRESH_DENIED = ":lock: `/box refresh`: only the agent's manager or this channel's approvers can move this thread to a new image.";
export const BOX_NOT_IN_USE = "Boxes are not in use on this deployment, so this thread runs on the worker itself.";

const short = (digest: string): string => digest.replace(/^sha256:/, "").slice(0, 12);
const gb = (mb: number): string => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);

function limits(p: BoxPolicy): string {
  const r = p.resources;
  return `memory ${gb(r.memoryMb)}, ${r.cpu} CPU, home ${gb(r.homeMb)}, installed dependencies ${gb(r.workspaceExtrasMb)}, system writes ${gb(r.rootOverlayMb)} (not kept)`;
}

/** The status lines of a pinned session. Exported for tests. */
export function boxStatusText(o: {
  box: string;
  pinnedDigest: string;
  /** The version the pin belongs to, or null when the gateway no longer has that digest. */
  pinned: (BoxVersion & { stale: boolean }) | null;
  current: BoxVersion | null;
}): string {
  const lines = [`*box* \`${o.box}\``];
  if (!o.current) {
    lines.push(`image \`${short(o.pinnedDigest)}\``);
    lines.push(":warning: This box is no longer defined on this deployment. The thread cannot start a turn until an operator restores it.");
    return lines.join("\n");
  }
  const newer = o.current.digest !== o.pinnedDigest;
  lines.push(`image \`${short(o.pinnedDigest)}\`${o.pinned ? ` (version ${o.pinned.version})` : ""}`);
  lines.push(`sandbox tier \`${o.current.policy.tier}\``);
  lines.push(`limits: ${limits(o.current.policy)}`);
  if (!o.pinned) {
    lines.push(`:warning: This image is no longer available. \`/box refresh\` moves the thread to the current one (version ${o.current.version}, \`${short(o.current.digest)}\`).`);
  } else if (!newer) {
    lines.push("This is the box's current image.");
  } else if (o.pinned.stale) {
    lines.push(`A newer image is required (version ${o.current.version}, \`${short(o.current.digest)}\`). The thread moves to it at its next message.`);
  } else {
    lines.push(`A newer image exists (version ${o.current.version}, \`${short(o.current.digest)}\`). \`/box refresh\` moves this thread to it; nothing moves on its own.`);
  }
  lines.push("Kept between turns: the home directory, the workspace, the conversation. Not kept: system-level installs.");
  return lines.join("\n");
}

/** The sender's answer to a refresh. Exported for tests. */
export function refreshReplyText(r: RefreshResult): string {
  switch (r.status) {
    case "refreshed":
      return (
        `:package: Moved this thread to the current image of box \`${r.box}\` (version ${r.version}, \`${short(r.to)}\`). ` +
        `The home directory, the workspace and the conversation were kept. Installed project dependencies were not: the agent reinstalls them when it needs them.` +
        (r.note.trim() ? `\n> ${r.note.trim().replace(/\n+/g, " ").slice(0, 500)}` : "")
      );
    case "current":
      return `This thread is already on the current image of box \`${r.box}\` (\`${short(r.digest)}\`). Nothing was changed.`;
    case "deferred":
      return ":hourglass: A turn is running or queued in this thread, and an image never changes during a turn. Run `/box refresh` again when it has finished.";
    case "raced":
      return r.digest
        ? `This thread was just moved by another refresh (now on \`${short(r.digest)}\`). Nothing more was changed.`
        : "This thread's box changed while the refresh ran. Nothing more was changed.";
    case "not-boxed":
      return "This thread does not run in a box, so there is no image to move.";
  }
}

export async function runBoxCommand(action: BoxAction, ctx: BoxCommandCtx, deps: BoxCommandDeps): Promise<BoxCommandReply> {
  if (!deps.enabled()) return { text: BOX_NOT_IN_USE };
  const pin = await deps.read(ctx.sessionId);
  if (action === "status") {
    if (!pin) {
      const named = deps.boxNameFor(ctx.persona);
      return {
        text: named
          ? `This thread has not started a turn in a box yet. Its agent runs in box \`${named}\`: the image is chosen at the thread's first turn.`
          : "This thread does not run in a box: its agent names none.",
      };
    }
    const [pinned, current] = await Promise.all([deps.pinned(ctx.tenant, pin.name, pin.digest), deps.current(ctx.tenant, pin.name)]);
    return { text: boxStatusText({ box: pin.name, pinnedDigest: pin.digest, pinned, current }) };
  }
  if (!(await deps.mayRefresh())) return { text: BOX_REFRESH_DENIED };
  const result = await refresh(
    { tenant: ctx.tenant, persona: ctx.persona, sessionId: ctx.sessionId, channelId: ctx.channelId, threadTs: ctx.threadTs },
    { by: { kind: "user", userId: ctx.userId } },
    deps,
  );
  return { text: refreshReplyText(result), result };
}
