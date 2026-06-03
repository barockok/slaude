# Surface abstraction — design

**Date:** 2026-06-03
**Status:** approved (pending spec review)
**Goal:** Decouple the agent's interaction tooling from Slack so the agent talks to a
single, platform-neutral **Surface** contract. Onboarding a new surface (WhatsApp, …)
later adds one Surface implementation and changes nothing the agent sees. The sim drives
the *real* Surface implementation over a fake transport, so the agent cannot tell sim from
prod.

**Scope boundary (descoped after review).** This effort extracts the **interaction-tool
seam** only: the Surface port, the `slaude_surface`/`slaude_runtime` MCP split, the Surface
factory, and sim parity. `core/gateway.ts` **remains the Slack adapter** — it keeps its
Slack-specific machinery (reactions, presence, status, `handleMessage`
app_mention/message/engagement routing, error `postMessage`, cron/connect context). It still
imports Slack. Making `gateway.ts` a truly platform-neutral event loop (moving
`handleMessage`/reactions/status into the Slack adapter) is a **separate, larger effort** and
is explicitly out of scope here. We do not claim a neutral core.

## Background

Today the agent calls `mcp__slaude_slack__{reply,edit,react,upload,request_approval,
get_thread_history,…}`. Those tools are built per session by `createSlackMcp(ctx)` in
`src/gateway/slack/mcp-tools.ts`, bound to a Slack-specific `SlackContext` (raw `WebClient`,
`threadTs`, mrkdwn, emoji `ts`). `core/gateway.ts` imports the Slack MCP directly, tracks the
agent's reply via a Slack-specific `spoke` flag, and the stop-guard nudge hardcodes
`mcp__slaude_slack__reply`. This coupling makes a new surface expensive.

## Invariants (non-negotiable)

1. **Real == sim, per surface.** For a given surface the agent sees an *identical* Surface:
   same `id`, same capability set, same tool schemas, same formatting. The sim achieves this
   by running the **real Surface implementation** over a **fake transport** (the IO seam
   *below* the Surface). The sim never masks, thins, or re-implements Surface logic.
2. **Sim-ness is invisible to the agent.** No `"sim:"`-prefixed ids, no sim-only tools, no
   sim hints in tool descriptions or the system prompt. `Surface.id` is the real platform id
   (`"slack"`).
3. **Agent-facing stability.** Onboarding a surface must not change the agent-facing contract
   (`mcp__slaude_surface__*`), only add a new Surface implementation + its transport.

## 1. The Surface port — `src/gateway/core/surface.ts`

Platform-neutral, per-session (bound to one conversation). New file; gateway core depends on
this, not on Slack.

```ts
export type SurfaceCapability = "edit" | "react" | "upload" | "typing";

// Rich enough to preserve today's get_thread_history output verbatim (blocker 7).
// Non-Slack surfaces populate the core fields and omit the optional ones.
export interface HistoryItem {
  author: string;
  text: string;
  ref: string;            // slack: ts
  threadRef?: string;     // slack: thread_ts
  replyCount?: number;    // slack: reply_count
  replies?: unknown[];    // slack: nested replies when includeReplies
}
export interface ApprovalRequest { summary: string; tools?: string[]; files?: string[]; risks?: string; category?: string }
export interface ApprovalResult { approved: boolean; by: string; note?: string }

export interface Surface {
  readonly id: string;                          // real platform id, e.g. "slack"
  readonly capabilities: ReadonlySet<SurfaceCapability>;

  // core — every surface MUST implement:
  reply(i: { text: string }): Promise<{ ref: string }>;       // `ref` replaces Slack `ts`
  getHistory(i: { limit?: number; includeReplies?: boolean }): Promise<{ messages: HistoryItem[]; hasMore: boolean }>;
  requestApproval(r: ApprovalRequest): Promise<ApprovalResult>;

  // optional — present iff listed in `capabilities`:
  edit?(i: { ref: string; text: string }): Promise<void>;       // cap: "edit"
  react?(i: { name: string; ref?: string }): Promise<void>;     // cap: "react"
  unreact?(i: { name: string; ref?: string }): Promise<void>;   // cap: "react" (rides with react)
  upload?(i: { path: string; comment?: string }): Promise<void>; // cap: "upload"
  typing?(i: { on: boolean }): Promise<void>;                   // cap: "typing"
}

/** Neutral per-session binding the gateway builds from the inbound turn. The factory
 *  closes over the transport client. (In this descoped effort the gateway still imports
 *  Slack and provides a default Slack factory; the factory is the extension seam for a
 *  future surface, not a full decoupling of gateway.ts.) */
export interface SessionBinding {
  conversationId: string;     // slack: channel
  threadRef?: string;         // slack: threadTs (thread-less surfaces ignore)
  inboundRef: string;         // slack: inboundTs (msg to react-to / reply-under)
  userId?: string;
  teamId?: string;
  requestApproval: (r: ApprovalRequest) => Promise<ApprovalResult>;
  reloadSession: () => boolean;
}

export type SurfaceFactory = (b: SessionBinding) => Surface;
```

`requestApproval` and `reloadSession` are gateway-provided behaviors passed through the
binding; the Surface delegates to them. (Approval rendering — buttons vs text — is the
Surface's concern when a real non-Slack surface lands.)

## 2. MCP server split

The single `slaude_slack` server splits by concern:

- **`slaude_surface`** (`core/surface-mcp.ts`, new) — built from a `Surface`. Always mounts
  `reply`, `get_history`, `request_approval`. Conditionally mounts `edit`, `react`,
  `unreact`, `upload`, `typing` — one per declared capability. Schemas neutralized: `ts` →
  `ref`; descriptions say "the current conversation", not "Slack thread". This is the only
  interaction namespace the agent uses.
- **`slaude_runtime`** (`core/runtime-mcp.ts`, new) — slaude control plane, surface-agnostic:
  `ignore_thread`, `unignore_thread`, `ignore_user`, `unignore_user`, `list_cron_jobs`,
  `add_cron_job`, `remove_cron_job`, `trigger_ingest`, `reload_session`. Logic moves out of
  `slack/mcp-tools.ts` largely unchanged (these never touched the WebClient for sending).
- **`slaude_slack`** (shrinks) — genuinely Slack-specific lookups only: `get_user_profile`,
  `get_channel_info`, `list_users_in_channel`, `search_messages`. The gateway core does **not**
  branch on platform; instead the adapter optionally injects a `directoryMcpFactory` and the
  gateway mounts it when present. The Slack adapter (and the sim, which *is* Slack) provide it;
  a future WhatsApp adapter omits it.

## 3. Gateway seam — `core/gateway.ts`

```ts
createGateway(agent, transport, { surfaceFactory?, directoryMcpFactory? })
```

The gateway stores a `Surface` on each route alongside today's context. `surfaceFactory`
defaults to `makeSlackSurfaceFactory(transport.client)` — neither the Slack adapter nor the
sim must pass it; it exists as the extension point for a future surface. The per-session MCP
resolver mounts `createSurfaceMcp(surface)` + `createRuntimeMcp(binding)` +
`directoryMcpFactory?.(binding)`.

**Functional touchpoints that MUST change (verified against code, blockers 1-5):**

- **`spoke` tracking (`gateway.ts:243-251`).** Keep the existing `toolCall`-event mechanism —
  it already counts reply **+ edit + upload**. Just widen the name-match to
  `mcp__slaude_surface__{reply,edit,upload}` (plus the deprecated `slaude_slack` names during
  the transition). **No new "notify" seam** — the earlier draft was wrong here.
- **Stop-guard nudge string (`gateway.ts:198`)** → `mcp__slaude_surface__reply`.
- **`humanizeToolStatus` (`gateway.ts:728+`)** hardcodes ~10 Slack tool names for status text;
  update them to the surface namespace or status falls through to the uglier generic case.
- **cron `onExecute` (`gateway.ts:141-158`)** builds a `SlackContext` + `routes.set` directly;
  it must build the binding + surface the same way the inbound path does, or cron sessions
  break.
- **connect-broker wiring (`gateway.ts:216-231`)** reads `route.ctx.{teamId,userId,channel,
  threadTs}`; repoint to the binding fields the route now holds.
- **Permission gate (`slack/permission-gate.ts:140`)** auto-allows `mcp__slaude_slack__*`
  ("agent output is never gated"). After the rename, surface tools no longer match and would
  be **gated on every reply** — CRITICAL. Add `mcp__slaude_surface__` and
  `mcp__slaude_runtime__` to the allow-prefix list.

`core/gateway.ts` continues to import Slack for its adapter responsibilities (descoped — see
Scope boundary). The Slack adapter does not need to pass a factory; the gateway's default
covers it.

## 4. SlackSurface — `src/gateway/slack/surface.ts`

`SlackSurface implements Surface` over the `WebClient`, wrapping today's `slackHandlers`
logic with **no behavior change**. `id = "slack"`,
`capabilities = {edit, react, upload, typing}`. `reply` returns the Slack `ts` as `ref`;
`edit`/`react`/`unreact` map `ref` → `ts`. `getHistory` uses `conversations.replies`.
`requestApproval`/`reloadSession` delegate to the binding hooks.

`makeSlackSurfaceFactory(client): SurfaceFactory` closes over the client and returns
`(binding) => new SlackSurface(client, binding)`.

**No profile/capability mask exists** — masking would let the sim diverge from a real impl,
violating Invariant 1.

## 5. Sim wiring

The sim already fakes the Slack `WebClient` via `SimTransport`. With the port, the sim simply
injects the **same** `makeSlackSurfaceFactory(simTransport.client)` (and the same
`directoryMcpFactory`, since sim *is* Slack) into `createGateway`.
Result: `sim:slack` runs the real `SlackSurface`, so the agent sees exactly the prod Surface
(`id="slack"`, full caps). This is what already works today, now routed through the port — a
pure refactor with the parity guarantee made structural.

No `--surface` flag and no WhatsApp code in this effort (see Deferred). The renderer and
`--real`/`--verbose` work from the previous change are unaffected — they key off generic
agent events.

**`StubAgent` rewrite (blocker 6).** `sim/stub-agent.ts` currently calls
`slackHandlers.reply(ctx.slack, …)` / `slackHandlers.request_approval(ctx.slack, …)` through
the `__sessionCtx().slack` seam. Since the per-session ctx changes shape (it now carries a
`Surface` + binding, not a raw `SlackContext`), the stub must call the same Surface the real
agent would — `surface.reply({text})`, `surface.requestApproval({summary,risks})`. The "25
sim transcripts stay green" guarantee **depends on this rewrite**, so it is a planned task,
not incidental.

## 6. Migration & tests

- **Deprecated alias, one release.** Keep `mcp__slaude_slack__reply` mounted as a thin alias
  delegating to `surface.reply`, so an in-flight session or a persona/skill referencing the
  old name doesn't break. Mark deprecated; remove next release.
- **Tool-name sweep (wider than first stated).** `mcp__slaude_slack__*` strings appear in
  more than the system prompt. Every site, repoint to the right new namespace
  (`slaude_surface__*` for interaction, `slaude_runtime__*` for control plane):
  - `agent/manager.ts:574,576` — skill-evolution prompt (`request_approval`, `reply`).
  - `agent/manager.ts:544` — **auto-evolve work-counting (blocker 8):** `if
    (t.startsWith("mcp__slaude_slack__")) continue;` skips surface output when deciding if the
    turn did substantive work. Add `mcp__slaude_surface__` (and `mcp__slaude_runtime__`) or the
    evolve threshold drifts.
  - `soul/loader.ts` (4×), `soul/data.ts` — persona/system-prompt references.
  - `skills/mcp-tools.ts:177`, `knowledge/ingest.ts:91` ("Do NOT call mcp__slaude_slack__*"),
    `gateway/slack/approval-gate.ts:33`.
  - Each must move to the namespace matching where the tool actually landed.
- **Tests.** The full existing suite (594) + sim transcripts (25) must stay green —
  consistency-by-construction means Slack-as-Surface behaves identically. Add a focused test:
  given a `SlackSurface`, `createSurfaceMcp` mounts exactly `reply`/`get_history`/
  `request_approval` + the four optional tools; given a hypothetical core-only stub surface,
  only the three core tools mount (proves capability gating without shipping WhatsApp).

## Deferred

- **WhatsAppSurface + `--surface whatsapp`.** Lands with a real WhatsApp Surface impl and a
  sim WhatsApp-transport fake. The `surfaceFactory` seam makes it drop-in: zero agent-facing
  change, faithful real==sim parity. Not in this effort.
- **Directory/search generalization** (`getUserProfile`/`searchMessages` as an optional
  `directory` capability) — stays Slack-specific for now.
- **Gateway neutralization** — moving `handleMessage`/reactions/presence/status/error-post out
  of `gateway.ts` into the Slack adapter so the core is a generic event loop. Own effort.
- **Approval-rendering abstraction (tension, flagged).** `binding.requestApproval` is today a
  gateway-provided Slack `ApprovalGate` (Block Kit buttons). A real non-Slack surface that must
  render approval *itself* (e.g. a text yes/no) cannot simply delegate to a Slack-bound hook —
  the approval seam will need rethinking when the first such surface lands. Out of scope now;
  Slack delegation stands.
- **Token-level streaming** in the sim renderer — events remain per-block.

## File-by-file

| File | Change |
|------|--------|
| `core/surface.ts` | **new** — `Surface`, `SurfaceCapability`, `SessionBinding`, `SurfaceFactory`, DTOs |
| `core/surface-mcp.ts` | **new** — `createSurfaceMcp(surface)`, capability-gated tool mounting |
| `core/runtime-mcp.ts` | **new** — `createRuntimeMcp(binding)`; ignore/cron/ingest/reload tools |
| `core/gateway.ts` | default+accept `surfaceFactory`; build binding; mount surface+runtime MCPs; widen `spoke` name-match; stop-guard string; `humanizeToolStatus` names; **cron `onExecute`** binding/surface; **connect-broker** ctx repoint. Keeps slack import (descoped) |
| `slack/surface.ts` | **new** — `SlackSurface`, `makeSlackSurfaceFactory(client)` |
| `slack/mcp-tools.ts` | shrink to directory/search; reply/edit/react/upload/history logic moves into `SlackSurface`; keep deprecated `reply` alias for one release |
| `slack/permission-gate.ts` | **add `mcp__slaude_surface__` + `mcp__slaude_runtime__` to the auto-allow prefixes (blocker 1)** |
| `slack/approval-gate.ts` | tool-name string (`:33`) → surface namespace |
| `slack/adapter.ts` | optionally pass `directoryMcpFactory` (factory itself defaults in gateway) |
| `gateway/sim/engine.ts` | uses gateway default factory over `SimTransport.client` (parity); pass directory mcp |
| `gateway/sim/stub-agent.ts` | **rewrite to call `surface.reply` / `surface.requestApproval`** instead of `slackHandlers.*` via `ctx.slack` (blocker 6) |
| `agent/manager.ts` | `:544` auto-evolve prefix (blocker 8); `:574,576` skill-evolution prompt strings |
| `soul/loader.ts`, `soul/data.ts` | persona/system-prompt tool-name references → new namespaces |
| `skills/mcp-tools.ts`, `knowledge/ingest.ts` | tool-name strings → new namespaces |
| tests | surface-mcp capability-gating test; keep suite (594) + sim transcripts (25) green; update `slaude_slack__*` assertions |
