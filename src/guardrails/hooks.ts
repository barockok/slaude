/**
 * PreToolUse hooks for owner guardrails (design section 4).
 *
 * hook.pre-tool.owner-guardrails: the session's enforced tool rules, then
 * on-match Guidance. PreToolUse runs in every permission mode, bypass
 * included, so `/mode` cannot skip an owner rule.
 *   - deny: permissionDecision deny with the deciding rule's message.
 *   - approve: the hook holds the call on an approval card (decided by the
 *     requester or an approver) and returns allow or deny itself. A timeout,
 *     an abort, a wake or background pass (nobody to ask) and any error are a
 *     deny. The hook owns an inner deadline strictly shorter than its
 *     matcher's timeout and the node's turn deadline. Spike:
 *     docs/superpowers/specs/2026-11-08-owner-guardrails-a2-spike.md.
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
import { combine, hitMessage, toolHits, type RuleHit } from "./match";
import { firingEvents, type FiringEvent } from "./audit";
import { guidanceText, toolTriggered, type OnMatchGuidance, type SessionGuardrails } from "./resolve";

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
});
const allow = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, permissionDecisionReason: reason },
});

/** Default and ceiling of how long an owner tool card waits (the permission card's own TTL is the ceiling). */
export const APPROVE_TIMEOUT_DEFAULT_SEC = 600;
export const APPROVE_TIMEOUT_MAX_SEC = 3600;
/** The matcher timeout sits this far above the inner deadline. */
export const APPROVE_MATCHER_MARGIN_SEC = 60;
/** On a node the card ends this long before the turn's own deadline. */
export const TURN_DEADLINE_MARGIN_MS = 30_000;
/** Less time than this left: no card is opened, the call is refused. */
export const MIN_APPROVE_MS = 5_000;

/** The PreToolUse matcher timeout (seconds) for a given approve cap: strictly above the inner deadline. */
export function approveMatcherTimeoutSec(capSec: number): number {
  return capSec + APPROVE_MATCHER_MARGIN_SEC;
}

/** What an owner approve asks the permission resolver for. */
export interface OwnerApproval {
  /** `<slug>#<rule id>`, the deciding rule. */
  ruleId: string;
  /** The rule's message, shown on the card. */
  message: string;
  /** Epoch ms: the card expires then; the caller has stopped waiting by then. */
  deadline: number;
}

export interface ApproveRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  approval: OwnerApproval;
  /** Aborts when the deadline passes or the turn is aborted. */
  signal: AbortSignal;
}

/** The card's outcome. `reason` names who decided or why nothing was decided. */
export type ApproveOutcome = { allow: true; reason: string } | { allow: false; reason: string };

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
  /**
   * Hold a call on an approval card. Absent (a background pass), or returning
   * a refusal (a wake), an approve rule is a deny.
   */
  approve?: (req: ApproveRequest) => Promise<ApproveOutcome>;
  /** How long a card may wait, in ms (default APPROVE_TIMEOUT_DEFAULT_SEC). */
  approveCapMs?: () => number;
  /** Epoch ms the session's turn must end by (a node's turn deadline), or null. */
  turnDeadline?: () => number | null;
  /** Clock (tests). */
  now?: () => number;
}

/** The refusal shown for an approve rule that was not approved. */
export function notApprovedMessage(hit: RuleHit, reason: string): string {
  const base = hit.oversize ? hitMessage(hit) : hit.rule.message.trim() || `The owner's guardrail ${hit.slug} needs an approver for this.`;
  return `${base} Not approved: ${reason}.`;
}

/**
 * Hold one call on a card, bounded by an inner deadline: the earlier of the
 * cap and the turn deadline less a margin. Whatever happens (the deadline, an
 * abort of the turn, a throw anywhere) the answer is a deny: a thrown hook
 * would fall through to allow (spike).
 */
async function holdOnCard(
  deps: OwnerGuardrailHookDeps,
  hit: RuleHit,
  call: { toolName: string; input: Record<string, unknown>; toolUseId: string },
  turnSignal: AbortSignal | undefined,
): Promise<ApproveOutcome> {
  if (!deps.approve) return { allow: false, reason: "nobody can be asked in this session" };
  const now = deps.now ?? Date.now;
  const start = now();
  const cap = deps.approveCapMs?.() ?? APPROVE_TIMEOUT_DEFAULT_SEC * 1000;
  const turn = deps.turnDeadline?.() ?? null;
  const deadline = Math.min(start + cap, turn === null ? Infinity : turn - TURN_DEADLINE_MARGIN_MS);
  if (deadline - start < MIN_APPROVE_MS) return { allow: false, reason: "not enough time left in this turn to ask" };
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<ApproveOutcome>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ allow: false, reason: "no decision in time" });
    }, deadline - start);
    const onAbort = () => {
      ac.abort();
      resolve({ allow: false, reason: "the turn was stopped" });
    };
    if (turnSignal?.aborted) onAbort();
    else turnSignal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const asked = deps
      .approve({ ...call, approval: { ruleId: `${hit.slug}#${hit.rule.id}`, message: hitMessage(hit), deadline }, signal: ac.signal })
      .then((o): ApproveOutcome => (o && o.allow === true ? { allow: true, reason: String(o.reason) } : { allow: false, reason: String(o?.reason ?? "refused") }))
      .catch((e: unknown): ApproveOutcome => ({ allow: false, reason: `the card failed (${e instanceof Error ? e.message : String(e)})` }));
    return await Promise.race([asked, stop]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
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
  return async (input, toolUseId, options) => {
    try {
      return await decideCall(deps, input, toolUseId, options?.signal);
    } catch (e) {
      // A thrown hook lets the tool run (spike): never let one escape.
      return deny(`The owner's guardrails could not check this call, so it is refused (${e instanceof Error ? e.message : String(e)}).`);
    }
  };
}

async function decideCall(deps: OwnerGuardrailHookDeps, input: Parameters<HookCallback>[0], toolUseId: string | undefined, signal: AbortSignal | undefined) {
  if (input.hook_event_name !== "PreToolUse") return {};
  const g = deps.guardrails();
  if (!g || (g.toolRules.length === 0 && g.onMatch.length === 0)) return {};
  const i = input as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
  const toolName = i.tool_name ?? "";
  const names = deps.toolNames?.(toolName) ?? [toolName];
  const decision = combine(toolHits(g.toolRules, names, i.tool_input));
  if (decision && decision.action === "deny") {
    deps.onFiring(firingEvents("tool", decision.hits, decision.deciding, toolName));
    return deny(hitMessage(decision.deciding));
  }
  // On-match Guidance before a card: the model reads it first, and an
  // approver is not asked about a call that is refused for delivery anyway.
  const seen = deps.delivered();
  const triggered = new Map<string, OnMatchGuidance>();
  for (const n of names) for (const o of toolTriggered(g, n, deps.channel())) triggered.set(o.slug, o);
  const due = [...triggered.values()].filter((o) => !seen.has(o.slug));
  if (due.length > 0) {
    if (decision && decision.action === "audit") deps.onFiring(firingEvents("tool", decision.hits, decision.deciding, toolName));
    for (const o of due) seen.add(o.slug);
    deps.onDelivered(due, toolName);
    const titles = due.map((o) => o.name).join(", ");
    return deny(`Read guardrail ${titles} first. This is not a refusal of the call: retry it after reading.\n\n${guidanceText(due)}`);
  }
  if (!decision) return {};
  if (decision.action !== "approve") {
    deps.onFiring(firingEvents("tool", decision.hits, decision.deciding, toolName));
    return {};
  }
  const toolInput = i.tool_input && typeof i.tool_input === "object" && !Array.isArray(i.tool_input) ? (i.tool_input as Record<string, unknown>) : {};
  const outcome = await holdOnCard(deps, decision.deciding, { toolName, input: toolInput, toolUseId: toolUseId ?? i.tool_use_id ?? "" }, signal);
  deps.onFiring(firingEvents("tool", decision.hits, decision.deciding, toolName, outcome.allow ? "approved" : "refused"));
  if (outcome.allow) return allow(`Approved under the owner's guardrail ${decision.deciding.slug}: ${outcome.reason}.`);
  return deny(notApprovedMessage(decision.deciding, outcome.reason));
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
