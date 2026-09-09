# Harness abstraction: what a runtime must implement to drive slaude

**Date:** 2026-09-09

slaude is welded to `@anthropic-ai/claude-agent-sdk`. Not just as a dependency —
as a *shape*. `AgentManager` builds an `Options` object inline, iterates
`SDKMessage`, and hangs four load-bearing behaviours off SDK-specific
affordances: the Slack approval gate on `canUseTool`, the disengage suppression
on a `UserPromptSubmit` hook returning `continue:false`, the KB-first stop guard
on a `Stop` hook returning `decision:"block"`, and every Slack-facing tool on
`createSdkMcpServer`.

The question was what it would take to run the same agent on a different
harness — Codex, Pi, DeepSeek Harness. The answer turned out to be less about
plumbing than about naming which of those four behaviours are *negotiable*.

## What the candidate harnesses actually offer

Surveyed 2026-09-09 from public docs. Only the claude row is verified against
the SDK slaude runs on; the rest are provisional and each descriptor in
`src/agent/harness/adapters/descriptors.ts` carries a `VERIFY` list.

| | Claude Agent SDK | Codex CLI/SDK | Pi | DeepSeek Harness |
|---|---|---|---|---|
| Embedding | in-process SDK | SDK wraps CLI subprocess (JSONL over stdio) | SDK mode, in-process | plugin runtime |
| System prompt | preset + **append** | base-instructions **replace** + `AGENTS.md` | `SYSTEM.md` **file** | replace |
| Hooks | 9 events, **in-process callbacks** | 11 events, **external command handlers** on disk | extension message injection | agent loop is itself a plugin |
| Tool-call gate | `canUseTool` callback | `PermissionRequest` hook | none documented | none documented |
| slaude-owned tools | in-process MCP server | external MCP only | in-process extension tools | tool-registry plugin |
| Streaming input | async-generator iterable | `run()` per turn | per turn | per turn |
| Resume | native | native (`resumeThread`) | native (session trees) | native |

Two findings reshaped the design.

**Codex has more hooks than Claude and they are still worse for us.** Eleven
lifecycle events, `continue:false`, `additionalContext`, `decision:"block"`,
`permissionDecision` — on paper a superset. But they are configured in
`~/.codex/hooks.json` or `[hooks]` in `config.toml` and dispatch to *external
commands*. slaude's hooks read the `sessions.engaged` row, mutate a
`#stopBlocked` set, and drain a queued-notes map. A subprocess can't touch any
of that. Hosting slaude on Codex means shipping a handler binary that RPCs back
into the running process over a loopback socket. The capability exists; the
*coupling* doesn't. So `hooks` in the port is a list of lifecycle points, and
the fact that they may be out-of-process is a note on the descriptor, not a
silent assumption.

**Pi has no MCP and is still the best fit for our tools.** Pi's docs say plainly
"No MCP — build an extension that adds it". But Pi extensions run in-process and
can register tools directly. Our surface tools (`reply`, `request_approval`,
`upload`, `react`) close over live Slack state and a pending-approval map;
what they need is *in-process hosting*, and MCP is merely how the Claude SDK
provides it. The first draft of the port had `McpServerSpec`. That was the
vendor leaking through the abstraction. It is now `ToolsetSpec` with a
`NeutralTool` (name, description, JSON Schema, handler) that each adapter mounts
its own way — wrapped in an SDK MCP server for Claude, registered natively for
Pi, bridged over loopback for Codex. The capability is
`tools.inProcess`, not `mcp.inProcess`.

## The port

`src/agent/harness/types.ts` defines what slaude says to a harness and what it
observes back. Nothing else in slaude may construct vendor options.

- `HarnessSessionSpec` — cwd, model, permission mode, env, system-prompt blocks,
  toolsets, hooks, permission handler, resume id, abort signal.
- `HarnessSession` — an `AsyncIterable<HarnessEvent>` plus `send`/`end`/
  `setModel`/`setPermissionMode`/`interrupt`.
- `HarnessEvent` — deliberately `AgentEvent` minus `sessionId` (the manager
  stamps it), so the Slack renderers keep working unchanged.
- `HookPoint` — seven neutral lifecycle points named for what slaude does at
  them, not for the vendor event backing them.

The subtle part is `HookDecision`. It has four actions, and **`halt` and `block`
are not interchangeable**:

- `halt` — the input persists to the transcript, the model does not run. This is
  the disengaged-thread path, and the reason it works is that a later re-engage
  resumes with the gap already in history (field note 2026-06-16).
- `block` — the model *keeps running* and gets `reason` fed back. This is the
  stop guard.

On the Claude SDK these are `continue:false` and `decision:"block"`, and
swapping them silently discards the prompt pre-persist. Any abstraction that
collapses them into one "reject" verb reintroduces a bug we already paid for, so
the distinction is in the port's vocabulary and adapters declare which they can
express (`hookDecisions`).

## Negotiation, and the one thing that doesn't degrade

`src/agent/harness/capabilities.ts` lists eleven slaude behaviours, what each
needs from a harness, and what happens when it isn't there:

| Behaviour | Missing capability → |
|---|---|
| `approval-gate` | **no fallback — refuse to boot** |
| `surface-tools` | emulate: loopback MCP bridge back into slaude |
| `persona-prompt` | emulate: own the whole prompt, or write an instructions file |
| `out-of-band-context` | emulate: prepend queued notes to the message text |
| `thread-continuity` | emulate: replay a rolled-up transcript prefix |
| `live-multiturn` | emulate: queue and run one turn at a time |
| `model-switch` | emulate: reboot the session with the new model |
| `disengage-suppression` | degrade: gateway drops the message, transcript loses the gap |
| `stop-guard` | degrade: advisory only |
| `compaction-signal` | degrade: no indicator |
| `token-budget` | degrade: no threshold warnings |

The approval gate is the one that refuses. A harness with no interactive
tool-call gate cannot host it, and there is no honest emulation — a system-prompt
line saying "ask before deploying" is not a gate, it's a suggestion. `negotiate()`
returns it as a blocker and `assertUsable()` throws with the missing-capability
list. An operator running a deployment that genuinely has no gating can pass
`disabled: ["approval-gate"]`, which makes the removal a deliberate config act
that shows up in a diff. That asymmetry is the whole point of the module:
conveniences degrade quietly, controls fail loudly.

Running the descriptors through it today, without a line of adapter code:

- **codex** — 6 native, 5 degraded, 0 blocked. Four are `emulate` and the
  loopback bridge is the bulk of that work. The fifth is the interesting one:
  `PermissionRequest` *can* deny, so the approval gate does not block boot — but
  a hook that decides inline cannot park on a Slack button, so it degrades to
  auto-deny. Not a gate that a human answers.
- **pi** — blocked on `approval-gate`. Usable only for a deployment that has
  opted out of gating, and even then the stop guard is advisory.
- **dsh** — blocked on `approval-gate` as declared, but the agent loop is itself
  a plugin, so this is the one harness where a missing lifecycle point can be
  *added* rather than emulated.

## What is not done

This lands the port, the negotiation, the descriptors and a registry —
`SLAUDE_HARNESS` selects, `resolveAdapter` refuses an unregistered or unusable
harness with the negotiation report attached. It does **not** rewire
`AgentManager`, which still calls `agentSdk.query` directly. Sequencing:

1. *(this change)* port + negotiation + descriptors, no behaviour change.
2. Claude adapter: move `Options` construction and `SDKMessage` → `HarnessEvent`
   translation out of `manager.ts` behind `HarnessAdapter`, with the existing
   manager tests as the contract. Until then the descriptor and the manager can
   drift, which is the known cost of landing the seam first.
3. Port the in-process toolsets from `createSdkMcpServer` to `NeutralTool`,
   keeping `kind:"vendorMcp"` as a migration escape hatch that only the Claude
   adapter accepts — every other adapter rejects it, which stops the hatch from
   becoming the design.
4. First non-Claude adapter, and with it the loopback bridge that hooks and
   toolsets both need.

The honest read on step 4 is that the bridge is most of the work for Codex and
DSH, and that Pi — no MCP, weakest hooks, best in-process tool story — is the
one that most tests whether the port is really vendor-neutral or just
Claude-shaped with the names filed off.
