import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  type SDKMessage,
  type Options,
  type CanUseTool,
  type Query,
  type McpServerConfig,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
// Namespace import (not a named `query`) so tests can swap the SDK via
// mock.module: the call site dereferences `agentSdk.query` fresh each boot,
// so the mock applies even when an earlier module already imported the SDK —
// no query-string re-import (which would split coverage off the canonical file).
import * as agentSdk from "@anthropic-ai/claude-agent-sdk";
import { TokenBudget, type PromptUsage, type ResultUsage, type UsageSnapshot } from "./token-budget";
import { SkillGate } from "./skill-gate";
import { denySyntheticProfileWrite } from "./profile-write-guard";
import { m as metric } from "../metrics";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";
import { paths } from "../config/home";
import { dbDialect } from "../db/client";
import { env } from "../config/env";
import { loadInstalledPluginPaths, loadInstalledPluginMcps } from "../config/plugins";
import { soulSystemBlock } from "../soul/loader";
import { BUILTIN_PLUGIN_DIR, cliPluginName, pluginsNamedLikeBuiltin } from "../soul/builtin";
import { personaSoulText } from "../persona/soul-source";
import { effectiveMandateIn, personaMandateText } from "../soul/persona-mandates";
import { compiledPromptSoul } from "../soul/per-persona";
import { allowedSkillNames, sdkSkillsOption } from "./skill-allow";
import { resolveSoulMandate } from "../soul/mandate-scope";
import { SoulDataSchema } from "../soul/data";
import { getPersonaRegistry, livePersona, managedPersonaDefinition, managedPersonaModel, onPersonaRegistryInstalled, type PersonaRegistry } from "../persona/registry";
import * as Sessions from "../db/sessions";
import type { ThreadKey } from "../db/sessions";
import { dbSessionStore, type SessionStore } from "./session-store";
import * as OneOnOne from "../db/one-on-one";
import type { OneOnOneLockRow } from "../db/one-on-one";
import { memory } from "../memory";
import { stripTurnMemoryContext, type MemoryProvider } from "../memory/provider";
import { ChildEnvPatch, scrubChildEnv, withoutKeys } from "./child-env";
import { resolveSessionConfigDir } from "./oauth-home";
import { sessionIdOpts } from "./session-id-opts";
import { sessionModeBlock, type RemoteModeInfo } from "./session-mode";
import { formatSessionNotes } from "./session-notes";
import { BootFailure, type FailureCode } from "../gateway/core/failure-codes";
import { redactSecrets } from "../gateway/core/status-text";
import { WAKE_ONLY_TOOL_IDS, wakeDeniedToolIds } from "../proactive/wake-guard";
import type { WakeStats } from "../proactive/wake-settle";
import { REMOTE_DENIED_LOCAL_TOOLS, REMOTE_MCP_NAME, REMOTE_TOOL_ALIASES, createRemoteMcp, denyLocalBuiltins, makeRemoteCanUseTool } from "../remote/mcp";
import { injectedTurns, voiceCallActive } from "../voice/turn-flags";
import { RemoteError, type RemoteHandle, type RemoteTarget } from "../remote/types";
import { turnModelTokens, type SkillCheckBudget } from "../background/skill-check";
import { skillUsageHook, type SkillUsageRecorder } from "./skill-usage-hook";
import { passEndsTurnHook } from "./pass-stop-hook";
import { HOOK_IDS, tagHook } from "./hook-tags";
import { aliasNames, approveMatcherTimeoutSec, deliveryTurnAllowance, guardrailFilesHook, ownerGuardrailsHook, type ApproveOutcome, type ApproveRequest, type OwnerApproval } from "../guardrails/hooks";
import { guidanceText, type SessionGuardrails } from "../guardrails/resolve";
import type { FiringEvent } from "../guardrails/audit";
import { GUARDRAILS_DIR } from "../guardrails/integrity";
import { isProactiveWorkspace, WorkspaceClaims } from "./workspace-claim";
import { addTokens, PROVISIONAL_OUTPUT_TOKENS, tokensFromUsage, type ModelTokens, type ModelUsageRow, type TokenCounts } from "../background/prices";

/** Upper bound on waiting for a previous remote handle's job cleanup at boot. */
const REMOTE_DISPOSE_TIMEOUT_MS = 8_000;

/**
 * CLI scheduling built-ins, removed from every session. slaude schedules through
 * its own Slack-aware cron tools (`add_cron_job` …); the CLI's versions live in
 * the child process, which exits at idle, so a job made there silently never
 * runs. The core prompt said these were blocked; nothing enforced it, and a live
 * run saw the model call `ScheduleWakeup` for a promise.
 */
export const SCHEDULER_TOOLS = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"] as const;

/** Who sent one delivered input (the gateway's view of the message). */
export interface InputSender {
  userId: string;
  teamId: string | null;
  origin: string | null;
  /** The message's own text as its sender typed it (never the envelope). See turnTexts. */
  text?: string;
}

type LiveSession = {
  id: string;
  /** Queue one input. `synthetic` marks a prompt the runtime itself sends
   *  (auto-evolve check, continuation and reload prompts), not a delivered one. */
  pushUser: (text: string, synthetic?: boolean, sender?: InputSender | null) => void;
  /** One flag per outstanding input, oldest first: whether it is synthetic.
   *  Inputs run in order and each ends with one `result`, so the head is the
   *  turn running now (see isSyntheticTurn). */
  inputSynthetic: boolean[];
  /** One entry per outstanding input, aligned with inputSynthetic: who sent
   *  it (sendMessage's `sender`), null for a synthetic input or one sent
   *  without a sender. See turnSenders. */
  inputSenders: (InputSender | null)[];
  closeIterable: () => void;
  abort: AbortController;
  /** Buffer of last user message + accumulated assistant text for memory.syncTurn. */
  turn: { user: string; assistant: string[] };
  /** Tool names invoked during the current turn (cleared on result). */
  turnTools: string[];
  /** Tool name per open tool_use id, so a tool result (which carries only the
   *  id) can name its tool. Entries leave when their result arrives. */
  toolNames: Map<string, string>;
  /** Text of reply tool calls awaiting their result, by tool_use id: it joins
   *  the turn record only once the result says it was delivered. */
  pendingReplies: Map<string, string>;
  /** Set after we inject an auto-evolve synthetic prompt — the next result
   *  is the evolution turn itself; don't recurse into another auto-evolve. */
  inAutoEvolve: boolean;
  /** Set while a check turn is in flight, settled by its result. The CLI folds an
   *  input that arrives during a running turn into that turn, so one result would
   *  answer both, flagged as the check's, and the input's own turn would never
   *  end. Inputs wait on this, or on the session's exit, before going in. */
  checkEnded?: { promise: Promise<void>; resolve: () => void };
  /** The budgeted skill-check run of the check turn in flight (set with
   *  inAutoEvolve when a budget is installed), ended exactly once: by the
   *  turn's result, or by the session's teardown when no result came. */
  evolveRun?: EvolveRun;
  /** Budgeted background turns delivered through sendMessage (a promise
   *  check), by the inputSeq of the input they rode on: that input's result
   *  finishes the run with its own usage. A run whose input never reaches a
   *  result (abort, reboot) is left open for the stale-run sweep. */
  bgRuns?: Map<number, BackgroundTurnRun>;
  /** The last result's `modelUsage` (a running total per CLI process): the
   *  base the check turn's own usage is measured from. */
  lastModelUsage?: Record<string, ModelUsageRow>;
  /** The model the CLI named on the last assistant message of a user turn:
   *  the skill check's fallback model when none is configured or priced. */
  lastAssistantModel?: string;
  /** Set after the SDK query() resolves; lets us call setPermissionMode/setModel live. */
  query?: Query;
  /** Idle TTL timer; cleared/rearmed on every user msg and turn-end. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Set when reload_session is called so expected exit errors are suppressed. */
  reloading?: boolean;
  /** Set when the idle timer closed the input: the instance is on its way out
   *  (still in #live until its loop unwinds), so a send treats it like a
   *  reloading one and boots fresh after it exits. */
  closing?: boolean;
  /** Inputs pushed so far (never decreases): a check whose budgeted start
   *  resolves after another input was pushed is stale and is not run. */
  inputSeq: number;
  /** Inputs pushed whose `result` has not arrived yet. Inputs overlap (an
   *  auto-evolve prompt and the next user message can both be outstanding), so
   *  this is a count: a turn is in flight while it is above zero. */
  pendingInputs: number;
  /** Resolves once the session's query loop has fully exited and the session
   *  has left #live. sendMessage awaits it for a session that is reloading. */
  exited: Promise<void>;
  /** Slack channel of the session row, cached at start for metric labels. */
  channelId?: string | null;
  /** The session row's working dir, cached at start (set once at creation, never changed). */
  workingDir?: string;
  /** Current permission mode (kept in sync by setPermissionMode) — remote tool gating reads it. */
  mode?: PermissionMode;
  /** The named persona this session booted as (undefined = default). */
  personaName?: string;
  /** Session-config fingerprint this session booted under (undefined = none known). */
  bootFp?: string;
  /** This query was booted for a wake: its caps and hidden tools are fixed
   *  for its life, so a person's message restarts the session (see
   *  #settleBootKind) and no skill check follows any of its turns. */
  bootedAsWake: boolean;
  /** Settled at each result. Made by #turnEnded for a waiter, which re-reads the count. */
  turnEnded?: { promise: Promise<void>; resolve: () => void };
  /** When the last result arrived (undefined: none yet). */
  lastResultAt?: number;
  /** Something of a further turn was seen since that result (its prompt hook,
   *  an assistant message, a tool result), so what is counted is really running. */
  activeSinceResult?: boolean;
};

// `autoEvolve` marks events of the internal skill-evolution turn that follows a
// user-visible turn: the gateway shows no status or reaction for them (#131).
export type AgentEvent =
  | { type: "assistantText"; sessionId: string; text: string; autoEvolve?: boolean }
  // `toolUseId` (the SDK's tool_use block id) pairs a result with its call.
  // A result's `tool` is the call's name when the id was seen, "" otherwise.
  | { type: "toolCall"; sessionId: string; tool: string; input: unknown; toolUseId?: string; autoEvolve?: boolean }
  | { type: "toolResult"; sessionId: string; tool: string; result: unknown; toolUseId?: string; autoEvolve?: boolean }
  | { type: "thinking"; sessionId: string; text: string; autoEvolve?: boolean }
  | { type: "turnStart"; sessionId: string }
  | { type: "done"; sessionId: string; autoEvolve?: boolean }
  // `error` is the RAW detail for logs only; Slack gets the fixed text for `code`
  // (gateway/core/failure-codes.ts). `jobId` lets the gateway post once per job.
  | { type: "error"; sessionId: string; error: string; code?: FailureCode; jobId?: string }
  | { type: "tokenUsage"; sessionId: string; snapshot: UsageSnapshot }
  | { type: "compacting"; sessionId: string; trigger: "manual" | "auto" };

/**
 * A ledger run a delivered input carries (sendMessage's `backgroundRun`):
 * opened by the caller before the turn, finished here with that input's own
 * usage when its result arrives.
 */
export interface BackgroundTurnRun {
  runId: string;
  finish(usage: ModelTokens, outcome: "ok" | "error" | "stopped-budget", stats?: WakeStats): Promise<void>;
}

/** A heartbeat wake's caps (src/proactive/wake.ts). Absent or 0: off. */
export type WakeOptions = { maxBudgetUsd?: number; maxTurns?: number; maxMinutes?: number };

/** A wake refused because a voice call owns its session: a restart would end
 *  the call. The session is busy, nothing went wrong: the wake's ledger run is
 *  already closed and a later slot may retry. */
export class WakeBusyError extends Error {
  override readonly name = "WakeBusyError";
  readonly code = "WAKE_BUSY";
  constructor(sessionId: string) {
    super(`wake refused: a voice call owns session ${sessionId}`);
  }
}

/** One input awaiting its UserPromptSubmit (AgentManager.#inputSuppression). */
type SuppressionEntry = { text: string; suppressed: boolean };

/** A session marked as a wake (see #armWake). `inFlight` is the wake's own
 *  turn: never read from `timer`, since a wake with no wall clock has none.
 *  `done` resolves when that turn ends, however it ends. */
type WakeState = {
  options: WakeOptions;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  done: Promise<void>;
  markDone: () => void;
};

/** An open skill-check run (see LiveSession.evolveRun). */
type EvolveRun = {
  budget: SkillCheckBudget;
  runId: string;
  /** modelUsage at the qualifying turn's result. */
  base: Record<string, ModelUsageRow> | undefined;
  /** Usage of the check turn's assistant messages so far, per message id
   *  (output raised to PROVISIONAL_OUTPUT_TOKENS), for a turn that never
   *  reaches its result. */
  seen: Map<string, { model: string; tokens: TokenCounts }>;
};

/** Permission resolver — called per tool use; given a sessionId so transports can present UI in the right thread. */
/** Per-session child-env overlay: a plain record adds variables; a
 *  ChildEnvPatch also removes them (WS-A §5.4). */
export type ChildEnvOverlay = Record<string, string | undefined> | ChildEnvPatch | undefined;
export type ChildEnvResolver = (sessionId: string) => Promise<ChildEnvOverlay> | ChildEnvOverlay;

export type PermissionResolver = (
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  ctx: PermissionContext,
) => ReturnType<CanUseTool>;

/** The SDK's canUseTool context, plus the owner-approval marker the owner
 *  guardrails hook sets: the card is forced (no auto-allow policy), carries
 *  the rule, offers no "always allow" and expires at the deadline. */
export type PermissionContext = Parameters<CanUseTool>[2] & { ownerApproval?: OwnerApproval };

/** Returns transport-supplied MCP servers for a fresh session. */
export type McpResolver = (
  sessionId: string,
) => Record<string, McpServerConfig> | undefined | Promise<Record<string, McpServerConfig> | undefined>;

/** Reply tools whose `text` the user reads in the thread (deprecated alias included). */
const REPLY_TOOLS = new Set(["mcp__slaude_surface__reply", "mcp__slaude_slack__reply"]);

/** The text of a reply tool call, or null for any other tool. */
export function replyToolText(tool: string, input: unknown): string | null {
  if (!REPLY_TOOLS.has(tool)) return null;
  const text = (input as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

/** Add a line to the turn's answer unless the same text is already there (a
 *  model that writes its reply as text AND sends it through the reply tool). */
export function recordAnswer(answer: string[], text: string): void {
  const t = text.trim();
  if (!t || answer.some((a) => a.trim() === t)) return;
  answer.push(text);
}

/** The text of a tool result (string, MCP content blocks, or `{content}`). */
function toolResultText(r: unknown): string {
  if (typeof r === "string") return r;
  const blocks = Array.isArray(r) ? r : (r as { content?: unknown } | null)?.content;
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (typeof b === "string" ? b : typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).join("\n");
}

/**
 * Whether a reply tool's result says the text reached someone: not an error
 * (on the tool_result block or the result), not a refusal, not a failure.
 * `posted ref=panel-suppressed` counts: the operator holding the session got it.
 */
export function replyDelivered(message: unknown, result: unknown): boolean {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(content) && content.some((b) => (b as { type?: unknown; is_error?: unknown })?.type === "tool_result" && (b as { is_error?: unknown }).is_error === true)) return false;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const o = result as { is_error?: unknown; isError?: unknown };
    if (o.is_error === true || o.isError === true) return false;
  }
  const text = toolResultText(result);
  if (/"refused"\s*:\s*true/.test(text)) return false;
  if (/^\s*(refused|error|reply failed)\b/i.test(text)) return false;
  return true;
}

/** The tool_use id a tool-result user message answers: the first
 *  `tool_result` block's `tool_use_id` (the SDK sends one result per message). */
export function toolResultId(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result") {
      const id = (b as { tool_use_id?: unknown }).tool_use_id;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

/** Plugin paths already reported by warnPluginsNamedLikeBuiltin (once per process). */
const warnedSlaudeNamedPlugins = new Set<string>();

/** Warn when a mounted plugin other than the built-in one would also get the
 *  CLI plugin name "slaude" (e.g. SLAUDE_HOME=/opt/slaude: the home plugin has
 *  no manifest, so the CLI names it after its basename). The CLI does not
 *  de-duplicate plugins by name and resolves a skill to the first match, so
 *  that plugin's skills share the `slaude:` namespace, and a pre-existing one
 *  named like a built-in would answer the Skill call for it and satisfy the
 *  skill gate. Not renamed here: a manifest name on the home plugin would
 *  change every agent skill's invoked name. */
function warnPluginsNamedLikeBuiltin(dirs: string[]): void {
  for (const dir of pluginsNamedLikeBuiltin(dirs)) {
    if (warnedSlaudeNamedPlugins.has(dir)) continue;
    warnedSlaudeNamedPlugins.add(dir);
    console.warn(
      `[mgr] WARNING: plugin at ${dir} resolves to the CLI plugin name "slaude", the built-in plugin's name. ` +
        `Its skills appear as slaude:<name>, and one named like a built-in skill would load in place of the built-in ` +
        `and satisfy the skill gate. Rename the directory (for SLAUDE_HOME, choose a path whose last component is not "slaude") ` +
        `or give that plugin a .claude-plugin/plugin.json with another name.`,
    );
  }
}

/** A node's manifest servers with the transport resolver's laid over them: a
 *  gateway-resolved server wins a name collision, with a warning naming it. */
function mergeLocalMcp(
  sessionId: string,
  local: Record<string, McpServerConfig>,
  resolved: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  for (const name of Object.keys(resolved ?? {})) {
    if (Object.hasOwn(local, name)) {
      console.warn(`[node] session=${sessionId} MCP server '${name}' is in the node manifest and also resolved by the gateway; the gateway's wins`);
    }
  }
  return { ...local, ...(resolved ?? {}) };
}

/** Stop-hook guard. Return an instruction string to block the agent from
 *  stopping (SDK feeds reason back, agent continues). Return null to allow stop.
 *  Guard fires at most once per turn — if it returns non-null twice, second
 *  call is ignored (agent stops) and manager logs to stderr. */
export type StopGuard = (sessionId: string) => string | null;

/** A persona's soul as the node receives it in the runtime bundle: the text for
 *  the <persona> block and its structured projection (SoulData-shaped, or null
 *  when the gateway has none). */
export type PersonaSoul = {
  soulMd: string;
  soulJson: unknown;
  /** Present for a persona from an agent.yaml: `soulMd` is prose plus the
   *  `## Channel` sections its `channels` key compiles to, and `soulJson` is
   *  compiled. `skills` limits the skills a session may load. */
  definition?: { skills?: string[]; guardrails?: string[] };
};
export type PersonaSoulResolver = (sessionId: string, persona: string | undefined) => Promise<PersonaSoul>;
/** The owner guardrails a booting session carries (src/guardrails/resolve.ts),
 *  or null when none apply. A throw fails the boot with GUARDRAILS_UNAVAILABLE:
 *  a session never runs with an empty set because the set could not be read. */
export type GuardrailResolver = (sessionId: string, persona: string | undefined, channelId: string | null) => Promise<SessionGuardrails | null>;
/** Where owner guardrail firings and Guidance deliveries are recorded (mono:
 *  the audit writer; a node: its gateway). Never awaited by a decision. */
export interface GuardrailSink {
  firing(sessionId: string, events: FiringEvent[], ctx: { persona: string; channelId: string | null; kind: string }): void;
  delivered(sessionId: string, slugs: string[], ctx: { persona: string; channelId: string | null; kind: string; via: "tool" | "inbound"; toolName?: string }): void;
}
/** A persona's default model as the node receives it in the runtime bundle, or
 *  undefined when the bundle is unmanaged (the row's model stands as is). */
export type PersonaModelResolver = (sessionId: string, persona: string | undefined) => Promise<string | undefined>;

/** Decide whether a UserPromptSubmit should be suppressed because its thread is
 *  disengaged. `continue:false` lets the user message persist to the transcript
 *  (session stays populated) but halts the turn before the model runs — so on
 *  re-engage the model resumes with the gap already in conversation history.
 *  `decision:"block"` is deliberately NOT used: it discards the prompt before it
 *  persists (verified against the pinned SDK — see the 2026-06-16 finding).
 *  Pure + exported for unit tests; the live hook reads the row via findById. */
export function disengagedHookDecision(
  row: { engaged: number } | null,
): { continue: boolean; suppressOutput?: boolean; stopReason?: string } {
  if (row && row.engaged === 0) {
    return {
      continue: false,
      suppressOutput: true,
      stopReason: "thread disengaged — message recorded, not processed",
    };
  }
  return { continue: true };
}

/** UserPromptSubmit hook that suppresses the model while the thread is
 *  disengaged. Engagement is re-read live (via findById) each turn, not closed
 *  over, so a re-@mention takes effect on the very next message. On suppression
 *  the metric is bumped. Exported (as a factory over sessionId) for unit tests;
 *  the suppression decision itself lives in disengagedHookDecision. */
export function makeDisengageSuppressHook(
  sessionId: string,
  findById: SessionStore["findById"] = Sessions.findById,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "UserPromptSubmit") return { continue: true };
    const decision = disengagedHookDecision(await findById(sessionId));
    if (decision.continue === false) metric.disengagedSuppressedTotal.inc();
    return decision;
  };
}

/** Combined UserPromptSubmit hook: suppress while disengaged or mention-only-suppressed
 *  (notes stay queued for the next engaged turn), otherwise drain any queued
 *  out-of-band gate events (mcp connect/disconnect, /model, /mode, /soul, /cron)
 *  into the turn's additionalContext — exactly once. Exported as a factory over
 *  (sessionId, notes store, suppressCheck) for unit tests; reads engagement live
 *  via findById each turn. suppressCheck is a consume-once fn that returns true
 *  when the current turn is a mention-only plain message that must not run the model. */
export function makeUserPromptHook(
  sessionId: string,
  notes: Map<string, string[]>,
  suppressCheck?: (prompt: string) => boolean,
  findById: SessionStore["findById"] = Sessions.findById,
  /** Inbound-triggered owner Guidance due this turn (drained once, like notes). */
  takeGuidance?: () => Array<{ name: string; body: string }>,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "UserPromptSubmit") return { continue: true };
    const dis = disengagedHookDecision(await findById(sessionId));
    if (dis.continue === false) {
      // Drain any suppress flag set for this same turn (e.g. the disengaging
      // message itself also passed suppress:true through handleMessage) — if
      // left unconsumed here it survives to the next turn and wrongly fires
      // "mention-only" on the message that re-engages the thread.
      suppressCheck?.(input.prompt);
      metric.disengagedSuppressedTotal.inc();
      return dis; // leave queued notes for the next engaged turn
    }
    if (suppressCheck?.(input.prompt)) {
      // mention-only thread: record the message in the transcript but don't run
      // the model. continue:false persists the prompt; decision:"block" would
      // discard it (see 2026-06-16 finding).
      return { continue: false, suppressOutput: true, stopReason: "mention-only — message recorded, not processed" };
    }
    const pending = notes.get(sessionId) ?? [];
    notes.set(sessionId, []);
    const guidance = takeGuidance?.() ?? [];
    const block = [formatSessionNotes(pending), guidance.length ? guidanceText(guidance) : null].filter(Boolean).join("\n");
    if (!block) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block },
    };
  };
}

/** Resume miss: the provider has no transcript for the seeded/resumed session id
 *  (e.g. a pre-resumable-sessions row whose claude_started flag predates the CLI
 *  ever sharing slaude's id). Expected + self-healing — #startSession clears the
 *  started flag and reboots seeding `--session-id`, so the user must NOT see it. */
const RESUME_MISS_RE = /No conversation found with session ID/i;

export class AgentManager extends EventEmitter {
  #live = new Map<string, LiveSession>();
  /** Close warm sessions of personas a managed registry install retired. Held
   *  through a WeakRef so a discarded manager is not kept alive by the
   *  registry's listener set; the listener removes itself once it is gone. */
  readonly #offRegistryInstalls: () => void = (() => {
    const ref = new WeakRef(this);
    const off = onPersonaRegistryInstalled((r) => {
      const self = ref.deref();
      if (!self) return off();
      self.#closeRetiredPersonaSessions(r);
    });
    return off;
  })();
  /** Session persistence. Defaults to the db repo; node workers inject the
   *  REST implementation (spec §6) via setSessionStore. */
  #store: SessionStore = dbSessionStore;
  /** Optional per-session child-env overlay (node runtime bundle creds). */
  #childEnvResolver:
    | ChildEnvResolver
    | undefined;
  #resolver: PermissionResolver | undefined;
  #turnDeadline: ((sessionId: string) => number | null) | undefined;
  /** Optional per-session CLAUDE_CONFIG_DIR override. Node workers install one
   *  to give every session a pod-local home seeded from the gateway; unset =
   *  today's resolution (persona home / per-initiator home / inherited). */
  #configDirResolver: ((sessionId: string, persona: string | undefined) => Promise<string>) | undefined;
  #personaSoulResolver: PersonaSoulResolver | undefined;
  #personaModelResolver: PersonaModelResolver | undefined;
  #guardrailResolver: GuardrailResolver | undefined;
  #guardrailSink: GuardrailSink | undefined;
  /** Per live session: the owner guardrails its boot resolved (fixed until the next boot). */
  #sessionGuardrails = new Map<string, SessionGuardrails>();
  /** Per session: the slugs whose on-match Guidance it has been given. Cleared on every boot. */
  #guidanceDelivered = new Map<string, Set<string>>();
  /** Inbound-triggered Guidance waiting for the session's next engaged turn (survives a reboot). */
  #guidanceQueue = new Map<string, Array<{ slug: string; name: string; body: string }>>();
  #mcpResolver: McpResolver | undefined;
  #localMcpResolver: McpResolver | undefined;
  /** Episodic memory. The process provider in mono and on the gateway; the
   *  node worker installs a REST client of the gateway's memory routes. */
  #memory: MemoryProvider = memory;
  #stopGuard: StopGuard | undefined;
  #backgroundBudget: SkillCheckBudget | undefined;
  #skillUsage: SkillUsageRecorder | undefined;
  #remoteResolver: ((sessionId: string) => Promise<RemoteTarget | null>) | undefined;
  #remoteFactory: ((sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> | RemoteHandle) | undefined;
  /** Per session: the open remote handle and the target it was opened for.
   *  Survives reboots (jobs keep running); disposed only when the target ends/changes. */
  #remoteHandles = new Map<string, { handle: RemoteHandle; key: string }>();
  /** Latest session-config fingerprint asked for per session (node: from job
   *  claims). A boot records it as its LiveSession.bootFp. */
  #desiredFp = new Map<string, string>();
  /** Sessions with a boot in progress (not yet live), counted per id. */
  #booting = new Map<string, number>();
  #remoteDisposeTimeoutMs = REMOTE_DISPOSE_TIMEOUT_MS;
  /** Sessions whose Stop hook already blocked once this turn — cleared on user msg. */
  #stopBlocked = new Set<string>();
  /** Out-of-band gate events (mcp connect/disconnect, model change) pending delivery
   *  to a session's transcript. Keyed by sessionId; survives reload (only #live is
   *  torn down on reboot). Drained once onto the next engaged user turn. */
  #sessionNotes = new Map<string, string[]>();
  /** Per-session OAuth-identity override for cron runs. A cron job created inside
   *  a /1on1 keys its run on a synthetic `cron:<id>` thread with no lock, so the
   *  thread-lock lookup in #startSession can't find the initiator. The scheduler
   *  sets this before sending so the child boots under the initiator's config dir.
   *  Takes precedence over the thread-lock lookup. Keyed by sessionId. */
  #cronOAuthUser = new Map<string, string>();
  /** Sessions with a stream_closed tool error this turn — trigger reload at turn end. */
  #pendingReload = new Set<string>();
  /** Count of consecutive stream_closed auto-reloads per session (circuit breaker). */
  #streamClosedCount = new Map<string, number>();
  /** Sessions that should inject a synthetic "continue" message after their reload. */
  #autoContinue = new Set<string>();
  /** Sessions whose reload is deferred until the turn in flight returns its
   *  result (see reloadAfterTurn). The single owner of that decision. */
  #reloadAfterTurn = new Set<string>();
  /** How long sendMessage waits for a reloading session to exit. */
  #reloadExitTimeoutMs = RELOAD_EXIT_TIMEOUT_MS;

  /** How long a query stays silent after a result before what it still counts is taken as folded. */
  #foldedQuietMs = FOLDED_INPUT_QUIET_MS;

  /** TEST SEAM: shrink the quiet period that bounds a wait on a folded input. */
  __setFoldedQuietForTests(ms: number) {
    this.#foldedQuietMs = ms;
  }

  /** TEST SEAM: shrink the bounded wait for a reloading session's exit. */
  __setReloadExitTimeoutForTests(ms: number) {
    this.#reloadExitTimeoutMs = ms;
  }
  /** Prompt to inject after a manual reload_session call (keyed by sessionId). */
  #reloadPrompt = new Map<string, string>();
  /** Sessions whose next turn must be suppressed (mention-only plain message).
   *  Consumed once by the UserPromptSubmit hook; set by suppressNextTurn(). */
  #suppressNextTurn = new Set<string>();
  /** Sessions whose idle TTL is suspended (an active voice call, spec §6). */
  #idleHeld = new Set<string>();
  /** Sessions that are heartbeat wakes (see #armWake). */
  #wakes = new Map<string, WakeState>();
  /** Per session, the last delivery waiting to change the session's kind
   *  (#sendInOrder): anything sent while one exists goes behind it. */
  #kindQueue = new Map<string, Promise<void>>();
  /** Per session, #send calls still running. A person's message that took the
   *  direct path has no mark and no live session yet while it reads the store
   *  or waits for the folder: a wake queues behind it, or that boot reads the
   *  wake's mark and boots as a wake. */
  #sendsInProgress = new Map<string, number>();
  /** Per session, the inputs pushed and not yet seen by UserPromptSubmit, with
   *  whether each was suppressed (#takeSuppressed matches them by text).
   *  Emptied when no input is outstanding. */
  #inputSuppression = new Map<string, SuppressionEntry[]>();
  #budget = new TokenBudget({
    fallbackContextWindow: env.tokenFallbackContextWindow(),
  });
  /** Built-in skills loaded per session; reset at every boot, dropped at teardown. */
  #skillGate = new SkillGate();
  /** The agent's proactive folder holds one turn at a time in this process. */
  #claims = new WorkspaceClaims();

  /** Current context-usage snapshot for a session, or null if no turn has completed. */
  getTokenSnapshot(sessionId: string): UsageSnapshot | null {
    return this.#budget.snapshot(sessionId);
  }

  /** Install a session persistence backend. Same setter pattern as the other
   *  transport seams; unset = the default db repo (zero behavior change). */
  setSessionStore(store: SessionStore | undefined) {
    this.#store = store ?? dbSessionStore;
  }

  /** Install a per-session child-env overlay (spec §6: node workers source
   *  provider credentials from the tenant runtime bundle, not process env).
   *  Resolved at session boot, merged OVER the process-env-derived provider
   *  vars; a ChildEnvPatch also deletes names; scrubChildEnv still applies
   *  afterwards. A throw fails the boot with a BootFailure (its own code, else
   *  PROVIDER_CREDENTIALS_UNAVAILABLE). Unset = no change. */
  setChildEnvResolver(resolver: ChildEnvResolver | undefined) {
    this.#childEnvResolver = resolver;
  }

  /** Install a per-session CLAUDE_CONFIG_DIR resolver, called at session boot
   *  with the session's persona name. It REPLACES the default resolution, and a
   *  failure fails the boot: falling back would run the session out of a
   *  config home that is not the one its credentials were seeded into. */
  setSessionConfigDirResolver(
    resolver: ((sessionId: string, persona: string | undefined) => Promise<string>) | undefined,
  ) {
    this.#configDirResolver = resolver;
  }

  /** Install a per-session persona soul resolver, called at session boot with
   *  the session's persona name (undefined = the default persona). It REPLACES
   *  the local soul source (personaSoulText) and the persona registry lookup,
   *  and a failure fails the boot: a node falling back to the shared volume when
   *  the gateway is unreachable would boot a deleted or tombstoned persona half
   *  configured, or as the default soul, instead of failing loudly. */
  setPersonaSoulResolver(resolver: PersonaSoulResolver | undefined) {
    this.#personaSoulResolver = resolver;
  }

  /** Install the owner guardrail resolver, called at session boot with the
   *  session's persona and channel (mono and gateway: the verified database
   *  snapshot; a node: its runtime bundle). Unset = no owner guardrails. */
  setGuardrailResolver(resolver: GuardrailResolver | undefined) {
    this.#guardrailResolver = resolver;
  }

  /** Install where guardrail firings are recorded. Unset = not recorded. */
  setGuardrailSink(sink: GuardrailSink | undefined) {
    this.#guardrailSink = sink;
  }

  /** The owner guardrails a live session booted with, or null. */
  guardrailsFor(sessionId: string): SessionGuardrails | null {
    return this.#sessionGuardrails.get(sessionId) ?? null;
  }

  /**
   * Inbound-triggered Guidance for a session's next turn (the gateway matched
   * the trigger; on a node it arrives with the job). Each guardrail is handed
   * over at most once per session boot: what the session already has is
   * dropped when the turn drains the queue.
   */
  offerGuidance(sessionId: string, items: ReadonlyArray<{ slug: string; name: string; body: string }>) {
    if (items.length === 0) return;
    const q = this.#guidanceQueue.get(sessionId) ?? [];
    for (const it of items) if (!q.some((x) => x.slug === it.slug)) q.push({ slug: it.slug, name: it.name, body: it.body });
    this.#guidanceQueue.set(sessionId, q);
  }

  /** A live session ended: its boot snapshot and delivery marks go with it. */
  #forgetGuardrails(sessionId: string) {
    this.#sessionGuardrails.delete(sessionId);
    this.#guidanceDelivered.delete(sessionId);
  }

  /** Drain the queued Guidance the session has not been given yet, marking it given. */
  #takeGuidance(sessionId: string): Array<{ slug: string; name: string; body: string }> {
    const q = this.#guidanceQueue.get(sessionId) ?? [];
    this.#guidanceQueue.delete(sessionId);
    const seen = this.#guidanceDelivered.get(sessionId) ?? new Set<string>();
    this.#guidanceDelivered.set(sessionId, seen);
    const due = q.filter((x) => !seen.has(x.slug));
    for (const x of due) seen.add(x.slug);
    return due;
  }

  /** Install a per-session persona model resolver (a node: the runtime
   *  bundle's default model). Consulted at boot only when the session row has
   *  no per-thread model. Unset = the persona registry (mono, gateway). */
  setPersonaModelResolver(resolver: PersonaModelResolver | undefined) {
    this.#personaModelResolver = resolver;
  }

  /**
   * The model a session runs with, in precedence order:
   *   1. a per-thread choice (`/model`, the panel) — the row's model;
   *   2. the persona's effective model on a managed tenant (git or override);
   *   3. SLAUDE_MODEL.
   * A managed tenant creates rows with an empty model ("follow the persona"),
   * so a later sync or override reaches the thread at its next boot. Rows
   * created before that, and every row on a filesystem tenant, carry
   * SLAUDE_MODEL from creation: unchanged.
   */
  async #sessionModel(sessionId: string, rowModel: string, personaName: string | undefined): Promise<string> {
    if (rowModel) return rowModel;
    const persona = this.#personaModelResolver
      ? await this.#personaModelResolver(sessionId, personaName)
      : this.#registryPersonaModel(personaName);
    return persona ?? "";
  }

  /** Mono/gateway: the managed persona's model, falling back to SLAUDE_MODEL;
   *  undefined on a filesystem registry. */
  #registryPersonaModel(personaName: string | undefined): string | undefined {
    const m = managedPersonaModel(personaName);
    return m === undefined ? undefined : (m ?? env.model());
  }

  /** The model a session row resolves to (for display), without a boot. Uses
   *  the persona registry, which on the gateway is the same effective state a
   *  node's bundle carries. */
  effectiveModelOf(row: { model: string; persona_id?: string | null }): string {
    if (row.model) return row.model;
    const named = row.persona_id && row.persona_id !== "default" ? row.persona_id : undefined;
    try {
      return this.#registryPersonaModel(named) ?? "";
    } catch {
      return "";
    }
  }

  /** Install a transport-level permission resolver (e.g. Slack approval gate). */
  setPermissionResolver(resolver: PermissionResolver | undefined) {
    this.#resolver = resolver;
  }

  /** The live session's abort signal (a stopped turn aborts it), or undefined when none is live. */
  sessionSignal(sessionId: string): AbortSignal | undefined {
    return this.#live.get(sessionId)?.abort.signal;
  }

  /** Node only: the epoch ms a session's current turn must end by (its hard
   *  turn deadline). An owner tool card ends before it. */
  setTurnDeadline(fn: ((sessionId: string) => number | null) | undefined) {
    this.#turnDeadline = fn;
  }

  /**
   * Hold one call on an owner approve rule's card through the permission
   * resolver (the gateway's wrapper in mono, the node's resolver on a node).
   * A wake has nobody to ask: refused before any card.
   */
  async #ownerApprove(sessionId: string, req: ApproveRequest): Promise<ApproveOutcome> {
    if (this.#wakes.has(sessionId)) return { allow: false, reason: "nobody is in this turn to approve it (you woke on your own)" };
    const resolver = this.#resolver;
    if (!resolver) return { allow: false, reason: "no approval card can be shown in this session" };
    const r = await resolver(sessionId, req.toolName, req.input, {
      signal: req.signal,
      suggestions: [],
      toolUseID: req.toolUseId,
      decisionReason: req.approval.message,
      ownerApproval: req.approval,
    } as PermissionContext);
    if (r.behavior === "allow") return { allow: true, reason: "allowed on the approval card" };
    return { allow: false, reason: r.message || "denied" };
  }

  /** Install a transport-level MCP server resolver. Called once per session start. */
  setMcpResolver(resolver: McpResolver | undefined) {
    this.#mcpResolver = resolver;
  }

  /** Node only (node labels spec §4.10): the session's stdio servers from the
   *  node manifest. Installed, it REPLACES installed-plugin MCP servers, the
   *  transport resolver's output is merged after it (and wins a name
   *  collision), and the CLI reads no other MCP source (strictMcpConfig). */
  setLocalMcpResolver(resolver: McpResolver | undefined) {
    this.#localMcpResolver = resolver;
  }

  /** Replace the memory provider (the node role: memory served by the gateway). */
  setMemoryProvider(provider: MemoryProvider) {
    this.#memory = provider;
  }

  /** Install the background budget for the post-turn skill check (spec
   *  §9.3): mono over the ledger, a node over /v1. With one installed, a check
   *  runs only after its run started; a refused or failed start skips it.
   *  Without one (a bare manager, as in tests) the check runs unbudgeted as before. */
  setBackgroundBudget(budget: SkillCheckBudget | undefined) {
    this.#backgroundBudget = budget;
  }

  /** Install the skill-usage recorder (spec §9.1): mono over the database, a
   *  node over /v1. Each successful `Skill` call is counted, best effort. Unset
   *  (a bare manager, as in tests) counts nothing. */
  setSkillUsageRecorder(recorder: SkillUsageRecorder | undefined) {
    this.#skillUsage = recorder;
  }

  /** Install a transport-level Stop hook guard (e.g. Slack "must reply" enforcement). */
  setStopGuard(guard: StopGuard | undefined) {
    this.#stopGuard = guard;
  }

  /** Whether a Stop guard is installed (the guardrails view: absent, the
   *  must-reply hook is a no-op, so it reports "not wired"). */
  hasStopGuard(): boolean {
    return this.#stopGuard !== undefined;
  }

  /** Whether a permission resolver is installed (absent: no canUseTool). */
  hasPermissionResolver(): boolean {
    return this.#resolver !== undefined;
  }

  /** Remote mode (spec §4.1): resolver says whether a session's tools run remotely;
   *  factory opens the connection handle for a session that does. */
  setRemote(
    resolver: ((sessionId: string) => Promise<RemoteTarget | null>) | undefined,
    factory: ((sessionId: string, t: RemoteTarget) => Promise<RemoteHandle> | RemoteHandle) | undefined,
  ) {
    this.#remoteResolver = resolver;
    this.#remoteFactory = factory;
  }

  /** Make sure the session will run under the lock/remote config `fp` names
   *  (spec §4.4). Undefined (older gateway) is ignored. True means the caller may
   *  send: the session is not live (its next boot records `fp`) or the live one
   *  booted under `fp`. Otherwise the live session is stale — or booted before any
   *  fingerprint existed, so its tools are unknown — and is rebooted through
   *  reloadAfterTurn: closing the input of a turn in flight would break it, so the
   *  reload is armed for that turn's result and this returns false at once (the
   *  caller requeues; it must not hold a worker slot for a long turn). An idle
   *  session reloads now and this waits for that live object to go, bounded.
   *  State is derived from the live session, never recorded ahead of the reboot,
   *  so no concurrent caller can see a stale session as current. */
  async ensureConfigFp(sessionId: string, fp: string | undefined, timeoutMs = 10_000): Promise<boolean> {
    if (fp === undefined) return true;
    this.#desiredFp.set(sessionId, fp);
    const live = this.#live.get(sessionId);
    if (!live) {
      // A boot in progress (e.g. an auto-continue after a reload) read its
      // fingerprint already; a message sent now would race it.
      if (this.#booting.has(sessionId)) {
        console.warn(`[mgr] config change: boot in progress session=${sessionId}`);
        return false;
      }
      return true;
    }
    if (live.bootFp === fp) return true;
    this.reloadAfterTurn(sessionId);
    if (live.pendingInputs > 0) {
      console.warn(`[mgr] config change: turn in flight, reboot deferred session=${sessionId}`);
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.#live.get(sessionId) === live && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const next = this.#live.get(sessionId);
    if (next === live) {
      console.warn(`[mgr] config change: session still live after ${timeoutMs}ms, reboot pending session=${sessionId}`);
      return false;
    }
    // A session that replaced it already: current only if it booted under fp.
    return !next || next.bootFp === fp;
  }

  /** Test hook: shrink the bound on disposing a previous remote handle. */
  setRemoteDisposeTimeoutMs(ms: number) {
    this.#remoteDisposeTimeoutMs = ms;
  }

  /** Await the old handle's disposal (ordering matters for same-host re-points)
   *  but never stall a boot on an unreachable old machine: on timeout, release the
   *  connection (rejects the in-flight cleanup) and carry on. Logs codes only. */
  async #disposeBounded(sessionId: string, handle: RemoteHandle): Promise<void> {
    const logFail = (what: string, e: unknown) =>
      console.error(`[mgr] remote ${what} failed session=${sessionId}: ${e instanceof RemoteError ? e.code : "error"}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposal = Promise.resolve().then(() => handle.dispose());
    const timedOut = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), this.#remoteDisposeTimeoutMs); });
    try {
      const outcome = await Promise.race([disposal.then(() => "done" as const), timedOut]);
      if (outcome === "timeout") {
        // Swallow the late settlement of the abandoned dispose.
        disposal.catch(() => {});
        console.error(`[mgr] remote dispose timed out session=${sessionId}; releasing`);
        await handle.release().catch((e) => logFail("release", e));
      }
    } catch (e) {
      logFail("dispose", e);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reuse the session's handle when the target is unchanged; otherwise dispose
   *  the old one (kills its background jobs — remote ended or moved) and open anew. */
  async #remoteHandleFor(sessionId: string, target: RemoteTarget | null): Promise<RemoteHandle | undefined> {
    const key = target ? `${target.userId}|${target.env ? `${target.env.id}|${target.env.hash}` : target.addr}|${target.dir}` : "";
    const prev = this.#remoteHandles.get(sessionId);
    if (prev && prev.key === key) return prev.handle;
    if (prev) {
      this.#remoteHandles.delete(sessionId);
      await this.#disposeBounded(sessionId, prev.handle);
    }
    if (!target) return undefined;
    // Fail closed: never boot local tools while the prompt says remote.
    if (!this.#remoteFactory) throw new Error("remote target set but no remote factory installed");
    const handle = await this.#remoteFactory(sessionId, target);
    this.#remoteHandles.set(sessionId, { handle, key });
    return handle;
  }

  /** Bind a cron run's OAuth identity to a session. Set by the scheduler before
   *  the run when the job was created inside a /1on1, so #startSession boots the
   *  child under the initiator's CLAUDE_CONFIG_DIR (initiator OAuth isolation)
   *  even though the run keys on a synthetic `cron:<id>` thread with no lock. */
  setCronOAuthUser(sessionId: string, userId: string) {
    this.#cronOAuthUser.set(sessionId, userId);
  }

  /** Resolve the identity a session should run as for both CLAUDE_CONFIG_DIR
   *  isolation and private-MCP credential scoping: the cron-captured initiator
   *  (if any) takes precedence over the live /1on1 lock, so both mechanisms
   *  agree by construction instead of independently re-deriving the same rule. */
  async resolveEffectiveIdentity(
    sessionId: string,
    channel?: string | null,
    threadTs?: string | null,
  ): Promise<string | undefined> {
    return this.#cronOAuthUser.get(sessionId)
      ?? (channel && threadTs ? (await this.#lockFor(sessionId, channel, threadTs))?.locked_user : undefined);
  }

  #lockResolver: ((sessionId: string) => Promise<OneOnOneLockRow | null | undefined>) | null = null;

  /** Install where a session's /1on1 lock comes from. A node has no database:
   *  its resolver reads the lock the gateway signed into the job token. The
   *  resolver returns undefined when it does not know (a token from an older
   *  gateway), which falls back to the database lookup. Unset = the database
   *  (mono, gateway). */
  setSessionLockResolver(fn: ((sessionId: string) => Promise<OneOnOneLockRow | null | undefined>) | null) {
    this.#lockResolver = fn;
  }

  async #lockFor(sessionId: string, channel: string, threadTs: string): Promise<OneOnOneLockRow | null> {
    const supplied = this.#lockResolver ? await this.#lockResolver(sessionId) : undefined;
    if (supplied !== undefined) return supplied;
    return OneOnOne.find(channel, threadTs);
  }

  /** Number of SDK Query sessions currently live in this process. */
  liveCount() {
    return this.#live.size;
  }

  /**
   * The owner guardrail set moved to `version`: every live session that booted
   * with another version reloads after its turn (an idle one now), so its next
   * turn boots with the new snapshot. Returns how many were asked to.
   */
  reloadForGuardrails(version: number): number {
    let n = 0;
    for (const id of [...this.#live.keys()]) {
      if ((this.#sessionGuardrails.get(id)?.version ?? 0) === version) continue;
      if (this.reloadAfterTurn(id)) n++;
    }
    return n;
  }

  /** Whether a specific session has an active SDK Query loop right now. */
  isLive(sessionId: string): boolean {
    return this.#live.has(sessionId);
  }

  /** Whether a live session has a turn in flight (an input is outstanding). */
  turnInFlight(sessionId: string): boolean {
    return (this.#live.get(sessionId)?.pendingInputs ?? 0) > 0;
  }

  /** Get-or-create a session bound to a Slack thread. */
  async ensureSession(thread: ThreadKey, opts: { title?: string; workingDir?: string } = {}) {
    let row = await this.#store.findByThread(thread);
    if (!row) {
      // Multi-persona: named personas sharing a thread must not share a cwd.
      // Suffix the workspace with the persona; default persona → path unchanged.
      const personaSuffix =
        thread.persona_id && thread.persona_id !== "default" ? `__${thread.persona_id}` : "";
      // `opts.workingDir` (a heartbeat thread's shared folder) applies only here,
      // at creation; an existing row keeps the folder it has.
      const workingDir =
        opts.workingDir ??
        join(paths.workspaces, `${thread.team_id}-${thread.channel_id}-${thread.thread_ts}${personaSuffix}`);
      mkdirSync(workingDir, { recursive: true });
      try {
        row = await this.#store.createForThread({
          thread,
          // A managed tenant leaves the model empty so the session follows its
          // persona's effective model at every boot (see #sessionModel). A
          // filesystem tenant stores SLAUDE_MODEL, as it always has.
          model: getPersonaRegistry().isManaged() ? "" : env.model(),
          working_dir: workingDir,
          title: opts.title,
          permission_mode: env.defaultPermissionMode(),
        });
      } catch (e) {
        // Find-then-create race: a concurrent caller (another replica, or the
        // cron scheduler alongside an inbound event) inserted this thread's
        // row between our find and insert and tripped the unique index. The
        // sibling's row is the session — use it.
        row = await this.#store.findByThread(thread);
        if (!row) throw e;
      }
    }
    return row;
  }

  /** Mark the next turn for sessionId as a mention-only suppressed turn.
   *  The UserPromptSubmit hook will return continue:false so the message is
   *  recorded in the transcript but the model does not run. Consumed once. */
  suppressNextTurn(sessionId: string) {
    this.#suppressNextTurn.add(sessionId);
  }

  /** Suspend (true) or restore (false) the idle TTL for a live session. A voice
   *  call holds it so the warm session — and its warm-node registration — stays
   *  up for the whole call; release re-arms the normal timer. Holding a session
   *  that is not live does nothing and returns false (a stale hold would block
   *  the idle TTL of a later session under the same id). */
  holdIdle(sessionId: string, hold: boolean): boolean {
    const live = this.#live.get(sessionId);
    if (!hold) {
      this.#idleHeld.delete(sessionId);
      if (live) this.#armIdle(live);
      return true;
    }
    if (!live) return false;
    this.#idleHeld.add(sessionId);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = undefined;
    return true;
  }

  /** Clear the hold and tell listeners (voice calls) the live session is gone.
   *  A throwing listener must not stall teardown. */
  #signalSessionExit(sessionId: string, o: { keepWake?: boolean } = {}) {
    this.#idleHeld.delete(sessionId);
    this.#inputSuppression.delete(sessionId);
    if (!o.keepWake) {
      this.#wakeEnded(sessionId);
      this.#wakes.delete(sessionId);
    }
    this.#claims.releaseHolder(sessionId);
    try {
      this.emit("sessionExit", sessionId);
    } catch (e) {
      console.error(`[mgr] sessionExit listener failed session=${sessionId}:`, e);
    }
  }

  /** True while a live session has inputs pushed whose result has not arrived.
   *  False for unknown or not-live sessions. */
  isTurnInFlight(sessionId: string): boolean {
    return (this.#live.get(sessionId)?.pendingInputs ?? 0) > 0;
  }

  /** Whether a turn is running or about to on this session: an input the CLI has
   *  not folded away, a boot or a send under way, or queued work. Unlike
   *  isTurnInFlight, a count left high by a folded input does not read as busy. */
  turnRunning(sessionId: string): boolean {
    if (this.#booting.has(sessionId) || this.#sendsInProgress.has(sessionId) || this.#kindQueue.has(sessionId)) return true;
    const live = this.#live.get(sessionId);
    return !!live && live.pendingInputs > 0 && !this.#onlyFoldedLeft(live);
  }

  /** True when the session works in the agent's proactive folder and another
   *  session holds that folder now, so a message sent to it would wait for
   *  the folder. False for a session anywhere else, or one that holds it. */
  async folderHeldByOther(sessionId: string): Promise<boolean> {
    const cached = this.#live.get(sessionId);
    const dir = cached ? cached.workingDir : (await this.#store.findById(sessionId))?.working_dir;
    if (!isProactiveWorkspace(dir)) return false;
    const holder = this.#claims.holderOf(dir!);
    return holder !== null && holder !== sessionId;
  }

  /** Send user input. Starts session loop if not already live. */
  async sendMessage(sessionId: string, text: string, opts: { sender?: InputSender; backgroundRun?: BackgroundTurnRun; wake?: WakeOptions } = {}) {
    return this.#sendInOrder(sessionId, text, { wake: opts.wake, sender: opts.sender ?? null, run: opts.backgroundRun });
  }

  /**
   * Deliver an input, first putting the session in the kind of boot it needs.
   * A session with no wake involved goes straight to #send, without even a
   * tick. Otherwise it joins this session's queue: arrival order holds across
   * the waits, and each delivery settles alone, so two callers cannot both
   * restart the session.
   */
  #sendInOrder(sessionId: string, text: string, o: { wake?: WakeOptions; synthetic?: boolean; sender?: InputSender | null; run?: BackgroundTurnRun }): Promise<void> {
    const wantWake = !!o.wake;
    // Bound here, to this message: an earlier input must not consume it.
    const suppressed = !wantWake && !o.synthetic && this.#suppressNextTurn.delete(sessionId);
    const direct = !this.#kindQueue.has(sessionId) && !this.#needsSettling(sessionId, wantWake);
    if (direct && !wantWake) return this.#send(sessionId, text, o.synthetic ?? false, o.sender ?? null, o.run, suppressed);
    const deliver = async () => {
      if (o.wake) this.#refuseWakeDuringCall(sessionId, o.run);
      const armed = o.wake ? this.#armWake(sessionId, o.wake, o.run) : undefined;
      try {
        await this.#send(sessionId, text, o.synthetic ?? false, o.sender ?? null, o.run, suppressed);
      } catch (e) {
        // Its input never went in: nothing behind it may wait for its turn.
        if (armed && this.#wakes.get(sessionId) === armed) {
          this.#wakeEnded(sessionId);
          this.#wakes.delete(sessionId);
        }
        throw e;
      }
    };
    if (direct) return deliver();
    const run = (this.#kindQueue.get(sessionId) ?? Promise.resolve()).then(async () => {
      await this.#settleBootKind(sessionId, wantWake, o.run);
      await deliver();
    });
    const tail = run.catch(() => {});
    this.#kindQueue.set(sessionId, tail);
    void tail.then(() => {
      if (this.#kindQueue.get(sessionId) === tail) this.#kindQueue.delete(sessionId);
    });
    return run;
  }

  /** A wake never waits for a voice call and never restarts one's session: it
   *  is refused at once (a restart's sessionExit would end the call), its run
   *  closed as neither a failure nor a cap. Throws, so its queue link settles
   *  and whatever is behind it goes on. */
  #refuseWakeDuringCall(sessionId: string, run: BackgroundTurnRun | undefined): void {
    if (!voiceCallActive(sessionId)) return;
    console.log(`[mgr] wake session=${sessionId} refused: a voice call owns the session`);
    if (run) {
      void run.finish({}, "stopped-budget").catch((e) => {
        console.error(`[mgr] background run ${run.runId} could not be recorded session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      });
    }
    throw new WakeBusyError(sessionId);
  }

  /** Whether an input of this kind cannot go straight to #send. */
  #needsSettling(sessionId: string, wantWake: boolean): boolean {
    if (this.#wakes.has(sessionId)) return true;
    if (wantWake) return this.#live.has(sessionId) || this.#booting.has(sessionId) || this.#sendsInProgress.has(sessionId);
    return this.#live.get(sessionId)?.bootedAsWake === true;
  }

  /**
   * A query's caps and tools are fixed at boot, so a session changes kind by
   * restarting on its transcript. A wake always gets a query of its own: the
   * CLI measures the budget cap against the whole process, so a warm wake
   * query would run on what the last wake left. A person's message restarts a
   * query booted as a wake. Runs only inside #sendInOrder. Re-reads the session
   * after every wait, and restarts only with no input outstanding.
   */
  async #settleBootKind(sessionId: string, wantWake: boolean, run: BackgroundTurnRun | undefined): Promise<void> {
    for (;;) {
      if (wantWake) this.#refuseWakeDuringCall(sessionId, run);
      const running = this.#wakes.get(sessionId);
      // A wake's turn is never shared with anything delivered here.
      if (running?.inFlight) {
        await running.done;
        continue;
      }
      if (this.#booting.has(sessionId) || (wantWake && this.#sendsInProgress.has(sessionId))) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const live = this.#live.get(sessionId);
      if (!live || !(wantWake || live.bootedAsWake)) break;
      if (live.pendingInputs > 0 && !this.#onlyFoldedLeft(live)) {
        await this.#turnEnded(live);
        continue;
      }
      // Nothing is running, so nothing may read as in flight while it exits.
      live.pendingInputs = 0;
      live.inputSynthetic = [];
      live.inputSenders = [];
      // No await since the check at the top: a call cannot have started.
      if (!live.reloading && !live.closing) this.reload(sessionId);
      // Here, not in #send: the old query's exit signal clears the wake mark,
      // so it must have fired before the next wake is armed.
      await this.#exitOfClosing(sessionId);
    }
    if (!wantWake) this.#wakes.delete(sessionId);
  }

  /** The CLI joins inputs queued during a turn, so one result can answer
   *  several and the count never reaches zero. They are taken as folded only
   *  when the query has been silent since its last result. Anything seen since
   *  means a turn is running, however long it is quiet (a slow tool), and it is
   *  waited for: its result re-arms this. */
  #onlyFoldedLeft(live: LiveSession): boolean {
    return live.lastResultAt !== undefined && !live.activeSinceResult && Date.now() - live.lastResultAt >= this.#foldedQuietMs;
  }

  /** Resolves at the query's next result (which covers the branches that emit
   *  no "done"), when it is gone, or when its quiet period is up. The caller
   *  re-reads the session. */
  #turnEnded(live: LiveSession): Promise<void> {
    if (!live.turnEnded) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      live.turnEnded = { promise, resolve };
    }
    const waits = [live.turnEnded.promise, live.exited];
    if (live.lastResultAt === undefined || live.activeSinceResult) return Promise.race(waits);
    const left = Math.max(0, live.lastResultAt + this.#foldedQuietMs - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([...waits, new Promise<void>((r) => (timer = setTimeout(r, left)))]).finally(() => clearTimeout(timer));
  }

  /**
   * True while the turn running now was injected by the runtime itself (the
   * auto-evolve `<runtime-check>`, the stream-restored continuation, a
   * reload_session prompt), not delivered through sendMessage. The same on
   * mono and nodes (the manager runs on both). A turn's `origin` (and
   * GateInput.interactive) describes what started the session's job, so a
   * write that needs a person's own words must also check this. A turn a
   * voice runner injected (a delegated request, the transcript flush, the
   * summary) is synthetic too: it arrives through sendMessage with no sender,
   * but on a node its job token still names the call's starter.
   */
  isSyntheticTurn(sessionId: string): boolean {
    if (injectedTurns.active(sessionId)) return true;
    return this.#live.get(sessionId)?.inputSynthetic[0] === true;
  }

  /**
   * The senders of every input outstanding now: the running turn's and any
   * queued behind it, because the CLI may fold a queued input into the
   * running turn. Null whenever that cannot be told for sure, so a write
   * that needs one person's own words fails closed: no live session, no
   * outstanding input, the per-input bookkeeping out of step with the input
   * count, or any input that is synthetic or was sent without a sender.
   */
  turnSenders(sessionId: string): InputSender[] | null {
    const live = this.#live.get(sessionId);
    if (!live || live.pendingInputs === 0) return null;
    if (live.inputSenders.length !== live.pendingInputs || live.inputSynthetic.length !== live.pendingInputs) return null;
    const out: InputSender[] = [];
    for (const s of live.inputSenders) {
      if (!s) return null;
      if (!out.some((o) => o.userId === s.userId && o.teamId === s.teamId && o.origin === s.origin)) out.push({ userId: s.userId, teamId: s.teamId, origin: s.origin });
    }
    return out;
  }

  /**
   * The own text of every input outstanding now, as turnSenders counts them
   * (a queued input may fold into the running turn). Null whenever turnSenders
   * would be, or any input was delivered without its text.
   */
  turnTexts(sessionId: string): string[] | null {
    if (!this.turnSenders(sessionId)) return null;
    const texts = this.#live.get(sessionId)!.inputSenders.map((s) => s?.text);
    return texts.every((t): t is string => typeof t === "string") ? texts : null;
  }

  async #send(sessionId: string, text: string, synthetic: boolean, sender: InputSender | null = null, run?: BackgroundTurnRun, suppressed = false) {
    // Counted in this frame, with no wrapper: a wrapper's await would add a tick to every send.
    this.#sendsInProgress.set(sessionId, (this.#sendsInProgress.get(sessionId) ?? 0) + 1);
    // A session in the agent's proactive folder waits for the folder before
    // its turn starts: two threads there never run at once in this process.
    // Re-entrant, so the holder's own next input never waits on itself. The
    // working dir is set at creation and never changes: a live session's
    // cached copy saves a store read (a /v1 call on a node) per input.
    let claimed = false;
    try {
      const cached = this.#live.get(sessionId);
      const dir = cached ? cached.workingDir : (await this.#store.findById(sessionId))?.working_dir;
      claimed = isProactiveWorkspace(dir);
      await this.#sendClaimed(sessionId, text, synthetic, sender, run, claimed ? dir! : null, suppressed);
    } catch (e) {
      // Failed before its input was in, and no other input of this session
      // runs or boots: nothing of this session runs there.
      if (claimed && !this.isTurnInFlight(sessionId) && !this.#booting.has(sessionId)) this.#claims.releaseHolder(sessionId);
      throw e;
    } finally {
      const n = (this.#sendsInProgress.get(sessionId) ?? 1) - 1;
      if (n > 0) this.#sendsInProgress.set(sessionId, n);
      else this.#sendsInProgress.delete(sessionId);
    }
  }

  async #sendClaimed(sessionId: string, text: string, synthetic: boolean, sender: InputSender | null, run: BackgroundTurnRun | undefined, claimDir: string | null, suppressed: boolean) {
    // Signal that a real user turn is starting for this session. Slash commands
    // and dropped messages never reach here, so a listener can distinguish
    // "agent will run" from "handled inline" without waiting for done/error.
    // A session in the proactive folder signals it once it holds the folder.
    if (!claimDir) this.emit("event", { type: "turnStart", sessionId } satisfies AgentEvent);
    let live: LiveSession | undefined;
    // Repeats until the folder is held without waiting for it: anything read
    // before a wait (the live instance, its reload state) may be stale after.
    for (;;) {
      live = this.#live.get(sessionId);
      // A reloading (or idled-out) session has closed its input: anything pushed now would never
      // reach the CLI. Wait for it to exit and boot a fresh one for this message.
      if (live?.reloading || live?.closing) live = await this.#exitOfClosing(sessionId);
      // Never into a running check turn (LiveSession.checkEnded). Unbounded here
      // like the check itself: the node's turn timeout aborts a check that never
      // ends, and its exit releases this wait. Read the session again after.
      if (live?.checkEnded) {
        await Promise.race([live.checkEnded.promise, live.exited]);
        continue;
      }
      // Held already (re-entrant): go on with the instance just read. Otherwise
      // wait for the folder (an old instance's exit may have freed it) and read
      // the session again.
      if (!claimDir || this.#claims.holderOf(claimDir) === sessionId) break;
      await this.#claims.acquire(claimDir, sessionId);
    }
    if (claimDir) this.emit("event", { type: "turnStart", sessionId } satisfies AgentEvent);
    if (live) {
      // flush prior turn if any pending assistant content was buffered
      this.#flushTurn(live);
      live.turn.user = text;
      live.turn.assistant = [];
      this.#stopBlocked.delete(sessionId);
      this.#noteInput(sessionId, text, suppressed);
      live.pushUser(text, synthetic, synthetic ? null : sender);
      if (run) (live.bgRuns ??= new Map()).set(live.inputSeq, run);
      this.#armIdle(live);
      return;
    }
    this.#stopBlocked.delete(sessionId);
    const noted = this.#noteInput(sessionId, text, suppressed);
    try {
      await this.#startSession(sessionId, text, synthetic, synthetic ? null : sender);
    } catch (e) {
      // Its input never reached the CLI: no hook will consume this entry.
      const q = this.#inputSuppression.get(sessionId);
      if (q?.includes(noted)) q.splice(q.indexOf(noted), 1);
      throw e;
    }
    if (run) {
      // A fresh session's first input is inputSeq 1. Anything else (a boot
      // that failed, another input already in) leaves the run open for the
      // stale-run sweep rather than charging it a turn that is not its own.
      const booted = this.#live.get(sessionId);
      if (booted && booted.inputSeq === 1) (booted.bgRuns ??= new Map()).set(1, run);
      else console.warn(`[mgr] background run ${run.runId} session=${sessionId}: its input could not be tagged; the run stays open`);
    }
  }

  /** Wait out a session whose input has closed, and return what holds the id
   *  after it. Bounded: a CLI that never exits after its stdin closes must not
   *  hang this forever. Past the bound the old session is aborted and detached
   *  (its eventual exit cannot touch the fresh one), and undefined is returned. */
  async #exitOfClosing(sessionId: string): Promise<LiveSession | undefined> {
    let live = this.#live.get(sessionId);
    while (live?.reloading || live?.closing) {
      const old = live;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        old.exited.then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.#reloadExitTimeoutMs))),
      ]);
      clearTimeout(timer);
      if (!exited) {
        console.warn(`[mgr] reloading session=${sessionId} did not exit within ${this.#reloadExitTimeoutMs}ms; aborting it and booting fresh`);
        this.abort(sessionId);
        if (old.idleTimer) clearTimeout(old.idleTimer);
        if (this.#live.get(sessionId) === old) {
          this.#live.delete(sessionId);
          this.#skillGate.forget(sessionId);
          this.#forgetGuardrails(sessionId);
          // The detached instance's own teardown no longer owns the id and
          // stays silent, so this is its one exit signal (a voice call must learn).
          this.#signalSessionExit(sessionId);
        }
        return undefined;
      }
      live = this.#live.get(sessionId);
    }
    return live;
  }

  /** Remember a pushed input until its UserPromptSubmit. */
  #noteInput(sessionId: string, text: string, suppressed: boolean): SuppressionEntry {
    const entry = { text, suppressed };
    const q = this.#inputSuppression.get(sessionId);
    if (q) q.push(entry);
    else this.#inputSuppression.set(sessionId, [entry]);
    return entry;
  }

  /**
   * Whether the prompt the hook is running for was suppressed. Matched by text,
   * not position: an input folded into a running turn never fires its hook, and
   * inputs the CLI joins at dequeue arrive as one prompt (newline-joined), which
   * is suppressed only if every one of them was. Older entries are discarded
   * with the match. A prompt matching nothing (a check, a command) is not
   * suppressed and disturbs nothing.
   */
  #takeSuppressed(sessionId: string, prompt: string): boolean {
    const q = this.#inputSuppression.get(sessionId);
    if (!q) return false;
    for (let start = 0; start < q.length; start++) {
      let joined = "";
      for (let end = start; end < q.length; end++) {
        joined = end === start ? q[end]!.text : `${joined}\n${q[end]!.text}`;
        if (joined === prompt) return q.splice(0, end + 1).slice(start).every((e) => e.suppressed);
        if (!prompt.startsWith(joined)) break;
      }
    }
    return false;
  }

  /** (Re)arm the idle timer for a session. On expiry, close the SDK loop
   *  silently — the next inbound user msg will boot a fresh Query w/ resume. */
  #armIdle(live: LiveSession) {
    const ms = env.idleMs();
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (this.#idleHeld.has(live.id)) return;
    if (ms <= 0) return;
    live.idleTimer = setTimeout(() => {
      // Not idle while an input is outstanding (a turn longer than the idle
      // timeout): closing now would make a later send wait out the exit and
      // abort that turn. Re-armed here, and again at the turn's result.
      if (live.pendingInputs > 0) return this.#armIdle(live);
      // Flush any buffered assistant content; close the prompt iterable so
      // the for-await loop in #startSession unwinds cleanly.
      this.#flushTurn(live);
      live.closing = true;
      try {
        live.closeIterable();
      } catch {}
    }, ms);
  }

  /**
   * Mark a session as a heartbeat wake before it boots. Its query gets the caps
   * and hides the tools a wake may not call. The wall clock closes the run itself
   * and ends the turn, because an aborted query never reaches a result.
   */
  #armWake(sessionId: string, wake: WakeOptions, run: BackgroundTurnRun | undefined): WakeState {
    let markDone!: () => void;
    const done = new Promise<void>((r) => (markDone = r));
    const state: WakeState = { options: wake, inFlight: true, done, markDone };
    this.#wakes.set(sessionId, state);
    if (!wake.maxMinutes || wake.maxMinutes <= 0) return state;
    state.timer = setTimeout(() => {
      console.log(`[mgr] wake session=${sessionId} reached its wall clock (${wake.maxMinutes} min)`);
      const live = this.#live.get(sessionId);
      if (live?.bgRuns) for (const [seq, r] of live.bgRuns) if (r === run) live.bgRuns.delete(seq);
      if (run) {
        void run.finish({}, "stopped-budget", { cap: "minutes", durationMs: wake.maxMinutes! * 60_000 }).catch((e) => {
          console.error(`[mgr] background run ${run.runId} could not be recorded session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
        });
      }
      this.#wakeEnded(sessionId);
      this.#wakes.delete(sessionId);
      this.emit("event", { type: "done", sessionId } satisfies AgentEvent);
      this.abort(sessionId);
    }, wake.maxMinutes * 60_000);
    (state.timer as { unref?: () => void }).unref?.();
    return state;
  }

  /** The wake's turn ended: no wall clock any more, and whatever waits for it
   *  may go on (once). The mark stays until a person's message or the session
   *  exit clears it: this is still the query it booted. */
  #wakeEnded(sessionId: string) {
    const w = this.#wakes.get(sessionId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = undefined;
    if (!w.inFlight) return;
    w.inFlight = false;
    w.markDone();
  }

  /** Cancel any in-flight turn for the session. */
  abort(sessionId: string) {
    this.#pendingReload.delete(sessionId);
    this.#reloadAfterTurn.delete(sessionId);
    this.#autoContinue.delete(sessionId);
    this.#reloadPrompt.delete(sessionId);
    this.#live.get(sessionId)?.abort.abort();
  }

  /** Push a raw CLI command (e.g. "/compact") directly into the live session's
   *  input iterable, bypassing the normal channel-envelope wrapper. Returns false
   *  if the session has no live query yet (user hasn't sent a message this boot). */
  triggerCommand(sessionId: string, command: string): boolean {
    const live = this.#live.get(sessionId);
    if (!live) return false;
    live.pushUser(command);
    return true;
  }

  /** Gracefully close a live session so the next inbound message boots a
   *  fresh Query with newly-resolved MCPs, plugins, and skills.
   *  If `prompt` is provided it is injected automatically after the reload
   *  instead of waiting for the user to type something. */
  reload(sessionId: string, prompt?: string) {
    const live = this.#live.get(sessionId);
    if (!live) return false;
    if (prompt) this.#reloadPrompt.set(sessionId, prompt);
    live.reloading = true;
    live.closeIterable();
    return true;
  }

  /** Reload a session without breaking a turn in flight. Closing the input
   *  mid-turn ends the CLI's stdin, which a turn still needs (permission
   *  prompts, hooks, in-process MCP), so a session with a turn in flight is
   *  marked and reloaded when that turn's result arrives; an idle session
   *  reloads now. Either way the next turn boots fresh. False if not live. */
  reloadAfterTurn(sessionId: string): boolean {
    const live = this.#live.get(sessionId);
    if (!live) return false;
    if (live.reloading) return true;
    if (live.pendingInputs > 0) {
      this.#reloadAfterTurn.add(sessionId);
      return true;
    }
    return this.reload(sessionId);
  }

  /** Queue an out-of-band gate event (e.g. "Connected MCP server `x`.") for delivery
   *  to the session's transcript on its next engaged user turn. Persists across the
   *  reboot that connect/disconnect trigger. */
  noteSessionEvent(sessionId: string, text: string) {
    const q = this.#sessionNotes.get(sessionId) ?? [];
    q.push(text);
    this.#sessionNotes.set(sessionId, q);
  }

  /** Change permission mode for a session. Persists; if live, also pushed to the SDK Query. */
  async setPermissionMode(sessionId: string, mode: PermissionMode) {
    await this.#store.setPermissionMode(sessionId, mode);
    const live = this.#live.get(sessionId);
    if (live) live.mode = mode;
    if (live?.query) {
      try {
        await live.query.setPermissionMode(mode);
      } catch (e) {
        console.error("[agent] setPermissionMode failed:", e);
      }
    }
  }

  /** Change the model for a session. Persists; if live, also pushed to the SDK Query. */
  async setSessionModel(sessionId: string, model: string) {
    await this.#store.setModel(sessionId, model);
    const live = this.#live.get(sessionId);
    if (live?.query) {
      try {
        await live.query.setModel(model);
      } catch (e) {
        console.error("[agent] setModel failed:", e);
      }
    }
  }

  /** Current MCP server statuses for a live session, or null if not live.
   *  Read-only passthrough to the SDK Query — slaude maintains no mirror. */
  async mcpServerStatus(sessionId: string) {
    const live = this.#live.get(sessionId);
    if (!live?.query) return null;
    try {
      return await live.query.mcpServerStatus();
    } catch (e) {
      console.error("[agent] mcpServerStatus failed:", e);
      return null;
    }
  }

  /** Re-run the MCP handshake for one server of a live session, so it picks up
   *  a credential rewritten under it. False if the session is not live or the
   *  SDK refused. Measured (Task 1 field note): after a rewrite the next call
   *  already uses the new token, but only a reconnect returns the reported
   *  status from needs-auth to connected. */
  async reconnectMcpServer(sessionId: string, serverName: string): Promise<boolean> {
    const live = this.#live.get(sessionId);
    if (!live?.query) return false;
    try {
      await live.query.reconnectMcpServer(serverName);
      return true;
    } catch (e) {
      console.warn(`[agent] reconnectMcpServer failed session=${sessionId} server=${serverName}: ${e instanceof Error ? e.name : typeof e}`);
      return false;
    }
  }

  /**
   * On a managed registry install, close every warm session whose persona is no
   * longer live. A live child never re-resolves its persona (sendMessage pushes
   * straight into it and re-arms the idle timer), so without this a retired
   * persona's thread or cron job keeps running as it booted, with the default
   * identity's fallbacks around it. The in-flight turn is aborted; the next
   * message boots fresh and #resolvePersona refuses it. Nodes (a soul resolver
   * installed) and filesystem registries are unaffected.
   */
  #closeRetiredPersonaSessions(r: PersonaRegistry) {
    if (this.#personaSoulResolver || !r.isManaged()) return;
    for (const [id, live] of this.#live) {
      if (!live.personaName || r.lookupByName(live.personaName)) continue;
      console.log(`[agent] closing session=${id} persona=${live.personaName} — persona no longer live`);
      this.abort(id);
      try {
        live.closeIterable();
      } catch {}
    }
  }

  /** The session's persona: its registry entry (gateway/mono) and its name.
   *  With a soul resolver installed (a node) the registry is never consulted —
   *  it loads lazily from the shared volume, where a node's persona directory
   *  need not exist — and the name is the session row's persona id. */
  #resolvePersona(personaId: string | null | undefined): {
    persona: ReturnType<ReturnType<typeof getPersonaRegistry>["lookupByName"]>;
    name: string | undefined;
  } {
    const named = personaId && personaId !== "default" ? personaId : undefined;
    if (this.#personaSoulResolver) return { persona: null, name: named };
    // A managed registry is complete, so a named persona it lacks was retired or
    // removed. Booting it as the default persona would hand that thread the
    // default's soul, credentials and brain slice: livePersona throws instead.
    // A filesystem registry keeps the old fallback (null).
    const persona = named ? livePersona(named) : null;
    return { persona, name: persona?.name };
  }

  /** A booting session's soul: its runtime bundle on a node, else the registry.
   *  A persona from an agent.yaml carries its compiled structure (a mono
   *  session has no bundle); any other soul keeps the process-global reading. */
  async #resolveSoul(sessionId: string, personaName: string | undefined): Promise<PersonaSoul> {
    let soul: PersonaSoul;
    if (this.#personaSoulResolver) {
      soul = await this.#personaSoulResolver(sessionId, personaName);
    } else {
      const definition = managedPersonaDefinition(personaName);
      const compiled = definition ? compiledPromptSoul(personaName) : null;
      soul = {
        soulMd: personaSoulText(personaName),
        soulJson: compiled ?? undefined,
        ...(definition ? { definition } : {}),
      };
    }
    // Booting anyway would run the agent without its skill list and access.
    if (soul.definition && !SoulDataSchema.safeParse(soul.soulJson).success) {
      throw new Error(`persona '${personaName ?? "default"}' is defined by agent.yaml but its stored structure does not parse; refusing to boot`);
    }
    return soul;
  }

  /** The persona's skill list as Skill tool names, read now so a sync reaches a
   *  warm session (a node asks its gateway, through the ETag-cached bundle). */
  async #currentSkillNames(sessionId: string, personaName: string | undefined): Promise<string[] | null> {
    const list = this.#personaSoulResolver
      ? (await this.#personaSoulResolver(sessionId, personaName)).definition?.skills
      : managedPersonaDefinition(personaName)?.skills;
    return list ? allowedSkillNames(list, personaName) : null;
  }

  /** The `systemPrompt.append` text for a booting session. One function for
   *  session start and {@link __systemPromptForTests}, so the test exercises the
   *  production path. A soul resolver failure propagates and fails the boot. */
  async #buildSystemAppend(
    sessionId: string,
    personaName: string | undefined,
    ctx: {
      channelId?: string | null;
      lock?: OneOnOneLockRow | null;
      remote?: RemoteModeInfo | null;
      mcpServers?: Record<string, unknown>;
      /** The CLI reads no MCP source but mcpServers (a node): the block is
       *  the whole list. */
      strictMcp?: boolean;
      memBlock?: string | null;
      /** The owner guardrails the session boots with (their Guidance block). */
      guardrails?: SessionGuardrails | null;
      /** The soul already resolved for this boot (else resolved here). */
      soul?: PersonaSoul;
    },
  ): Promise<string> {
    // Named personas use their own soul for the persona block (the database
    // soul when the tenant is managed, else their SOUL.md); the runtime baseline
    // stays the same. Default persona = the managed `default` row when one
    // exists, else the global SOUL.md. On a node the resolver supplies both
    // from the runtime bundle.
    const soul: PersonaSoul = ctx.soul ?? await this.#resolveSoul(sessionId, personaName);
    // Observable soul source: a hash, never the text.
    const soulHash = createHash("sha256").update(soul.soulMd).digest("hex").slice(0, 12);
    console.log(`[agent] session=${sessionId} persona=${personaName ?? "default"} soul=${soulHash}`);
    const { mcpServers, memBlock } = ctx;
    return [
      soulSystemBlock(soul.soulMd),
      compiledMandateBlock(soul),
      // Owner Guidance right after the soul, before the channel mandate.
      // Enforced rules are never in the prompt: code checks them.
      ctx.guardrails?.promptBlock ?? "",
      channelMandateBlock(ctx.channelId, soul.soulJson, sessionId, personaName),
      sessionModeBlock(ctx.lock ?? null, ctx.remote),
      mcpServers
        ? `<mcp-servers>\nMCP server namespaces mounted this session. Call tools as \`mcp__<server>__<tool>\`.\n${Object.keys(mcpServers)
            .map((n) => `- ${n}`)
            .join("\n")}\n${
            ctx.strictMcp
              ? ""
              : "Additional servers may be available if configured in ~/.claude/mcp.json or .mcp.json in the working directory.\n"
          }</mcp-servers>`
        : "<mcp-servers>none</mcp-servers>",
      memBlock ? `<memory-context>\n${memBlock}\n</memory-context>` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** TEST SEAM: the system-prompt append a session with this persona would boot
   *  with, built by the same function session start uses. */
  async __systemPromptForTests(
    sessionId: string,
    personaId: string | undefined,
    ctx: { channelId?: string | null } = {},
  ): Promise<string> {
    const name = this.#resolvePersona(personaId).name;
    const guardrails = await this.#resolveGuardrails(sessionId, name, ctx.channelId ?? null);
    return this.#buildSystemAppend(sessionId, name, { ...ctx, guardrails });
  }

  /** The session's owner guardrails, or a typed boot failure: never an empty
   *  set because the set could not be read or verified. */
  async #resolveGuardrails(sessionId: string, personaName: string | undefined, channelId: string | null): Promise<SessionGuardrails | null> {
    if (!this.#guardrailResolver) return null;
    try {
      return await this.#guardrailResolver(sessionId, personaName, channelId);
    } catch (e) {
      console.error(`[mgr] guardrails unavailable session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      throw e instanceof BootFailure ? e : new BootFailure("GUARDRAILS_UNAVAILABLE", "owner guardrails could not be read or verified", { cause: e });
    }
  }

  /** Boot a session, marked as booting (see ensureConfigFp) from the first
   *  synchronous step until it is live or the boot fails. A counter, since a
   *  retry path may start a boot for the same id while another is unwinding. */
  /** A fire-and-forget reboot (resume-miss retry) has no caller to reject to:
   *  its failure is the turn's error event, with its code when it is typed.
   *  `signalExit`: the session the reboot replaced left without its exit
   *  signal (the resume-retry paths), so a voice call holding it must learn
   *  now, unless a session holds the id again. */
  #rebootFailed(sessionId: string, e: unknown, o: { signalExit?: boolean } = {}) {
    console.error(`[mgr] reboot failed session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    this.emit("event", {
      type: "error",
      sessionId,
      error: "session reboot failed",
      code: e instanceof BootFailure ? e.code : "TURN_FAILED",
    } satisfies AgentEvent);
    if (!this.#live.has(sessionId)) {
      this.#skillGate.forget(sessionId);
      this.#forgetGuardrails(sessionId);
    }
    if (o.signalExit && !this.#live.has(sessionId)) this.#signalSessionExit(sessionId);
  }

  /** Reboot a session whose first boot failed, with the same first input. A
   *  wake's ledger run moves to the new query, which runs that same turn. */
  #retryBoot(sessionId: string, live: LiveSession, firstText: string, firstSynthetic: boolean, firstSender: InputSender | null): void {
    const run = live.bootedAsWake ? live.bgRuns?.get(1) : undefined;
    void this.#startSession(sessionId, firstText, firstSynthetic, firstSender)
      .then(() => {
        const booted = this.#live.get(sessionId);
        if (run && booted?.inputSeq === 1) (booted.bgRuns ??= new Map()).set(1, run);
      })
      .catch((e) => this.#rebootFailed(sessionId, e, { signalExit: true }));
  }

  async #startSession(sessionId: string, firstText: string, firstSynthetic = false, firstSender: InputSender | null = null) {
    this.#booting.set(sessionId, (this.#booting.get(sessionId) ?? 0) + 1);
    let marked = true;
    const unmark = () => {
      if (!marked) return;
      marked = false;
      const n = (this.#booting.get(sessionId) ?? 1) - 1;
      if (n > 0) this.#booting.set(sessionId, n);
      else this.#booting.delete(sessionId);
    };
    try {
      await this.#bootSession(sessionId, firstText, unmark, firstSynthetic, firstSender);
    } finally {
      unmark();
    }
  }

  async #bootSession(sessionId: string, firstText: string, onLive: () => void, firstSynthetic = false, firstSender: InputSender | null = null) {
    // Read before any config is resolved: a fingerprint that arrives while this
    // boot resolves its lock/remote state must not be credited to it.
    const bootFp = this.#desiredFp.get(sessionId);
    const row = await this.#store.findById(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);

    // Memory must never break a turn (the brain provider's own policy). The
    // sqlite provider throws where no database is open; a node uses the
    // gateway's memory routes instead (setMemoryProvider).
    const memBlock = await this.#memory.prefetch(sessionId).catch((e) => {
      console.error(`[mgr] memory prefetch failed session=${sessionId}:`, e instanceof Error ? e.message : e);
      return null;
    });
    const abort = new AbortController();
    const queue: string[] = [firstText];
    let resolveNext: (() => void) | null = null;
    let closed = false;

    const pushUser = (text: string) => {
      queue.push(text);
      resolveNext?.();
      resolveNext = null;
    };

    const closeIterable = () => {
      closed = true;
      resolveNext?.();
      resolveNext = null;
    };

    const promptIterable = (async function* () {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (resolveNext = r));
          continue;
        }
        const text = queue.shift()!;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: text },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }
    })();

    // Pass through Anthropic-compatible provider env so any compatible API works.
    const providerEnv: Record<string, string | undefined> = {};
    for (const k of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      // Claude subscription OAuth token (from `claude setup-token`). When
      // set, the SDK child authenticates via OAuth — no API key needed.
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      if (process.env[k]) providerEnv[k] = process.env[k];
    }
    // Kill telemetry / autoupdater / bug-reporter / error-reporter — they
    // hit Anthropic-owned endpoints and crash the CLI when ANTHROPIC_BASE_URL
    // points at a non-Anthropic gateway (e.g. DeepSeek, OpenRouter).
    providerEnv.DISABLE_TELEMETRY = "1";
    providerEnv.DISABLE_AUTOUPDATER = "1";
    providerEnv.DISABLE_BUG_COMMAND = "1";
    providerEnv.DISABLE_ERROR_REPORTING = "1";
    providerEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    // Node runtime (spec §6): overlay wins over process-env-derived provider
    // vars — a node's own env carries no tenant credentials, the runtime
    // bundle does. No resolver installed → no change (mono/gateway).
    // A resolver failure is FATAL and typed (WS-A §5.4): spawning on the node's
    // own environment would run the persona on someone else's credentials.
    let unsetChildEnv: readonly string[] = [];
    if (this.#childEnvResolver) {
      let overlay: ChildEnvOverlay;
      try {
        overlay = await this.#childEnvResolver(sessionId);
      } catch (e) {
        console.error(`[mgr] child-env resolver failed session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
        throw e instanceof BootFailure
          ? e
          : new BootFailure("PROVIDER_CREDENTIALS_UNAVAILABLE", "child-env resolver failed", { cause: e });
      }
      if (overlay instanceof ChildEnvPatch) {
        Object.assign(providerEnv, overlay.set);
        unsetChildEnv = overlay.unset.filter((k) => !Object.hasOwn(overlay.set, k));
      } else {
        Object.assign(providerEnv, overlay ?? {});
      }
    }
    // /1on1 privacy: when this session's thread is locked, point the claude-code
    // child at the initiator's isolated config home so OAuth-authenticated MCP
    // servers (whose tokens the CLI persists under CLAUDE_CONFIG_DIR, beyond the
    // reach of the .mcp.json credential-strip) resolve as the initiator, not the
    // agent. Unlocked → inherit the agent's config dir. Reboot-on-/1on1 forces
    // re-resolution (CLAUDE_CONFIG_DIR is read once at child boot).
    const lock =
      row.slack_channel_id && row.slack_thread_ts
        ? await this.#lockFor(sessionId, row.slack_channel_id, row.slack_thread_ts)
        : null;
    const oauthUser = await this.resolveEffectiveIdentity(
      sessionId,
      row.slack_channel_id,
      row.slack_thread_ts,
    );
    // Multi-persona: resolve the persona first — it anchors both the brain slice
    // (SLAUDE_AGENT_ID) and the config dir (creds + transcripts) below.
    const { persona, name: personaName } = this.#resolvePersona(row.persona_id);
    if (persona) {
      // Inject the persona's Slack user ID as the brain-slice anchor so named
      // personas each get their own private KB slice.
      providerEnv.SLAUDE_AGENT_ID = persona.slackUserId;
    }

    // CLAUDE_CONFIG_DIR precedence: a named persona gets its own config home
    // (isolated .credentials.json + projects/ transcripts); a /1on1 lock nests
    // its per-initiator home INSIDE that persona boundary. Default persona +
    // unlocked → undefined → inherit the agent's config dir (unchanged).
    const sessionConfigDir = this.#configDirResolver
      ? await this.#configDirResolver(sessionId, personaName)
      : resolveSessionConfigDir(oauthUser, personaName);
    if (sessionConfigDir) providerEnv.CLAUDE_CONFIG_DIR = sessionConfigDir;

    const mode = (row.permission_mode || "default") as PermissionMode;
    const mcpServers = await this.#mcpResolver?.(sessionId);
    // Node: the manifest's stdio servers for this persona, and nothing else
    // local (no plugin MCP from disk, no CLI discovery). The transport's
    // servers go after them, so a gateway-resolved name wins a collision.
    const localMcp = this.#localMcpResolver ? ((await this.#localMcpResolver(sessionId)) ?? {}) : null;
    const baseMcpServers = localMcp ? mergeLocalMcp(sessionId, localMcp, mcpServers) : mcpServers;
    // Remote mode: tools for this session run on the lock owner's machine.
    const remoteTarget = this.#remoteResolver ? await this.#remoteResolver(sessionId) : null;
    const model = await this.#sessionModel(sessionId, row.model, personaName);
    // Strict (node): the prompt lists exactly what the CLI will mount.
    const strictNames = localMcp ? { ...baseMcpServers, ...(remoteTarget ? { [REMOTE_MCP_NAME]: true } : {}) } : null;
    // Owner guardrails: resolved once per boot (the same lifecycle as the
    // soul); a failure fails the boot.
    const guardrails = await this.#resolveGuardrails(sessionId, personaName, row.slack_channel_id ?? null);
    const soul = await this.#resolveSoul(sessionId, personaName);
    const systemAppend = await this.#buildSystemAppend(sessionId, personaName, {
      guardrails,
      soul,
      channelId: row.slack_channel_id,
      lock,
      remote: remoteTarget
        ? { userId: remoteTarget.userId, dir: remoteTarget.dir, ...(remoteTarget.env ? { env: { name: remoteTarget.env.name, kind: remoteTarget.env.kind, trust: remoteTarget.env.trust } } : {}) }
        : null,
      mcpServers: strictNames ? (Object.keys(strictNames).length > 0 ? strictNames : undefined) : mcpServers,
      strictMcp: !!localMcp,
      memBlock,
    });
    const preCompact: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreCompact") return { continue: true };
      this.emit("event", {
        type: "compacting",
        sessionId,
        trigger: input.trigger,
      } satisfies AgentEvent);
      return { continue: true };
    };
    const stopHook: HookCallback = async (input) => {
      if (input.hook_event_name !== "Stop") return { continue: true };
      const guard = this.#stopGuard;
      if (!guard) return { continue: true };
      const reason = guard(sessionId);
      if (!reason) return { continue: true };
      if (this.#stopBlocked.has(sessionId)) {
        // Already blocked once this turn and the agent still wants to stop —
        // let it. Surfaces as a stderr line so drift is visible in logs.
        process.stderr.write(
          `[stop-guard] session=${sessionId} blocked once but agent still stopping: ${reason}\n`,
        );
        metric.stopGuardFailedTotal.inc();
        metric.errorsTotal.inc({ kind: "stop_guard_failed" });
        return { continue: true };
      }
      this.#stopBlocked.add(sessionId);
      metric.stopGuardBlockedTotal.inc();
      return { decision: "block", reason };
    };
    // While a thread is disengaged (sessions.engaged=0), keep the session
    // transcript populated WITHOUT running the model. `continue:false` halts the
    // turn after the user message is enqueued/persisted but before generation,
    // so on re-engage the model resumes with the gap already in conversation
    // history — no Slack re-fetch, no synthetic preamble. (decision:"block"
    // discards the prompt *before* it persists — verified against the pinned
    // SDK; see docs/site/_content/field-notes/2026-06-16-reengage-hook-suppress.md.)
    const guardrailKind = () => (this.#wakes.has(sessionId) ? "wake" : this.#remoteHandles.has(sessionId) ? "remote" : "interactive");
    const guardrailCtx = () => ({ persona: personaName ?? "default", channelId: row.slack_channel_id ?? null, kind: guardrailKind() });
    const userPromptHook = makeUserPromptHook(
      sessionId,
      this.#sessionNotes,
      (prompt) => {
        // The next turn has started, so what is counted is not folded.
        live.activeSinceResult = true;
        return this.#takeSuppressed(sessionId, prompt);
      },
      (id) => this.#store.findById(id),
      () => {
        const due = this.#takeGuidance(sessionId);
        if (due.length) this.#guardrailSink?.delivered(sessionId, due.map((d) => d.slug), { ...guardrailCtx(), via: "inbound" });
        return due;
      },
    );
    const ownerGuardrails = ownerGuardrailsHook({
      // This boot's own snapshot, held by the hook: a teardown race on the
      // per-session map can never leave a running CLI without its rules.
      guardrails: () => guardrails,
      channel: () => row.slack_channel_id,
      delivered: () => {
        let d = this.#guidanceDelivered.get(sessionId);
        if (!d) this.#guidanceDelivered.set(sessionId, (d = new Set()));
        return d;
      },
      onFiring: (events) => this.#guardrailSink?.firing(sessionId, events, guardrailCtx()),
      onDelivered: (items, toolName) => this.#guardrailSink?.delivered(sessionId, items.map((i) => i.slug), { ...guardrailCtx(), via: "tool", toolName }),
      // Remote mode: the CLI reports the alias (mcp__remote__bash); a rule
      // written for the builtin (Bash) must still match, and the other way round.
      toolNames: (name) => (remoteHandle ? remoteToolNames(name) : [name]),
      // approve: the card through the permission resolver, bounded by the
      // approve cap and (on a node) the turn deadline; a wake is refused.
      approve: (req) => this.#ownerApprove(sessionId, req),
      approveCapMs: () => env.guardrailApproveTimeoutSec() * 1000,
      turnDeadline: () => this.#turnDeadline?.(sessionId) ?? null,
    });
    const guardrailFiles = guardrailFilesHook(
      () => row.working_dir,
      () => ({ guardrailsDir: GUARDRAILS_DIR, dbFile: dbDialect() === "sqlite" ? paths.db : null }),
    );
    // CC plugins installed via `bun run install-deps`. Without this, the SDK
    // ignores the enabledPlugins entry in settings.json (it only reads
    // settings when settingSources is set). Explicit Options.plugins surfaces
    // each plugin's skills/commands for this session. The SDK's `--plugin-dir`
    // path does NOT auto-mount the plugin's .mcp.json servers (CLI landmine),
    // so we also read each plugin's .mcp.json and merge into mcpServers.
    // On a node (a local MCP resolver installed) plugin MCP servers run only
    // when the node manifest declares them: none are read from disk, and every
    // plugin skips the CLI's own .mcp.json discovery.
    const pluginPaths = localMcp
      ? loadInstalledPluginPaths().map((p) => ({ ...p, skipMcpDiscovery: true }))
      : loadInstalledPluginPaths();
    const pluginMcps = localMcp ? {} : loadInstalledPluginMcps();
    // Always mount ~/.slaude/ as a local plugin so the SDK discovers
    // ~/.slaude/skills/<slug>/SKILL.md and injects them into <system-reminder>.
    // skipMcpDiscovery prevents the SDK from reading slaude's own mcp.json
    // (those servers are managed separately via Options.mcpServers above).
    const slaudeHomePlugin = { type: "local" as const, path: paths.home, skipMcpDiscovery: true };
    // The built-in `slaude` plugin (read-only, shipped in src/): its skills are
    // `slaude:<name>`, named by the skill index in the core prompt.
    const builtinPlugin = { type: "local" as const, path: BUILTIN_PLUGIN_DIR, skipMcpDiscovery: true };
    const allPlugins = [slaudeHomePlugin, builtinPlugin, ...pluginPaths];
    warnPluginsNamedLikeBuiltin(allPlugins.map((p) => p.path));
    // An agent.yaml `skills` list: the Skill tool's names for it, and the SDK
    // option that hides the rest from the model's listing.
    const allowedSkills = soul.definition?.skills ? allowedSkillNames(soul.definition.skills, personaName) : null;

    // Opened after the soul resolves, so a boot that fails there holds no connection.
    const remoteHandle = await this.#remoteHandleFor(sessionId, remoteTarget);
    const resolver = this.#resolver;
    const baseCanUse: CanUseTool | undefined = resolver
      ? (toolName, input, ctx) => resolver(sessionId, toolName, input, ctx)
      : undefined;
    const canUseTool: CanUseTool | undefined = remoteHandle
      ? makeRemoteCanUseTool(baseCanUse, () => this.#live.get(sessionId)?.mode ?? mode)
      : baseCanUse;
    if (remoteHandle && localMcp && Object.hasOwn(localMcp, REMOTE_MCP_NAME)) {
      console.warn(
        `[node] session=${sessionId} MCP server '${REMOTE_MCP_NAME}' is in the node manifest; this session runs remotely, so the remote tools replace it`,
      );
    }
    let options: Options;
    let wake: WakeOptions | undefined;
    try {
      const mergedMcpServers = {
        ...(baseMcpServers ?? {}),
        ...pluginMcps,
        ...(remoteHandle && remoteTarget
          ? { [REMOTE_MCP_NAME]: createRemoteMcp({ exec: remoteHandle.exec, root: remoteTarget.dir, sessionKey: sessionId }) }
          : {}),
      };
      const hasMcpServers = Object.keys(mergedMcpServers).length > 0;
      wake = this.#wakes.get(sessionId)?.options;
      options = {
        cwd: row.working_dir,
        // Pass `model` only when explicitly set. Empty = let the SDK / CLI use
        // its own default (e.g. Claude Code subscription default under
        // CLAUDE_CODE_OAUTH_TOKEN). When pointing at a non-Anthropic gateway,
        // SLAUDE_MODEL MUST be set to a provider-qualified id.
        ...(model ? { model } : {}),
        abortController: abort,
        env: scrubChildEnv(withoutKeys({ ...process.env, ...providerEnv }, unsetChildEnv)),
        ...(canUseTool ? { canUseTool } : {}),
        ...(hasMcpServers ? { mcpServers: mergedMcpServers } : {}),
        ...(localMcp ? { strictMcpConfig: true } : {}),
        plugins: allPlugins,
        ...(allowedSkills ? { skills: sdkSkillsOption(allowedSkills, pluginPaths.map((p) => p.path)) } : {}),
        // The aliased built-ins stay enabled (an alias needs its source tool, spike §8);
        // local-only tools with no remote counterpart are removed outright.
        ...(remoteHandle ? { toolAliases: REMOTE_TOOL_ALIASES } : {}),
        disallowedTools: [...SCHEDULER_TOOLS, ...(remoteHandle ? REMOTE_DENIED_LOCAL_TOOLS : []), ...(wake ? wakeDeniedToolIds() : WAKE_ONLY_TOOL_IDS)],
        ...(wake?.maxBudgetUsd && wake.maxBudgetUsd > 0 ? { maxBudgetUsd: wake.maxBudgetUsd } : {}),
        // A Guidance delivery refusal costs a turn the wake did not choose:
        // each on-match tool guardrail can refuse once, so the cap grows by that many.
        ...(wake?.maxTurns && wake.maxTurns > 0 ? { maxTurns: wake.maxTurns + deliveryTurnAllowance(guardrails) } : {}),
        permissionMode: mode,
        ...(mode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        // Each callback is marked with its guardrail registry id (tagHook
        // returns it unchanged); the agreement test reads the marks back.
        hooks: {
          PreCompact: [{ hooks: [tagHook(HOOK_IDS.preCompact, preCompact)] }],
          Stop: [{ hooks: [tagHook(HOOK_IDS.stopMustReply, stopHook)] }],
          UserPromptSubmit: [{ hooks: [tagHook(HOOK_IDS.userPromptSuppress, userPromptHook)] }],
          // The timeout sits above the owner approve card's inner deadline
          // (spike: a hook may wait as long as its matcher allows).
          PreToolUse: [{
            timeout: approveMatcherTimeoutSec(env.guardrailApproveTimeoutSec()),
            hooks: [
              ...(remoteHandle ? [tagHook(HOOK_IDS.remoteDenyLocal, denyLocalBuiltins)] : []),
              tagHook(HOOK_IDS.guardrailFiles, guardrailFiles),
              tagHook(HOOK_IDS.ownerGuardrails, ownerGuardrails),
              tagHook(HOOK_IDS.skillGate, this.#skillGate.pre(sessionId)),
              tagHook(HOOK_IDS.profileWriteGuard, denySyntheticProfileWrite(() => this.isSyntheticTurn(sessionId))),
            ],
          }],
          PostToolUse: [{
            hooks: [
              tagHook(HOOK_IDS.skillGateMark, this.#skillGate.post(sessionId)),
              tagHook(HOOK_IDS.skillUsage, skillUsageHook(sessionId, personaName, () => this.#skillUsage)),
              tagHook(HOOK_IDS.passEndsTurn, passEndsTurnHook()),
            ],
          }],
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemAppend,
        },
        ...sessionIdOpts(row),
      };
    } catch (e) {
      // No live session will own the handle: release the connection (never
      // dispose — the user's background jobs survive a failed boot).
      if (remoteHandle) {
        await remoteHandle.release().catch((err) =>
          console.error(`[mgr] remote release failed session=${sessionId}: ${err instanceof RemoteError ? err.code : "error"}`));
      }
      throw e;
    }

    let markExited!: () => void;
    const live: LiveSession = {
      id: sessionId,
      // Every input starts a turn; its `result` ends it (#fanout).
      pushUser: (text: string, synthetic = false, sender: InputSender | null = null) => {
        live.inputSeq++;
        live.pendingInputs++;
        live.inputSynthetic.push(synthetic);
        live.inputSenders.push(sender);
        pushUser(text);
      },
      inputSynthetic: [firstSynthetic], // firstText is already queued
      inputSenders: [firstSender],
      closeIterable,
      abort,
      turn: { user: firstText, assistant: [] },
      turnTools: [],
      toolNames: new Map(),
      pendingReplies: new Map(),
      inAutoEvolve: false,
      channelId: row.slack_channel_id,
      workingDir: row.working_dir,
      mode,
      personaName,
      bootFp,
      bootedAsWake: wake !== undefined,
      inputSeq: 1, // firstText
      pendingInputs: 1, // firstText is already queued
      exited: new Promise<void>((r) => (markExited = r)),
    };
    // Every (re)boot is a fresh CLI that has not seen any built-in skill's
    // text: the loaded set starts empty. Set here, not earlier, so a boot that
    // fails before going live leaves no state behind.
    this.#skillGate.reset(sessionId);
    this.#skillGate.markMounted(sessionId, allPlugins.some((p) => p.path === BUILTIN_PLUGIN_DIR));
    this.#skillGate.setSkillListSource(sessionId, {
      read: () => this.#currentSkillNames(sessionId, personaName),
      initial: allowedSkills,
      mounted: new Set(pluginPaths.map((p) => cliPluginName(p.path))),
    });
    // A fresh CLI has been given no Guidance: deliveries start over.
    if (guardrails) this.#sessionGuardrails.set(sessionId, guardrails);
    else this.#sessionGuardrails.delete(sessionId);
    this.#guidanceDelivered.set(sessionId, new Set());
    this.#live.set(sessionId, live);
    onLive();
    metric.sessionsLive.set(this.#live.size);
    this.#armIdle(live);
    try {
      await this.#store.setStatus(sessionId, "running");
    } catch (e) {
      // The query loop never starts, so nothing else would end this live
      // session: without this, whoever waits for its turn or exit waits forever.
      if (live.idleTimer) clearTimeout(live.idleTimer);
      if (this.#live.get(sessionId) === live) {
        this.#live.delete(sessionId);
        metric.sessionsLive.set(this.#live.size);
        this.#budget.forget(sessionId);
        this.#skillGate.forget(sessionId);
        this.#forgetGuardrails(sessionId);
        this.#stopBlocked.delete(sessionId);
        void this.#remoteHandles.get(sessionId)?.handle.release().catch((err) =>
          console.error(`[mgr] remote release failed session=${sessionId}: ${err instanceof RemoteError ? err.code : "error"}`));
        markExited();
        this.#signalSessionExit(sessionId);
      } else {
        markExited();
      }
      throw e;
    }

    let stderrBuf = "";
    (options as any).stderr = (chunk: string) => {
      stderrBuf += chunk;
      process.stderr.write(`[claude-cli] ${chunk}`);
    };
    let retried = false;
    /** Teardown signalled sessionExit (the last-resort catch must not twice). */
    let exitSignalled = false;

    (async () => {
      try {
        console.log(`[mgr] query() boot session=${sessionId} model=${model} cwd=${row.working_dir} resume=${!!row.claude_started}`);
        const q = agentSdk.query({ prompt: promptIterable, options });
        live.query = q;
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          console.log(`[mgr] sdk msg type=${(msg as any).type} subtype=${(msg as any).subtype ?? "-"}`);
          this.#fanout(sessionId, msg, live);
        }
        console.log(`[mgr] query() exited session=${sessionId}`);
        // for-await ends only when the prompt iterable is closed; that is
        // session shutdown, not turn-end. We don't emit a per-turn "done"
        // here — that's done from #fanout on `result` messages.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mgr] query() threw session=${sessionId}:`, err);
        // Resume failure: provider has no record of this session id (e.g.
        // after swapping ANTHROPIC_BASE_URL across providers). Clear the
        // started flag and reboot the session w/o `resume` so the user
        // doesn't have to retry manually.
        if (RESUME_MISS_RE.test(stderrBuf)) {
          retried = true;
          console.log(`[mgr] clearing stale claude_started + retrying session=${sessionId}`);
          await this.#bestEffortStore(sessionId, "clearStarted", () => this.#store.clearStarted(sessionId));
          if (live.idleTimer) clearTimeout(live.idleTimer);
          this.#live.delete(sessionId);
          // Fire and forget — restart with the same first prompt.
          this.#retryBoot(sessionId, live, firstText, firstSynthetic, firstSender);
          return;
        }
        // Mirror failure: we seeded --session-id but a transcript with that id
        // already exists (claude_started flag lost, e.g. crash between the CLI
        // persisting and markStarted). Flip to resume and retry.
        if (/session.*(already in use|already exists)/i.test(stderrBuf)) {
          retried = true;
          console.log(`[mgr] session id already has a transcript — retrying with resume session=${sessionId}`);
          await this.#bestEffortStore(sessionId, "markStarted", () => this.#store.markStarted(sessionId));
          if (live.idleTimer) clearTimeout(live.idleTimer);
          this.#live.delete(sessionId);
          this.#retryBoot(sessionId, live, firstText, firstSynthetic, firstSender);
          return;
        }
        if (live?.reloading) {
          console.log(`[mgr] reload session=${sessionId} — suppressing expected exit error`);
        } else if (live?.abort.signal.aborted) {
          console.log(`[mgr] abort session=${sessionId} — suppressing expected abort error`);
          this.emit("event", { type: "done", sessionId } satisfies AgentEvent);
        } else {
          metric.errorsTotal.inc({ kind: "sdk" });
          this.emit("event", { type: "error", sessionId, error: message, code: "TURN_FAILED" } satisfies AgentEvent);
        }
      } finally {
        // A check turn cut off before its result (abort, reload, crash) still
        // ends its run, with the usage its assistant messages carried.
        if (live.evolveRun) this.#endEvolveRun(sessionId, live, "error", seenEvolveUsage(live.evolveRun));
        // A session detached by sendMessage's bounded reload wait no longer owns
        // the id: a fresh session may hold it, and nothing here may touch that.
        const owns = () => this.#live.get(sessionId) === live;
        if (owns()) this.#reloadAfterTurn.delete(sessionId);
        if (retried) {
          markExited();
          return;
        }
        if (live.idleTimer) clearTimeout(live.idleTimer);
        if (!owns()) {
          markExited();
          return;
        }
        await this.#bestEffortStore(sessionId, "setStatus(idle)", () => this.#store.setStatus(sessionId, "idle"));
        if (!owns()) {
          markExited();
          return;
        }
        this.#live.delete(sessionId);
        // Again after the delete: a reloadAfterTurn during the await above saw
        // this session still live and may have re-added the id, which would
        // otherwise reload the next fresh session spuriously.
        this.#reloadAfterTurn.delete(sessionId);
        // Release the connection only: a reboot (reload, stream_closed, idle TTL,
        // /mcp connect) must not kill the user's background jobs. They are killed
        // when remote ends or moves (#remoteHandleFor disposes).
        void this.#remoteHandles.get(sessionId)?.handle.release().catch((e) =>
          console.error(`[mgr] remote release failed session=${sessionId}: ${e instanceof RemoteError ? e.code : "error"}`));
        this.#budget.forget(sessionId);
        this.#skillGate.forget(sessionId);
        this.#forgetGuardrails(sessionId);
        this.#stopBlocked.delete(sessionId);
        metric.sessionsLive.set(this.#live.size);
        markExited();
        exitSignalled = true;
        // A wake cut by a closed stream is still that wake's turn: its mark,
        // caps, wall clock and run go on to the query that continues it.
        const wakeGoesOn = live.reloading && live.bootedAsWake && this.#autoContinue.has(sessionId) && this.#wakes.get(sessionId)?.inFlight === true;
        this.#signalSessionExit(sessionId, { keepWake: wakeGoesOn });
        // After a stream_closed auto-reload, inject a synthetic "continue"
        // prompt so the resumed session picks up without human input.
        if (live.reloading && this.#autoContinue.has(sessionId)) {
          this.#autoContinue.delete(sessionId);
          console.log(`[mgr] auto-continuing after stream_closed reload session=${sessionId}`);
          const text = "The MCP stream was restored. Please continue where you left off.";
          // Not through the queue: what waits there is waiting for this turn.
          if (wakeGoesOn) void this.#send(sessionId, text, true, null, live.bgRuns?.get(1)).catch((e) => this.#rebootFailed(sessionId, e, { signalExit: true }));
          else void this.#sendInOrder(sessionId, text, { synthetic: true }).catch((e) => this.#rebootFailed(sessionId, e));
        }
        // After a manual reload_session with a prompt, inject it so the user
        // doesn't need to type anything to resume the flow.
        if (live.reloading && this.#reloadPrompt.has(sessionId)) {
          const p = this.#reloadPrompt.get(sessionId)!;
          this.#reloadPrompt.delete(sessionId);
          console.log(`[mgr] injecting reload prompt session=${sessionId}`);
          void this.#sendInOrder(sessionId, p, { synthetic: true }).catch((e) => this.#rebootFailed(sessionId, e));
        }
      }
    })().catch((e) => {
      // Last resort: nothing awaits this loop, so a throw here would be an
      // unhandled rejection, which ends the whole process (a node worker
      // serves many sessions). Every known throw is handled above. A throw
      // inside teardown may have skipped its tail: finish it here, but never
      // touch a fresh session that holds the id now.
      console.error(`[mgr] session loop failed session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      if (retried) return markExited();
      const owned = this.#live.get(sessionId) === live;
      if (owned) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        this.#live.delete(sessionId);
        this.#skillGate.forget(sessionId);
        this.#forgetGuardrails(sessionId);
      }
      markExited();
      if (!exitSignalled && (owned || !this.#live.has(sessionId))) {
        exitSignalled = true;
        this.#signalSessionExit(sessionId);
      }
    });
  }

  /**
   * A session-row write from the detached query loop (teardown status, the
   * started flag). Nothing awaits that loop, so a rejection would be
   * unhandled and end the process; and teardown must still finish (drop the
   * live entry, signal sessionExit to a voice call). On a node the store is
   * the gateway's /v1, authenticated by the last job token bound for the
   * session, which a session that outlived its job may hold expired. The
   * write is lost and logged; the row is corrected by the next turn.
   */
  async #bestEffortStore(sessionId: string, what: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (e) {
      console.error(`[mgr] session store ${what} failed session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  }

  #fanout(sessionId: string, msg: SDKMessage, owner: LiveSession) {
    // A session detached by sendMessage's bounded reload wait keeps running its
    // own query loop, but no longer owns the id: a fresh session may hold it.
    // Its late messages must not join the fresh session's turn, nor decrement
    // its outstanding inputs (which could apply a deferred reload under it).
    if (this.#live.get(sessionId) !== owner) return;
    const live = owner;
    switch (msg.type) {
      case "assistant": {
        live.activeSinceResult = true;
        void this.#bestEffortStore(sessionId, "markStarted", () => this.#store.markStarted(sessionId));
        // The context fill is this call's prompt, not the result's per-turn sum.
        // A subagent's messages (parent_tool_use_id set) run in their own context.
        if (!(msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
          this.#budget.notePrompt(sessionId, (msg.message as { usage?: PromptUsage }).usage);
        }
        // The SDK's BetaContentBlock union types only text + tool_use, but the
        // model also emits thinking blocks at runtime. Widen so the thinking
        // branch type-checks (both the discriminant and `.thinking`).
        type ThinkingBlock = { type: "thinking"; thinking: string };
        const evolve = live?.inAutoEvolve ? { autoEvolve: true } : {};
        if (live?.inAutoEvolve && live.evolveRun) noteEvolveUsage(live.evolveRun, msg.message as { id?: string; model?: string; usage?: unknown });
        else if (live) {
          const reported = (msg.message as { model?: unknown }).model;
          if (typeof reported === "string" && reported) live.lastAssistantModel = reported;
        }
        const blocks = msg.message.content as Array<
          (typeof msg.message.content)[number] | ThinkingBlock
        >;
        for (const block of blocks) {
          if (block.type === "text") {
            if (live) recordAnswer(live.turn.assistant, block.text);
            this.emit("event", {
              type: "assistantText",
              sessionId,
              text: block.text,
              ...evolve,
            } satisfies AgentEvent);
          } else if (block.type === "thinking") {
            this.emit("event", {
              type: "thinking",
              sessionId,
              text: block.thinking,
              ...evolve,
            } satisfies AgentEvent);
          } else if (block.type === "tool_use") {
            if (live) live.turnTools.push(block.name);
            const toolUseId = typeof block.id === "string" && block.id ? block.id : undefined;
            if (live && toolUseId) live.toolNames.set(toolUseId, block.name);
            // What the agent said through a reply tool is the turn's answer:
            // held here until its result says it was delivered (see toolResult).
            const replied = replyToolText(block.name, block.input);
            if (live && replied && toolUseId && !live.inAutoEvolve) live.pendingReplies.set(toolUseId, replied);
            metric.toolCallsTotal.inc({ tool: block.name });
            this.emit("event", {
              type: "toolCall",
              sessionId,
              tool: block.name,
              input: block.input,
              ...(toolUseId ? { toolUseId } : {}),
              ...evolve,
            } satisfies AgentEvent);
          }
        }
        break;
      }
      case "user": {
        if (msg.tool_use_result !== undefined) {
          live.activeSinceResult = true;
          // Detect stream_closed cascade: an external MCP server disconnecting
          // can tear down the SDK's shared MCP transport pool, causing ALL
          // in-process slaude_* tool calls to fail with "Stream closed".
          // Flag the session so the turn-end "result" handler can reload.
          const r = msg.tool_use_result as any;
          if (r?.is_error && !this.#pendingReload.has(sessionId)) {
            const text =
              typeof r.content === "string"
                ? r.content
                : Array.isArray(r.content)
                ? r.content.map((b: any) => (typeof b === "string" ? b : (b?.text ?? ""))).join(" ")
                : "";
            if (/stream.?closed/i.test(text)) {
              console.warn(`[mgr] stream_closed tool error detected session=${sessionId}`);
              this.#pendingReload.add(sessionId);
              const prev = this.#streamClosedCount.get(sessionId) ?? 0;
              this.#streamClosedCount.set(sessionId, prev + 1);
            }
          }
          const toolUseId = toolResultId(msg.message);
          const tool = toolUseId ? (live?.toolNames.get(toolUseId) ?? "") : "";
          if (toolUseId) live?.toolNames.delete(toolUseId);
          // A reply joins the conversation record once delivered: posted, or
          // held in the console (the operator got it). A refused or failed one
          // reached nobody.
          const pendingReply = toolUseId ? live?.pendingReplies.get(toolUseId) : undefined;
          if (toolUseId && pendingReply !== undefined) {
            live!.pendingReplies.delete(toolUseId);
            if (replyDelivered(msg.message, msg.tool_use_result)) recordAnswer(live!.turn.assistant, pendingReply);
          }
          this.emit("event", {
            type: "toolResult",
            sessionId,
            tool,
            ...(toolUseId ? { toolUseId } : {}),
            result: msg.tool_use_result,
            ...(live?.inAutoEvolve ? { autoEvolve: true } : {}),
          } satisfies AgentEvent);
        }
        break;
      }
      case "result": {
        const resultError = msg.is_error ? ("errors" in msg && Array.isArray((msg as any).errors) ? (msg as any).errors.join("; ") : msg.subtype) : "";
        const resumeMiss = RESUME_MISS_RE.test(resultError);
        if (live) {
          // Settled first so no branch below can miss it; a waiting input resumes
          // only after this handler returns, and reads the session again then.
          live.checkEnded?.resolve();
          live.checkEnded = undefined;
          // A call still open when its turn ends never gets a result.
          live.toolNames.clear();
          live.pendingReplies.clear();
          // The input this result ends: the oldest outstanding one.
          const endedSeq = live.inputSeq - live.pendingInputs + 1;
          // A wake's own input is always this query's first (it boots for it).
          const wakesTurn = live.bootedAsWake && endedSeq === 1;
          // Its turn is not over when the same wake is about to run again: a
          // resume miss reboots it, and a closed stream continues it.
          const wakeGoesOn = wakesTurn && (resumeMiss || (this.#pendingReload.has(sessionId) && (this.#streamClosedCount.get(sessionId) ?? 1) <= 2));
          const bgRun = wakeGoesOn ? undefined : live.bgRuns?.get(endedSeq);
          if (bgRun) live.bgRuns!.delete(endedSeq);
          live.pendingInputs = Math.max(0, live.pendingInputs - 1);
          live.inputSynthetic.shift();
          live.inputSenders.shift();
          live.lastResultAt = Date.now();
          live.activeSinceResult = false;
          live.turnEnded?.resolve();
          live.turnEnded = undefined;
          // Anything left never fired its hook (the CLI folded it into a turn).
          // Not on a resume miss: the retried boot runs that same input.
          if (live.pendingInputs === 0 && !resumeMiss) this.#inputSuppression.delete(sessionId);
          if (wakesTurn && !wakeGoesOn) this.#wakeEnded(sessionId);
          // The check turn's result: its own usage (this result's running
          // modelUsage minus the qualifying turn's) ends its budgeted run.
          const r = msg as { subtype?: string; is_error?: boolean; usage?: Partial<ResultUsage>; modelUsage?: Record<string, ModelUsageRow>; num_turns?: number; duration_ms?: number };
          if (live.inAutoEvolve && live.evolveRun) {
            const ok = r.subtype === "success" && !r.is_error;
            this.#endEvolveRun(sessionId, live, ok ? "ok" : "error", turnModelTokens(r.modelUsage, live.evolveRun.base, r.usage));
          }
          if (bgRun) {
            const ok = r.subtype === "success" && !r.is_error;
            const usage = turnModelTokens(r.modelUsage, live.lastModelUsage, r.usage);
            const wake = this.#wakes.has(sessionId);
            const cap = wake ? (r.subtype === "error_max_budget_usd" ? ("usd" as const) : r.subtype === "error_max_turns" ? ("turns" as const) : undefined) : undefined;
            const stats = wake ? { ...(r.num_turns !== undefined ? { turns: r.num_turns } : {}), ...(r.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}), ...(cap ? { cap } : {}) } : undefined;
            void bgRun.finish(usage, ok ? "ok" : cap ? "stopped-budget" : "error", stats).catch((e) => {
              console.error(`[mgr] background run ${bgRun.runId} could not be recorded session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
            });
          }
          if (r.modelUsage) live.lastModelUsage = Object.fromEntries(Object.entries(r.modelUsage).map(([k, v]) => [k, { ...v }]));
        }
        // A reload deferred by reloadAfterTurn applies once NO input is
        // outstanding: another queued input (e.g. a user message behind an
        // auto-evolve turn) still needs the CLI's stdin.
        const deferredReload = (live?.pendingInputs ?? 0) === 0 && this.#reloadAfterTurn.delete(sessionId);
        // Stream-closed circuit breaker: if a stream_closed error was detected
        // during this turn, handle at turn-end (clean exit point).
        if (this.#pendingReload.has(sessionId)) {
          this.#pendingReload.delete(sessionId);
          if (live) this.#flushTurn(live);
          const count = this.#streamClosedCount.get(sessionId) ?? 1;
          if (count <= 2) {
            console.warn(`[mgr] stream_closed auto-reload session=${sessionId} attempt=${count}/2`);
            this.#autoContinue.add(sessionId);
            this.noteSessionEvent(sessionId, `⚠️ MCP stream closed (auto-reload ${count}/2) — recovering…`);
            this.reload(sessionId);
          } else {
            // Circuit open — stop reloading; surface the failure directly.
            console.warn(`[mgr] stream_closed circuit open session=${sessionId} count=${count}`);
            this.emit("event", {
              type: "error",
              sessionId,
              error: `MCP stream closed ${count}× in a row — circuit open, not auto-reloading. Send any message to restart.`,
              code: "TURN_FAILED",
            } satisfies AgentEvent);
            // A config reload still applies: it is not an MCP recovery attempt.
            if (deferredReload) this.reload(sessionId);
          }
          this.#releaseIfIdle(sessionId, live);
          break;
        }
        // Clean turn — reset the circuit breaker counter.
        this.#streamClosedCount.delete(sessionId);

        // End of one user→assistant turn. Persist memory + signal listeners.
        if (live) {
          this.#flushTurn(live);
          this.#armIdle(live);
        }
        // Record token usage from the SDK's result message and surface
        // crossings of the warn / critical thresholds (edge-triggered).
        if ((msg as any).usage && (msg as any).modelUsage) {
          this.#budget.record(sessionId, {
            usage: (msg as any).usage,
            modelUsage: (msg as any).modelUsage,
          });
          const snapshot = this.#budget.snapshot(sessionId)!;

          const channelId = live?.channelId ?? "unknown";
          const modelUsageKeys = Object.keys((msg as any).modelUsage ?? {});
          const modelName = modelUsageKeys[0] ?? env.model() ?? "unknown";
          const baseLabels = { channel_id: channelId, model: modelName };

          metric.tokensTotal.inc({ ...baseLabels, kind: "input" }, (msg as any).usage.input_tokens ?? 0);
          metric.tokensTotal.inc({ ...baseLabels, kind: "output" }, (msg as any).usage.output_tokens ?? 0);
          metric.tokensTotal.inc({ ...baseLabels, kind: "cache_read" }, (msg as any).usage.cache_read_input_tokens ?? 0);
          metric.tokensTotal.inc({ ...baseLabels, kind: "cache_creation" }, (msg as any).usage.cache_creation_input_tokens ?? 0);
          metric.contextWindowPct.set(snapshot.pctUsed);
          this.emit("event", {
            type: "tokenUsage",
            sessionId,
            snapshot,
          } satisfies AgentEvent);
        }
        if (msg.is_error) {
          const errStr: string = resultError;
          // A resume miss also arrives here as a result(is_error), in parallel
          // with the stderr/throw that drives the silent reboot in #startSession.
          // Suppress the user-facing emit so the self-healing migration stays
          // invisible — the catch path recovers it; surfacing a :warning: here
          // just scares the user about an expected, already-handled condition.
          if (resumeMiss) {
            console.log(`[resume-attempt] suppressing resume-miss result error session=${sessionId} (reboot will reseed --session-id)`);
            if (live) live.turnTools = [];
          } else if (this.#wakes.has(sessionId)) {
            // Nobody is in a wake's turn: its ledger run and state record this,
            // and the manager hears after repeated failures. A cap is not an
            // incident, and a failed wake must not be retried at full cost.
            metric.turnsTotal.inc({ result: "error" });
            console.log(`[mgr] wake session=${sessionId} ended: ${redactSecrets(errStr)}`);
            if (live) live.turnTools = [];
            this.emit("event", { type: "done", sessionId } satisfies AgentEvent);
          } else {
            metric.turnsTotal.inc({ result: "error" });
            metric.errorsTotal.inc({ kind: "turn" });
            // A failed check turn is over too: the next turn is not a check.
            if (live) live.inAutoEvolve = false;
            this.emit("event", {
              type: "error",
              sessionId,
              error: errStr,
              code: "TURN_FAILED",
            } satisfies AgentEvent);
            if (live) live.turnTools = [];
          }
        } else {
          const wasAutoEvolve = live?.inAutoEvolve === true;
          if (live) live.inAutoEvolve = false;
          metric.turnsTotal.inc({ result: "success" });
          this.emit("event", {
            type: "done",
            sessionId,
            ...(wasAutoEvolve ? { autoEvolve: true } : {}),
          } satisfies AgentEvent);
          // Never during a voice call: the follow-up turn would occupy the
          // session and the next delegated request would queue behind it.
          if (live && !wasAutoEvolve && !deferredReload && !voiceCallActive(sessionId) && this.#shouldAutoEvolve(live)) {
            live.turnTools = [];
            const budget = this.#backgroundBudget;
            if (!budget) {
              this.#pushCheck(live);
            } else if (live.pendingInputs === 0) {
              void this.#startBudgetedCheck(sessionId, live, budget, live.inputSeq);
            } else {
              // A queued message would run first and be taken for the check.
              console.log(`[mgr] skill check skipped session=${sessionId}: a newer message is already queued`);
            }
          } else if (live) {
            live.turnTools = [];
          }
        }
        if (deferredReload && live) this.reload(sessionId);
        this.#releaseIfIdle(sessionId, live);
        break;
      }
      default:
        break;
    }
  }

  /** Free the proactive folder once no input of this session is outstanding
   *  (checked after an unbudgeted skill check may have been pushed). */
  #releaseIfIdle(sessionId: string, live: LiveSession | undefined): void {
    if (live && live.pendingInputs > 0) return;
    this.#claims.releaseHolder(sessionId);
  }

  /**
   * Start the check's budgeted run, then push the check prompt. Fails closed:
   * a refused start, or one that throws (network, gateway error), skips the
   * check with one log line, so it never runs unbudgeted. A session that moved
   * on while the run started (any input pushed since, a reload, a voice call, gone)
   * ends the run as `error` with no usage instead of running the check.
   */
  async #startBudgetedCheck(sessionId: string, live: LiveSession, budget: SkillCheckBudget, seq: number): Promise<void> {
    let r: { ok: boolean; runId?: string };
    try {
      r = await budget.start(sessionId, live.personaName ?? "default", live.lastAssistantModel);
    } catch (e) {
      console.warn(`[mgr] skill check skipped session=${sessionId}: its budgeted run could not start: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      return;
    }
    if (!r.ok || !r.runId) {
      console.log(`[mgr] skill check skipped session=${sessionId}: refused by the background budget`);
      return;
    }
    const run: EvolveRun = { budget, runId: r.runId, base: live.lastModelUsage, seen: new Map() };
    const movedOn =
      this.#live.get(sessionId) !== live ||
      // Any input since the qualifying turn ended, even one whose turn has
      // already finished: the check would no longer follow that turn.
      live.inputSeq !== seq ||
      live.pendingInputs > 0 ||
      live.inAutoEvolve ||
      live.reloading === true ||
      live.abort.signal.aborted ||
      this.#reloadAfterTurn.has(sessionId) ||
      voiceCallActive(sessionId);
    if (movedOn) {
      console.log(`[mgr] skill check abandoned session=${sessionId}: the session moved on while its run started`);
      this.#finishEvolveRun(sessionId, run, "error", {});
      return;
    }
    // Pushed after its turn freed the proactive folder: the check takes the
    // folder only when it is free (at once), and is skipped, never queued,
    // when another thread there holds it or waits for it.
    if (isProactiveWorkspace(live.workingDir)) {
      const holder = this.#claims.holderOf(live.workingDir!);
      if (holder !== null && holder !== sessionId) {
        console.log(`[mgr] skill check abandoned session=${sessionId}: another thread holds the proactive folder`);
        this.#finishEvolveRun(sessionId, run, "error", {});
        return;
      }
      void this.#claims.acquire(live.workingDir!, sessionId);
    }
    live.evolveRun = run;
    this.#pushCheck(live);
  }

  /** Start the check turn. Later inputs wait for its result (LiveSession.checkEnded). */
  #pushCheck(live: LiveSession): void {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    live.checkEnded = { promise, resolve };
    live.inAutoEvolve = true;
    live.pushUser(AUTO_EVOLVE_PROMPT, true);
  }

  /** End the session's open check run (once). */
  #endEvolveRun(sessionId: string, live: LiveSession, outcome: "ok" | "error", usage: ModelTokens): void {
    const run = live.evolveRun;
    if (!run) return;
    live.evolveRun = undefined;
    this.#finishEvolveRun(sessionId, run, outcome, usage);
  }

  /** Detached: nothing awaits it, so a failure is logged, never thrown. */
  #finishEvolveRun(sessionId: string, run: EvolveRun, outcome: "ok" | "error", usage: ModelTokens): void {
    void run.budget.finish(sessionId, run.runId, { usage, outcome }).catch((e) => {
      console.error(`[mgr] skill check run ${run.runId} could not be recorded session=${sessionId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    });
  }

  #flushTurn(live: LiveSession) {
    if (!live.turn.user || live.turn.assistant.length === 0) return;
    // The per-turn <memory-context> block is for this turn only, never the transcript.
    const user = stripTurnMemoryContext(live.turn.user);
    const assistant = live.turn.assistant.join("\n");
    live.turn = { user: "", assistant: [] };
    void this.#memory.syncTurn({ sessionId: live.id, user, assistant }).catch((e) => {
      console.error(`[mgr] memory sync failed session=${live.id}:`, e instanceof Error ? e.message : e);
    });
  }

  /**
   * Decide whether the just-finished turn should be followed by an
   * auto-evolve check. Triggers when the turn used at least
   * `env.autoEvolveMinTools()` (default 4) "substantive" tools, at least one
   * of them mutating (excludes pure Slack surface ops, skill introspection,
   * and trivial reads). Skips when the
   * turn already wrote/deleted a skill (no need to re-prompt).
   */
  #shouldAutoEvolve(live: LiveSession): boolean {
    if (!env.autoEvolve()) return false;
    // A wake skips the check: the nightly skill review still sees its work.
    // Read from the query, not the mark, which a person's message clears.
    if (live.bootedAsWake) return false;
    const tools = live.turnTools;
    if (tools.some((t) =>
      t === "mcp__slaude_skills__write_skill" ||
      t === "mcp__slaude_skills__delete_skill"
    )) return false;
    let substantive = 0;
    let mutating = false;
    for (const raw of tools) {
      // A /remote alias is its built-in run elsewhere: classify it as one.
      const t = REMOTE_ALIAS_BUILTIN.get(raw) ?? raw;
      if (AUTO_EVOLVE_IGNORE.has(t)) continue;
      if (t.startsWith("mcp__slaude_surface__")) continue;   // interaction output ≠ substantive work
      if (t.startsWith("mcp__slaude_runtime__")) continue;   // housekeeping ≠ substantive work
      if (t.startsWith("mcp__slaude_slack__")) continue;     // deprecated namespace (transition)
      if (t.startsWith("mcp__slaude_skills__")) continue;
      substantive++;
      if (MUTATING_TOOLS.has(t) || (t.startsWith("mcp__") && !t.startsWith("mcp__slaude_"))) mutating = true;
    }
    return substantive >= env.autoEvolveMinTools() && mutating;
  }
}

/** Record one check-turn assistant message's usage (one API call arrives as
 *  several messages sharing an id: counted once, the last copy wins). Its
 *  output counts as at least PROVISIONAL_OUTPUT_TOKENS: the CLI reports
 *  message_start's usage here (see the pass runner). */
function noteEvolveUsage(run: EvolveRun, m: { id?: string; model?: string; usage?: unknown } | undefined): void {
  if (!m?.usage) return;
  const t = tokensFromUsage(m.usage as ResultUsage);
  t.output = Math.max(t.output, PROVISIONAL_OUTPUT_TOKENS);
  run.seen.set(m.id ?? `anon-${run.seen.size}`, { model: m.model ?? "", tokens: t });
}

/** The check turn's usage so far, per model ("" = the run's own model). */
function seenEvolveUsage(run: EvolveRun): ModelTokens {
  const out: ModelTokens = {};
  for (const { model, tokens } of run.seen.values()) out[model] = out[model] ? addTokens(out[model]!, tokens) : tokens;
  return out;
}

/** Bound on sendMessage's wait for a reloading session's CLI to exit. */
const RELOAD_EXIT_TIMEOUT_MS = 30_000;

/** Silence after a result that means the inputs still counted were folded into
 *  a turn already answered (LiveSession.checkEnded): they will get no result. */
const FOLDED_INPUT_QUIET_MS = 30_000;

/** Tools that don't count toward the auto-evolve trigger threshold. */
const AUTO_EVOLVE_IGNORE = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "TodoWrite",
]);

/** `/remote` alias (`mcp__remote__read`) → the built-in it stands for (`Read`). */
/** A tool's names in a remote session: the alias and the builtin it stands for. */
const remoteToolNames = aliasNames(REMOTE_TOOL_ALIASES);
const REMOTE_ALIAS_BUILTIN = new Map(Object.entries(REMOTE_TOOL_ALIASES).map(([builtin, alias]) => [alias, builtin]));

/** Built-in tools that mutate state; any external `mcp__` tool also counts. */
const MUTATING_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Injected as a synthetic user message after substantial turns. The agent
 * must either save/refine a skill OR end the turn without any tool call.
 * The adapter recognizes the `autoEvolve` flag on the resulting `done`
 * event and suppresses the "no reply emitted" warning so silent NO is fine.
 */
const AUTO_EVOLVE_PROMPT = [
  '<runtime-check kind="auto-evolve">',
  "<auto-evolve>",
  "The previous turn used multiple tools. Evaluate: did it perform a procedure worth saving as a reusable skill, or refine an existing one?",
  "",
  "If YES:",
  "  1. Load `slaude:skill-authoring` with the Skill tool (skip if already loaded this session), then call `mcp__slaude_skills__list_skills` (skip if you've already listed this session).",
  "  2. Decide: create-new vs refine-existing. If refining, call `mcp__slaude_skills__read_skill` first.",
  "  3. Call `mcp__slaude_skills__write_skill` with slug/name/description/body. Parameterize body via `${SLAUDE_SKILL_ARGS}` so it generalizes.",
  "  4. Do not tell the user. Skill changes are reported to the manager separately.",
  "",
  "If NO:",
  "  End the turn immediately: no tool call, no reply, no pass.",
  "",
  "Do NOT redo the original task. Do NOT save one-off facts (those belong in memory). Skills are for repeatable multi-step procedures.",
  "Only save a procedure that took several steps and that you would plausibly repeat.",
  "</auto-evolve>",
  "</runtime-check>",
].join("\n");

/** An agent.yaml's soul is prose: its global mandate reaches the prompt here. */
function compiledMandateBlock(soul: PersonaSoul): string {
  if (!soul.definition) return "";
  const parsed = SoulDataSchema.safeParse(soul.soulJson);
  const mandate = parsed.success ? parsed.data.mandate?.trim() : "";
  return mandate ? `<mandate>\n${mandate}\n</mandate>` : "";
}

/**
 * Scoped mandate: when a sub-mandate applies here (a `## Channel` block's
 * `### Mandate`, or a `## Scope` block), the resolver's effective text as an
 * authoritative directive that supersedes the global Mandate (which lives,
 * unedited, inside the <persona> text block).
 *
 * With a structured soul from the persona soul resolver (a node's runtime
 * bundle), the mandate comes from that persona's own soul. Without one (mono,
 * the gateway, or a bundle carrying no structured soul), from the persona's own
 * text via personaMandateText, so a named persona never reads the default
 * persona's sub-mandates. A structured soul that
 * is present but does not parse yields NO channel mandate: falling back to the
 * global soul would hand this persona another persona's mandate.
 */
function channelMandateBlock(
  channelId: string | null | undefined,
  soulJson: unknown,
  sessionId: string,
  persona: string | undefined,
): string {
  if (!channelId) return "";
  let eff: string | undefined;
  let base: string | undefined;
  const parsed = soulJson == null ? null : SoulDataSchema.safeParse(soulJson);
  if (parsed && !parsed.success) {
    console.warn(`[agent] session=${sessionId} persona=${persona ?? "default"} structured soul did not parse; no channel mandate`);
    return "";
  }
  if (parsed?.success) {
    base = parsed.data.mandate?.trim();
    eff = resolveSoulMandate(parsed.data, channelId, parsed.data).text.trim();
  } else {
    const own = personaMandateText(persona);
    base = own.global;
    eff = effectiveMandateIn(own, channelId).text.trim();
  }
  if (!eff || eff === base) return "";
  return `<channel-mandate>\nFor this channel your mandate is: ${eff}\nThis supersedes the Mandate section in your persona for this channel.\n</channel-mandate>`;
}
