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
import { combine, toolRuleMatches } from "./match";
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
}

export function deniedMessage(slug: string, message: string): string {
  return message.trim() ? message.trim() : `Blocked by the owner's guardrail ${slug}.`;
}

export function ownerGuardrailsHook(deps: OwnerGuardrailHookDeps): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const g = deps.guardrails();
    if (!g || (g.toolRules.length === 0 && g.onMatch.length === 0)) return {};
    const i = input as { tool_name?: string; tool_input?: unknown };
    const toolName = i.tool_name ?? "";
    const hits = g.toolRules.filter((h) => toolRuleMatches(h.rule, toolName, i.tool_input));
    const decision = combine(hits);
    if (decision) deps.onFiring(firingEvents("tool", decision.hits, decision.deciding, toolName));
    if (decision && decision.action !== "audit") {
      return deny(deniedMessage(decision.deciding.slug, decision.deciding.rule.message));
    }
    const seen = deps.delivered();
    const due = toolTriggered(g, toolName, deps.channel()).filter((o) => !seen.has(o.slug));
    if (due.length === 0) return {};
    for (const o of due) seen.add(o.slug);
    deps.onDelivered(due, toolName);
    const names = due.map((o) => o.name).join(", ");
    return deny(`Read guardrail ${names} first. This is not a refusal of the call: retry it after reading.\n\n${guidanceText(due)}`);
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
}

/** Whether a file tool's target is a protected guardrail path. */
export function isProtectedPath(target: string, cwd: string, p: ProtectedPaths): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const candidates = [abs, realish(abs)];
  const dirs = [p.guardrailsDir, realish(p.guardrailsDir)];
  const dbs = p.dbFile ? [p.dbFile, realish(p.dbFile)].flatMap((f) => [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]) : [];
  return candidates.some((c) => dirs.some((d) => under(c, d)) || dbs.includes(c));
}

export function guardrailFilesHook(cwd: () => string, protectedPaths: () => ProtectedPaths): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown> | null };
    if (!(FILE_WRITE_TOOLS as readonly string[]).includes(i.tool_name ?? "")) return {};
    const t = i.tool_input ?? {};
    const target = typeof t.file_path === "string" ? t.file_path : typeof t.notebook_path === "string" ? t.notebook_path : null;
    if (!target) return {};
    if (!isProtectedPath(target, cwd(), protectedPaths())) return {};
    return deny("Guardrail files and the runtime database are not editable from a session. The owner changes guardrails through the deploy repo, the console or `slaude guardrails import`.");
  };
}
