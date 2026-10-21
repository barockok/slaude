/**
 * /1on1 named guests: who is speaking in a locked thread, and which tool calls
 * stay with the owner while a guest's message is in the turn.
 *
 * The session keeps running as the lock owner (runAs, credentials, config dir
 * are unchanged by guests), so a guest's turn could otherwise push, commit or
 * write under the owner's identity. A tool call that matches the owner-only
 * list during such a turn waits for the owner's click on a card; nobody else's
 * click counts, and no click before the timeout is a deny. The check runs in a
 * PreToolUse hook, which the CLI runs in every permission mode, bypass
 * included (canUseTool is never called under bypass).
 *
 * Roles come from the lock and the signed inbound user id, never from model
 * input. Everything here is pure; the manager installs the hook and the
 * gateway (mono) or the node decides when a turn carries a guest.
 */
import type { OneOnOneLockRow } from "../db/one-on-one";

export type TurnRole = "owner" | "guest" | "manager";

/**
 * The speaker's role in a thread's /1on1, or null when the thread is not a
 * 1on1 or the speaker is not heard there. Owner first, then manager/backup
 * (heard in every locked thread), then guests: everyone else in open mode, the
 * invited users in locked mode.
 */
export function speakerRole(
  lock: Pick<OneOnOneLockRow, "locked_user" | "open_scope" | "guests"> | null,
  userId: string | null | undefined,
  managers: ReadonlyArray<string | null | undefined>,
): TurnRole | null {
  if (!lock || !userId) return null;
  if (userId === lock.locked_user) return "owner";
  if (managers.some((m) => !!m && m === userId)) return "manager";
  if (lock.open_scope !== null) return "guest";
  return (lock.guests ?? []).includes(userId) ? "guest" : null;
}

/** A guest of a LOCKED 1on1: the case the owner-only guard covers. Open mode
 *  keeps its model-enforced scope, as before named guests. */
export function isNamedGuestTurn(
  lock: Pick<OneOnOneLockRow, "locked_user" | "open_scope" | "guests"> | null,
  userId: string | null | undefined,
  managers: ReadonlyArray<string | null | undefined>,
): boolean {
  return !!lock && lock.open_scope === null && speakerRole(lock, userId, managers) === "guest";
}

/**
 * Owner-only tools in a guest turn when SLAUDE_1ON1_OWNER_ONLY_TOOLS is unset:
 * file writes, and the sandbox / workbench MCP tools that commit, push, move
 * or lease under the owner's identity. `>:write` checks a meta-tool's inner
 * calls (see ownerOnlyMatch).
 */
export const DEFAULT_OWNER_ONLY_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "mcp__*__git_push",
  "mcp__*__git_commit",
  "mcp__*__write_file",
  "mcp__*__edit_file",
  "mcp__*__delete_path",
  "mcp__*__move_path",
  "mcp__*__sandbox_lease",
  "mcp__*__sandbox_release",
  "mcp__workbench__execute_tools>:write",
];

/** Owner-only in every guest turn whatever the list says: changing the 1on1
 *  itself (a guest must not open or release it), and scheduling a prompt,
 *  since a job created in a 1on1 later runs as its owner with no guest in it. */
export const ALWAYS_OWNER_ONLY: readonly string[] = [
  "mcp__slaude_surface__set_one_on_one",
  "mcp__slaude_runtime__add_cron_job",
  "mcp__slaude_runtime__edit_cron_job",
];

export interface OwnerOnlyRule {
  /** The entry as configured, shown on the owner's card. */
  source: string;
  tool: RegExp;
  /** Inner-call matcher for a meta-tool: a glob over inner tool names, or
   *  "write" = any inner call whose name does not read as read-only. */
  inner?: RegExp | "write";
}

function glob(pattern: string, flags = ""): RegExp {
  const body = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, flags);
}

function rule(entry: string): OwnerOnlyRule | null {
  const [outer, inner] = entry.split(">", 2).map((s) => s.trim());
  if (!outer) return null;
  return {
    source: entry,
    tool: glob(outer),
    ...(inner === undefined || inner === "" ? {} : { inner: inner === ":write" ? ("write" as const) : glob(inner, "i") }),
  };
}

/**
 * Parse SLAUDE_1ON1_OWNER_ONLY_TOOLS: comma-separated globs over tool names
 * (`*` matches any run of characters). Unset or blank = the defaults; `none` =
 * no list (the always-owner-only tools still apply); a leading `+` adds the
 * entries to the defaults. `tool>inner` matches a meta-tool call when one of
 * its inner tool names matches `inner` (a glob, or `:write`).
 */
export function parseOwnerOnlyRules(raw: string | undefined): OwnerOnlyRule[] {
  const v = (raw ?? "").trim();
  let entries: string[];
  if (!v) entries = [...DEFAULT_OWNER_ONLY_TOOLS];
  else if (v.toLowerCase() === "none") entries = [];
  else if (v.startsWith("+")) entries = [...DEFAULT_OWNER_ONLY_TOOLS, ...csv(v.slice(1))];
  else entries = csv(v);
  return [...ALWAYS_OWNER_ONLY, ...entries].map(rule).filter((r): r is OwnerOnlyRule => r !== null);
}

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Inner tool names of a meta-tool call (`executions[].tool`, the workbench
 *  shape), or null when the input carries none in a shape we know. */
export function innerToolNames(input: unknown): string[] | null {
  if (!input || typeof input !== "object") return null;
  const ex = (input as { executions?: unknown }).executions;
  if (!Array.isArray(ex) || ex.length === 0) return null;
  const names: string[] = [];
  for (const e of ex) {
    const t = e && typeof e === "object" ? (e as { tool?: unknown }).tool : undefined;
    if (typeof t !== "string" || !t) return null;
    names.push(t);
  }
  return names;
}

const READ_VERBS = new Set(["get", "list", "search", "read", "fetch", "find", "query", "describe", "view", "show", "lookup", "count"]);
const WRITE_VERBS = new Set([
  "create", "update", "delete", "remove", "write", "edit", "send", "post", "put", "patch", "push", "merge",
  "commit", "move", "rename", "add", "set", "upload", "close", "approve", "assign", "transition", "archive",
  "invite", "run", "execute", "trigger", "start", "stop", "cancel", "replace", "insert", "modify", "publish",
  "share", "grant", "revoke", "reply", "comment", "lock", "unlock", "enable", "disable", "restore", "import",
]);

/** Whether a tool name reads as read-only: it names a read verb and no write
 *  verb (`JIRA_GET_ISSUE` yes, `GITHUB_CREATE_ISSUE` no, `FOO_SYNC` no). A
 *  name that says neither is treated as a write: unknown means the owner asks. */
export function readsAsReadOnly(name: string): boolean {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((t) => READ_VERBS.has(t)) && !tokens.some((t) => WRITE_VERBS.has(t));
}

/**
 * The rule a call matches, or null. A rule with an inner matcher matches when
 * the call's inner tools cannot be read (fail closed) or any of them matches.
 */
export function ownerOnlyMatch(toolName: string, input: unknown, rules: readonly OwnerOnlyRule[]): OwnerOnlyRule | null {
  for (const r of rules) {
    if (!r.tool.test(toolName)) continue;
    if (!r.inner) return r;
    const names = innerToolNames(input);
    if (!names) return r;
    const inner = r.inner;
    if (names.some((n) => (inner === "write" ? !readsAsReadOnly(n) : inner.test(n)))) return r;
  }
  return null;
}
