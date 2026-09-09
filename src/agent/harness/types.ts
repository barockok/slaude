/**
 * Harness port — the seam between slaude and whatever agent runtime drives a
 * session (claude-agent-sdk today; codex / pi / dsh candidates).
 *
 * Design rule: this file names slaude's *requirements*, not any one vendor's
 * API. Every type here is either (a) something slaude must be able to say to a
 * harness, or (b) something slaude must be able to observe from one. Vendor
 * shapes are translated at the adapter boundary and never leak past it.
 *
 * See docs/site/_content/field-notes/2026-09-09-harness-abstraction.md.
 */

import type { UsageSnapshot } from "../token-budget";
import type { PermissionMode } from "../manager";

/** Harness implementations slaude knows how to describe. Open for third parties. */
export type HarnessId = "claude" | "codex" | "pi" | "dsh" | (string & {});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Neutral lifecycle points. Named for what slaude does at them, not for the
 * vendor event that happens to back them:
 *   sessionStart     — session boots (claude SessionStart / codex SessionStart)
 *   userPromptSubmit — a user turn is enqueued, before the model runs
 *   preToolUse       — a tool call is proposed, before it executes
 *   postToolUse      — a tool call returned
 *   preCompact       — context compaction is about to run
 *   turnEnd          — the model wants to end the turn (claude Stop)
 *   sessionEnd       — session torn down
 */
export type HookPoint =
  | "sessionStart"
  | "userPromptSubmit"
  | "preToolUse"
  | "postToolUse"
  | "preCompact"
  | "turnEnd"
  | "sessionEnd";

export type HookRequest = {
  point: HookPoint;
  sessionId: string;
  /** preToolUse / postToolUse only. */
  tool?: { name: string; input: Record<string, unknown>; id?: string };
  /** userPromptSubmit only — the text about to be processed. */
  prompt?: string;
  /** preCompact only. */
  compactTrigger?: "auto" | "manual";
};

/**
 * What a hook may decide. The halt/block split is load-bearing and must survive
 * translation into every adapter — they are NOT interchangeable:
 *
 *   continue — proceed; `addContext` is injected as model-visible context.
 *   halt     — the input is *persisted to the transcript* but the model does
 *              not run. slaude uses this for disengaged threads so a later
 *              re-engage resumes with the gap already in history
 *              (field note 2026-06-16). Maps to claude `continue:false`.
 *   block    — the model DOES keep running; `reason` is fed back to it. slaude
 *              uses this for the KB-first stop guard. Maps to claude
 *              `decision:"block"`. On claude this discards a userPromptSubmit
 *              prompt pre-persist, which is exactly why it is not `halt`.
 *   deny     — preToolUse only: refuse the tool call, tell the model why.
 */
export type HookDecision =
  | { action: "continue"; addContext?: string }
  | { action: "halt"; reason: string; silent?: boolean }
  | { action: "block"; reason: string }
  | { action: "deny"; reason: string };

export type HookHandler = (req: HookRequest) => Promise<HookDecision> | HookDecision;

// ---------------------------------------------------------------------------
// Tool permission gate
// ---------------------------------------------------------------------------

/**
 * Per-call approval. Distinct from a preToolUse hook because it is *interactive*
 * — slaude parks the turn on a Slack Block Kit button press and resumes on the
 * answer. A harness whose only gate is a fire-and-forget hook cannot host the
 * approval gate; see `HarnessCapabilities.permissionGate`.
 */
export type ToolPermissionRequest = {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
};

export type ToolPermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type ToolPermissionHandler = (
  req: ToolPermissionRequest,
) => Promise<ToolPermissionDecision>;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** What a slaude-implemented tool returns. Same shape every harness can render. */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * A tool slaude implements itself, described without reference to any vendor.
 * MCP is one way to mount these, not the definition of them: claude wraps them
 * in an in-process SDK MCP server, pi registers them through an extension, dsh
 * through its tool-registry plugin, codex has to reach them over a bridge.
 */
export type NeutralTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Adapters convert to their own validator. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

/**
 * How slaude wants a tool namespace mounted.
 *
 * `inProcess` is the one slaude actually depends on — the surface tools (reply,
 * request_approval, upload, react) close over live Slack state and a pending
 * approval map, so they cannot live in a subprocess. A harness that cannot host
 * in-process tools must be served by a loopback bridge; see the "surface-tools"
 * requirement in capabilities.ts.
 *
 * `vendorMcp` is a migration escape hatch: slaude's existing toolsets are built
 * with createSdkMcpServer, and porting them all to NeutralTool is phase-3 work.
 * Only the claude adapter accepts it; every other adapter must reject it, which
 * is what keeps the escape hatch from quietly becoming the design.
 */
export type ToolsetSpec =
  | { kind: "inProcess"; name: string; tools: NeutralTool[] }
  | { kind: "vendorMcp"; name: string; instance: unknown }
  | { kind: "stdio"; name: string; command: string; args: string[]; env?: Record<string, string> }
  | { kind: "http"; name: string; url: string; headers?: Record<string, string> };

// ---------------------------------------------------------------------------
// Session spec
// ---------------------------------------------------------------------------

/**
 * Everything slaude hands a harness to boot one session. Adapters translate
 * this into their vendor options object; nothing else in slaude may construct
 * vendor options directly.
 */
export type HarnessSessionSpec = {
  sessionId: string;
  cwd: string;
  /** Empty = let the harness pick its own default (subscription default etc). */
  model?: string;
  permissionMode: PermissionMode;
  env: Record<string, string>;
  /**
   * `base:"harnessDefault"` keeps the vendor's own coding-agent preamble (claude
   * `systemPrompt.preset`); slaude's persona/mandate/mode/memory blocks are
   * appended in order. A harness that can only *replace* its system prompt must
   * declare so — slaude then has to ship its own baseline.
   */
  systemPrompt: { base: "harnessDefault" | "none"; append: string[] };
  toolsets: ToolsetSpec[];
  /** Directories scanned for SKILL.md-style capabilities. */
  skillRoots: string[];
  hooks: Partial<Record<HookPoint, HookHandler>>;
  permission?: ToolPermissionHandler;
  /** Continue a prior conversation the harness already owns a transcript for. */
  resume?: { id: string };
  abort: AbortSignal;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Neutral event stream. Deliberately the same shape as `AgentEvent` minus
 * `sessionId` (the manager stamps it), so the gateway/Slack renderers keep
 * working unchanged when a session is driven by a non-claude harness.
 */
export type HarnessEvent =
  | { type: "turnStart" }
  | { type: "assistantText"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; tool: string; input: unknown; id?: string }
  | { type: "toolResult"; tool: string; result: unknown; isError?: boolean; id?: string }
  | { type: "usage"; snapshot: UsageSnapshot }
  | { type: "compacting"; trigger: "auto" | "manual" }
  | { type: "done" }
  | { type: "error"; error: string };

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a harness can actually do. Every field exists because slaude depends on
 * it somewhere; a `false` here forces either a documented degradation or a hard
 * boot failure (see negotiate()).
 */
export type HarnessCapabilities = {
  id: HarnessId;
  /** Human label for boot logs and /harness output. */
  label: string;
  /**
   * Can slaude push additional user turns into an already-running session
   * (claude's async-generator prompt iterable)? false → the manager must queue
   * messages and run them one turn at a time.
   */
  streamingInput: boolean;
  /**
   * native — harness owns the transcript, resume by id.
   * replay — no native resume; slaude must re-send prior context each boot.
   * none   — every turn starts cold.
   */
  resume: "native" | "replay" | "none";
  /** append — vendor preamble kept, slaude blocks appended. replace — slaude must supply the whole prompt. file — prompt only settable via an on-disk file (AGENTS.md / SYSTEM.md). */
  systemPrompt: "append" | "replace" | "file";
  /** Lifecycle points the harness actually fires. */
  hooks: readonly HookPoint[];
  /** Which HookDecision actions the harness can express. */
  hookDecisions: { addContext: boolean; halt: boolean; block: boolean; deny: boolean };
  /** callback — synchronous in-process approval fn (claude canUseTool). hook — decision must come from a hook handler. none — no gate. */
  permissionGate: "callback" | "hook" | "none";
  /**
   * inProcess — can host slaude-implemented tools inside the runtime process by
   * ANY mechanism (sdk mcp server, extension registration, plugin registry).
   * mcpStdio / mcpHttp — can attach external MCP servers over those transports,
   * which is also what a loopback bridge needs when inProcess is false.
   */
  tools: { inProcess: boolean; mcpStdio: boolean; mcpHttp: boolean };
  /** Mutating a live session without rebooting it. */
  liveControls: { model: boolean; permissionMode: boolean; interrupt: boolean };
  compaction: "native" | "none";
  /** Does the event stream carry token accounting (input/output/cache)? */
  usageReporting: boolean;
  /** Free-text caveats surfaced in boot logs. */
  notes?: readonly string[];
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** A live harness session: an event stream plus the controls slaude needs. */
export type HarnessSession = {
  /** Neutral event stream for the life of the session. */
  events: AsyncIterable<HarnessEvent>;
  /** Enqueue another user turn. Adapters without streamingInput queue internally. */
  send(text: string): void;
  /** Close the input side; the stream ends after the in-flight turn. */
  end(): void;
  /** Best-effort live controls; reject if the capability is absent. */
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  interrupt(): Promise<void>;
};

export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  /** Boot a session. Throws if the spec asks for something capabilities deny. */
  start(spec: HarnessSessionSpec): Promise<HarnessSession>;
}
