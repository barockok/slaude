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
  sandbox = false,
  localExecOff = false,
  sandboxAvailable = false,
  workflow: WorkflowInfo | null = null,
): string {
  const base = [lockBlock(lock), workflow ? workflowBlock(workflow) : ""].filter(Boolean).join("\n\n");
  if (remote) return [base, remoteBlock(remote)].filter(Boolean).join("\n\n");
  if (sandbox) return [base, SANDBOX_BLOCK].filter(Boolean).join("\n\n");
  const available = sandboxAvailable ? SANDBOX_AVAILABLE_BLOCK : "";
  if (localExecOff) return [base, LOCAL_EXEC_OFF_BLOCK, available].filter(Boolean).join("\n\n");
  return [base, available].filter(Boolean).join("\n\n");
}

/** A ticket workflow running in this thread (factory framework). */
export interface WorkflowInfo { runId: string; pipeline: string; ticketRef?: string | null; starter: string }

function workflowBlock(w: WorkflowInfo): string {
  return [
    "<workflow>",
    `This thread runs the ticket workflow \`${w.pipeline}\`${w.ticketRef ? ` for ${w.ticketRef}` : ""} (run ${w.runId}), started by <@${w.starter}>.`,
    "Stages arrive as turns marked [workflow ...]; each one names its stage and attempt. Do only that stage.",
    "End every stage by calling mcp__slaude_surface__request_stage_approval, then stop. Never start the next stage yourself: the workflow sends it after the starter or a participant approves.",
    "Only the starter and the participants (/participant list) may approve. Messages from others are input, not approvals.",
    "</workflow>",
  ].join("\n");
}

const SANDBOX_AVAILABLE_BLOCK = [
  "<sandbox-available>",
  "Code work (cloning, building, testing, editing or committing a repo) runs in a per-thread sandbox, not on this server. Before any code work, call mcp__slaude_surface__enter_sandbox; if the user is not allowed, say so and do not do the code work here. Reading, answering questions and calling MCP tools stay here.",
  "</sandbox-available>",
].join("\n");

const LOCAL_EXEC_OFF_BLOCK = [
  "<local-exec-off>",
  "This thread has no remote target, and this deployment never runs shell commands or writes files on its own server: Bash, Write and Edit are unavailable here. Read, Glob, Grep, the knowledge base, MCP servers and web tools still work.",
  "For any work that needs a shell or file edits, ask the user to attach a sandbox with `/remote <address> <dir>` first. Do not look for another way to run commands.",
  "</local-exec-off>",
].join("\n");

const SANDBOX_BLOCK = [
  "<sandbox-mode>",
  "Your file and shell tools (Bash, Read, Write, Edit, Glob, Grep) run in an isolated sandbox for this thread — not on this server.",
  "The sandbox holds no credentials: anything that needs one (pushing code, opening a pull request, calling an API) cannot be done from Bash there. The knowledge base, MCP servers and web tools are unchanged and still run here.",
  "Background jobs: Bash with run_in_background returns an ID; read output with mcp__remote__bash_output and stop it with mcp__remote__bash_kill.",
  "To publish work: commit on a branch named factory/<name>, then call mcp__remote__git_push (it asks the user for approval and pushes from outside the sandbox).",
  "The repos were cloned when the sandbox was created and have no remote, so `git fetch` or `git pull` from Bash always fails. To bring newer commits in, call mcp__remote__git_fetch with the branch names (for example [\"master\"]); they arrive as mirror/<branch>. Rebase on mirror/master before a push, and `git reset --hard mirror/factory/<name>` when a human rewrote your branch.",
  "If a sandbox tool fails because the sandbox is unreachable or expired, stop and tell the user. Do not retry in a loop and do not work around it.",
  "The user can leave with `/sandbox off`, which destroys the sandbox: push anything worth keeping first.",
  "</sandbox-mode>",
].join("\n");

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
    "To publish work: commit on a branch named factory/<name>, then call mcp__remote__git_push. `git push` from Bash has no credential there; git_push asks the user for approval and pushes from this server.",
    "If a tool fails with REMOTE_UNREACHABLE or REMOTE_AUTH_FAILED, stop and tell the user (they can check with `/remote`). Do not retry in a loop and do not work around it.",
    "</remote-mode>",
  ].join("\n");
}
