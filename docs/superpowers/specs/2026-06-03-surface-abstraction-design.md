# Surface abstraction — design

**Date:** 2026-06-03
**Status:** approved (pending spec review)
**Goal:** Decouple the agent's interaction tooling from Slack so the agent talks to a
single, platform-neutral **Surface** contract. Onboarding a new surface (WhatsApp, …)
later adds one Surface implementation and changes nothing the agent sees. The sim drives
the *real* Surface implementation over a fake transport, so the agent cannot tell sim from
prod.

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

export interface HistoryItem { author: string; text: string; ref: string }
export interface ApprovalRequest { summary: string; tools?: string[]; files?: string[]; risks?: string; category?: string }
export interface ApprovalResult { approved: boolean; by: string; note?: string }

export interface Surface {
  readonly id: string;                          // real platform id, e.g. "slack"
  readonly capabilities: ReadonlySet<SurfaceCapability>;

  // core — every surface MUST implement:
  reply(i: { text: string }): Promise<{ ref: string }>;       // `ref` replaces Slack `ts`
  getHistory(i: { limit?: number }): Promise<HistoryItem[]>;
  requestApproval(r: ApprovalRequest): Promise<ApprovalResult>;

  // optional — present iff listed in `capabilities`:
  edit?(i: { ref: string; text: string }): Promise<void>;
  react?(i: { name: string; ref?: string }): Promise<void>;
  unreact?(i: { name: string; ref?: string }): Promise<void>;
  upload?(i: { path: string; comment?: string }): Promise<void>;
  typing?(i: { on: boolean }): Promise<void>;
}

/** Neutral per-session binding the gateway builds from the inbound turn. The factory
 *  (provided by the adapter) closes over the transport client, so the gateway core never
 *  imports a platform SDK. */
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
createGateway(agent, transport, { surfaceFactory, directoryMcpFactory? })
```

Per session the gateway builds a neutral `SessionBinding` from the inbound event, then
`const surface = surfaceFactory(binding)`. The MCP resolver mounts
`createSurfaceMcp(surface)` + `createRuntimeMcp(binding)` + `directoryMcpFactory?.(binding)`
when provided. The core never names a platform. Generalize the Slack-specific bits:

- `spoke` reply-tracking keys off a `surface.reply` call (the Surface notifies the gateway it
  replied), not a `mcp__slaude_slack__reply` string match.
- The stop-guard nudge string becomes `mcp__slaude_surface__reply`.
- `core/gateway.ts` drops its `import … from "../slack/mcp-tools"`.

The slack adapter (`slack/adapter.ts`) builds the factory bound to the real `WebClient`:
`const surfaceFactory = makeSlackSurfaceFactory(transport.client)` and passes it to
`createGateway`.

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

## 6. Migration & tests

- **Deprecated alias, one release.** Keep `mcp__slaude_slack__reply` mounted as a thin alias
  delegating to `surface.reply`, so an in-flight session or a persona/skill referencing the
  old name doesn't break. Mark deprecated; remove next release.
- **Prompt/doc sweep.** Update agent system-prompt / soul references and docs from
  `slaude_slack__reply` → `slaude_surface__reply`.
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
- **Token-level streaming** in the sim renderer — events remain per-block.

## File-by-file

| File | Change |
|------|--------|
| `core/surface.ts` | **new** — `Surface`, `SurfaceCapability`, `SessionBinding`, `SurfaceFactory`, DTOs |
| `core/surface-mcp.ts` | **new** — `createSurfaceMcp(surface)`, capability-gated tool mounting |
| `core/runtime-mcp.ts` | **new** — `createRuntimeMcp(binding)`; ignore/cron/ingest/reload tools |
| `core/gateway.ts` | accept `surfaceFactory`; build binding; mount surface+runtime MCPs; generalize `spoke` + stop-guard; drop slack import |
| `slack/surface.ts` | **new** — `SlackSurface`, `makeSlackSurfaceFactory(client)` |
| `slack/mcp-tools.ts` | shrink to directory/search; move runtime tools out; reply logic moves into `SlackSurface`; keep deprecated `reply` alias for one release |
| `slack/adapter.ts` | build + pass `surfaceFactory`; pass slack-directory mcp |
| `gateway/sim/engine.ts` | inject `makeSlackSurfaceFactory(transport.client)` into `createGateway` |
| tests | surface-mcp capability-gating test; keep suite + sim transcripts green; update any `slaude_slack__reply` assertions |
