# 2026-06-09 — /mcp OAuth connect in /1on1 (write CLI mcpOAuth store, CLI owns lifecycle)

## Decision

slaude runs **only** the initial OAuth handshake — because a Slack-only initiator has no CLI
access — then writes the resulting token into the CLI's native `mcpOAuth` credential store
inside the initiator's `CLAUDE_CONFIG_DIR`. Everything after (connection, refresh, reconnect,
lifecycle) is owned by the CLI child that reads from that store. **slaude does not reinvent
credential session management.**

The per-initiator `CLAUDE_CONFIG_DIR` isolation shipped in
[[2026-06-08-oauth-config-dir-1on1]] is the runtime mechanism; this feature adds only: a gate
command (`/mcp`), an OAuth client (PKCE/discovery/registration/loopback/token-exchange), and a
store writer.

## Store format (reverse-engineered, must be pinned)

```
key = serverName + "|" + sha256( JSON.stringify({ type, url, headers: headers||{} }) ).hex.slice(0, 16)
```

Critical: **plain `JSON.stringify`, fixed field order** (`type`, `url`, `headers`). No key
sorting. The CLI uses `JSON.stringify` directly (source: `a2A(A,Q)` → `Q1({type,url,headers||{}})`
in `cli.js`), so sorting the object keys changes the hash and every server mismatches.

Entry written to `<CLAUDE_CONFIG_DIR>/.credentials.json`:

```json
{
  "mcpOAuth": {
    "<key>": {
      "serverName", "serverUrl",
      "clientId", "clientSecret",
      "accessToken", "refreshToken",
      "expiresAt": now + (expires_in || 3600) * 1000
    }
  }
}
```

**Golden canary:** `workbench|c17ea65c6b709142` (the known hash for the workbench test
fixture). A boot guard asserts `oauthKey` reproduces this value and **disables `/mcp`** on
drift, so any SDK update that changes the canonicalization is immediately loud rather than
silently mis-keyed.

The CLI's refresh path (`r2A` in `cli.js`) keys off `clientId` + `refreshToken` in this same
entry, so once written refresh is automatic.

## macOS caveat

On darwin the CLI's store reader (`Ow()`) is keychain-primary:
`if(process.platform==="darwin")return pVQ(cVQ,V_1)` where `pVQ` reads the keychain first and
falls to file only when the keychain blob is null. A `.credentials.json` write is therefore
**shadowed by the keychain** on macOS — the CLI never reads the file.

Consequence: the full connect → `connected` loop round-trips **only on Linux/container** (the
deploy target). On a macOS dev box only the store-writer unit (a pure function operating on a
temp fixture) is verifiable end-to-end; the "CLI reads the new token → server becomes
connected" leg cannot be exercised locally. The container smoke step in
`scripts/verify-1on1.sh` is the authoritative end-to-end check.

This extends the existing darwin NO-OP caveat from [[2026-06-08-oauth-config-dir-1on1]] (which
documented the `claudeAiOauth` keychain shadow) to the entire `mcpOAuth` store.

## Atomic RMW

`writeEntry` is atomic: write to a temp file, `chmod 0600`, then `rename` over the target.
A concurrent CLI refresh-write (the CLI also writes `mcpOAuth[key]` on refresh) cannot
observe a half-written file; one write wins atomically. The connect flow also gates the write
on session-idle (it naturally pauses during `await waitForCode()`) to minimize the overlap
window.

## Components

- **OAuth client** — `src/agent/mcp-oauth/client.ts`: PKCE, discovery, dynamic client
  registration, ephemeral loopback listener, token exchange. Pure async; no global state.
- **Store writer** — `src/agent/mcp-oauth/store.ts`: `oauthKey()` (canary-tested),
  `writeEntry()` (atomic RMW, `0600`).
- **`/mcp` gate command** — new `kind: "mcp"` in `parseSlashCommand`; rejected unless the
  thread is `/1on1`-locked and the caller is the lock's initiator. Renders a Block Kit server
  status card with `[Connect]` buttons for non-connected HTTP servers.
- **Boot canary** — asserts `oauthKey` reproduces the golden fixture on startup; disables
  `/mcp` on drift.

## Connect-broker removal

The connect-broker (`slaude_connect` / `mcp_call` proxy / CDP credential-scrape / borrow
model) is removed entirely. The per-initiator `/1on1` lock (see
[[2026-06-08-private-services-1on1]]) makes borrow-on-behalf-of obsolete: each locked thread
already runs *as* the initiator. The broker tables (`connections`, `connection_grants`,
`connection_audit`), the `SLAUDE_ENABLE_CONNECT_BROKER` flag, and the `grantButtons`/borrow
extensions to `ApprovalGate` are deleted in the same change set.

## Callback modes — loopback vs paste-back (k8s)

The authorization-code callback is delivered two ways, env-selected. **Uniqueness across
concurrent flows never relies on the port** — it rests on `state` (CSRF) + a per-initiator,
per-thread pending entry.

- **Loopback (default)** — ephemeral `http://localhost:<port>/callback` on the slaude host.
  Works local / same-host container (host networking → no `-p`; bridge → pre-map
  `SLAUDE_OAUTH_LOOPBACK_PORTS`). Browser must reach the slaude host.
- **Paste-back (`SLAUDE_OAUTH_REDIRECT_URL` set)** — for **k8s / remote**, where the pod
  can't expose an arbitrary runtime port and the user's browser is remote (so `localhost`
  would hit the user's own machine). No listener. slaude registers the operator's **fixed
  static redirect page**, posts the authorize URL + "paste it back" instruction; the IdP
  redirects the browser to that page (it shows `code`+`state`); the initiator pastes the
  callback URL/bare code into the locked thread; slaude parses it (`parseOAuthCallback`),
  matches the parked flow by `channel:thread:user`, validates `state`, runs `exchange`.
  No ingress *into* slaude — only the static page must be user-reachable.

Both modes share the listener-free core `prepareConnect` (register + PKCE + authorize URL +
`exchange`); `beginConnect` is the loopback wrapper. Pending paste flows expire after 10 min;
one in-flight connect per initiator per thread. The 1on1 lock guarantees only the initiator
can complete (non-initiators are dropped before reaching the paste interception).

## Testing

- OAuth client: mocked discovery / registration / PKCE params / token exchange / state-mismatch / timeout.
- Store writer: `oauthKey` fixture reproduces `workbench|c17ea65c6b709142`; `writeEntry` preserves other keys + sets `mcpOAuth`; file mode `0600`.
- Gate command (sim): `/mcp` rejected when unlocked; status card in locked thread; stubbed OAuth client surfaces URL + writes entry; non-initiator rejected.
- Container smoke: `scripts/verify-1on1.sh` asserts `mcpOAuth` entry present in `verify-data/.claude/.credentials.json` on Linux; prints SKIP on macOS.
