import type { OneOnOneLockRow } from "../db/one-on-one";

/**
 * System-prompt block telling the model whether this thread is a private `/1on1`
 * session. The session reboots whenever the lock is taken or released
 * (gateway: `OneOnOne.lock/unlock` + `agent.reload`), so a block computed from the
 * lock at session start stays accurate for the session's lifetime.
 *
 * Returns "" when the thread is unlocked (ordinary group/channel mode) so the
 * caller can drop it from the appended blocks.
 */
export function sessionModeBlock(lock: OneOnOneLockRow | null): string {
  if (!lock) return "";
  return [
    "<session-mode>",
    `This thread is a private 1on1 session locked to <@${lock.locked_user}>.`,
    "Only that user and the manager are heard here — treat it as a confidential,",
    "direct one-on-one: you may speak more freely and personally than in a shared",
    "channel, and anything said is between you and them.",
    "</session-mode>",
  ].join("\n");
}
