# 2026-06-08 — /1on1 OAuth isolation via per-initiator CLAUDE_CONFIG_DIR

## Problem

The `.mcp.json` credential-strip (`clearCredentials`, see
[private-services finding](2026-06-08-private-services-1on1.md)) does **not** affect
OAuth-authenticated HTTP MCP servers. Observed in the sim: a `workbench`
(`type: http`, no `env`/`headers`/url creds) stays connected to google-sheets after
`/1on1`.

Root cause chain:
- `clearCredentials` edits the **config** (env/headers/url). `workbench` carries no
  credentials there, so the strip is a byte-identical no-op.
- The real credential is an **MCP OAuth token** the claude-code child (spawned by the
  SDK) persists under its `CLAUDE_CONFIG_DIR` (default `~/.claude`:
  `.credentials.json`, `mcp-needs-auth-cache.json`), keyed by server and **reused
  across runs/reboots**. The Agent SDK itself doesn't persist MCP OAuth — the CLI child
  does.
- slaude never set a per-session `CLAUDE_CONFIG_DIR`, so every session shared one OAuth
  store; the lock state couldn't change which token the CLI picked up.

So `clearCredentials`/`privateServices` only works for **config-credential** servers
(e.g. `grafana`, key in `env.GRAFANA_API_KEY`), never for OAuth servers.

## Fix

Per-initiator `CLAUDE_CONFIG_DIR` isolation, active only while `/1on1`-locked:

- **Locked** → child runs with `CLAUDE_CONFIG_DIR = $SLAUDE_HOME/oauth/<initiatorUserId>`
  (persistent, per-initiator — tokens accumulate across that user's locked threads).
  Every OAuth-requiring HTTP MCP resolves against the **initiator's** tokens.
- **Unlocked** → inherit the agent's config dir unchanged (agent identity).
- The existing reboot-on-`/1on1` forces re-resolution (`CLAUDE_CONFIG_DIR` is read once
  at child boot, can't hot-swap).

**Seeding:** the initiator home is seeded from the agent config dir with non-secret
`settings.json` (copied) + `plugins/` (symlinked) so the locked session keeps
skills/plugins, but **never** the credential files (`.credentials.json`,
`mcp-needs-auth-cache.json`) — those are scrubbed defensively on every ensure.

## Code

- `src/agent/oauth-home.ts` (pure helpers, unit-tested): `agentConfigDir`,
  `initiatorConfigDir`, `ensureInitiatorConfigDir`, `resolveSessionConfigDir`.
- Wired in `manager.ts` `#startSession`: look up
  `OneOnOne.find(row.slack_channel_id, row.slack_thread_ts)`; if locked, set
  `providerEnv.CLAUDE_CONFIG_DIR = resolveSessionConfigDir(lock.locked_user)`.

## Decisions / scope

- **Keying = per-initiator** (not per-thread): matches "run as the initiator"; auth once,
  reuse across the user's locked threads. Mirrors the connect-broker's per-user identity.
- **Pre-authed, slaude-managed:** the initiator authenticates their
  `$SLAUDE_HOME/oauth/<userId>` home out-of-band. First `/1on1` with no token does **not**
  surface the CLI's OAuth flow into Slack — deferred (would reuse connect-broker
  cdp-login / a login host). MVP only swaps the config dir + reuses existing tokens.
- **All-or-nothing:** `CLAUDE_CONFIG_DIR` isolates the *whole* OAuth store, so a locked
  session runs ALL OAuth MCP servers as the initiator (not selectively per
  `privateServices`). Per-server OAuth scoping isn't possible via config-dir alone.

## Caveats

- **macOS:** claude-code may store some credentials in the Keychain (global per OS user),
  which `CLAUDE_CONFIG_DIR` does not isolate. File-based MCP OAuth caches DO isolate.
  Deploy target is Linux (container, all file-based) → fine; the local sim on macOS may
  not fully isolate subscription-level OAuth.
- `clearCredentials` (config-cred path) still applies to non-OAuth whitelisted servers and
  is unchanged. The two mechanisms are complementary.

## Still open (from earlier audit, not addressed here)

- `clearCredentials` doesn't strip URL **path**-embedded creds (only userinfo/query/hash).
- Plugin-provided MCP servers (`loadInstalledPluginMcps`) bypass `privateOverrides`.
