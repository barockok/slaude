# Connect Broker — Login Host & Operations

How the contextual MCP connections feature captures credentials and what an
operator must provision. Design: `docs/superpowers/specs/2026-05-29-contextual-mcp-connections-design.md`.
Plan: `docs/superpowers/plans/2026-05-29-contextual-mcp-connections.md`.

## What this is

Per-user, thread-scoped, ephemeral MCP connections (e.g. Jira). A stable
in-process broker MCP (`slaude_connect`) fronts lazily-spawned vendor MCP
subprocesses, one per connection, and proxies tool calls. Credentials are
captured through an interactive, confined web-CDP login browser and stored
AES-256-GCM-encrypted in sqlite with a TTL.

## Required: `SLAUDE_ENCRYPTION_KEY`

The broker will not mount without it (the adapter logs `[connect-broker]
disabled: ...` and runs normally otherwise).

Generate once, store as a deploy secret (same place as `ANTHROPIC_API_KEY`):

```bash
openssl rand -base64 32
```

Rules:
- 32 bytes, base64. Generated once and kept stable — rotating it makes existing
  `cred_ciphertext` rows undecryptable (the `key_id` column exists to support a
  future rotation job).
- Never commit, never log. Secret manager / k8s Secret env var only.
- It is **scrubbed from the SDK child env** (`manager.ts` `scrubChildEnv`) so it
  never propagates to spawned subprocesses. The broker decrypts in-process;
  vendor children never see the key.

## web-CDP login host (deploy-time)

Transport is settled: **web-CDP screencast**, not noVNC. Page-scoped by
construction = confined; the user cannot reach the OS, a terminal, or browser
chrome. Trade-off: OS-native auth dialogs (basic-auth / client-cert) are
unreachable — out of scope; target cloud SSO (redirect + `window.open` popup),
which CDP covers.

`CdpLoginHost` (`src/agent/connect-broker/cdp-login.ts`) is the seam. Its
responsibilities (verified manually — not in CI, requires a headful Chrome):

- Spawn Chrome with `CHROME_CONFINE_FLAGS` (`--kiosk`, `--disable-dev-tools`,
  no extensions, no first-run) + CDP on a **random loopback port that is never
  exposed**. Lock navigation/downloads via `Page.setDownloadBehavior=deny` and a
  `Page.navigate` allowlist scoped to the service's `loginUrl` domain.
- Serve a **server-mediated** web-CDP live-view behind the signed login token
  (`login-token.ts`): `Page.startScreencast` + `Page.screencastFrameAck`,
  browser-side input → `Input.dispatchMouse/Key/TouchEvent`, with
  screencast-frame coordinate/scale mapping.
- **Multi-target popups:** `Target.setAutoAttach` → on `targetCreated` attach +
  stream the popup target + route input to it → on `targetDestroyed` switch back.
  Covers `window.open` SSO.
- **Capture** (`captureReady`): token strategy → catch the OAuth redirect and
  capture the access/refresh token; cookie strategy → capture `storageState`
  when target-domain cookies are present or the user clicks "Done — I'm
  connected".
- **Session-fixation defense:** the resulting credential is bound to the Slack
  user who *completed* login, verified out-of-band via an authenticated Slack
  interaction — reject if the completer differs from the initiator.
- Resolve `LoginSession.done` with the `CapturedCred`, then tear the browser
  down. The live-view token is one-time, single-viewer, short-TTL, never logged.

## Deploy-time seams (wired outside the unit-tested core)

The pure broker logic is fully unit-tested. These collaborators are injected at
deploy time:

- `spawnChild(connectionId)` → a `ChildHandle` that is an MCP client to the real
  vendor MCP subprocess. Deliver the decrypted credential via **stdin/handshake,
  never argv/env** (same-uid `/proc` leak across children). The default build
  throws here.
- `postConnectUrl(service)` → starts the consent + `CdpLoginHost` flow and
  returns `{ url, expiresInMs }`. The default build returns a placeholder.
- `isMember(caller, thread)` → MVP returns `true` (Slack delivered the event, so
  the caller is in the channel). Hardening: verify via `conversations.members`.

## Security summary

AES-256-GCM at rest (96-bit CSPRNG nonce, AAD = connection id); HMAC-signed
one-time single-user login token; owner-only borrow approval (reuses
`ApprovalGate` with an `approvers` override + 3-button grant); write tools gated
+ hash-bound to the exact `(service, tool, args)`; borrowable vs owner-only per
tool; personal tools never silently fall back to slaude's identity; reaper wipes
expired/idle connections and kills their child. See the design doc for the full
threat model (H1–H5, M1–M3).
