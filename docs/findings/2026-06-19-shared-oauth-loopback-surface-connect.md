# Shared OAuth loopback + surface-aware connect + URL-safe mrkdwn (#51)

2026-06-19. Shipped in PR #51 (`09eeeae`). Three intertwined threads, all driven by the
same realization: the `/mcp connect` OAuth flow had Slack and a per-flow listener baked
into it, and the markdown→mrkdwn converter quietly corrupted the auth URL.

## 1. The runtime synthesizes the OAuth `authenticate` tools — the server never ships them

Investigating how `mcp__workbench__authenticate` / `…__complete_authentication` appear: they
are **not** declared by the workbench MCP server (its real tools are `whoami`, `connect`,
`list_integrations`, …). The server returns `401` + `WWW-Authenticate: Bearer
resource_metadata=…` (RFC 9728); the Claude Code **runtime** sees that and *fabricates* the
auth tool pair to drive the OAuth bootstrap, then drops them once a token is in hand. The
redirect_uri (`http://localhost:3118/callback`) is owned entirely by the runtime's loopback
client — host+path hardcoded, only the port configurable. Nothing in the prompt or the SDK
sets it. This is why slaude can't "override" the synthesized tool: in the SDK path it never
exists; slaude must own the flow itself (which it already did via `src/agent/mcp-oauth/`).

## 2. Shared always-on loopback, demuxed by HMAC-signed state

Goal: let many sessions authorize concurrently behind **one** fixed callback port (so a
container maps a single port) instead of a fresh ephemeral listener per connect.

- `state.ts` — `state = b64u(sid).b64u(nonce).HMAC(secret,"<sid>.<nonce>")`. The session id
  rides in the OAuth `state` (RFC 6749's client-set, echoed-back slot). The **nonce** makes
  each flow's state unique (the registry key) and is the effective capability/CSRF guard; the
  **HMAC** makes the sid tamper-evident.
- `shared-loopback.ts` — one listener (default port 3118), routes each callback to its flow by
  exact `state` match. Always-on singleton, started at boot, opt-in via
  `SLAUDE_OAUTH_SHARED_LOOPBACK`.
- Workbench's auth server exact-matches `redirect_uri` (full path+query) **but** supports open
  dynamic registration (RFC 7591) — so a fixed state-independent redirect_uri works: register
  it once, route by state. (Verified in `../workbench`: `oauth-routes.ts` `.includes()` match +
  `clients.ts registerClient`.)

**Security-review correction (`7163116`):** routing was pure registry string-match — the nonce
guarded it and the HMAC was dead. A future change trusting a sid decoded from the returned
state *without* verifying would open a forgery surface. Fix: a `verify(state)` gate runs on the
inbound state **before** registry lookup, wired to `verifyState(s, secret)`. Now any routed
state provably bears a valid HMAC. Defense-in-depth; nonce still the capability.

## 3. The converter corrupted the auth URL; the connect flow ignored the Surface

Two coupled bugs surfaced from "is the posted URL markdown-friendly?":

- **`mdToMrkdwn` was not URL-safe.** Emphasis rules rewrote `_`/`__`/`*` *inside* URLs.
  base64url query params (`code_challenge`, `state`) contain `__`, so `…U__.mac…` → `…U*.mac…`.
  Fix: carve `<…>` autolinks and bare `http(s)://` tokens like code spans (protect+restore),
  before the `[text](url)` link rule. Fixes **any** agent-emitted URL, not just OAuth.
- **The connect flow hardcoded `t.client.chat.postMessage`** — a Slack leak in a
  channel-agnostic path. Routed it through the session's **Surface** (`connectSurface()` mints
  one from the gateway's `surfaceFactory`; works outside a live turn). Because `surface.reply()`
  runs the converter, the URL-safe fix was a prerequisite.

**Redact, don't delete.** On settle (success, failure, **or loopback timeout**) the auth-URL
message is edited in place to strip the live link — keeps the breadcrumb, kills a stale
clickable secret. Reuses the existing `edit` capability; best-effort. `authMsgRef` threaded
through `PendingPaste` so paste-back redacts too.

## Also flanking-fix (`0f69a3a`)

Slack mrkdwn rejects emphasis when a space hugs the marker and has no triple-star. `***x***`
→ `_*x*_`; `** x **` → `*x*` (trim inner padding). Intra-word bold (`word**b**word`) is a
Slack-renderer limit, left as-is.

## Takeaways

- Security-sensitive control strings (auth URLs, tokens) must go **out-of-band of the LLM**,
  verbatim. The connect flow is gateway-deterministic for exactly this reason — and that also
  sidesteps the converter. Don't "tidy" it onto `SlackSurface.reply()` without the URL-safe carve.
- When a signed value is only ever string-matched, the signature is dead weight — wire the
  verify before anything trusts the decoded payload, or it's a latent forgery surface.
- Whole-file coverage numbers (gateway.ts, surface.ts) are dominated by pre-existing code;
  judge a PR by its diff's coverage, not the file's.
