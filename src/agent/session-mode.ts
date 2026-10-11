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
export function sessionModeBlock(
  lock: OneOnOneLockRow | null,
  remote?: { userId: string; dir: string } | null,
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
    return [
      "<session-mode>",
      `This thread is a 1on1 session owned by <@${lock.locked_user}>, currently open to all participants.`,
      scopeLine,
      "The session owner can restrict access again at any time with `/1on1 lock`.",
      "</session-mode>",
    ].join("\n");
  }
  return [
    "<session-mode>",
    `This thread is a private 1on1 session locked to <@${lock.locked_user}>.`,
    "Only that user and the manager are heard here — treat it as a confidential,",
    "direct one-on-one: you may speak more freely and personally than in a shared",
    "channel, and anything said is between you and them.",
    "</session-mode>",
  ].join("\n");
}

function remoteBlock(r: { userId: string; dir: string }): string {
  return [
    "<remote-mode>",
    `Your file and shell tools (Bash, Read, Write, Edit, Glob, Grep) run on <@${r.userId}>'s own machine, in \`${r.dir}\` — not on this server.`,
    "Relative paths resolve against that directory. The knowledge base, MCP servers and web tools are unchanged and still run here.",
    "Background jobs: Bash with run_in_background returns an ID; read output with mcp__remote__bash_output and stop it with mcp__remote__bash_kill.",
    "If a tool fails with REMOTE_UNREACHABLE or REMOTE_AUTH_FAILED, stop and tell the user (they can check with `/remote`). Do not retry in a loop and do not work around it.",
    "</remote-mode>",
  ].join("\n");
}
