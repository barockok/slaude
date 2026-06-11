/**
 * Session-id contract between slaude and the claude CLI.
 *
 * The CLI generates its own conversation id unless told otherwise; slaude
 * used to resume with its OWN sqlite uuid, which the CLI had never seen —
 * every idle-reopen logged "No conversation found with session ID" and
 * cold-started (100% resume miss).
 *
 * Fix: first boot seeds the CLI with slaude's id (`--session-id` via the
 * SDK's extraArgs passthrough), so the two worlds share one id and a later
 * `resume` finds the transcript.
 */
export function sessionIdOpts(row: { id: string; claude_started: number | boolean }): {
  resume?: string;
  extraArgs?: Record<string, string>;
} {
  return row.claude_started ? { resume: row.id } : { extraArgs: { "session-id": row.id } };
}
