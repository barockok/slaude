# 2026-06-03 — Surface abstraction (agent interaction decoupled from Slack)

Implements [the surface-abstraction spec](../superpowers/specs/2026-06-03-surface-abstraction-design.md).
The agent now talks to a platform-neutral **Surface** contract; Slack is the first
implementation; the sim drives the *real* implementation over a fake transport.

## What shipped

- **`core/surface.ts`** — `Surface` port: core `reply`/`getHistory`/`requestApproval` +
  optional `edit`/`react`/`upload`/`typing` (capability-gated). `SessionBinding`,
  `SurfaceFactory`.
- **`core/surface-mcp.ts`** — `createSurfaceMcp` / `surfaceTools`: mounts core tools always,
  optional tools per declared capability. Agent calls `mcp__slaude_surface__*`.
- **`slack/surface.ts`** — `SlackSurface` (id=`slack`, caps `edit/react/upload`) over the
  WebClient, same mrkdwn+redact formatting; `getHistory` preserves `reply_count`/`thread_ts`/
  `has_more`. `makeSlackSurfaceFactory(client)`.
- **`gateway.ts`** — builds a `SlackSurface` per session via a live `SessionBinding` view over
  the mutated-in-place `ctx`; mounts surface + runtime MCPs (default `surfaceFactory` =
  extension seam). `spoke`, `humanizeToolStatus`, stop-guard nudge all moved to the surface
  namespace. Both inbound and cron routes carry the surface.
- **`slaude_runtime`** — ignore/cron/ingest/reload split out of `slaude_slack`
  (`createRuntimeMcp`). `slaude_slack` now = directory/search + a DEPRECATED `reply` alias.
- **`permission-gate`** — auto-allows `mcp__slaude_surface__` / `mcp__slaude_runtime__`
  (without this every reply would be gated — the worst review blocker).
- **stub-agent** — drives the real `surface` (parity); the 25 sim transcripts now exercise
  gateway→surface→SlackSurface→transport end-to-end.
- **sweep** — system prompt (soul/loader), soul/data, skills, knowledge-ingest, manager
  skill-evolution prompt, auto-evolve work-counting all repointed to the new namespaces.

## Key decisions / facts

- **Parity is structural, not a flag.** The sim never masks or re-implements Surface logic; it
  injects `SimTransport`'s fake client into the *same* `SlackSurface`. So `id="slack"` and the
  capability set are identical in sim and prod — the agent cannot tell them apart. Faking a
  thinner surface (e.g. WhatsApp) by masking caps was explicitly rejected: it would diverge
  from a future real `WhatsAppSurface`.
- **Descoped after review.** `gateway.ts` stays the Slack adapter (reactions/presence/status/
  handleMessage). Full gateway neutralization + a real WhatsApp surface are deferred behind the
  `surfaceFactory` seam — onboarding one later is a new impl with zero agent-facing change.
- **Transition safety.** A deprecated `mcp__slaude_slack__reply` alias remains one release;
  `spoke`/permission-gate match both namespaces. `slackHandlers` kept (its direct tests are
  untouched), so the `SessionMcpCtx` shape change didn't ripple destructively.
- **Live-LLM smoke blocked on creds.** The subscription OAuth token 401s (short-lived), so a
  real agent turn couldn't complete a reply — but the stop-guard nudge confirmed the surface
  wiring is active, and the 25 sim transcripts are a deterministic end-to-end smoke.

## Verification

Full suite **666 pass / 0 fail**, sim **25/25**, `tsc --noEmit` clean. New tests:
surface-mcp capability gating (4), SlackSurface behavior (8), permission-gate surface+runtime
allow (2), stub-agent parity path (rewritten).

## Deferred

WhatsApp `Surface` + `--surface` flag; gateway neutralization; approval-rendering abstraction
for non-Slack surfaces; directory/search generalization; removing the deprecated `reply` alias
(next release).
