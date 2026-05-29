# 2026-05-29 — Contextual per-user MCP connections

Per-user, thread-scoped, ephemeral MCP connections (e.g. Jira). Spec:
`docs/superpowers/specs/2026-05-29-contextual-mcp-connections-design.md`.
Plan: `docs/superpowers/plans/2026-05-29-contextual-mcp-connections.md`.
Ops: `docs/connect-broker-login.md`.

## Shape

A stable in-process broker MCP (`slaude_connect`, wired into the per-session MCP
resolver like `session-mcp`) fronts lazily-spawned vendor MCP subprocesses, one
per connection, keyed by connection id (process-global pool, idle reaper). It
exposes generic proxy tools — `mcp_call`, `mcp_describe`, `connect`,
`connections_list`, `connections_revoke` — so the SDK tool list stays fixed
(MCP servers resolve once at session start; the broker dodges that by owning the
children and proxying as an MCP client). Credentials are captured via a confined
web-CDP login browser and stored AES-256-GCM-encrypted in sqlite with a TTL.

## Two review-driven reversals from the brainstorm

1. **Caller identity is in-band, not from session context (B1).** `adapter.ts`
   mutates `SlackContext.userId` per inbound message; under concurrent thread
   users it races, so a borrow could resolve the wrong user's connection. Fix:
   the agent passes `on_behalf_of` to `mcp_call`, validated server-side against
   the turn's caller. (Full per-user turn isolation remains a deeper manager-level
   change, out of scope here; the equality check is the MVP guard.)

2. **Per-thread revocable grant, not per-request approval.** The brainstorm chose
   per-request; all three review angles flagged it as rubber-stamp theater. Now
   the owner gets one rich approval (`Allow for thread / Just once / Deny`); a
   thread grant lets later borrows run silently, but every use is still audited.

## web-CDP, no noVNC

Live-view transport is confined web-CDP screencast: page-scoped, so the user
cannot reach OS/terminal/browser-chrome — a deliberate security choice over
noVNC's full-desktop blast radius. Cost: OS-native auth dialogs are unreachable
(rare for cloud SSO). `window.open` SSO popups are handled via CDP multi-target
auto-attach. See `docs/connect-broker-login.md`.

## Security highlights

`SLAUDE_ENCRYPTION_KEY` (32-byte base64, scrubbed from child env); AAD-bound
GCM; write tools gated + hash-bound to exact args (defeats LLM-summary spoofing);
borrowable-vs-owner-only per tool; personal tools never silently use slaude's
identity (fail-closed for unclassified tools). Partial unique indexes work around
SQLite NULL-distinct so slaude-scope rows dedupe on `(owner, service)`.
