import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  query,
  type SDKMessage,
  type Options,
  type CanUseTool,
  type Query,
  type McpServerConfig,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { TokenBudget, type UsageSnapshot } from "./token-budget";
import { m as metric } from "../metrics";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";
import { paths } from "../config/home";
import { env } from "../config/env";
import { loadInstalledPluginPaths, loadInstalledPluginMcps } from "../config/plugins";
import { soulSystemBlock } from "../soul/loader";
import * as Sessions from "../db/sessions";
import type { ThreadKey } from "../db/sessions";
import * as OneOnOne from "../db/one-on-one";
import { memory } from "../memory/sqlite-provider";
import { scrubChildEnv } from "./child-env";
import { resolveSessionConfigDir } from "./oauth-home";

type LiveSession = {
  id: string;
  pushUser: (text: string) => void;
  closeIterable: () => void;
  abort: AbortController;
  /** Buffer of last user message + accumulated assistant text for memory.syncTurn. */
  turn: { user: string; assistant: string[] };
  /** Tool names invoked during the current turn (cleared on result). */
  turnTools: string[];
  /** Set after we inject an auto-evolve synthetic prompt — the next result
   *  is the evolution turn itself; don't recurse into another auto-evolve. */
  inAutoEvolve: boolean;
  /** Set after the SDK query() resolves; lets us call setPermissionMode/setModel live. */
  query?: Query;
  /** Idle TTL timer; cleared/rearmed on every user msg and turn-end. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Set when reload_session is called so expected exit errors are suppressed. */
  reloading?: boolean;
};

export type AgentEvent =
  | { type: "assistantText"; sessionId: string; text: string }
  | { type: "toolCall"; sessionId: string; tool: string; input: unknown }
  | { type: "toolResult"; sessionId: string; tool: string; result: unknown }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "turnStart"; sessionId: string }
  | { type: "done"; sessionId: string; autoEvolve?: boolean }
  | { type: "error"; sessionId: string; error: string }
  | { type: "tokenUsage"; sessionId: string; snapshot: UsageSnapshot }
  | { type: "compacting"; sessionId: string; trigger: "manual" | "auto" };

/** Permission resolver — called per tool use; given a sessionId so transports can present UI in the right thread. */
export type PermissionResolver = (
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  ctx: Parameters<CanUseTool>[2],
) => ReturnType<CanUseTool>;

/** Returns transport-supplied MCP servers for a fresh session. */
export type McpResolver = (sessionId: string) => Record<string, McpServerConfig> | undefined;

/** Stop-hook guard. Return an instruction string to block the agent from
 *  stopping (SDK feeds reason back, agent continues). Return null to allow stop.
 *  Guard fires at most once per turn — if it returns non-null twice, second
 *  call is ignored (agent stops) and manager logs to stderr. */
export type StopGuard = (sessionId: string) => string | null;

export class AgentManager extends EventEmitter {
  #live = new Map<string, LiveSession>();
  #resolver: PermissionResolver | undefined;
  #mcpResolver: McpResolver | undefined;
  #stopGuard: StopGuard | undefined;
  /** Sessions whose Stop hook already blocked once this turn — cleared on user msg. */
  #stopBlocked = new Set<string>();
  #budget = new TokenBudget({
    fallbackContextWindow: env.tokenFallbackContextWindow(),
  });

  /** Current context-usage snapshot for a session, or null if no turn has completed. */
  getTokenSnapshot(sessionId: string): UsageSnapshot | null {
    return this.#budget.snapshot(sessionId);
  }

  /** Install a transport-level permission resolver (e.g. Slack approval gate). */
  setPermissionResolver(resolver: PermissionResolver | undefined) {
    this.#resolver = resolver;
  }

  /** Install a transport-level MCP server resolver. Called once per session start. */
  setMcpResolver(resolver: McpResolver | undefined) {
    this.#mcpResolver = resolver;
  }

  /** Install a transport-level Stop hook guard (e.g. Slack "must reply" enforcement). */
  setStopGuard(guard: StopGuard | undefined) {
    this.#stopGuard = guard;
  }

  /** Number of SDK Query sessions currently live in this process. */
  liveCount() {
    return this.#live.size;
  }

  /** Whether a specific session has an active SDK Query loop right now. */
  isLive(sessionId: string): boolean {
    return this.#live.has(sessionId);
  }

  /** Get-or-create a session bound to a Slack thread. */
  ensureSession(thread: ThreadKey, opts: { title?: string } = {}) {
    let row = Sessions.findByThread(thread);
    if (!row) {
      const workingDir = join(paths.workspaces, `${thread.team_id}-${thread.channel_id}-${thread.thread_ts}`);
      mkdirSync(workingDir, { recursive: true });
      row = Sessions.createForThread({
        thread,
        model: env.model(),
        working_dir: workingDir,
        title: opts.title,
        permission_mode: env.defaultPermissionMode(),
      });
    }
    return row;
  }

  /** Send user input. Starts session loop if not already live. */
  async sendMessage(sessionId: string, text: string) {
    // Signal that a real user turn is starting for this session. Slash commands
    // and dropped messages never reach here, so a listener can distinguish
    // "agent will run" from "handled inline" without waiting for done/error.
    this.emit("event", { type: "turnStart", sessionId } satisfies AgentEvent);
    const live = this.#live.get(sessionId);
    if (live) {
      // flush prior turn if any pending assistant content was buffered
      this.#flushTurn(live);
      live.turn.user = text;
      live.turn.assistant = [];
      this.#stopBlocked.delete(sessionId);
      live.pushUser(text);
      this.#armIdle(live);
      return;
    }
    this.#stopBlocked.delete(sessionId);
    await this.#startSession(sessionId, text);
  }

  /** (Re)arm the idle timer for a session. On expiry, close the SDK loop
   *  silently — the next inbound user msg will boot a fresh Query w/ resume. */
  #armIdle(live: LiveSession) {
    const ms = env.idleMs();
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (ms <= 0) return;
    live.idleTimer = setTimeout(() => {
      // Flush any buffered assistant content; close the prompt iterable so
      // the for-await loop in #startSession unwinds cleanly.
      this.#flushTurn(live);
      try {
        live.closeIterable();
      } catch {}
    }, ms);
  }

  /** Cancel any in-flight turn for the session. */
  abort(sessionId: string) {
    this.#live.get(sessionId)?.abort.abort();
  }

  /** Gracefully close a live session so the next inbound message boots a
   *  fresh Query with newly-resolved MCPs, plugins, and skills. */
  reload(sessionId: string) {
    const live = this.#live.get(sessionId);
    if (!live) return false;
    live.reloading = true;
    live.closeIterable();
    return true;
  }

  /** Change permission mode for a session. Persists; if live, also pushed to the SDK Query. */
  async setPermissionMode(sessionId: string, mode: PermissionMode) {
    Sessions.setPermissionMode(sessionId, mode);
    const live = this.#live.get(sessionId);
    if (live?.query) {
      try {
        await live.query.setPermissionMode(mode);
      } catch (e) {
        console.error("[agent] setPermissionMode failed:", e);
      }
    }
  }

  async #startSession(sessionId: string, firstText: string) {
    const row = Sessions.findById(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);

    const memBlock = await memory.prefetch(sessionId);
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
    // /1on1 privacy: when this session's thread is locked, point the claude-code
    // child at the initiator's isolated config home so OAuth-authenticated MCP
    // servers (whose tokens the CLI persists under CLAUDE_CONFIG_DIR, beyond the
    // reach of the .mcp.json credential-strip) resolve as the initiator, not the
    // agent. Unlocked → inherit the agent's config dir. Reboot-on-/1on1 forces
    // re-resolution (CLAUDE_CONFIG_DIR is read once at child boot).
    const lock =
      row.slack_channel_id && row.slack_thread_ts
        ? OneOnOne.find(row.slack_channel_id, row.slack_thread_ts)
        : null;
    const lockedConfigDir = resolveSessionConfigDir(lock?.locked_user);
    if (lockedConfigDir) providerEnv.CLAUDE_CONFIG_DIR = lockedConfigDir;

    const resolver = this.#resolver;
    const canUseTool: CanUseTool | undefined = resolver
      ? (toolName, input, ctx) => resolver(sessionId, toolName, input, ctx)
      : undefined;

    const mode = (row.permission_mode || "default") as PermissionMode;
    const mcpServers = this.#mcpResolver?.(sessionId);
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
    // CC plugins installed via `bun run install-deps`. Without this, the SDK
    // ignores the enabledPlugins entry in settings.json (it only reads
    // settings when settingSources is set). Explicit Options.plugins surfaces
    // each plugin's skills/commands for this session. The SDK's `--plugin-dir`
    // path does NOT auto-mount the plugin's .mcp.json servers (CLI landmine),
    // so we also read each plugin's .mcp.json and merge into mcpServers.
    const pluginPaths = loadInstalledPluginPaths();
    const pluginMcps = loadInstalledPluginMcps();
    const mergedMcpServers = {
      ...(mcpServers ?? {}),
      ...pluginMcps,
    };
    const hasMcpServers = Object.keys(mergedMcpServers).length > 0;
    const options: Options = {
      cwd: row.working_dir,
      // Pass `model` only when explicitly set. Empty = let the SDK / CLI use
      // its own default (e.g. Claude Code subscription default under
      // CLAUDE_CODE_OAUTH_TOKEN). When pointing at a non-Anthropic gateway,
      // SLAUDE_MODEL MUST be set to a provider-qualified id.
      ...(row.model ? { model: row.model } : {}),
      abortController: abort,
      env: scrubChildEnv({ ...process.env, ...providerEnv }),
      ...(canUseTool ? { canUseTool } : {}),
      ...(hasMcpServers ? { mcpServers: mergedMcpServers } : {}),
      ...(pluginPaths.length > 0 ? { plugins: pluginPaths } : {}),
      permissionMode: mode,
      ...(mode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      hooks: {
        PreCompact: [{ hooks: [preCompact] }],
        Stop: [{ hooks: [stopHook] }],
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          soulSystemBlock(),
          mcpServers
            ? `<mcp-servers>\nMCP server namespaces mounted this session. Call tools as \`mcp__<server>__<tool>\`.\n${Object.keys(mcpServers)
                .map((n) => `- ${n}`)
                .join(
                  "\n",
                )}\nAdditional servers may be available if configured in ~/.claude/mcp.json or .mcp.json in the working directory.\n</mcp-servers>`
            : "<mcp-servers>none</mcp-servers>",
          memBlock ? `<memory-context>\n${memBlock}\n</memory-context>` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...(row.claude_started ? { resume: row.id } : {}),
    };

    const live: LiveSession = {
      id: sessionId,
      pushUser,
      closeIterable,
      abort,
      turn: { user: firstText, assistant: [] },
      turnTools: [],
      inAutoEvolve: false,
    };
    this.#live.set(sessionId, live);
    metric.sessionsLive.set(this.#live.size);
    this.#armIdle(live);
    Sessions.setStatus(sessionId, "running");

    let stderrBuf = "";
    (options as any).stderr = (chunk: string) => {
      stderrBuf += chunk;
      process.stderr.write(`[claude-cli] ${chunk}`);
    };
    let retried = false;

    (async () => {
      try {
        console.log(`[mgr] query() boot session=${sessionId} model=${row.model} cwd=${row.working_dir} resume=${!!row.claude_started}`);
        const q = query({ prompt: promptIterable, options });
        live.query = q;
        for await (const msg of q as AsyncIterable<SDKMessage>) {
          console.log(`[mgr] sdk msg type=${(msg as any).type} subtype=${(msg as any).subtype ?? "-"}`);
          this.#fanout(sessionId, msg);
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
        if (/No conversation found with session ID/i.test(stderrBuf)) {
          retried = true;
          console.log(`[mgr] clearing stale claude_started + retrying session=${sessionId}`);
          Sessions.clearStarted(sessionId);
          if (live.idleTimer) clearTimeout(live.idleTimer);
          this.#live.delete(sessionId);
          // Fire and forget — restart with the same first prompt.
          void this.#startSession(sessionId, firstText);
          return;
        }
        if (live?.reloading) {
          console.log(`[mgr] reload session=${sessionId} — suppressing expected exit error`);
        } else {
          metric.errorsTotal.inc({ kind: "sdk" });
          this.emit("event", { type: "error", sessionId, error: message } satisfies AgentEvent);
        }
      } finally {
        if (retried) return;
        if (live.idleTimer) clearTimeout(live.idleTimer);
        Sessions.setStatus(sessionId, "idle");
        this.#live.delete(sessionId);
        this.#budget.forget(sessionId);
        this.#stopBlocked.delete(sessionId);
        metric.sessionsLive.set(this.#live.size);
      }
    })();
  }

  #fanout(sessionId: string, msg: SDKMessage) {
    const live = this.#live.get(sessionId);
    switch (msg.type) {
      case "assistant": {
        Sessions.markStarted(sessionId);
        for (const block of msg.message.content) {
          if (block.type === "text") {
            live?.turn.assistant.push(block.text);
            this.emit("event", {
              type: "assistantText",
              sessionId,
              text: block.text,
            } satisfies AgentEvent);
          } else if (block.type === "thinking") {
            this.emit("event", {
              type: "thinking",
              sessionId,
              text: block.thinking,
            } satisfies AgentEvent);
          } else if (block.type === "tool_use") {
            if (live) live.turnTools.push(block.name);
            metric.toolCallsTotal.inc({ tool: block.name });
            this.emit("event", {
              type: "toolCall",
              sessionId,
              tool: block.name,
              input: block.input,
            } satisfies AgentEvent);
          }
        }
        break;
      }
      case "user": {
        if (msg.tool_use_result !== undefined) {
          this.emit("event", {
            type: "toolResult",
            sessionId,
            tool: "",
            result: msg.tool_use_result,
          } satisfies AgentEvent);
        }
        break;
      }
      case "result": {
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
          metric.tokensTotal.inc({ kind: "input" }, (msg as any).usage.input_tokens ?? 0);
          metric.tokensTotal.inc({ kind: "output" }, (msg as any).usage.output_tokens ?? 0);
          metric.tokensTotal.inc({ kind: "cache_read" }, (msg as any).usage.cache_read_input_tokens ?? 0);
          metric.tokensTotal.inc({ kind: "cache_creation" }, (msg as any).usage.cache_creation_input_tokens ?? 0);
          metric.contextWindowPct.set(snapshot.pctUsed);
          this.emit("event", {
            type: "tokenUsage",
            sessionId,
            snapshot,
          } satisfies AgentEvent);
        }
        if (msg.is_error) {
          const errStr =
            "errors" in msg && Array.isArray((msg as any).errors)
              ? (msg as any).errors.join("; ")
              : msg.subtype;
          metric.turnsTotal.inc({ result: "error" });
          metric.errorsTotal.inc({ kind: "turn" });
          this.emit("event", {
            type: "error",
            sessionId,
            error: errStr,
          } satisfies AgentEvent);
          if (live) live.turnTools = [];
        } else {
          const wasAutoEvolve = live?.inAutoEvolve === true;
          if (live) live.inAutoEvolve = false;
          metric.turnsTotal.inc({ result: "success" });
          this.emit("event", {
            type: "done",
            sessionId,
            ...(wasAutoEvolve ? { autoEvolve: true } : {}),
          } satisfies AgentEvent);
          if (live && !wasAutoEvolve && this.#shouldAutoEvolve(live)) {
            live.inAutoEvolve = true;
            live.turnTools = [];
            live.pushUser(AUTO_EVOLVE_PROMPT);
          } else if (live) {
            live.turnTools = [];
          }
        }
        break;
      }
      default:
        break;
    }
  }

  #flushTurn(live: LiveSession) {
    if (!live.turn.user || live.turn.assistant.length === 0) return;
    const user = live.turn.user;
    const assistant = live.turn.assistant.join("\n");
    live.turn = { user: "", assistant: [] };
    void memory.syncTurn({ sessionId: live.id, user, assistant });
  }

  /**
   * Decide whether the just-finished turn should be followed by an
   * auto-evolve check. Triggers when the turn used ≥2 "substantive" tools
   * (anything that mutated state or did real work — excludes pure Slack
   * surface ops, skill introspection, and trivial reads). Skips when the
   * turn already wrote/deleted a skill (no need to re-prompt).
   */
  #shouldAutoEvolve(live: LiveSession): boolean {
    if (!env.autoEvolve()) return false;
    const tools = live.turnTools;
    if (tools.some((t) =>
      t === "mcp__slaude_skills__write_skill" ||
      t === "mcp__slaude_skills__delete_skill"
    )) return false;
    let substantive = 0;
    for (const t of tools) {
      if (AUTO_EVOLVE_IGNORE.has(t)) continue;
      if (t.startsWith("mcp__slaude_surface__")) continue;   // interaction output ≠ substantive work
      if (t.startsWith("mcp__slaude_runtime__")) continue;   // housekeeping ≠ substantive work
      if (t.startsWith("mcp__slaude_slack__")) continue;     // deprecated namespace (transition)
      if (t.startsWith("mcp__slaude_skills__")) continue;
      substantive++;
    }
    return substantive >= 2;
  }
}

/** Tools that don't count toward the auto-evolve trigger threshold. */
const AUTO_EVOLVE_IGNORE = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "TodoWrite",
]);

/**
 * Injected as a synthetic user message after substantial turns. The agent
 * must either save/refine a skill OR end the turn without any tool call.
 * The adapter recognizes the `autoEvolve` flag on the resulting `done`
 * event and suppresses the "no reply emitted" warning so silent NO is fine.
 */
const AUTO_EVOLVE_PROMPT = [
  "<auto-evolve>",
  "The previous turn used multiple tools. Evaluate: did it perform a procedure worth saving as a reusable skill, or refine an existing one?",
  "",
  "If YES:",
  "  1. Call `mcp__slaude_skills__list_skills` (skip if you've already listed this session).",
  "  2. Decide: create-new vs refine-existing. If refining, call `mcp__slaude_skills__read_skill` first.",
  "  3. Call `mcp__slaude_surface__request_approval` with `category: 'skills'` and a one-line summary.",
  "  4. On approval, call `mcp__slaude_skills__write_skill` with slug/name/description/body. Parameterize body via `${SLAUDE_SKILL_ARGS}` so it generalizes.",
  "  5. Call `mcp__slaude_surface__reply` with a brief confirmation (e.g. `saved /<slug>`).",
  "",
  "If NO:",
  "  End the turn immediately. Do not call any tool. Do not reply. Do not narrate. The runtime knows to stay quiet on no-op evolution turns.",
  "",
  "Do NOT redo the original task. Do NOT save one-off facts (those belong in memory). Skills are for repeatable multi-step procedures.",
  "</auto-evolve>",
].join("\n");
