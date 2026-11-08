/**
 * The guardrail registry: every piece of the runtime's own layer that blocks,
 * rewrites or stops the agent, described in one typed list. It describes; it
 * builds nothing. agent/manager.ts and background/runner.ts keep wiring their
 * hooks as they always have and mark each callback with its id (hook-tags.ts);
 * tests/agent/guardrails-agreement.test.ts builds real session options and
 * checks that the hooks there are exactly the hook entries below, in order.
 *
 * Order matters for hook entries: within one event, the registry order is the
 * order the hooks are wired.
 *
 * A state is computed from injected runtime facts (GuardrailCtx), not only from
 * env and config: a guardrail whose code exists but is not installed in this
 * process reports "not-wired", never "enforcing". Details show env values only
 * as on/off, a mode or a cap, and anything a redaction pattern names only to a
 * superadmin.
 */
import type {
  GuardrailAppliesTo,
  GuardrailDetail,
  GuardrailEvent,
  GuardrailKind,
  GuardrailState,
  GuardrailToggle,
} from "../gateway/panel/api-types";
import { env } from "../config/env";
import { parseDecisionConfig } from "../decision/config";
import { listBuiltinSkills } from "../soul/builtin";
import { redactPatternsFor } from "../soul/per-persona";
import { SECRET_PATTERN_COUNT } from "../redact";
import { budgetConfigFor } from "../background/config";
import { autoAllowFromEnv, PERM_GATE_TTL_MS } from "../gateway/slack/permission-gate";
import { WAKE_ONLY_TOOL_IDS, WAKE_TOOL_ALLOWLIST } from "../proactive/wake-guard";
import { REMOTE_DENIED_LOCAL_TOOLS } from "../remote/mcp";
import { TOOLS_SURVIVING_EMPTY_SET } from "./child-env";
import { MEMORY_WRITE_TOOLS, PROACTIVE_RULE_TOOL } from "./profile-write-guard";
import { PASS_TOOL } from "./pass-stop-hook";
import { HOOK_IDS } from "./hook-tags";

/**
 * The CLI scheduling built-ins every manager session disallows (slaude runs
 * its own cron). Kept here, not imported from manager.ts, so the registry
 * loads without the agent loop; the agreement test asserts both lists match.
 */
export const SCHEDULER_TOOL_NAMES = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"] as const;

/** Facts about this process the registry cannot read from env or config. */
export interface GuardrailRuntime {
  /** The gateway installed a Stop guard (AgentManager.setStopGuard). Absent, the must-reply hook is a no-op. */
  stopGuard: boolean;
  /** A permission resolver is set (AgentManager.setPermissionResolver). Absent, no canUseTool is passed. */
  permissionResolver: boolean;
  /** Where interactive turns run: in this process (mono) or on nodes (gateway role). */
  turnsRunOn: "this-process" | "nodes";
}

/**
 * A node worker (src/node/worker.ts) installs a permission resolver
 * (makeNodePermissionResolver) and the must-reply Stop guard
 * (makeNodeStopGuard). In the gateway role, turns run there, so these are the
 * facts that hold for them.
 *
 * Keep in step with src/node/worker.ts: tests/panel/console-guardrails.test.ts
 * checks the worker's source for these two calls. A node that stops
 * installing either must flip it here (and that test).
 */
export const NODE_RUNTIME: GuardrailRuntime = { stopGuard: true, permissionResolver: true, turnsRunOn: "nodes" };

/** No runtime facts known: nothing is assumed wired. */
export const UNKNOWN_RUNTIME: GuardrailRuntime = { stopGuard: false, permissionResolver: false, turnsRunOn: "this-process" };

export interface GuardrailCtx extends GuardrailRuntime {
  /** The agent the page is about (`default` or a persona name). */
  agent: string;
}

export interface GuardrailViewer {
  role: "superadmin" | "operator";
}

export interface GuardrailDescriptor {
  id: string;
  kind: GuardrailKind;
  title: string;
  summary: string;
  event?: GuardrailEvent;
  effect: string;
  appliesTo: GuardrailAppliesTo[];
  state: (ctx: GuardrailCtx) => GuardrailState;
  toggle?: GuardrailToggle;
  details?: (ctx: GuardrailCtx, viewer: GuardrailViewer) => GuardrailDetail[];
  source: string;
  /** Designed only: no code exists, the state is always "not-built". */
  notBuilt?: true;
  fieldNote?: { title: string; href: string };
}

const MANAGER_SESSIONS: GuardrailAppliesTo[] = ["interactive", "wake", "remote", "voice"];
const ALWAYS: GuardrailToggle = { source: "none" };
const enforcing = (): GuardrailState => "enforcing";
const onOff = (v: boolean): string => (v ? "on" : "off");
const cap = (n: number, unit: string): string => (n > 0 ? `${n} ${unit}` : "off");
const DOCS = "https://barockok.github.io/slaude/field-notes";

/** Remote rows: who turns remote mode on, and where the page reads it from. */
const REMOTE_SCOPE: GuardrailDetail = {
  label: "Scope",
  value: "Applies to threads bound with /remote; read from the gateway's SLAUDE_REMOTE (nodes follow the signed claim)",
};

/** The decision gate's mode only (never the adapter, never a value). */
export function decisionMode(): "off" | "shadow" | "on" {
  return parseDecisionConfig(env.decisionConfigRaw()).config.gate.mode;
}

function governedTools(): string[] {
  return listBuiltinSkills().flatMap((s) => s.governs);
}

export const GUARDRAILS: readonly GuardrailDescriptor[] = [
  // --- Hooks, in wiring order per event (manager.ts #bootSession) ----------
  {
    id: HOOK_IDS.preCompact,
    kind: "observability",
    title: "Compaction notice",
    summary: "Tells the surface the CLI is compacting the context.",
    event: "PreCompact",
    effect: "Emits a `compacting` event; never blocks.",
    appliesTo: MANAGER_SESSIONS,
    state: enforcing,
    toggle: ALWAYS,
    source: "agent/manager.ts #bootSession (preCompact)",
  },
  {
    id: HOOK_IDS.stopMustReply,
    kind: "hook",
    title: "Must reply or pass",
    summary: "A turn that ends with nothing user-visible is sent back once.",
    event: "Stop",
    effect: "Blocks the first stop of a turn without a reply, an edit, an upload or a `pass`, with an instruction to do one. A second stop is let through and counted. Skipped during a voice call.",
    appliesTo: MANAGER_SESSIONS,
    state: (ctx) => (ctx.stopGuard ? "enforcing" : "not-wired"),
    toggle: ALWAYS,
    details: (ctx) => [
      {
        label: "Stop guard installed in",
        value: !ctx.stopGuard ? "nowhere (no guard set)" : ctx.turnsRunOn === "nodes" ? "each node worker (same rule and text as mono)" : "this process",
      },
      { label: "Not forced", value: "cron runs, promise checks, heartbeat turns and wakes (silent), and voice turns" },
    ],
    source: "agent/manager.ts #bootSession (stopHook); gateway/core/gateway.ts setStopGuard; node/stop-guard.ts; agent/must-reply.ts",
  },
  {
    id: HOOK_IDS.userPromptSuppress,
    kind: "hook",
    title: "Disengaged and mention-only suppression",
    summary: "A message in a disengaged or mention-only thread is recorded but not answered.",
    event: "UserPromptSubmit",
    effect: "Returns `continue: false` so the message lands in the transcript without running the model; otherwise drains queued session notes into the turn.",
    appliesTo: MANAGER_SESSIONS,
    state: enforcing,
    toggle: { source: "thread", key: "disengage, or set_mention_only", default: "engaged" },
    source: "agent/manager.ts makeUserPromptHook",
  },
  {
    id: HOOK_IDS.remoteDenyLocal,
    kind: "hook",
    title: "Remote mode local-tool deny",
    summary: "In a remote thread, tools that would touch this machine are refused.",
    event: "PreToolUse",
    effect: "Denies local-only built-ins with no remote counterpart; file and shell tools are aliased to the remote environment.",
    appliesTo: ["remote"],
    state: () => (env.remote.enabled() ? "enforcing" : "off"),
    toggle: { source: "env", key: "SLAUDE_REMOTE", default: "off" },
    details: () => [REMOTE_SCOPE, { label: "Denied tools", value: [...REMOTE_DENIED_LOCAL_TOOLS] }],
    source: "remote/mcp.ts denyLocalBuiltins",
  },
  {
    id: HOOK_IDS.skillGate,
    kind: "hook",
    title: "Built-in skill gate",
    summary: "A tool a built-in skill governs is refused until that skill is loaded.",
    event: "PreToolUse",
    effect: "Denies the tool with \"Load `slaude:<skill>` first\" until the session has loaded the skill with the Skill tool.",
    appliesTo: MANAGER_SESSIONS,
    state: () => (governedTools().length ? "enforcing" : "off"),
    toggle: ALWAYS,
    details: () => [{ label: "Governed tools", value: governedTools() }],
    source: "agent/skill-gate.ts SkillGate.pre",
  },
  {
    id: HOOK_IDS.profileWriteGuard,
    kind: "hook",
    title: "Profile write guard",
    summary: "A turn nobody started cannot write a person's profile or teach a rule.",
    event: "PreToolUse",
    effect: "On a synthetic turn (cron, heartbeat, wake, voice-injected), denies a memory write to target \"profile\" and `proactive_rule`.",
    appliesTo: MANAGER_SESSIONS,
    state: enforcing,
    toggle: ALWAYS,
    details: () => [{ label: "Guarded tools", value: [...MEMORY_WRITE_TOOLS].map((t) => `${t} (target profile)`).concat(PROACTIVE_RULE_TOOL) }],
    source: "agent/profile-write-guard.ts denySyntheticProfileWrite",
  },
  {
    id: HOOK_IDS.skillGateMark,
    kind: "hook",
    title: "Built-in skill gate (loaded mark)",
    summary: "Records that a built-in skill was loaded, which opens its governed tools.",
    event: "PostToolUse",
    effect: "After a successful Skill call for a built-in skill, marks it loaded for this session.",
    appliesTo: MANAGER_SESSIONS,
    state: () => (governedTools().length ? "enforcing" : "off"),
    toggle: ALWAYS,
    source: "agent/skill-gate.ts SkillGate.post",
  },
  {
    id: HOOK_IDS.skillUsage,
    kind: "observability",
    title: "Skill usage counter",
    summary: "Counts each successful Skill call for the Skills page.",
    event: "PostToolUse",
    effect: "Records the call, best effort; never blocks.",
    appliesTo: MANAGER_SESSIONS,
    state: enforcing,
    toggle: ALWAYS,
    source: "agent/skill-usage-hook.ts skillUsageHook",
  },
  {
    id: HOOK_IDS.passEndsTurn,
    kind: "hook",
    title: "Pass ends the turn",
    summary: "A successful `pass` is the end of the turn, whatever the model wants next.",
    event: "PostToolUse",
    effect: "Returns `continue: false` after a successful pass, stopping the agent loop.",
    appliesTo: MANAGER_SESSIONS,
    state: enforcing,
    toggle: ALWAYS,
    details: () => [{ label: "Tool", value: PASS_TOOL }],
    source: "agent/pass-stop-hook.ts passEndsTurnHook",
  },
  {
    id: HOOK_IDS.backgroundOnlyPassTools,
    kind: "hook",
    title: "Background pass tool lock",
    summary: "A background pass may call only its own pass tools.",
    event: "PreToolUse",
    effect: "Denies any tool outside the pass's own `slaude_pass` server.",
    appliesTo: ["background"],
    state: enforcing,
    toggle: ALWAYS,
    source: "background/runner.ts onlyPassTools",
  },
  // --- Designed, not built ---------------------------------------------------
  {
    id: "hook.stop.kb-first",
    kind: "hook",
    title: "KB-first Stop guard",
    summary: "Would block a stop that answered a domain question without reading memory first.",
    event: "Stop",
    effect: "Designed shadow-first; today the rule is prose in the baseline only.",
    appliesTo: MANAGER_SESSIONS,
    notBuilt: true,
    state: () => "not-built",
    source: "soul/runtime/core.md (prose only)",
    fieldNote: { title: "KB-first enforcement: from prose to teeth", href: `${DOCS}/2026-06-13-kb-first-enforcement.html` },
  },
  {
    id: "gate.policy.tier-2-3",
    kind: "gate",
    title: "Policy guardrails (Tier 2 and 3)",
    summary: "Would check every tool call and reply against a written policy.",
    event: "PreToolUse",
    effect: "Designed (a policy service, POLICY.md, a check on SDK hooks); no code implements it.",
    appliesTo: ["deployment"],
    notBuilt: true,
    state: () => "not-built",
    source: "none yet",
    fieldNote: { title: "Policy guardrails (Tier 2 / Tier 3 design)", href: `${DOCS}/2026-05-21-policy-guardrails.html` },
  },
  // --- canUseTool and dispatch gates -----------------------------------------
  {
    id: "gate.can-use-tool.permission",
    kind: "gate",
    title: "Permission gate",
    summary: "Decides each tool call: allowed, denied, or a permission card.",
    event: "canUseTool",
    effect: "Auto-allows slaude's own surface, runtime, session, memory and connect tools, skill introspection (`list_skills`, `read_skill`) and the env allow-list; always denies the synthesized MCP `authenticate` tools; everything else posts a card.",
    appliesTo: ["interactive", "remote", "voice"],
    state: (ctx) => (ctx.permissionResolver ? "enforcing" : "not-wired"),
    toggle: { source: "thread", key: "/mode", default: env.defaultPermissionMode() },
    details: (ctx) => [
      ctx.turnsRunOn === "nodes"
        ? { label: "Gateway env allow-list (SLAUDE_AUTO_ALLOW_TOOLS)", value: `${autoAllowFromEnv().size} tools; each node reads its own` }
        : { label: "Env allow-list (SLAUDE_AUTO_ALLOW_TOOLS)", value: `${autoAllowFromEnv().size} tools` },
      { label: "Default mode of a new thread", value: env.defaultPermissionMode() },
      { label: "A card waits for", value: `${PERM_GATE_TTL_MS / 60_000} minutes` },
    ],
    source: "gateway/slack/permission-gate.ts permissionPolicy",
  },
  {
    id: "gate.can-use-tool.wake-refusal",
    kind: "gate",
    title: "Wake refusal",
    summary: "Nobody is in a wake's turn to click a card, so anything off the wake allow-list is refused.",
    event: "canUseTool",
    effect: "Denies with a refusal naming proactive_post and post_message; the node tool plane refuses the same from the signed wake claim.",
    appliesTo: ["wake"],
    // Mono wraps the resolver; a node's resolver refuses first, before its
    // local permissionPolicy (src/node/shims/permission.ts).
    state: (ctx) => (ctx.permissionResolver ? "enforcing" : "not-wired"),
    toggle: ALWAYS,
    details: (ctx) =>
      ctx.turnsRunOn === "nodes"
        ? [
            {
              label: "On nodes",
              value: "Every permission request during a wake is refused on the node before its local policy (including its SLAUDE_AUTO_ALLOW_TOOLS) runs, from the signed wake claim; the gateway's can_use_tool route refuses the same.",
            },
          ]
        : [{ label: "In this process", value: "Every permission request during a wake is refused before any policy runs." }],
    source: "gateway/core/gateway.ts (resolver wrapper); gateway/api/tools/index.ts (wake claim); node/shims/permission.ts (node resolver)",
  },
  {
    id: "gate.can-use-tool.remote",
    kind: "gate",
    title: "Remote tool permissions",
    summary: "Remote reads run without asking; remote shell and edits ask as their local tool.",
    event: "canUseTool",
    effect: "Maps a remote tool to the built-in it stands for, so a card and the thread's mode treat it the same.",
    appliesTo: ["remote"],
    state: () => (env.remote.enabled() ? "enforcing" : "off"),
    toggle: { source: "env", key: "SLAUDE_REMOTE", default: "off" },
    details: () => [REMOTE_SCOPE],
    source: "remote/mcp.ts makeRemoteCanUseTool",
  },
  {
    id: "gate.dispatch.decision",
    kind: "gate",
    title: "Decision gate",
    summary: "A bounded pre-turn check whether a message deserves a turn at all.",
    event: "dispatch",
    effect: "On: a message scored below the threshold gets no turn. Shadow: scored and logged only.",
    appliesTo: ["interactive"],
    state: () => {
      const m = decisionMode();
      return m === "on" ? "enforcing" : m === "shadow" ? "shadow" : "off";
    },
    toggle: { source: "env", key: "SLAUDE_DECISION_CONFIG", default: "off" },
    details: () => {
      const { config, error } = parseDecisionConfig(env.decisionConfigRaw());
      return [{ label: "Mode", value: config.gate.mode }, ...(error ? [{ label: "Config problem", value: error }] : [])];
    },
    source: "decision/config.ts parseDecisionConfig",
  },
  {
    id: "gate.soul-override.manager-only",
    kind: "gate",
    title: "soul_override is manager-only",
    summary: "Runtime ACL overrides need a turn the manager started.",
    effect: "Refuses soul_override unless the current turn came from the manager's own message.",
    appliesTo: ["deployment"],
    state: enforcing,
    toggle: ALWAYS,
    source: "gateway/core/surface-mcp.ts soul_override",
  },
  {
    id: "gate.outbound.ssrf",
    kind: "gate",
    title: "Outbound fetch policy",
    summary: "Credentialed fetches (MCP OAuth) never reach private, loopback or metadata addresses.",
    effect: "https only; every resolved address checked; pinned connection; redirects not followed; timeout and size cap.",
    appliesTo: ["deployment"],
    state: enforcing,
    toggle: ALWAYS,
    details: () => [
      { label: "Allowed hosts list", value: onOff(!!process.env.SLAUDE_OUTBOUND_ALLOWED_HOSTS?.trim()) },
      { label: "Internal hosts list", value: onOff(!!process.env.SLAUDE_OUTBOUND_INTERNAL_HOSTS?.trim()) },
      { label: "Dev loopback", value: onOff(process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK === "1") },
    ],
    source: "net/outbound-policy.ts safeFetch",
  },
  // --- Deny lists -------------------------------------------------------------
  {
    id: "deny.scheduler-tools",
    kind: "deny-list",
    title: "CLI scheduler tools",
    summary: "The CLI's own scheduling tools are removed; slaude's cron tools replace them.",
    effect: "Listed in every session's `disallowedTools`.",
    appliesTo: MANAGER_SESSIONS,
    state: enforcing,
    toggle: ALWAYS,
    details: () => [{ label: "Removed", value: [...SCHEDULER_TOOL_NAMES] }],
    source: "agent/manager.ts SCHEDULER_TOOLS",
  },
  {
    id: "deny.wake-allow-list",
    kind: "deny-list",
    title: "Wake tool allow-list",
    summary: "What a wake may call; anything else is hidden and refused.",
    effect: "A wake's `disallowedTools` hides every contract tool not listed; other sessions do not see the wake-only tools.",
    appliesTo: ["wake"],
    state: enforcing,
    toggle: ALWAYS,
    details: () => [
      ...Object.entries(WAKE_TOOL_ALLOWLIST).map(([server, tools]) => ({ label: server, value: tools === "all" ? "every tool" : tools.length ? [...tools] : "none" })),
      { label: "Hidden outside a wake", value: [...WAKE_ONLY_TOOL_IDS] },
    ],
    source: "proactive/wake-guard.ts",
  },
  {
    id: "deny.remote-local-tools",
    kind: "deny-list",
    title: "Remote mode deny list",
    summary: "Local-only built-ins a remote thread loses.",
    effect: "Listed in a remote session's `disallowedTools`, and denied by the PreToolUse hook.",
    appliesTo: ["remote"],
    state: () => (env.remote.enabled() ? "enforcing" : "off"),
    toggle: { source: "env", key: "SLAUDE_REMOTE", default: "off" },
    details: () => [REMOTE_SCOPE, { label: "Removed", value: [...REMOTE_DENIED_LOCAL_TOOLS] }],
    source: "remote/mcp.ts REMOTE_DENIED_LOCAL_TOOLS",
  },
  {
    id: "deny.background-lockdown",
    kind: "deny-list",
    title: "Background pass lockdown",
    summary: "A background pass runs with no built-in tools, no settings and only its own MCP server.",
    effect: "`tools: []`, the surviving built-ins disallowed by name, `dontAsk`, strict MCP config, no setting sources, no persisted session.",
    appliesTo: ["background"],
    state: enforcing,
    toggle: ALWAYS,
    details: () => [{ label: "Disallowed by name", value: [...TOOLS_SURVIVING_EMPTY_SET] }],
    source: "background/runner.ts passQueryOptions",
  },
  {
    id: "deny.builtin-skill-write",
    kind: "deny-list",
    title: "Built-in skills are read-only",
    summary: "A built-in `slaude:` skill cannot be written, deleted or installed over.",
    effect: "write_skill and the installer refuse a built-in skill's name.",
    appliesTo: ["deployment"],
    state: enforcing,
    toggle: ALWAYS,
    source: "skills/mcp-tools.ts; soul/builtin builtinSkillRefusal",
  },
  {
    id: "deny.child-env",
    kind: "deny-list",
    title: "Child environment scrub",
    summary: "The CLI child never inherits gateway secrets, and its telemetry is off.",
    effect: "Strips gateway-only variables, node and queue credentials and embedding keys; sets the telemetry, autoupdater and error-reporting kill flags.",
    appliesTo: [...MANAGER_SESSIONS, "background"],
    state: enforcing,
    toggle: ALWAYS,
    source: "agent/child-env.ts scrubChildEnv",
  },
  // --- Limits ------------------------------------------------------------------
  {
    id: "limit.background-budget",
    kind: "limit",
    title: "Background and proactive budget",
    summary: "What the agent may spend per day on work nobody asked for.",
    effect: "A pass, a skill check or a proactive turn that would exceed the day's pool does not start.",
    appliesTo: ["background", "wake"],
    state: enforcing,
    toggle: { source: "env", key: "SLAUDE_BACKGROUND_BUDGET_USD" },
    details: (ctx) => {
      const cfg = budgetConfigFor(ctx.agent);
      return [
        { label: "Background per day", value: `${cfg.limitUsd} USD` },
        { label: "Proactive per day", value: cfg.proactiveLimitUsd != null ? `${cfg.proactiveLimitUsd} USD` : "shared with background" },
      ];
    },
    source: "background/config.ts budgetConfigFor",
  },
  {
    id: "limit.wake-caps",
    kind: "limit",
    title: "Wake caps",
    summary: "How far one wake may go.",
    effect: "Passed to the wake's query as maxBudgetUsd and maxTurns; the wall clock closes the run.",
    appliesTo: ["wake"],
    state: enforcing,
    toggle: { source: "env", key: "SLAUDE_WAKE_MAX_USD, SLAUDE_WAKE_MAX_TURNS, SLAUDE_WAKE_MAX_MINUTES" },
    details: (ctx) => [
      { label: "Spend", value: cap(env.wakeMaxUsd(), "USD") },
      { label: "Turns", value: cap(env.wakeMaxTurns(), "turns") },
      {
        label: "Wall clock",
        value: `${cap(env.wakeMaxMinutes(), "minutes")}${ctx.turnsRunOn === "nodes" ? " (nodes clamp to their turn timeout)" : ""}`,
      },
    ],
    source: "agent/manager.ts #bootSession (wake options)",
  },
  // --- Redaction -------------------------------------------------------------
  {
    id: "redact.secrets",
    kind: "redaction",
    title: "Secret masking",
    summary: "Keys, tokens, bearer headers and JWTs are masked wherever the runtime shows text.",
    effect: "Masked in the status line, approval cards, logs, the audit trail and console views.",
    appliesTo: ["deployment"],
    state: enforcing,
    toggle: ALWAYS,
    details: () => [{ label: "Secret shapes", value: SECRET_PATTERN_COUNT }],
    source: "redact/index.ts redactSecrets; gateway/core/status-text.ts",
  },
  {
    id: "redact.soul-patterns",
    kind: "redaction",
    title: "Soul redaction patterns",
    summary: "Text the soul says must never leave in a reply.",
    effect: "Matches are replaced with [REDACTED] in what the agent posts; an agent's own patterns add to the default agent's.",
    appliesTo: ["interactive", "wake", "remote", "voice"],
    state: (ctx) => (redactPatternsFor(ctx.agent).length ? "enforcing" : "off"),
    toggle: { source: "config", key: "SOUL.md redact patterns" },
    // A pattern can name what it hides: values for superadmins, a count for operators.
    details: (ctx, viewer) => {
      const patterns = redactPatternsFor(ctx.agent);
      return [{ label: "Patterns", value: viewer.role === "superadmin" ? patterns : `${patterns.length} ${patterns.length === 1 ? "pattern" : "patterns"}` }];
    },
    source: "gateway/slack/redact.ts; soul/per-persona.ts redactPatternsFor",
  },
];

/** Registry entries that are SDK hooks wired today (the agreement test's subject). */
export function wiredHookEntries(): GuardrailDescriptor[] {
  return GUARDRAILS.filter((g) => (g.kind === "hook" || g.kind === "observability") && !g.notBuilt && g.event && g.event !== "canUseTool" && g.event !== "dispatch");
}
