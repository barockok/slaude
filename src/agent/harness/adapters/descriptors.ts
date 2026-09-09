/**
 * Capability descriptors for the harnesses slaude either drives today or is a
 * candidate to drive.
 *
 * A descriptor is a *claim*, not an implementation. Its job is to answer
 * "what breaks if we point slaude at this harness?" before anyone writes the
 * adapter — run it through negotiate() and read the degradation list.
 *
 * Provenance: `claude` is verified against the pinned @anthropic-ai/claude-agent-sdk
 * that slaude runs on. The rest were compiled from public documentation on
 * 2026-09-09 and are marked PROVISIONAL — each carries a VERIFY list that the
 * adapter author must confirm against the real SDK before the descriptor is
 * trusted for anything but planning.
 */

import type { HarnessCapabilities } from "../types";

/**
 * @anthropic-ai/claude-agent-sdk — the reference implementation. Every other
 * descriptor is, in effect, a diff against this one.
 */
export const CLAUDE_CAPS: HarnessCapabilities = {
  id: "claude",
  label: "Claude Agent SDK",
  streamingInput: true,
  resume: "native",
  systemPrompt: "append",
  hooks: [
    "sessionStart",
    "userPromptSubmit",
    "preToolUse",
    "postToolUse",
    "preCompact",
    "turnEnd",
    "sessionEnd",
  ],
  hookDecisions: { addContext: true, halt: true, block: true, deny: true },
  permissionGate: "callback",
  tools: { inProcess: true, mcpStdio: true, mcpHttp: true },
  liveControls: { model: true, permissionMode: true, interrupt: true },
  compaction: "native",
  usageReporting: true,
  notes: [
    "hooks are in-process callbacks, so they can read sqlite and mutate manager state directly",
    "halt (continue:false) and block (decision:'block') differ on whether the prompt persists — see field note 2026-06-16",
  ],
};

/**
 * @openai/codex-sdk — wraps the codex CLI, exchanging JSONL over stdin/stdout.
 *
 * The structural mismatch is hooks: codex has a rich event list (11 lifecycle
 * events) but they are configured in ~/.codex/hooks.json or [hooks] in
 * config.toml and dispatch to *external command handlers*. slaude's hooks need
 * live process state (engagement rows, the stop-guard set, queued session
 * notes), so an adapter has to ship a tiny handler binary that RPCs back into
 * slaude over a loopback socket — the same bridge the toolsets need.
 *
 * VERIFY before implementing:
 *  - whether run()/runStreamed() accept per-turn model + base-instruction overrides
 *  - whether turn.completed carries token usage
 *  - whether an in-flight turn can be interrupted, and how
 *  - whether PermissionRequest can block on an out-of-band answer or only decide inline
 */
export const CODEX_CAPS: HarnessCapabilities = {
  id: "codex",
  label: "OpenAI Codex CLI (PROVISIONAL)",
  // run() is called per turn on a Thread; there is no mid-turn input iterable.
  streamingInput: false,
  // resumeThread(id); transcripts live in ~/.codex/sessions.
  resume: "native",
  // baseInstructions replaces the preamble; AGENTS.md is the project-instruction file.
  systemPrompt: "replace",
  hooks: [
    "sessionStart",
    "userPromptSubmit",
    "preToolUse",
    "postToolUse",
    "preCompact",
    "turnEnd",
    "sessionEnd",
  ],
  // continue:false, additionalContext, decision:"block", permissionDecision.
  hookDecisions: { addContext: true, halt: true, block: true, deny: true },
  // PermissionRequest is a hook, not an in-process callback that can await a human.
  permissionGate: "hook",
  tools: { inProcess: false, mcpStdio: true, mcpHttp: true },
  liveControls: { model: false, permissionMode: false, interrupt: false },
  compaction: "native",
  usageReporting: true,
  notes: [
    "hooks are external command handlers configured on disk, not in-process callbacks",
    "the CLI is a subprocess, so every slaude-owned tool and hook needs a loopback bridge",
  ],
};

/**
 * Pi (@earendil-works/pi-coding-agent) — minimal four-tool core (Read, Write,
 * Edit, Bash) with everything else pushed into extensions, which run in-process
 * and can register tools, inject messages before each turn, and filter history.
 *
 * That in-process extension model is a better fit for slaude's surface tools
 * than codex's subprocess bridge, and it is why the port talks about
 * "in-process tools" rather than "in-process MCP": pi has no native MCP at all
 * (its docs say to build an extension if you want it), yet it can host slaude's
 * tools directly.
 *
 * VERIFY before implementing:
 *  - which lifecycle points extensions can actually intercept, and whether any can veto
 *  - whether an extension can deny a tool call and await an out-of-band answer
 *  - the SDK-mode API surface for driving a session programmatically
 *  - whether SYSTEM.md is the only system-prompt path or the SDK takes one directly
 */
export const PI_CAPS: HarnessCapabilities = {
  id: "pi",
  label: "Pi Coding Agent (PROVISIONAL)",
  streamingInput: false,
  // Sessions are stored as trees, all branches in one file.
  resume: "native",
  // SYSTEM.md replaces or appends to the default prompt, per project.
  systemPrompt: "file",
  hooks: ["sessionStart", "userPromptSubmit", "sessionEnd"],
  hookDecisions: { addContext: true, halt: false, block: false, deny: false },
  permissionGate: "none",
  tools: { inProcess: true, mcpStdio: false, mcpHttp: false },
  liveControls: { model: false, permissionMode: false, interrupt: false },
  compaction: "none",
  usageReporting: false,
  notes: [
    "no native MCP — external MCP servers require an extension that adds it",
    "extensions run in-process: slaude tools register natively rather than through a bridge",
    "hook list is the documented minimum; anything beyond message injection is unconfirmed",
  ],
};

/**
 * DeepSeek Harness (deepseek-ai/deepseek-harness, MIT) — "everything is a
 * plugin": the model adapter, tool registry, session log and the agent loop
 * itself are all replaceable plugins.
 *
 * On paper this is the most accommodating target — a harness whose agent loop
 * is a plugin can be made to satisfy any of slaude's requirements. That is also
 * the risk: capability here means "implementable", not "implemented", so this
 * descriptor is the least trustworthy of the four until someone reads
 * docs/architecture.md and the tool-registry interface.
 *
 * VERIFY before implementing: every field below, plus whether the embedding
 * surface is TypeScript, Python, or only the CLI/Web UI.
 */
export const DSH_CAPS: HarnessCapabilities = {
  id: "dsh",
  label: "DeepSeek Harness (PROVISIONAL)",
  streamingInput: false,
  resume: "native",
  systemPrompt: "replace",
  hooks: ["sessionStart", "userPromptSubmit", "preToolUse", "postToolUse", "sessionEnd"],
  hookDecisions: { addContext: true, halt: false, block: false, deny: true },
  permissionGate: "none",
  tools: { inProcess: true, mcpStdio: true, mcpHttp: true },
  liveControls: { model: false, permissionMode: false, interrupt: false },
  compaction: "none",
  usageReporting: false,
  notes: [
    "session log and agent loop are plugins, so missing lifecycle points can in principle be added rather than emulated",
    "descriptor compiled from announcement coverage, not from the source — treat as a planning sketch",
  ],
};

export const DESCRIPTORS: Record<string, HarnessCapabilities> = {
  claude: CLAUDE_CAPS,
  codex: CODEX_CAPS,
  pi: PI_CAPS,
  dsh: DSH_CAPS,
};
