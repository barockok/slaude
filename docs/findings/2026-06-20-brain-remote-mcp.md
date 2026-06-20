# Brain as a remote, OAuth-protected MCP process (configurable)

**Date:** 2026-06-20

The gbrain engine behind `slaude_kb` can now run either in-process (default,
unchanged) or as a **separate OAuth-protected MCP process** that slaude proxies to.
The toggle is config-only; default deploys see zero behavior change.

## Mechanism

### The backend seam

`brainCall` / `brainAdminCall` in `src/knowledge/brain.ts` no longer talk to the
engine directly. They delegate to `getBackend()` (`src/knowledge/backend.ts`):

- `LocalBackend` → the extracted engine primitives `runScopedOp` / `runAdminOp`
  (the old bodies, moved verbatim). `buildScopedCtxAuth(scope)` builds the
  synthetic gbrain `AuthInfo` from a resolved `BrainScope`.
- `RemoteBackend` → an OAuth'd MCP client to the brain server.

Selection is by `SLAUDE_BRAIN_MODE` (`local` default / `remote`). The remote
backend registers itself via `registerRemoteBackend()` on import, so `backend.ts`
needs no static import of the MCP client (avoids a cycle and keeps the client out
of the local code path).

**Scope and write-gating stay in slaude.** `mcp-tools.ts` (`runRead`/`runGated`)
and `gated-dispatch.ts` are unchanged — the approval card, standing grants, and
channel-trust tiers all run *before* the backend call. The remote server is a
**dumb engine**: it receives an already-resolved scope and runs the op. OAuth only
proves "a legitimate slaude is calling."

### Topology — slaude proxies

The agent's CLI child never sees the brain server. The flow is:

```
agent → in-process slaude_kb tool → scope+gate in slaude → brainCall
      → RemoteBackend → MCP client → [HTTP + OAuth bearer] → brain server
      → runScopedOp on the engine → JSON result
```

Local mode short-circuits at `getBackend()`.

### The brain server

`src/knowledge/server/brain-server.ts`, launched by `slaude brain-server`:

1. Boots the gbrain engine via the existing `getBrain()` and runs `ensureSources()`.
2. Serves MCP over Streamable HTTP (`WebStandardStreamableHTTPServerTransport`
   under `Bun.serve`, stateless — fresh server+transport per request).
3. Exposes exactly two tools (`src/knowledge/server/tools.ts`):
   - `brain_op { op, params, clientId, sourceId, allowedSources }` → `runScopedOp`.
   - `brain_admin_op { op, params, sourceId }` → `runAdminOp`.
4. Guards `/mcp` with an OAuth **resource-server** check
   (`src/knowledge/server/oauth-guard.ts`): a `jose` `createRemoteJWKSet` validates
   the bearer JWT against `SLAUDE_BRAIN_OIDC_ISSUER` (Keycloak realm) checking
   `iss` and `aud`. Unauthenticated requests get `401` +
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
   and that RFC 9728 PRM endpoint advertises the issuer so slaude's existing
   `discover()` finds it. `SLAUDE_BRAIN_AUTH_DISABLED=1` bypasses (trusted network).

   **Fail-closed config:** when auth is enabled, both issuer and audience MUST be
   set. `jwtVerify` skips the `iss`/`aud` checks if either is `undefined`, which
   would accept any well-formed token from anywhere — so `guardConfigError()` makes
   `startBrainServer` refuse to boot on that config, and `verifyBearer` returns
   `500` (never a check-skipping verify) if it ever slips through.

### Auth reuses the existing loopback

`slaude brain connect` (`src/cli/brain-connect.ts`) drives the shared OAuth
loopback (finding 2026-06-19): `discover(url)` → `beginConnectShared()` → print
authorize URL → wait for the loopback code → exchange → `writeEntry(…, "slaude_brain", …)`.
One-time human bootstrap; the refresh token sustains the link. `RemoteBackend`
reads the bearer from `SLAUDE_BRAIN_TOKEN` (non-interactive bootstrap/testing)
first, else the credential store (`readEntry`, added to `store.ts`). No token + an
authenticated server → a clear "run `slaude brain connect`" error surfaced as a
tool error (the turn never crashes).

## Deploy contract

Remote = two processes:

- `slaude brain-server` — owns the brain home / PGLite DB. **One writer.**
- `slaude start` with `SLAUDE_BRAIN_MODE=remote` + `SLAUDE_BRAIN_URL` — proxies.
  In remote mode the gateway skips local source-bootstrap + nightly maintenance
  (`gateway.ts`: `brainEnabled() && brainMode() === "local"`); the server owns them.

The PGLite single-writer invariant is preserved: only the server touches the DB.

## Keycloak setup (operator)

- A realm + a confidential/public client for slaude; dynamic client registration
  (RFC 7591) enabled on the realm so `beginConnectShared`'s `registerClient` works,
  or pre-register and adapt.
- An audience mapper so issued tokens carry `aud = SLAUDE_BRAIN_OIDC_AUDIENCE`.
- `SLAUDE_BRAIN_OIDC_ISSUER` = the realm issuer; JWKS resolved at
  `<issuer>/protocol/openid-connect/certs`.

## Config reference

| Env | Where | Meaning |
|-----|-------|---------|
| `SLAUDE_BRAIN_MODE` | slaude | `local` (default) / `remote` |
| `SLAUDE_BRAIN_URL` | slaude | remote brain MCP URL (required in remote) |
| `SLAUDE_BRAIN_TOKEN` | slaude | non-interactive bearer (bootstrap/testing) |
| `SLAUDE_BRAIN_SERVER_PORT` | server | default `4319` |
| `SLAUDE_BRAIN_SERVER_HOST` | server | default `0.0.0.0` |
| `SLAUDE_BRAIN_PUBLIC_URL` | server | external base (PRM `resource`) |
| `SLAUDE_BRAIN_OIDC_ISSUER` | server | Keycloak realm issuer |
| `SLAUDE_BRAIN_OIDC_AUDIENCE` | server | expected token `aud` |
| `SLAUDE_BRAIN_AUTH_DISABLED` | server | `1` = skip JWT (trusted net / dev) |

Spec: `docs/superpowers/specs/2026-06-20-brain-remote-mcp-design.md`.
Plan: `docs/superpowers/plans/2026-06-20-brain-remote-mcp.md`.
