# Brain as a remote, OAuth-protected MCP process

**Date:** 2026-06-20
**Status:** approved (autonomous build — owner asleep, instructed "be autonomous")
**Branch:** `worktree-brain-remote-mcp`

## Goal

Make the gbrain engine behind `slaude_kb` runnable as a **separate process**, reachable
by slaude over an **OAuth-protected MCP transport**, with a **config toggle** so the same
binary runs either:

- **local** (default, unchanged) — gbrain engine in-process, or
- **remote** — gbrain engine in its own process; slaude proxies to it.

The brain process gets its **own CLI command** to start. Authorization uses OAuth; the
authorization server is **Keycloak** first (any RFC 9728 / OIDC issuer works).

## Non-goals

- The agent's CLI child never talks to the brain server directly. Slaude proxies.
- No change to scope resolution or write-gating semantics. Those stay in slaude.
- Not building multi-tenant brain. One brain process serves one slaude deploy.

## Decisions (locked)

1. **Scope + gating stay in slaude.** The remote brain server is a *dumb engine*: it
   receives an already-resolved scope and runs the op. OAuth only proves "a legitimate
   slaude is calling." (Owner pick.)
2. **Slaude proxies.** Agent → in-process `slaude_kb` tools (unchanged) → slaude is the
   MCP *client* → remote brain engine server. (Owner pick.)
3. **Auth reuses the existing OAuth loopback machinery** (`src/agent/mcp-oauth/*`,
   finding 2026-06-19). The brain server advertises RFC 9728 protected-resource metadata
   pointing at Keycloak; slaude's existing `discover()` + `beginConnectShared()` +
   credential store drive an `authorization_code` flow once; the refresh token keeps it
   alive. (Owner pick.) A non-interactive `SLAUDE_BRAIN_TOKEN` env path exists for
   bootstrap/testing.

## Architecture

### The fork point

`src/knowledge/brain.ts` exposes `brainCall(name, params, scope)` and
`brainAdminCall(name, params, sourceId)`. Today both do: `findOp` → `buildCtx` →
`op.handler(ctx, params)` against the local engine.

Introduce a `BrainBackend` interface and route both through the selected backend:

```ts
interface BrainBackend {
  call(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown>;
  adminCall(name: string, params: Record<string, unknown>, sourceId: string): Promise<unknown>;
}
```

- `LocalBackend` — the current bodies (findOp/ensureSource/buildCtx/handler). Verbatim move.
- `RemoteBackend` — serialize `{name, params, scope|sourceId}` to the brain server over an
  OAuth'd MCP client; deserialize the JSON result.

`brainCall`/`brainAdminCall` keep their signatures (all callers — `mcp-tools.ts`,
`brain-sync.ts`, `ensureSource`, `ensureSources`, memory provider — unchanged) and
delegate to `getBackend()`. `ensureSource`/`ensureSources` keep calling `brainAdminCall`,
so in remote mode source-ensure happens on the server, where the engine lives.

`getBackend()` selects by `brainMode()`:
- `SLAUDE_BRAIN_MODE` unset / `local` → `LocalBackend` (default; zero behavior change).
- `SLAUDE_BRAIN_MODE=remote` → `RemoteBackend` (requires `SLAUDE_BRAIN_URL`).

Boot-side concerns (`getBrain`, `boot`, `closeBrain`, `configureEmbeddingGateway`,
takeover-lock) stay local-only — in remote mode slaude never boots an engine; the brain
server does. `brainEnabled()` is unchanged. The gateway's source bootstrap
(`ensureSources` + `syncKbWikis`) runs through `brainAdminCall`, so it transparently
targets the remote engine in remote mode.

### The brain server (separate process)

New entry `src/knowledge/server/brain-server.ts`, launched by CLI `slaude brain-server`
(wired in `bin/slaude.ts`). It:

1. Boots the gbrain engine via the existing `getBrain()` / `boot()` (reused as-is).
2. Runs `ensureSources()` + nightly maintenance — the engine owner. (Moves the bootstrap
   that the gateway does today; in remote mode the gateway skips it, the server owns it.)
3. Serves an MCP server (Streamable HTTP, `webStandardStreamableHttp` under `Bun.serve`)
   exposing exactly two tools — the dumb-engine surface:
   - `brain_op` `{ op, params, clientId, sourceId, allowedSources }` → runs the
     `LocalBackend.call` body (synthetic AuthInfo from the passed scope, `remote:true`).
   - `brain_admin_op` `{ op, params, sourceId }` → runs the `LocalBackend.adminCall` body
     (`remote:false`, trusted — only reachable behind OAuth, which is the trust boundary).
4. Wraps the HTTP handler in an OAuth **resource-server** guard:
   - `Authorization: Bearer <jwt>` required. Validate with `jose` `createRemoteJWKSet`
     against `SLAUDE_BRAIN_OIDC_ISSUER` (Keycloak realm) JWKS, checking `iss` and `aud`
     (`SLAUDE_BRAIN_OIDC_AUDIENCE`).
   - Unauthenticated requests get `401` with a `WWW-Authenticate` header carrying
     `resource_metadata="<public-url>/.well-known/oauth-protected-resource"` so slaude's
     `discover()` finds the issuer.
   - Serve RFC 9728 PRM at `/.well-known/oauth-protected-resource`:
     `{ resource, authorization_servers: [issuer] }`.

Config:
- `SLAUDE_BRAIN_SERVER_PORT` (default `4319`)
- `SLAUDE_BRAIN_SERVER_HOST` (default `0.0.0.0`)
- `SLAUDE_BRAIN_PUBLIC_URL` (the externally reachable base, for PRM `resource` + redirect)
- `SLAUDE_BRAIN_OIDC_ISSUER`, `SLAUDE_BRAIN_OIDC_AUDIENCE`
- `SLAUDE_BRAIN_AUTH_DISABLED=1` — escape hatch for trusted-network/local-dev (skips JWT).

### The remote client (slaude side)

`src/knowledge/remote/brain-client.ts`:
- An MCP `Client` over `StreamableHTTPClientTransport` to `SLAUDE_BRAIN_URL`, with an
  `Authorization: Bearer` header sourced from:
  1. `SLAUDE_BRAIN_TOKEN` env (non-interactive bootstrap/testing), else
  2. the OAuth credential store (`src/agent/mcp-oauth/store.ts`, server key
     `slaude_brain`), refreshed via the existing token-exchange refresh path on
     expiry/401.
- Single-flight client init; reconnect on transport error.
- `RemoteBackend.call` → `client.callTool("brain_op", {...})`; `adminCall` →
  `brain_admin_op`. Tool result content is JSON-decoded back to the raw op result so
  `mcp-tools.ts` (which already `asJson`-wraps) is none the wiser.

`slaude brain connect` CLI subcommand: runs `discover(SLAUDE_BRAIN_URL)` →
`beginConnectShared()` → prints the authorize URL → waits for the loopback code →
exchanges → `writeEntry(configDir, "slaude_brain", cfg, tokens)`. One-time human
bootstrap; refresh token sustains it.

## Data flow (remote)

```
agent
  → mcp__slaude_kb__kb_think            (in-process, mcp-tools.ts unchanged)
  → runRead / runGated                  (scope + approval gate IN SLAUDE)
  → brainCall(name, params, scope)
  → getBackend() == RemoteBackend
  → brain-client: callTool brain_op {op,params,clientId,sourceId,allowedSources}
  → [HTTP + OAuth bearer] ─────────────────────────────────────────────►
                                          brain server: validate JWT (Keycloak JWKS)
                                          → LocalBackend.call → engine op.handler
  ◄───────────────────────────────────── JSON result
```

Local mode short-circuits at `getBackend()` — identical to today.

## Error handling

- Remote mode but no token and no `SLAUDE_BRAIN_TOKEN` → `brainCall` throws a clear
  "brain remote not authenticated — run `slaude brain connect`" surfaced through the
  existing `humanizeBrainError` path as a tool error (never crashes the turn).
- Brain server unreachable → typed transport error, surfaced as tool error; slaude turn
  survives.
- `401` from server → one refresh-and-retry; if still `401`, surface auth error.
- Server JWT invalid → `401`; never executes the op.
- `SLAUDE_BRAIN_MODE=remote` without `SLAUDE_BRAIN_URL` → fail fast at config read.

## Testing

Unit / integration (bun test, no network to real Keycloak):
1. **Backend selection** — `getBackend()` returns Local by default, Remote when
   `SLAUDE_BRAIN_MODE=remote`; throws without URL.
2. **RemoteBackend serialization** — with a stub MCP client, `call` sends correct
   `brain_op` args (scope flattened), `adminCall` sends `brain_admin_op`; JSON result
   round-trips. Error mapping on tool error.
3. **Server tool handlers** — `brain_op`/`brain_admin_op` dispatch to a stubbed engine-op
   registry with the right ctx (`remote` flag, synthetic auth, sourceId, allowlist).
   Mirror of the LocalBackend body.
4. **OAuth resource guard** — with a locally-generated RSA keypair served as a JWKS stub:
   accept a valid token (good `iss`/`aud`), reject missing / malformed / wrong-aud /
   wrong-iss / expired. PRM endpoint returns correct JSON. `SLAUDE_BRAIN_AUTH_DISABLED`
   bypasses.
5. **Round trip** — boot the server on an ephemeral port with auth disabled (or stub
   JWKS), point `RemoteBackend` at it, run a `brain_op` through a stubbed engine, assert
   the result. Confirms client+server+transport wiring.
6. **Local parity** — existing brain/mcp-tools tests still pass unchanged (LocalBackend is
   a verbatim move).

## Rollout / compatibility

- Default is local. Existing deploys unaffected (no env change → no behavior change).
- Remote deploy = two processes: `slaude brain-server` (owns the PVC/brain home) and
  `slaude start` with `SLAUDE_BRAIN_MODE=remote` + `SLAUDE_BRAIN_URL`. The one-writer
  PGLite contract is preserved — only the server process touches the DB.
- Keycloak setup (realm, client, audience mapper) documented in a findings doc on landing.

## Files

New:
- `src/knowledge/backend.ts` — `BrainBackend`, `LocalBackend`, `getBackend`, mode config.
- `src/knowledge/remote/brain-client.ts` — OAuth'd MCP client + `RemoteBackend`.
- `src/knowledge/server/brain-server.ts` — engine + MCP server + OAuth resource guard.
- `src/knowledge/server/oauth-guard.ts` — JWT validation + PRM (jose).
- `src/cli/brain-connect.ts` — `slaude brain connect`.
- tests alongside each.

Changed:
- `src/knowledge/brain.ts` — extract Local bodies into `LocalBackend`; `brainCall`/
  `brainAdminCall` delegate to `getBackend()`.
- `src/config/env.ts` (or new `src/knowledge/brain-config.ts`) — mode/url/oidc getters.
- `bin/slaude.ts` — `brain-server` + `brain` subcommands.
- `src/gateway/core/gateway.ts` — in remote mode, skip local source bootstrap + nightly
  cycle (the server owns them).
```
