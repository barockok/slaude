import type { OneOnOneLockRow } from "../db/one-on-one";
import { renderRuntimeFile } from "../soul/runtime/render";

/**
 * System-prompt block telling the model whether this thread is a private `/1on1`
 * session. The session reboots whenever the lock is taken or released
 * (gateway: `OneOnOne.lock/unlock` + `agent.reload`), so a block computed from the
 * lock at session start stays accurate for the session's lifetime.
 *
 * Returns "" when the thread is unlocked (ordinary group/channel mode) so the
 * caller can drop it from the appended blocks.
 */
/** Where a remote session's tools run, as the prompt describes it. */
export interface RemoteModeInfo {
  userId: string;
  dir: string;
  /** Absent for a pre-environment tailcat claim. */
  env?: { name: string; kind: string; trust: "user-machine" | "provisioned" };
}

export function sessionModeBlock(
  lock: OneOnOneLockRow | null,
  remote?: RemoteModeInfo | null,
): string {
  const base = lockBlock(lock);
  if (!remote) return base;
  return [base, remoteBlock(remote)].filter(Boolean).join("\n\n");
}

function lockBlock(lock: OneOnOneLockRow | null): string {
  if (!lock) return "";
  if (lock.open_scope !== null) {
    const scopeLine = lock.open_scope.trim()
      ? `Active scope constraint (applies to all guests — not the session owner <@${lock.locked_user}>): ${lock.open_scope.trim()}`
      : `No additional scope constraint is active — guests may participate freely.`;
    return renderRuntimeFile("modules/one-on-one-open.md", { LOCKED_USER: lock.locked_user, SCOPE_LINE: scopeLine });
  }
  return renderRuntimeFile("modules/one-on-one-locked.md", { LOCKED_USER: lock.locked_user });
}

function remoteBlock(r: RemoteModeInfo): string {
  const where = r.env?.trust === "provisioned"
    ? `in a disposable sandbox environment \`${r.env.name}\` (${r.env.kind}), in \`${r.dir}\``
    : `on <@${r.userId}>'s own machine${r.env ? ` (environment \`${r.env.name}\`, ${r.env.kind})` : ""}, in \`${r.dir}\``;
  return renderRuntimeFile("modules/remote.md", { WHERE: where });
}
