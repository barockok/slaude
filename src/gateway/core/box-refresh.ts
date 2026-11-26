/**
 * Refresh: move a session to its box's current image (box spec, "Refresh
 * semantics").
 *
 * A session is pinned to a digest at its first dispatch and never moves on
 * its own. It moves in two ways only, and both end here:
 *
 *   - a person runs `/box refresh` in the thread;
 *   - a box version marked `refresh.force` makes every older digest of that
 *     box stale, and the next dispatch of a session pinned to one refreshes
 *     it before the turn is queued.
 *
 * A refresh is a new digest and nothing else. Home, workspace and transcript
 * are kept. Workspace extras start empty by construction: their unit id
 * contains the digest. Nothing is asked of a node here beyond ending the warm
 * session, so its next boot reads the new digest from the session view.
 *
 * Never during a turn: a session with a turn queued or running is left as it
 * is (`deferred`) and refreshed by a later dispatch or a later command.
 *
 * Order: the digest moves by compare-and-set from the digest that was read,
 * then the warm session is ended, then the audit row is written. So a session
 * never boots on a digest that has no refresh row coming, and two refreshes
 * at once move it once.
 */
import { emitAudit } from "../../audit/emit";
import { env } from "../../config/env";
import { db, type DbClient } from "../../db/client";
import { sessionBox } from "../../db/boxes";
import { currentBox, pinnedBox, type BoxVersion } from "./box-registry";

/** Who asked. */
export type RefreshBy = { kind: "user"; userId: string } | { kind: "forced" };

export type RefreshResult =
  /** The session moved from `from` to `to`. `note` is the box's own note (may be empty). */
  | { status: "refreshed"; box: string; from: string; to: string; version: number; note: string }
  /** Nothing newer: the session is on the box's current image. */
  | { status: "current"; box: string; digest: string }
  /** A turn is queued or running: nothing was changed. */
  | { status: "deferred"; box: string }
  /** The session has no box. */
  | { status: "not-boxed" }
  /** Another refresh moved the session first; `digest` is where it is now. */
  | { status: "raced"; box: string; digest: string | null };

/** What the first turn after a refresh is told. Stored between the refresh and that turn. */
export interface BoxRefreshMark {
  box: string;
  from: string;
  to: string;
  at: number;
}

export interface BoxRefreshDeps {
  read: (sessionId: string) => Promise<{ name: string; digest: string } | null>;
  current: (tenant: string, name: string) => Promise<BoxVersion | null>;
  pinned: (tenant: string, name: string, digest: string) => Promise<(BoxVersion & { stale: boolean }) | null>;
  /** Whether the session has a turn queued or running. */
  turnInFlight: (sessionId: string) => Promise<boolean>;
  /** Compare-and-set of the pinned digest. False when the session was not on `from` any more. */
  setDigest: (sessionId: string, name: string, from: string, to: string) => Promise<boolean>;
  /** End the warm session wherever it runs (the reload route). */
  reload: (sessionId: string) => void;
  /** Remember that the next turn must be told. */
  mark: (sessionId: string, m: BoxRefreshMark) => Promise<void>;
  audit: typeof emitAudit;
  now?: () => number;
}

/** The compare-and-set a refresh moves a session with. */
export async function setSessionBoxDigestOn(client: DbClient, sessionId: string, name: string, from: string, to: string): Promise<boolean> {
  const r = await client.run(`UPDATE sessions SET box_digest = ? WHERE id = ? AND box_name = ? AND box_digest = ?`, [to, sessionId, name, from]);
  return (r.changes ?? 0) > 0;
}

/** The parts of the deps that need no queue: the signed set and the session row. */
export const storedBoxRefreshDeps: Pick<BoxRefreshDeps, "read" | "current" | "pinned" | "setDigest" | "audit"> = {
  read: (sessionId) => sessionBox(sessionId),
  current: (tenant, name) => currentBox(tenant, name),
  pinned: (tenant, name, digest) => pinnedBox(tenant, name, digest),
  setDigest: (sessionId, name, from, to) => setSessionBoxDigestOn(db, sessionId, name, from, to),
  audit: emitAudit,
};

/** Whether boxes are switched on at all (off: nothing here reads or writes). */
export const boxRefreshEnabled = (): boolean => env.box.enabled();

const short = (digest: string): string => digest.replace(/^sha256:/, "").slice(0, 12);

/**
 * Whether a session's pin is stale: a version newer than the pinned digest's
 * was marked forced, with another digest. A pin whose digest the gateway no
 * longer has is not "stale" here: that is the pin's own error.
 */
export async function isStale(
  ctx: { tenant: string },
  pin: { name: string; digest: string },
  deps: Pick<BoxRefreshDeps, "pinned"> = storedBoxRefreshDeps,
): Promise<boolean> {
  return (await deps.pinned(ctx.tenant, pin.name, pin.digest))?.stale ?? false;
}

/**
 * Refresh one session. Changes nothing unless it answers `refreshed`. Throws
 * what the signed set throws (a set that does not verify refreshes nothing).
 */
export async function refresh(
  ctx: { tenant: string; persona: string; sessionId: string; channelId?: string; threadTs?: string },
  o: { by: RefreshBy },
  deps: BoxRefreshDeps,
): Promise<RefreshResult> {
  const pin = await deps.read(ctx.sessionId);
  if (!pin) return { status: "not-boxed" };
  const cur = await deps.current(ctx.tenant, pin.name);
  // The box is gone from the deploy: there is nothing to move to. The pin's own check reports it.
  if (!cur) return { status: "current", box: pin.name, digest: pin.digest };
  if (cur.digest === pin.digest) return { status: "current", box: pin.name, digest: pin.digest };
  if (await deps.turnInFlight(ctx.sessionId)) return { status: "deferred", box: pin.name };
  if (!(await deps.setDigest(ctx.sessionId, pin.name, pin.digest, cur.digest))) {
    return { status: "raced", box: pin.name, digest: (await deps.read(ctx.sessionId))?.digest ?? null };
  }
  const at = (deps.now ?? Date.now)();
  // The mark first: a turn that boots on the new image must find it. A failed mark loses a hint, not the refresh.
  await deps.mark(ctx.sessionId, { box: pin.name, from: pin.digest, to: cur.digest, at }).catch((e: unknown) => {
    console.warn(`[box] session=${ctx.sessionId}: the refresh note could not be stored (${e instanceof Error ? e.message : String(e)})`);
  });
  deps.reload(ctx.sessionId);
  deps.audit({
    tenantId: ctx.tenant,
    persona: ctx.persona,
    actorKind: o.by.kind === "user" ? "slack_user" : "system",
    actorId: o.by.kind === "user" ? o.by.userId : "dispatch",
    action: "box.refreshed",
    targetKind: "session",
    targetId: ctx.sessionId,
    sessionId: ctx.sessionId,
    ...(ctx.channelId ? { channelId: ctx.channelId } : {}),
    ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
    summary: `session moved to box ${pin.name} version ${cur.version} (${o.by.kind === "user" ? "asked for in the thread" : "the version is forced"})`,
    details: { box: pin.name, version: cur.version, from: pin.digest, to: cur.digest, by: o.by.kind },
  });
  console.log(`[box] session=${ctx.sessionId} refreshed box=${pin.name} ${short(pin.digest)} -> ${short(cur.digest)} by=${o.by.kind}`);
  return { status: "refreshed", box: pin.name, from: pin.digest, to: cur.digest, version: cur.version, note: cur.policy.refresh.note };
}

/**
 * The dispatch-time check: a session pinned to a stale digest is refreshed
 * before its turn is queued. Null when nothing was done (not stale, or a turn
 * is in flight and the refresh waits for a later dispatch).
 */
export async function refreshIfStale(
  ctx: { tenant: string; persona: string; sessionId: string; channelId?: string; threadTs?: string },
  pin: { name: string; digest: string },
  deps: BoxRefreshDeps,
): Promise<Extract<RefreshResult, { status: "refreshed" }> | null> {
  if (!(await isStale(ctx, pin, deps))) return null;
  const r = await refresh(ctx, { by: { kind: "forced" } }, deps);
  return r.status === "refreshed" ? r : null;
}

/** The tag of the note. Listed in ENVELOPE_TAG_NAMES, so a person's text can never open or close one. */
export const BOX_REFRESHED_TAG = "box-refreshed";

/**
 * The note the first turn after a refresh carries, before the `<channel>`
 * envelope. It says only what changed for the agent: no digest, no box name
 * from anyone's text. Stripped from the episodic record with the thread head
 * (src/memory/provider.ts).
 */
export function boxRefreshedNote(): string {
  return (
    `<${BOX_REFRESHED_TAG}>\n` +
    `Your sandbox was moved to a new image since your last turn. The system tools and runtimes may have changed versions. ` +
    `Your home directory, this workspace and this conversation were kept. Installed project dependencies ` +
    `(node_modules, .venv and the like) were not: reinstall them before you rely on them. ` +
    `Compiled caches in your home directory may have been built for the old image; clear one if a tool fails on it. ` +
    `Do not mention this note unless it explains a problem the user sees.\n` +
    `</${BOX_REFRESHED_TAG}>\n`
  );
}

/** The private notice a forced refresh sends the person whose message met it. */
export function forcedRefreshNotice(r: { box: string; note: string }): string {
  const note = r.note.trim();
  return (
    `:package: This thread's sandbox was moved to a new image of box \`${r.box}\` (its maintainers required it). ` +
    `Files in the agent's home and workspace were kept; installed project dependencies must be installed again.` +
    (note ? `\n> ${note.replace(/\n+/g, " ").slice(0, 500)}` : "")
  );
}
