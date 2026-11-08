/**
 * PreToolUse hooks for owner guardrails (design section 4).
 *
 * hook.pre-tool.owner-guardrails: the session's enforced tool rules, then
 * on-match Guidance. PreToolUse runs in every permission mode, bypass
 * included, so `/mode` cannot skip an owner rule.
 *   - deny (and approve, enforced as deny until approval cards exist):
 *     permissionDecision deny with the deciding rule's message.
 *   - audit: the call goes on; the firing is recorded.
 *   - every matching rule is recorded, the deciding one marked.
 *   - Guidance with a tool trigger: the first matching call of the session is
 *     refused once with the body ("Read guardrail <name> first"); the retry
 *     proceeds. Delivery only, never a decision.
 *
 * hook.pre-tool.guardrail-files: refuses Write, Edit, MultiEdit and
 * NotebookEdit under $SLAUDE_HOME/guardrails and on the database file.
 * Defence in depth only: Bash is not covered, which is why files are never the
 * authority and stored rows are signed.
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { combine, hitMessage, toolHits } from "./match";
import { firingEvents, type FiringEvent } from "./audit";
import { guidanceText, toolTriggered, type OnMatchGuidance, type SessionGuardrails } from "./resolve";

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
});

export interface OwnerGuardrailHookDeps {
  /** The session's guardrails (snapshot at boot), or null when none. */
  guardrails: () => SessionGuardrails | null;
  /** The session's channel (on-match triggers can be channel-limited). */
  channel: () => string | null | undefined;
  /** Slugs whose Guidance this session has already been given (cleared on every boot). */
  delivered: () => Set<string>;
  /** Every firing of one call, the deciding one marked. */
  onFiring: (events: FiringEvent[]) => void;
  /** Guidance handed over by a refusal. */
  onDelivered: (items: OnMatchGuidance[], toolName: string) => void;
  /** Every name the called tool goes by (remote mode: the alias and the builtin it stands for). Default: the name itself. */
  toolNames?: (toolName: string) => string[];
}

/** A tool's names in remote mode: the alias the CLI reports and the builtin it stands for. */
export function aliasNames(aliases: Readonly<Record<string, string>>): (toolName: string) => string[] {
  const reverse = new Map(Object.entries(aliases).map(([builtin, alias]) => [alias, builtin]));
  return (name) => {
    const builtin = reverse.get(name);
    const forward = aliases[name];
    return [name, ...(builtin ? [builtin] : []), ...(forward ? [forward] : [])];
  };
}

export function deniedMessage(slug: string, message: string): string {
  return hitMessage({ slug, rule: { message } as never });
}

export function ownerGuardrailsHook(deps: OwnerGuardrailHookDeps): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const g = deps.guardrails();
    if (!g || (g.toolRules.length === 0 && g.onMatch.length === 0)) return {};
    const i = input as { tool_name?: string; tool_input?: unknown };
    const toolName = i.tool_name ?? "";
    const names = deps.toolNames?.(toolName) ?? [toolName];
    const decision = combine(toolHits(g.toolRules, names, i.tool_input));
    if (decision) deps.onFiring(firingEvents("tool", decision.hits, decision.deciding, toolName));
    if (decision && decision.action !== "audit") return deny(hitMessage(decision.deciding));
    const seen = deps.delivered();
    const triggered = new Map<string, OnMatchGuidance>();
    for (const n of names) for (const o of toolTriggered(g, n, deps.channel())) triggered.set(o.slug, o);
    const due = [...triggered.values()].filter((o) => !seen.has(o.slug));
    if (due.length === 0) return {};
    for (const o of due) seen.add(o.slug);
    deps.onDelivered(due, toolName);
    const titles = due.map((o) => o.name).join(", ");
    return deny(`Read guardrail ${titles} first. This is not a refusal of the call: retry it after reading.\n\n${guidanceText(due)}`);
  };
}

/** How many refusals on-match tool Guidance can cost a session at most (one per guardrail). */
export function deliveryTurnAllowance(g: SessionGuardrails | null): number {
  return g ? g.onMatch.filter((o) => o.tool.length > 0).length : 0;
}

export const FILE_WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

/** The deepest existing ancestor resolved through symlinks, the rest appended. */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    rest.unshift(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    cur = up;
  }
  try {
    return resolve(realpathSync(cur), ...rest);
  } catch {
    return p;
  }
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export interface ProtectedPaths {
  /** $SLAUDE_HOME/guardrails */
  guardrailsDir: string;
  /** The sqlite database file (its -wal, -shm and -journal siblings too). */
  dbFile: string | null;
  /** The signing key file when there is no master key (default: `.hmac-key` in guardrailsDir). */
  keyFile?: string;
  /** Compare paths case-insensitively (default: on macOS and Windows, whose default volumes are). */
  caseInsensitive?: boolean;
}

const caseInsensitiveDefault = process.platform === "darwin" || process.platform === "win32";

function norm(p: ProtectedPaths): (x: string) => string {
  return (p.caseInsensitive ?? caseInsensitiveDefault) ? (x) => x.toLowerCase() : (x) => x;
}

function absolute(target: string, cwd: string): string[] {
  const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  return [abs, realish(abs)];
}

/** Whether a file tool's target is a protected guardrail path (written). */
export function isProtectedPath(target: string, cwd: string, p: ProtectedPaths): boolean {
  const n = norm(p);
  const candidates = absolute(target, cwd).map(n);
  const dirs = [p.guardrailsDir, realish(p.guardrailsDir)].map(n);
  const dbs = (p.dbFile ? [p.dbFile, realish(p.dbFile)].flatMap((f) => [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]) : []).map(n);
  return candidates.some((c) => dirs.some((d) => under(c, d)) || dbs.includes(c));
}

/** Whether a read of `target` reaches the signing key: the key file itself, or a search rooted in the guardrails folder. */
export function readsKey(target: string, cwd: string, p: ProtectedPaths, search: boolean): boolean {
  const n = norm(p);
  const keyFile = p.keyFile ?? resolve(p.guardrailsDir, ".hmac-key");
  const keys = [keyFile, realish(keyFile)].map(n);
  const candidates = absolute(target, cwd).map(n);
  if (candidates.some((c) => keys.includes(c))) return true;
  if (!search) return false;
  const dirs = [p.guardrailsDir, realish(p.guardrailsDir)].map(n);
  return candidates.some((c) => dirs.some((d) => under(c, d)));
}

export const KEY_READ_TOOLS = ["Read", "Grep", "Glob"] as const;

export function guardrailFilesHook(cwd: () => string, protectedPaths: () => ProtectedPaths): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown> | null };
    const name = i.tool_name ?? "";
    const t = i.tool_input ?? {};
    const str = (k: string) => (typeof t[k] === "string" ? (t[k] as string) : null);
    if ((KEY_READ_TOOLS as readonly string[]).includes(name)) {
      const search = name !== "Read";
      const targets = [str("file_path"), str("path"), ...(name === "Glob" && str("pattern") && isAbsolute(str("pattern")!) ? [str("pattern")] : [])].filter((x): x is string => !!x);
      if (!targets.some((x) => readsKey(x, cwd(), protectedPaths(), search))) return {};
      return deny("The guardrail signing key is not readable from a session.");
    }
    if (!(FILE_WRITE_TOOLS as readonly string[]).includes(name)) return {};
    const target = str("file_path") ?? str("notebook_path");
    if (!target) return {};
    if (!isProtectedPath(target, cwd(), protectedPaths())) return {};
    return deny("Guardrail files and the runtime database are not editable from a session. The owner changes guardrails through the deploy repo, the console or `slaude guardrails import`.");
  };
}
