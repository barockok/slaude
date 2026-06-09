# Design — `/mcp` Slack gate command: connect MCP HTTP OAuth in `/1on1` mode

**Date:** 2026-06-09
**Status:** Draft for review
**Related:** [[2026-06-08-oauth-config-dir-1on1]] (per-initiator `CLAUDE_CONFIG_DIR`, shipped `965de07`), [[2026-06-08-private-services-1on1]] (`/1on1` credential overlay), [[2026-05-29-contextual-mcp-connections]] (connect-broker — explicitly NOT this path).

## Problem

In a `/1on1`-locked thread, the locked session runs with `CLAUDE_CONFIG_DIR` pointed at the initiator's config home, so OAuth-authenticated HTTP MCP servers resolve as the initiator. But the initiator's config home starts empty — and the only way claude-code triggers MCP OAuth is its **interactive `/mcp` UI** (loopback callback). A Slack user has **no CLI access**, so they cannot bootstrap their own tokens out-of-band. There is no programmatic SDK hook to run the OAuth flow.

Result: the per-initiator config-dir isolation works mechanically, but a Slack-only initiator can never populate it → OAuth MCP servers stay disconnected for them.

## Goal

Let a Slack-only initiator, inside a `/1on1`-locked thread, connect an OAuth HTTP MCP server **from Slack** — no CLI, no public URL — after which claude-code natively owns the connection lifecycle.

### Non-goals (MVP)

- Connecting in **normal (unlocked) mode** — untouched, agent identity as-is.
- **Auto-trigger** on `needs-auth` mid-turn — explicit command only.
- **Token refresh / reconnect** logic in slaude — the CLI owns it.
- **SSE** servers — HTTP only.
- Multiple distinct initiators per thread — one lock = one initiator.
- A `setMcpServers`-based live path — rejected (see Alternatives).

## Key decision: write the CLI's `mcpOAuth` store, let the CLI own the lifecycle

slaude runs **only** the initial OAuth handshake (because the Slack user can't), then **writes the token into the CLI's native credential store** in the initiator's config dir. Everything after — connection, reconnection, **refresh** — is the CLI's, because the token lives where the CLI looks.

This keeps the shipped `CLAUDE_CONFIG_DIR` override as the runtime mechanism and adds only: a gate command, an OAuth client, and a store writer.

### SDK-utilization boundary (what slaude does NOT reinvent)

slaude must lean on the claude-code SDK for everything the SDK owns; it reimplements **only** the one step the SDK exposes no hook for.

- **Credential session management — SDK/CLI owns it, slaude must not touch.** Token refresh, reconnect, connection lifecycle, expiry handling. These run inside the CLI's own MCP OAuth provider (`r2A` in `cli.js`), which reads `mcpOAuth[key]` from its store and refreshes off `clientId` + `refreshToken`. Because we write the token where the CLI looks, this is automatic. Non-goals already forbid a slaude refresh/reconnect path; this section is the positive statement of the same rule.
- **Status — read from the SDK.** Server state comes from `Query.mcpServerStatus()` (`connected | failed | needs-auth | pending`), never a slaude-maintained mirror.
- **The one unavoidable reimplementation — the initial handshake (Unit 1).** Verified against the installed SDK: the public `Query` interface exposes only `mcpServerStatus()` / `setMcpServers()`, and the control protocol subtypes are `initialize, interrupt, can_use_tool, set_permission_mode, set_model, set_max_thinking_tokens, mcp_status, rewind_files, hook_callback, mcp_message, mcp_set_servers` — **no oauth/authorize subtype**. The CLI's OAuth machinery (`a2A`, `r2A`, discovery/registration/exchange) is internal, not exported. So there is no SDK call to "run the OAuth grant"; Unit 1 performs the grant **once** and stops. It does NOT manage sessions, refresh, or reconnect — it hands the resulting tokens to the store and the CLI takes over. If a future SDK release adds a programmatic auth hook, Unit 1 is the single module to delete.

### The store format (reverse-engineered from `cli.js`, must be pinned)

```
# NOT canonical/sorted JSON — the CLI uses plain JSON.stringify with a FIXED field
# order and headers kept verbatim (insertion order from the server config). Do NOT
# sort keys; doing so changes the hash and every server mismatches.
key = serverName + "|" + sha256( JSON.stringify({ type, url, headers: headers||{} }) ).hex.slice(0, 16)
# Source: cli.js `a2A(A,Q)` = Q1({type,url,headers||{}}); Q1 === JSON.stringify (no key sort).

<CLAUDE_CONFIG_DIR>/.credentials.json:
  mcpOAuth[key] = {
    serverName, serverUrl,
    clientId, clientSecret,        // from dynamic client registration
    accessToken, refreshToken,
    expiresAt: now + (expires_in || 3600) * 1000
  }
```

Validated against a known CLI-written entry (`workbench|33367cca58b918d7`). The CLI's refresh path keys off `clientId` + `refreshToken` in this same entry — so once written, refresh is native.

**macOS write-path is a no-op (Linux/container only).** The CLI's store reader `Ow()` is keychain-backed on darwin: `Ow(){if(process.platform==="darwin")return pVQ(cVQ,V_1);return V_1}`, where `pVQ` is keychain-primary + file-fallback — `read()` returns the keychain blob if non-null and **only** falls to the file when it's null. So a `.credentials.json` write is *shadowed by the keychain* on macOS and the CLI never reads it. This extends the existing `resolveSessionConfigDir` darwin caveat (claudeAiOauth) to the **entire `mcpOAuth` store**. Consequence: the full connect→`connected` loop is verifiable only on Linux/container (the deploy target). On a macOS dev box only the store-writer unit/fixture (a pure function) round-trips; the "CLI reads the token → connected" leg cannot. The container smoke test (below) is the authoritative end-to-end check.

## Architecture

Three new units; one integration point already exists.

### 1. MCP OAuth client — `src/agent/mcp-oauth/client.ts`

Pure async flow implementing the MCP authorization spec for an HTTP server:

1. `GET <server>` → `401` + `WWW-Authenticate` → resource metadata URL.
2. Fetch protected-resource metadata → authorization-server metadata (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`).
3. **Dynamic client registration** (`POST registration_endpoint`, `redirect_uris=[loopback]`) → `client_id`/`client_secret`.
4. Generate PKCE (`code_verifier`/`code_challenge`) + `state`. Build the **authorize URL**.
5. Bind an **ephemeral loopback listener** (`127.0.0.1:0`, or `0.0.0.0` in-container), `redirect_uri = http://localhost:<port>/callback`.
6. Return `{ authorizeUrl, waitForCode(): Promise<code> }`; the listener resolves `waitForCode` on `?code&state` (state match) then closes. Timeout → reject.
7. `exchange(code)` → `POST token_endpoint` (PKCE verifier) → `{ access_token, refresh_token, expires_in, client_id, client_secret }`.

Unit-tested against mocked discovery/registration/token endpoints. No slaude global state; the pending PKCE/state live in the returned handle.

### 2. `mcpOAuth` store writer — `src/agent/mcp-oauth/store.ts`

- `oauthKey(serverName, serverConfig)` → the `serverName|hash16` key (replicates `a2A`).
- `writeEntry(configDir, serverName, serverConfig, tokens)` → read-modify-write `<configDir>/.credentials.json`, set `mcpOAuth[key]`, preserve `claudeAiOauth` + other keys, `0600`.
- **RMW race.** A still-live locked session's CLI child can refresh-write the same `.credentials.json` concurrently (the CLI refresh path also writes `mcpOAuth[key]`). `agent.reload` fires *after* the write, so a window exists where our read-modify-write and the CLI's overlap → lost update / truncated file. Mitigation: write atomically (temp file + `rename`), and prefer writing while the session is idle (no turn in flight) — the connect flow already pauses on `await waitForCode()`, so gate the write on session-idle before committing.
- A **fixture test** asserts `oauthKey` reproduces the known `workbench|33367cca58b918d7` for that config — the canary that fails loudly if the CLI format changes.

### 3. Gate command — `parseSlashCommand` kind `mcp` + gateway handler

- New kind `{ kind: "mcp"; action?: "status" | "connect"; server?: string }`.
- **Rejected unless the thread is `/1on1`-locked** (and the caller is the lock's initiator) — mirrors the existing 1on1 gate checks.
- `/mcp` → `query.mcpServerStatus()` → Block Kit card: each server + `connected/failed/needs-auth/pending`; a `[Connect]` button per non-connected HTTP server.
- `[Connect <server>]` button →
  1. run the OAuth client → post the **authorize URL** to the initiator (Slack link / sim line);
  2. `await waitForCode()` (loopback);
  3. `exchange` → `store.writeEntry(initiatorConfigDir, …)`;
  4. `agent.reload(sessionId)` (existing) so the next turn boots the locked session, CLI reads the new token → connected;
  5. update the card → `connected`.

### 4. Integration point (exists) + one required change to shipped code

`resolveSessionConfigDir` / the manager already set `CLAUDE_CONFIG_DIR = initiatorConfigDir` for a locked session (`965de07`). The writer targets that same dir. No new resolver wiring.

**Required change — stop scrubbing `.credentials.json`.** `ensureInitiatorConfigDir` (shipped) currently deletes `CRED_FILES = [".credentials.json", "mcp-needs-auth-cache.json"]` on every call (a belt-and-suspenders guard against a bad seed). That call runs on **every** locked-session boot — so it would wipe the token this feature writes. The original scrub was defensive only (the seeder never copies agent creds — it copies `settings.json` and symlinks `plugins/`). With this feature the initiator dir is *meant* to hold the initiator's own `.credentials.json`. **Change:** drop the `CRED_FILES` scrub from `ensureInitiatorConfigDir` (keep the "never copy agent creds" property by simply not copying them, which is already the case). Also fix the existing seeding gap: copy `settings.local.json` too, not only `settings.json`.

## Data flow

```
/mcp (locked, initiator)
  → mcpServerStatus() → card
  → [Connect server]
     → oauth.client: discover → register → PKCE authorize URL + loopback
     → surface authorizeUrl in Slack
     → user authorizes (browser) → loopback captures code
     → exchange → tokens
     → store.writeEntry(initiatorConfigDir, server, cfg, tokens)
     → agent.reload(session)
  → next turn: locked session boots w/ CLAUDE_CONFIG_DIR=initiatorConfigDir
     → CLI reads mcpOAuth[key] → connected; CLI owns refresh/reconnect thereafter
```

## Loopback constraint (no public URL)

The authorize `redirect_uri` is `http://localhost:<port>/callback` on the slaude host — never a public URL. The initiator's browser must reach that loopback:
- **local / sim:** works directly.
- **container:** bind `0.0.0.0` + `docker -p <port>:<port>`; the initiator opens `localhost:<port>` on the Docker host. Port chosen from a configured range (`SLAUDE_OAUTH_LOOPBACK_PORTS`) so the `-p` map is known. Documented as a deploy constraint; still no public ingress.

## Error handling

- discovery/registration/exchange failure → card `failed` + reason; pending torn down.
- loopback timeout (no callback within N s) → expire, card prompts retry.
- `state` mismatch on callback → reject (CSRF guard).
- no live `Query` for `mcpServerStatus` → "send a message first".
- not locked / not the initiator → command rejected (gate).
- `oauthKey` canary mismatch at startup → log loud + disable the command (format drift).

## Testing

- **OAuth client** — mocked endpoints: discovery, registration, PKCE authorize params, token exchange, state-mismatch, timeout.
- **Store writer** — fixture: `oauthKey` reproduces `workbench|33367cca58b918d7`; `writeEntry` preserves other keys + sets `mcpOAuth`; `0600`.
- **Gate command** — sim: `/mcp` rejected when unlocked; in a locked thread renders the status card; `[Connect]` with a **stubbed** OAuth client surfaces a URL and writes the entry; reject for non-initiator.
- **Container smoke** — extend the existing verify harness: `/1on1` → `/mcp` → connect (loopback via `-p`) → confirm `mcpOAuth[key]` in `verify-data/oauth/<initiator>/.credentials.json`.

## Risks

1. **Undocumented CLI format** (`a2A` canonicalizer + entry schema). Mitigation: pin the `@anthropic-ai/claude-agent-sdk` version; the `oauthKey` canary test fails loudly on drift; the writer is one small isolated module to update.
2. **Loopback reachability** in container deploys — documented; acceptable since the alternative (public callback) is explicitly disallowed.
3. **Token at rest** — written to `.credentials.json` (the CLI's own location, `0600`) inside the initiator's config dir under `$SLAUDE_HOME`. No additional slaude encryption (matches where the CLI already stores it).

## Alternatives considered

- **`setMcpServers` header injection** (slaude owns token + refresh + reconnect). Rejected: slaude would re-own the whole lifecycle (refresh, reconnect) the CLI already does; the config-dir write lets the CLI own it. More code, parallel path.
- **connect-broker** (`slaude_connect`, `mcp_call` proxy, CDP cred-scrape). Rejected by the owner: wrong layer; not the SDK's native MCP-HTTP-OAuth connection; borrow-model, not self-connect. **Now removed entirely** — the `/1on1` per-initiator lock makes the borrow-on-behalf-of concept obsolete (each locked thread already runs *as* the initiator). The `slaude_connect` tool family, broker module, `connections`/`connection_grants`/`connection_audit` tables, `SLAUDE_ENABLE_CONNECT_BROKER` flag, and the `grantButtons`/borrow extensions to `ApprovalGate` are deleted in the same change set as this feature.
- **Out-of-band `claude /mcp` bootstrap.** Rejected: Slack users have no CLI access.

## Open decisions

- [ ] Command name: `/mcp` (mirrors claude-code) vs `/connect`. Default `/mcp`.
- [ ] Loopback port strategy in container: fixed single port vs a small configured range.
- [ ] Surface the authorize URL via the thread, or via Telegram/DM to the initiator (link is sensitive-ish; thread is simpler). Default: thread, ephemeral where possible.
