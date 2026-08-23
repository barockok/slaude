# Configuration & SOUL

> Every variable, file, and manifest slaude reads at boot — with types, defaults, and copy-paste examples. One page to go from zero env to a validated deploy.

This page is the single source of truth for runtime configuration. It mirrors `src/config/env.ts`, `src/config/home.ts`, `src/soul/*`, and `src/cli/validate.ts` — if code and this page disagree, code wins and this page has a bug.

On this page:

- [Slack tokens & app setup](#slack)
- [Anthropic auth & model selection](#anthropic)
- [Runtime environment variables](#runtime-env)
- [Filesystem layout — SLAUDE_HOME](#filesystem)
- [Connect broker](#connect-broker)
- [SOUL.md — persona schema](#soul)
- [Dependency manifests — slaude.json & slaude.lock](#manifests)
- [External MCP — .mcp.json](#external-mcp)
- [Validation — bun run validate-soul](#validation)

---

## Slack <a id="slack"></a>

slaude speaks to Slack exclusively through **Socket Mode** (no public HTTP endpoint). Two tokens and one app-level scope make that work.

### Tokens

| Name | Required | Example | Where it comes from |
|------|----------|---------|---------------------|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-…` | **OAuth & Permissions → Install to workspace → Bot User OAuth Token**. Reinstall whenever `manifest.json` scopes change. |
| `SLACK_APP_TOKEN` | Yes | `xapp-…` | **Basic Information → App-Level Tokens → Generate** with scope `connections:write`. This is the Socket Mode pipe. |
| `SLACK_USER_TOKEN` | No | `xoxp-…` | Optional user token for presence (`users.profile.set`) and — only when `SLACK_POST_AS_USER=true` — posting as your real Slack user instead of the bot. |

> **Callout — Do not commit tokens.** `.env` and `~/.slaude/.env` are gitignored. If a token appears in `git diff --cached`, `git reset` immediately and rotate it in Slack. Treat `xoxb`/`xapp`/`xoxp` with the same care as `sk-ant`.

### Socket Mode & required scopes

slaude is Socket Mode-only. The manifest at `src/cli/manifest.ts` declares these bot scopes — install will fail if any are missing:

```json
{
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "reactions:read",
        "reactions:write",
        "users:read",
        "users.profile:write",
        "assistant:write"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "interactivity": { "is_enabled": true },
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "assistant_thread_started",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim"
      ]
    },
    "org_deploy_enabled": false
  }
}
```

### App-level scopes & setup checklist

| Scope | Where | Why slaude needs it |
|-------|-------|---------------------|
| `connections:write` | **App-Level Token** (`xapp-…`) | Opens the Socket Mode websocket. Without it Bolt never connects. |
| `assistant:write` | **Bot scopes** | Unlocks `assistant.threads.setStatus` — the animated "thinking…" / "running tool…" indicator next to the bot name. |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Bot scopes | Read thread history; required for `SLACK_POST_AS_USER=true` reads as well. |

**Setup checklist (api.slack.com/apps):**

1. `bun run manifest > manifest.json` → **Create New App → From manifest** → paste.
2. **Basic Information → App-Level Tokens** → create token → enable `connections:write` → copy `xapp-…` as `SLACK_APP_TOKEN`.
3. **OAuth & Permissions → Install to workspace** → copy `xoxb-…` as `SLACK_BOT_TOKEN`. Reinstall after any manifest change.
4. **Agents & AI Apps** → enable assistant view (unlocks status indicator, requires `assistant:write`).
5. **Socket Mode** → enable (must be on; no HTTP Events URL needed).

### Agents & AI status

When `assistant:write` is granted, slaude calls `assistant.threads.setStatus` to show live status in the thread header: `is thinking…`, `running Read …`, `writing file …`. No extra env needed — if the scope is missing the call is silently skipped and threads still work, just without the animation.

### Optional — post as the real user

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLACK_USER_TOKEN` | No | `""` | `xoxp-…` user token for `users.profile.set` and optional post-as-user. |
| `SLACK_POST_AS_USER` | No | `false` | When `true` **and** `SLACK_USER_TOKEN` is set, the agent posts/edits/reacts/uploads as the real Slack user account instead of the bot. App-bound interactivity (Approve/Deny gate buttons) always stays on the bot token. Accepts `true` case-insensitively; anything else is `false`. |

> **Security note for `SLACK_POST_AS_USER`** — reads also route through the user token in this mode, so the `xoxp` must carry both write scopes (`chat:write`, `reactions:write`, `files:write`) and read scopes (`channels:history`, `groups:history`, `im:history`, `users:read`). The agent's read reach equals the human account's (private channels and DMs included). Only enable for accounts whose full scope you are comfortable exposing to tool use.

```bash
# .env — bot-only (default, recommended)
SLACK_BOT_TOKEN=xoxb-1234567890-XXXXXXXXXXXX
SLACK_APP_TOKEN=xapp-1-A111-abc123def456

# .env — post as your real Slack user (opt-in)
SLACK_USER_TOKEN=xoxp-1234567890-XXXXXXXXXXXX
SLACK_POST_AS_USER=true
```

---

## Anthropic auth & model selection <a id="anthropic"></a>

slaude talks to any **Anthropic-compatible Messages API**. That includes `api.anthropic.com`, OpenRouter, Z.ai, or a self-hosted gateway — same wire format, different base URL.

### Auth modes — pick one

| Mode | Env vars | When to use | What slaude sends |
|------|----------|-------------|-------------------|
| **(a) API key** | `ANTHROPIC_API_KEY` + optional `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Metered API credits; any compatible gateway | `x-api-key: sk-ant-…` (or `Authorization: Bearer <ANTHROPIC_AUTH_TOKEN>` for gateways that prefer bearer) |
| **(b) Claude subscription OAuth** | `CLAUDE_CODE_OAUTH_TOKEN` | Run on your Claude Pro/Max subscription instead of metered credits | `Authorization: Bearer sk-ant-oat01-…` + `anthropic-beta: oauth-2025-04-20` |

Rules:

- **API key wins when both are set.** Explicit `ANTHROPIC_API_KEY` beats `CLAUDE_CODE_OAUTH_TOKEN`.
- **`ANTHROPIC_AUTH_TOKEN`** — alternative bearer token for gateways that expect `Authorization: Bearer` instead of `x-api-key`. Rarely needed; `ANTHROPIC_API_KEY` covers Anthropic and most gateways.
- **Generate the OAuth token:** on a machine already logged into Claude Code, run `claude setup-token`, paste the `sk-ant-oat01-…` value into slaude's env. Both the SDK child and the soul extractor (`src/soul/extract.ts`) auto-detect it.

```bash
# Gateway matrix — same .env shape for every provider
# Anthropic direct (default base URL)
ANTHROPIC_API_KEY=sk-ant-...

# OpenRouter / Z.ai / self-hosted — point the base URL, pin a provider-qualified model (required)
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_API_KEY=sk-or-...          # OpenRouter key
SLAUDE_MODEL=anthropic/claude-sonnet-4-6

# Claude Pro / Max subscription — no API key, inherits subscription default model
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# leave SLAUDE_MODEL unset to inherit the subscription default — set it only to pin a tier-allowed model
```

```bash
# .env — auth validation errors you will see
# missing both keys:
#   Error: missing env SLACK_BOT_TOKEN          (startup, from src/config/env.ts req())
#   Error: missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN   (soul extractor / model listing)
```

### ANTHROPIC_BASE_URL — gateways

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Base URL for the Messages API. Set to any compatible gateway. When pointing at a **non-Anthropic** gateway you **must** set `SLAUDE_MODEL` to a provider-qualified id — those endpoints do not recognise Anthropic's default model id. |
| `ANTHROPIC_AUTH_TOKEN` | No | `""` | Bearer token for gateways that prefer `Authorization: Bearer` over `x-api-key`. |

Additional provider env forwarded to the SDK child (and scrubbed from telemetry paths) by `src/agent/manager.ts`:

```
ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
CLAUDE_CODE_OAUTH_TOKEN
→ forwarded as providerEnv
DISABLE_TELEMETRY=1, DISABLE_AUTOUPDATER=1,
DISABLE_BUG_COMMAND=1, DISABLE_ERROR_REPORTING=1,
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
→ forced to 1 so non-Anthropic gateways do not crash on telemetry
```

### Model selection — precedence & the small/fast model

There is **no** per-tier var like `ANTHROPIC_OPUS_MODEL` / `ANTHROPIC_SONNET_MODEL`. Only two vars are honoured:

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_MODEL` | Conditionally | `""` (empty) | slaude-side override. Provider-qualified model id (e.g. `claude-sonnet-4-6`, `anthropic/claude-sonnet-4-6` on OpenRouter). **Required when `ANTHROPIC_BASE_URL` points at a non-Anthropic gateway.** Empty means "do not pass `--model` to the SDK child — let the CLI pick its own default." |
| `ANTHROPIC_MODEL` | No | `""` | Claude Code CLI-native fallback for the main-session model when `SLAUDE_MODEL` is unset. Same semantics, just CLI-native. Forwarded transparently — slaude never reads it directly. |
| `ANTHROPIC_SMALL_FAST_MODEL` | No | CLI default | Haiku-class model for compaction, tool routing, and sub-tasks. Orthogonal to the main model. Pin only to override the fast-tier default. |

**Precedence in the SDK child (from `src/agent/manager.ts`):**

```
1. options.model  (= SLAUDE_MODEL, when non-empty)   ← highest, set per-session at boot + via /model
2. ANTHROPIC_MODEL  (CLI-native env, when SLAUDE_MODEL empty)
3. CLI built-in default for the active auth mode
     • under CLAUDE_CODE_OAUTH_TOKEN → subscription default (leave both unset)
     • under ANTHROPIC_API_KEY       → Anthropic default model
```

> **When to leave `SLAUDE_MODEL` unset.** With `CLAUDE_CODE_OAUTH_TOKEN` you usually want to inherit the subscription default — the SDK chooses a tier-allowed model automatically. Set `SLAUDE_MODEL` only to pin a specific model, or when using `ANTHROPIC_BASE_URL`.

```bash
# Model selection examples

# 1. Subscription — inherit default (recommended for CLAUDE_CODE_OAUTH_TOKEN)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# (no SLAUDE_MODEL, no ANTHROPIC_MODEL)

# 2. Subscription — pin a tier-allowed model
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
SLAUDE_MODEL=claude-sonnet-4-6

# 3. Non-Anthropic gateway — SLAUDE_MODEL is required
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_API_KEY=sk-or-...
SLAUDE_MODEL=anthropic/claude-sonnet-4-6
# If SLAUDE_MODEL is missing on OpenRouter/Z.ai the request fails:
#   extractor http 400 / SDK model-not-found — provider does not recognise the default model id

# 4. CLI-native fallback (SLAUDE_MODEL unset, ANTHROPIC_MODEL set)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5

# 5. Fast-tier override (independent of main model)
ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5
```

Per-thread model switching is also available at runtime via `/model` (and `slaude model` MCP) — it calls `Query.setModel()` live and persists to `sessions.model` for resume. The env vars above are the boot default.

---

## Runtime environment variables <a id="runtime-env"></a>

All vars are read via `src/config/env.ts` (`req()` throws on missing, `opt()` returns `""` or a fallback). `SLAUDE_HOME` and its derived paths live in `src/config/home.ts`.

### Required

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | — | `xoxb-…` bot token. `req()` throws `missing env SLACK_BOT_TOKEN` if empty. |
| `SLACK_APP_TOKEN` | Yes | — | `xapp-…` app-level token with `connections:write`. `req()` throws if empty. |

### Anthropic / provider

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Conditionally | `""` | Required when not using `CLAUDE_CODE_OAUTH_TOKEN`. API-key auth (`x-api-key` header). |
| `CLAUDE_CODE_OAUTH_TOKEN` | Conditionally | `""` | Claude Pro/Max subscription token (`sk-ant-oat01-…`). Requires `anthropic-beta: oauth-2025-04-20` header — handled automatically. At least one of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` must be set. |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Any compatible gateway. Non-Anthropic gateways require `SLAUDE_MODEL`. |
| `ANTHROPIC_AUTH_TOKEN` | No | `""` | Bearer token for gateways that prefer `Authorization: Bearer` over `x-api-key`. |
| `SLAUDE_MODEL` | Conditionally | `""` | Provider-qualified model id. See [Model selection](#anthropic) for precedence. **Required when `ANTHROPIC_BASE_URL` is non-Anthropic.** |
| `ANTHROPIC_MODEL` | No | `""` | CLI-native fallback when `SLAUDE_MODEL` is unset. Forwarded to SDK child. |
| `ANTHROPIC_SMALL_FAST_MODEL` | No | CLI default | Haiku-class model for compaction and sub-tasks. |

### Slack — optional

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLACK_USER_TOKEN` | No | `""` | `xoxp-…` user token. Used for `users.profile.set` presence; also the post-as-user token when `SLACK_POST_AS_USER=true`. |
| `SLACK_POST_AS_USER` | No | `false` | `true` (case-insensitive) enables posting as the real Slack user. Requires `SLACK_USER_TOKEN`. |
| `SLAUDE_APPROVERS` | No | `""` | Comma-separated Slack user ids allowed to click **Approve / Deny** on `request_approval` plans. **Fallback only** — used when `SOUL.md` has no `## Approvers` section. Empty means any clicker is accepted (only safe for solo / DM workspaces). Trimmed, comma-split, empty entries dropped. |

### Home & paths

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_HOME` | No | `~/.slaude` | Runtime home. All state lives beneath it. Overridable for testing or multi-persona hosts. |
| `SLAUDE_DB_PATH` | No | `$SLAUDE_HOME/db.sqlite` | Override the sqlite file. Accepts absolute path or path relative to `SLAUDE_HOME`. Use when `SLAUDE_HOME` is a read-only image layer and the DB must live on a separately-mounted volume (e.g. k8s `subPath`). |
| `SLAUDE_WORKSPACES` | No | `$SLAUDE_HOME/workspaces` | Per-session cwd root. Same absolute/relative semantics as `SLAUDE_DB_PATH`. The sim redirects both under `$SLAUDE_HOME/sim/` so it shares config without mutating prod state. |
| `SLAUDE_DB` | No | `sqlite` | State store dialect: `sqlite` (file at `SLAUDE_DB_PATH`) or `pg` (Postgres). With `pg` and no `SLAUDE_PG_URL`, an in-process PGLite is used (sim and tests; `SLAUDE_PGLITE_DIR` persists it to disk). Schema for `pg` is applied from `src/db/migrations/*.sql` at boot. |
| `SLAUDE_PG_URL` | With `SLAUDE_DB=pg` | none | Postgres connection URL (`postgres://user:pass@host:5432/db`). Driver is `Bun.sql`; pool size via `SLAUDE_PG_POOL` (default 10). |
| `SLAUDE_MASTER_KEY` | For encrypted columns | none | 32 random bytes, base64 (`openssl rand -base64 32`). Keys AES-256-GCM for the `(enc)` Postgres columns (`slack_apps.bot_token`, `signing_secret`, `provider_creds.value`). Not needed while the monolith runs a single Socket Mode app. |

See [Filesystem layout](#filesystem) for every file under `SLAUDE_HOME`.

### Sessions & UX

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_IDLE_MINUTES` | No | `15` | Minutes of inactivity after which the SDK `Query` closes. Next inbound message in the same thread resumes via `resume: <session-id>`. Set to `0` to disable (sessions live forever). Non-finite or negative values fall back to `15`. Parsed as `Number(raw) * 60 * 1000` ms. |
| `SLAUDE_DEFAULT_MODE` | No | `default` | Default permission mode for new sessions. Aliases are normalized. Values: `default` (alias `ask`), `acceptEdits` (aliases `accept-edits`, `acceptedits`, `edits`), `bypassPermissions` (aliases `bypass`, `yolo`), `plan`, `dontAsk` (aliases `dont-ask`, `deny`). Unknown values fall back to `default`. Override per-thread with `/mode`. |
| `SLAUDE_AUTO_ALLOW_TOOLS` | No | `""` | Comma-separated tool names auto-allowed without prompting. Others post a Block Kit **Allow / Always / Deny** prompt. Empty means ask for every tool. Common default `Read,Grep,Glob,LS`. |
| `SLAUDE_HEALTH_PORT` | No | `8080` | Health server port. `GET /healthz` → liveness `{status:"ok", uptime_ms, sessions_live}`, `GET /readyz` → DB ping (503 if unreachable), `GET /metrics` → Prometheus exposition. Set to `0` or non-finite to disable. See `src/health.ts`. |
| `SLAUDE_TOKEN_WARN_PCT` | No | `0.8` | Fraction of the model's context window at which slaude posts a one-shot warning in the active thread. Edge-triggered — fires once per session. Source window comes from live `modelUsage.contextWindow`. |
| `SLAUDE_TOKEN_CRITICAL_PCT` | No | `0.92` | Critical threshold sibling of `SLAUDE_TOKEN_WARN_PCT`. Set to `0` to disable the critical tier. |

### Metrics & context budget

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_FALLBACK_CONTEXT_WINDOW` | No | `200000` | Fallback context-window size (tokens) when the SDK `result` message has no `modelUsage` entry to source the cap from. Non-positive or non-finite values fall back to `200000`. |
| `SLAUDE_METRICS_LABELS` | No | `""` | Static Prometheus labels applied to every metric, e.g. `agent=hermes,env=prod`. Malformed entries are silently dropped by the metrics registry (`src/metrics.ts`). |
| `SLAUDE_METRICS_PER_USER` | No | `0` | Opt in to per-user turn counters `slaude_user_turns_total`. Off by default to avoid high-cardinality blow-up in public channels. Accepts `1`, `true`, or `yes` (case-insensitive). |

### MCP OAuth — loopback vs paste-back

Two modes for the authorization-code callback when connecting HTTP MCP servers via `/mcp connect` in `/1on1`:

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_OAUTH_REDIRECT_URL` | No | `""` | Fixed `redirect_uri` for paste-back mode. When set, slaude does **not** bind a loopback listener — it registers this URL, the IdP redirects the browser to an operator-hosted static page that shows the `code` + `state` with a "paste this back into Slack" instruction, and the initiator pastes the callback URL into the locked thread. Required for k8s / remote deploys where an ephemeral loopback port is not reachable. Empty → loopback mode. |
| `SLAUDE_OAUTH_PUBLIC_URL` | No | `""` | Public base URL the shared loopback advertises as its `redirect_uri` (e.g. `https://slaude.example.com`). In-cluster the listener binds a private port but the IdP must redirect the user's browser to a publicly routable host fronted by ingress — this is that host. The callback path is appended. Empty → loopback falls back to `http://localhost:<port>`. |
| `SLAUDE_OAUTH_LOOPBACK_HOST` | No | `127.0.0.1` | Loopback bind host. `127.0.0.1` locally; `0.0.0.0` in-container so a `docker -p` mapped port is reachable from the host. |
| `SLAUDE_OAUTH_LOOPBACK_PORTS` | No | `""` (ephemeral) | Inclusive range `a-b` the container pre-maps with `-p` (e.g. `40100-40110`). The connect flow picks the first free port in the range; empty → `port 0` (ephemeral). |
| `SLAUDE_OAUTH_SHARED_LOOPBACK` | No | `false` | Use the always-on shared loopback (one fixed port, flows demuxed by signed `state`) instead of a fresh ephemeral listener per connect. Lets many sessions authorize concurrently behind a single pre-mapped port. Accepts `1`/`true`/`yes` (case-insensitive). |
| `SLAUDE_OAUTH_SHARED_LOOPBACK_PORT` | No | `3118` | Fixed port for the shared loopback callback server (same port the Claude CLI uses). Only meaningful when `SLAUDE_OAUTH_SHARED_LOOPBACK` is on. Non-finite values fall back to `3118`. |
| `SLAUDE_OAUTH_STATE_SECRET` | No | random per-process | HMAC secret signing the session id inside the OAuth `state`. Empty → `randomBytes(32).base64url` per process (fine: the shared listener lives for the process lifetime, so in-flight states stay verifiable; a restart invalidates pending flows). |

```bash
# MCP OAuth examples

# Loopback (default, local / same-host container) — no extra env; ephemeral port
# SLAUDE_OAUTH_LOOPBACK_HOST=0.0.0.0 in-container so docker -p mapping is reachable

# Paste-back (k8s / remote)
SLAUDE_OAUTH_REDIRECT_URL=https://slaude.example.com/oauth/paste
# That static page must display `code` and `state` and instruct the user to paste the full callback URL back into the locked Slack thread.

# Shared always-on loopback (multi-session concurrency behind one port)
SLAUDE_OAUTH_SHARED_LOOPBACK=true
SLAUDE_OAUTH_SHARED_LOOPBACK_PORT=3118
SLAUDE_OAUTH_PUBLIC_URL=https://slaude.example.com
SLAUDE_OAUTH_LOOPBACK_HOST=0.0.0.0
SLAUDE_OAUTH_LOOPBACK_PORTS=40100-40110
```

### Skills repo & evolution

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_SKILLS_REPO` | No | `""` | Git repo URL where runtime-created skills are pushed by `sync_manifest`. Accepts `github:owner/repo` shorthand or full `https`/SSH URL. When unset, `sync_manifest` records skills as local-only entries (survive on PVC only). |
| `SLAUDE_AUTO_EVOLVE` | No | `1` | Auto-evolve after each substantial user turn. When `1`, the manager injects an internal `<auto-evolve>` prompt so the agent decides whether to save or refine a skill. Set to `0` to disable. |
| `SLAUDE_SOUL_PARSE_MAX_TOKENS` | No | `8192` | `max_tokens` budget for the soul extractor LLM call. Raise when a slower model needs more headroom (thinking-mode providers emit thinking + text blocks that both count). Non-positive or non-finite values fall back to `8192`. |
| `SLAUDE_SOUL_PARSE_MODEL` | No | `SLAUDE_MODEL` or `claude-haiku-4-5-20251001` | Model used for the SOUL.md → JSON extraction pass. Defaults to `SLAUDE_MODEL` when set, otherwise `claude-haiku-4-5-20251001`. |

### External MCP env references

Any env var referenced via `${VAR}` inside `~/.slaude/.mcp.json` is expanded at load time (see [External MCP](#external-mcp)). Common examples:

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `GRAFANA_URL` | No | `""` | Example external MCP server URL, referenced as `${GRAFANA_URL}` in `.mcp.json`. |
| `GRAFANA_API_KEY` | No | `""` | Companion secret, referenced as `${GRAFANA_API_KEY}`. |

```bash
# Full .env example — copy to ~/.slaude/.env and fill in
# --- Slack (required) ---
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# --- Slack optional ---
# SLACK_USER_TOKEN=xoxp-...       # presence / post-as-user
# SLACK_POST_AS_USER=false

# --- Provider (pick ONE auth mode) ---
ANTHROPIC_API_KEY=sk-ant-...
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
# ANTHROPIC_AUTH_TOKEN=...
# SLAUDE_MODEL=claude-sonnet-4-6
# ANTHROPIC_MODEL=claude-sonnet-4-6
# ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5

# --- Home ---
# SLAUDE_HOME=~/.slaude
# SLAUDE_DB_PATH=db.sqlite
# SLAUDE_DB=pg
# SLAUDE_PG_URL=postgres://slaude:change-me@localhost:5432/slaude
# SLAUDE_MASTER_KEY=<openssl rand -base64 32>
# SLAUDE_WORKSPACES=workspaces

# --- Sessions ---
SLAUDE_DEFAULT_MODE=ask
SLAUDE_AUTO_ALLOW_TOOLS=Read,Grep,Glob,LS
SLAUDE_IDLE_MINUTES=15
SLAUDE_HEALTH_PORT=8080
# SLAUDE_TOKEN_WARN_PCT=0.8
# SLAUDE_TOKEN_CRITICAL_PCT=0.92
# SLAUDE_FALLBACK_CONTEXT_WINDOW=200000

# --- Approvers fallback (SOUL.md wins when present) ---
SLAUDE_APPROVERS=

# --- Metrics ---
# SLAUDE_METRICS_LABELS=agent=hermes,env=prod
# SLAUDE_METRICS_PER_USER=0

# --- MCP OAuth (loopback by default; set redirect for k8s paste-back) ---
# SLAUDE_OAUTH_REDIRECT_URL=https://slaude.example.com/oauth/paste
# SLAUDE_OAUTH_LOOPBACK_HOST=127.0.0.1
# SLAUDE_OAUTH_LOOPBACK_PORTS=40100-40110
# SLAUDE_OAUTH_SHARED_LOOPBACK=
# SLAUDE_OAUTH_SHARED_LOOPBACK_PORT=3118
# SLAUDE_OAUTH_PUBLIC_URL=
# SLAUDE_OAUTH_STATE_SECRET=

# --- Skills evolution ---
# SLAUDE_SKILLS_REPO=github:owner/repo
# SLAUDE_AUTO_EVOLVE=1
# SLAUDE_SOUL_PARSE_MAX_TOKENS=8192
# SLAUDE_SOUL_PARSE_MODEL=claude-haiku-4-5-20251001

# --- External MCP vars referenced from .mcp.json ---
GRAFANA_URL=
GRAFANA_API_KEY=
```

---

## Filesystem layout — SLAUDE_HOME <a id="filesystem"></a>

`SLAUDE_HOME` defaults to `~/.slaude` (`src/config/home.ts` → `process.env.SLAUDE_HOME || join(homedir(), ".slaude")`). Every path below is resolved against it — see overrides `SLAUDE_DB_PATH` and `SLAUDE_WORKSPACES` above.

| Path | What it holds |
|------|---------------|
| `~/.slaude/SOUL.md` | Persona — the operator-authored identity file. Auto-seeded with the starter scaffold on first boot if missing. See [SOUL.md](#soul). |
| `~/.slaude/.env` | Env file auto-loaded by `src/config/env.ts` (`loadDotenv(paths.env)`) without overriding existing `process.env`. Docker compose also reads `./.env` from the repo root. |
| `~/.slaude/.mcp.json` | External MCP servers. Mounted into the container at `/data/.mcp.json` (discovered via session cwd parent chain). See [External MCP](#external-mcp). |
| `~/.slaude/slaude.json` | Dependency manifest — plugins, skills, knowledge bases. See [Manifests](#manifests). |
| `~/.slaude/slaude.lock` | Pinned shas for every manifest entry. See [Manifests](#manifests). |
| `~/.slaude/skills/` | Installed skills — one dir per slug containing `SKILL.md`. Hot-reloaded each turn; mounted as a local plugin (`paths.home` with `skipMcpDiscovery: true`). |
| `~/.slaude/knowledge/` | Installed KB wikis — one dir per label. Indexed into the brain at boot and nightly maintenance. |
| `~/.slaude/cache/` | Extracted `SoulData` JSON keyed by `sha256(SOUL.md)`, policy embeddings. Safe to delete — re-extracted on next boot. |
| `~/.slaude/workspaces/` | Per-session cwd — `workspaces/<team>-<channel>-<thread>[__persona]/`. Each thread gets its own git worktree-like dir. |
| `~/.slaude/.claude/` | Claude Code config dir (`CLAUDE_CONFIG_DIR`). Holds `installed_plugins.json`, plugin cache, project transcripts (`projects/`). In `/1on1` mode the child is pointed at `$SLAUDE_HOME/oauth/<userId>` for OAuth isolation. |
| `~/.slaude/personas/` | Multi-persona operator-created directory. Presence means multi-bot mode; each named persona has its own `SOUL.md` and `mcp.json` overlay. |
| `~/.slaude/db.sqlite` | `bun:sqlite` — `sessions`, `brain`, `soul_overrides`, `kb_ingest_jobs` tables. Override via `SLAUDE_DB_PATH` for PVC `subPath` mounts. Absent when `SLAUDE_DB=pg`; move an existing file with `bun run migrate-sqlite` (idempotent, `--dry-run` to preview). |

```bash
~/.slaude/
├── SOUL.md              # persona (you author this)
├── .env                 # env — never commit
├── .mcp.json            # external MCP servers
├── slaude.json          # dependency manifest
├── slaude.lock          # pinned shas
├── db.sqlite            # sessions + overrides + jobs
├── cache/
│   └── soul.<sha>.json  # LLM-extracted SoulData cache
├── skills/
│   └── <slug>/SKILL.md
├── knowledge/
│   └── <label>/         # markdown wiki per KB
├── workspaces/
│   └── T111-C222-1700000000.000000/
├── .claude/
│   ├── plugins/
│   │   └── installed_plugins.json
│   └── projects/        # per-session transcripts
└── personas/            # multi-persona (optional)
    └── <name>/
        ├── SOUL.md
        └── mcp.json
```

> **Container note.** When `SLAUDE_HOME` is mounted from a read-only image layer, use `SLAUDE_DB_PATH` and `SLAUDE_WORKSPACES` to place mutable state on a separately-mounted volume. `install.ts` stages clones inside a sibling of the eventual destination (not `$SLAUDE_HOME/.tmp`) so `renameSync` stays on the same filesystem across PVC `subPath` volumes.

---

## Connect broker <a id="connect-broker"></a>

slaude ships two connection models. Understanding which you need avoids over-configuring.

### /1on1 mode (shipped, no extra env)

`/1on1` locks a thread to you + manager and isolates the Claude child's `CLAUDE_CONFIG_DIR` per initiator (`$SLAUDE_HOME/oauth/<userId>`). This is slaude's per-thread contextual MCP story — it works with no broker env. Most teams only need this.

### Connect broker — when you need it

The connect broker exposes **per-user OAuth'd MCP connections** as slaude tools scoped to the calling thread. It is **off by default**. When disabled, no `slaude_connect` tools mount at all — `/1on1` still works but there is no cross-user MCP brokering.

> **Current code:** the broker gate is documented in `README.md` as `SLAUDE_ENABLE_CONNECT_BROKER` + `SLAUDE_ENCRYPTION_KEY`. At the time this page was written those two vars are referenced as the broker's mount condition and the encryption secret (32-byte base64, e.g. `openssl rand -base64 32`), and `src/agent/child-env.ts` scrubs `SLAUDE_ENCRYPTION_KEY` from the SDK child env so it never leaks to the model. If you enable the broker you **must** set both — one without the other leaves the tool unmounted.

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `SLAUDE_ENABLE_CONNECT_BROKER` | No | `""` (off) | Truthy value mounts the `slaude_connect` broker tools. Empty means no broker — no connection tools exposed. |
| `SLAUDE_ENCRYPTION_KEY` | No | `""` | 32-byte base64 encryption key for broker-held OAuth tokens/secrets at rest. Generate with `openssl rand -base64 32`. Scrubbed from the SDK child env (`src/agent/child-env.ts`) — the model never sees it. Required when the broker is enabled. |

```bash
# Connect broker — OFF by default (no tools mounted)
# SLAUDE_ENABLE_CONNECT_BROKER=
# SLAUDE_ENCRYPTION_KEY=

# Enable (both required):
SLAUDE_ENABLE_CONNECT_BROKER=1
SLAUDE_ENCRYPTION_KEY=$(openssl rand -base64 32)   # 32 random bytes, base64
```

> **Key hygiene.** `SLAUDE_ENCRYPTION_KEY` is the encryption-at-rest key for broker-held secrets. Rotate by re-encrypting stored credentials; do not reuse a development key in production. The child-env scrub guarantees the model cannot exfiltrate it via tool args.

---

## SOUL.md — persona schema <a id="soul"></a>

`SOUL.md` is the operator-authored file at `~/.slaude/SOUL.md` (or `~/.slaude/personas/<name>/SOUL.md` in multi-persona mode). On first boot if the file is missing, slaude seeds the **starter scaffold** from `src/soul/loader.ts` — fill it in before going live.

The runtime enforces two layers:

- **Runtime baseline** (in code, `RUNTIME_BASELINE` in `loader.ts`) — non-negotiable rules about Slack output discipline, formatting, approval, engagement, channel trust, KB-first, skill evolution, and harness overrides. You never author this; a new release can tighten it without touching your persona.
- **Persona** (your `SOUL.md`) — who the agent is: name, role, voice, manager, mandate, values, channels, approvers, redaction. This is what the agent's system prompt renders inside `<persona>…</persona>`.

Structured extraction (`src/soul/extract.ts`) calls the configured provider with `EXTRACTION_PROMPT` (`src/soul/data.ts`), validates the JSON with `SoulDataSchema` (zod), checks that every extracted Slack id appears verbatim in the raw persona (hallucinated ids are rejected), and caches the result at `~/.slaude/cache/soul.<sha>.json` keyed by `sha256(SOUL.md)`. On any extraction failure it falls back to a regex parser that only fills `approvers`.

### Validated schema — what extraction looks for

Every field below is optional in the markdown (the extractor omits what it cannot find), but three are **required** for `bun run validate-soul` to pass: `identity.name`, `manager.userId`, `mandate`.

| Field | Source section in SOUL.md | Type | Required | What to write |
|-------|---------------------------|------|----------|---------------|
| `identity.name` | `## Identity` | string | **Yes** | Agent display name |
| `identity.role` | `## Identity` | string | No | One line — e.g. `engineering teammate in #platform` |
| `identity.voice` | `## Identity` | string | No | e.g. `terse, direct, no filler. fragments OK.` |
| `manager.userId` | `## Reporting` | `U…` / `W…` | **Yes** | Slack user id of the person the agent reports to |
| `manager.handle` | `## Reporting` | string | No | e.g. `@barock` |
| `backupManager.userId` | `## Reporting` (Backup manager) | `U…` / `W…` | No | Fallback manager — same engagement authority as primary |
| `backupManager.handle` | `## Reporting` | string | No | e.g. `@deputy` |
| `allowedChannels` | `## Allowed channels` / `## Public channels` | `C…` / `G…` / `D…` ids | No | Public-interaction zones — anyone in the channel can address slaude (public eyes, avoid unsolicited internal dumps) |
| `trustedChannels` | `## Trusted channels` / `## Team channel` / `## Home channel` | `C…` / `G…` / `D…` ids | No | Internal team channels where slaude operates as a member — engagement identical to allowed, but agent gets `trust="trusted"` and may show MCP servers, skill names, internals |
| `blockedUsers` | `## Blocked` / `## Blacklist` / `## Ignore` | `U…` / `W…` ids | No | Inbound messages from these users are dropped at the adapter gate — no logs leaked to the agent, no token spend |
| `dmAllowedUsers` | `## DM allowlist` / `## Allowed DMs` | `U…` / `W…` ids | No | Users allowed to DM slaude besides manager/backup. Grants DM chat only — not admin authority |
| `approvers` | `## Approvers` | `{userId, scope, catchall}` entries | No | Who may approve `request_approval` — see [Approvers](#approvers) |
| `redactPatterns` | `## Redaction` | regex strings | No | JS regex sources (without `/…/` wrappers, without flags) matched global + case-insensitive; substrings replaced with `[REDACTED]` in outbound `reply`/`edit`/upload comments |
| `approvalTimeoutSeconds` | `## Approval timeout` | integer ≥ 0 | No | Auto-deny `request_approval` blocks after N seconds with no click. `0` or omitted = wait forever |
| `mandate` | `## Mandate` | string | **Yes** | What the agent is meant to accomplish — drives every turn |
| `values` | `## Values` | string[] | No | 1–2 lines of operating principles unique to the persona |
| `channelOverrides` | `## Channel <#Cxxx\|name>` blocks | `{channel, mandate?, approvers}` per block | No | Per-channel replacement of `mandate` and `approvers` — see [Channel overrides](#channel-overrides) |

### Required vs warnings — what `validate-soul` checks

`src/soul/validate.ts` implements `validateSoul(data)`:

- **Missing (blocks `ok`):** `identity.name`, `manager.userId`, `mandate` — any empty/absent → `missing: [...]`, exit 1.
- **Warnings (do not block `ok`, but review):**
  - `approvers` empty → `request_approval` falls back to `SLAUDE_APPROVERS` env or accepts anyone.
  - `allowedChannels` + `trustedChannels` both empty → only manager/backup can chat outside DMs.
  - `backupManager.userId === manager.userId` → backup is redundant.
  - Any `redactPatterns` entry that fails `new RegExp(p, "gi")` → rejected as invalid regex.

### Writing SOUL.md — section cookbook

Every list below is **one id per line**, in any of these forms: `<@U0XXXXXXXXX>`, `<#C0123456789|name>`, raw `U0XXXXXXXXX` / `C0123456789`. Trailing `;` starts an inline comment.

```markdown
# Persona

## Identity
- Name: Slaude
- Role: engineering teammate in #platform
- Voice: terse, direct, no filler. fragments OK.

## Reporting
- Manager: U0MANAGER123
- Manager handle: @you
- Backup manager: U0DEPUTY456
- Backup manager handle: @deputy

## DM allowlist
- <@U0TEAMMATE1>
- <@U0TEAMMATE2>

## Redaction
- AKIA[0-9A-Z]{16}                  ; AWS access keys
- ghp_[0-9A-Za-z]{36}               ; GitHub personal tokens
- xox[baprs]-[0-9A-Za-z-]{10,}      ; Slack tokens

## Approval timeout
- 600

## Allowed channels
- <#C0123456789|engineering>
- <#G0123456789|private-ops>

## Trusted channels
- <#C0711111111|squadron-team>

## Values
- Ownership over ceremony. Ship the smallest thing that proves the idea.
- Prefer explicit defaults over clever inference.

## Mandate
- Own the #platform Slack surface. Triage threads, ship fixes, keep context warm so humans can delegate async.

## Approvers
- <@U0MANAGER123>:    anything                ; catchall, always eligible
- <@U0REVIEWER123>:   code changes, repo writes, refactors, dependency bumps
- <@U0DBA123>:        database migrations, schema changes, prod data, SQL
- <@U0SRE123>:        deploys, infra, kubernetes, rollbacks, ingress, CI/CD
- <@U0SECURITY123>:   secrets, credentials, IAM, env vars, OAuth scopes
- <@U0COMMS123>:      external comms, customer messages, emails, social
```

### Approvers <a id="approvers"></a>

Each approver line is `<id-or-mention>: <scope description>` — one per person.

```
- <@U123>: anything                                    → catchall — always eligible
- <@U456>: database migrations, schema changes, SQL    → keyword-matched against the agent's plan summary
- <@U777>: production deploys, infra, kubernetes
- <@U888>: external comms — emails, customer messages
```

**Catchall keywords** (case-insensitive, tested at start of scope): `anything`, `any`, `all`, `*`, `default`, `catchall`, `everything` — marked `catchall: true`, always included.

**Keyword matching** (`src/soul/loader.ts` → `selectApprovers` / `tokenize`): the runtime tokenizes the plan summary and each approver's scope (lowercased, split on `[^a-z0-9]`, crude-stemmed `s|es|ing|ed`, stopword-filtered, minimum 3 chars), then selects every approver whose scope tokens overlap with summary tokens, plus all catchalls. If nothing matches, it falls back to every listed approver so the request is not undeliverable. Comma, dash, and `and` are equivalent separators in scope text.

Fallback chain:

1. `## Approvers` exists → keyword-matched entries from SOUL.md (or channel override when in that channel).
2. No `## Approvers` → `SLAUDE_APPROVERS` env (comma-separated ids, no scopes — all treated as catchalls).
3. Neither → any clicker accepted (only safe for solo / DM workspaces).

> **Grounding guard.** The extractor verifies every id it returns appears verbatim in the raw `SOUL.md` text (`assertIdsGroundedInPersona` in `extract.ts`). A hallucinated id is thrown rather than widening the allowlist.

### Channel overrides <a id="channel-overrides"></a>

Repeatable `## Channel <#Cxxx|name>` (or raw `Cxxx`/`Gxxx`/`Dxxx`) blocks replace the global `Mandate` and/or `Approvers` when slaude operates in that channel. Replace semantics — absent subsection falls back to global.

The manager and backup manager are always retained as catchall approvers in every channel override (`withManagerApprover` in `extract.ts`) — a channel block can only *add* approvers, never lock the operator out.

```markdown
## Channel <#C0999999999|incidents>

### Mandate
- Own incident triage in #incidents — acknowledge within 2 minutes, keep the timeline, page on-call if needed.

### Approvers
- <@U0INCIDENTLEAD>: anything             ; catchall for this channel
- <@U0DBA123>:       migrations, SQL, schema changes
```

Resolution at runtime: `effectiveSoulForChannel(channelId)` in `extract.ts` starts from the global `soulData()` (runtime overlays preserved), looks up the matching `channelOverrides` entry, and applies: `mandate` replaced when the override sets one (non-empty after trim), `approvers` replaced when the override lists ≥ 1. The channel mandate is injected as `<channel-mandate>` directive that supersedes the global Mandate for that channel.

> **Template stub block.** The seeded `SOUL.md` contains a `## Channel <#C0123456789|example-channel>` stub with a placeholder id — the extractor skips it (placeholder ids like `C0123456789` and `<@manager-id>` are ignored). Delete the stub or fill it with a real channel id.

### Minimal valid SOUL.md

This is the smallest file that passes `bun run validate-soul`:

```markdown
# Persona

## Identity
- Name: Slaude

## Reporting
- Manager: U0MANAGER123

## Mandate
- Own the #engineering Slack surface — triage, ship, keep context warm.
```

```bash
bun run validate-soul
# [validate] ok                        → exit 0
# [validate] missing required fields:  → exit 1
#   - identity.name
#   - manager.userId
#   - mandate
# [validate] warnings:                 → exit 0, but review
#   - approvers is empty — request_approval blocks will fall back to env or accept anyone
#   - allowedChannels + trustedChannels both empty — only manager/backup can chat outside DMs
```

Add the optional sections above as your workspace grows. Update `SOUL.md` without a restart — `soulData()` re-reads overrides on every call, and the extractor cache is keyed by `sha256(SOUL.md)` so an edit triggers a fresh extraction on next boot.

### Runtime overrides without redeploy <a id="runtime-overrides"></a>

Managers can mutate ACLs at runtime without editing `SOUL.md` or restarting. The `soul_overrides` sqlite table (effective view = `(base ∪ adds) − removes` per field) backs two surfaces:

- Slash: `/soul trust <#Cxxx>` / `/soul allow <#Cxxx>` / `/soul block <@Uxxx>` / `/soul dm <@Uxxx>` and their remove counterparts.
- MCP: `slaude_soul_override` with the same `FIELD_ALIASES` (`trust`→`trustedChannels`, `allow`→`allowedChannels`, `dm`→`dmAllowedUsers`, `block`→`blockedUsers`).

Validation (`src/soul/overrides.ts` → `mutateOverride`): id shape (`^[CGD][A-Z0-9]+$` for channels, `^[UW][A-Z0-9]+$` for users), self-lockout guard (refusing to block the manager), authority check performed by the caller.

```bash
# Runtime ACL examples (Slack slash)
/soul trust <#C0711111111|squadron-team>   # add to trustedChannels
/soul block <@U0NOISY999>                  # block a noisy user in an otherwise trusted channel
/soul dm <@U0TEAMMATE1>                    # allow DM from a teammate
```

---

## Dependency manifests — slaude.json & slaude.lock <a id="manifests"></a>

`slaude.json` and `slaude.lock` live at `~/.slaude/slaude.json` and `~/.slaude/slaude.lock`. They are the declarative dependency surfaces for **plugins, skills, and knowledge bases** — MCP is deliberately excluded and stays in `.mcp.json`.

Schema lives in `src/config/manifest-schema.ts`; installer is `src/cli/install.ts` (`bun run install-deps` / `slaude install`).

### slaude.json

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `plugins` | `PluginEntry[]` | No | CC plugins — marketplace git + plugin name + ref. |
| `skills` | `SkillEntry[]` | No | Skills — `source` (Vercel-style), or `git`+`ref`, or local `slug`. Mixed modes are invalid. |
| `knowledge` | `KnowledgeEntry[]` | No | KB wikis — `label` + optional `git`+`ref`. Mixed `git`/`ref` invalid. |
| `slaude_skills` | `SlaudeSkillsTarget` | No | Reserved target for slaude-owned skills manifest (optional). |
| `slaude_knowledge` | `SlaudeKnowledgeTarget` | No | Reserved target for slaude-owned knowledge manifest (optional). |

**Entry shapes:**

```typescript
// Plugin — explicit marketplace git + plugin name + ref
{ marketplace: "github:owner/repo" | "https://…", plugin: "my-plugin", ref: "v1.2.3" }

// Skill — three mutually exclusive modes
{ source: "owner/repo" }                          // vercel-style, ref defaults to "main"
{ source: "owner/repo/skill-path" }               // path inside repo
{ source: "owner/repo@ref" }                      // pinned ref
{ source: "owner/repo/skill-path@ref" }
{ git: "github:owner/repo", ref: "main" }         // git-backed
{ slug: "local-skill" }                           // local (no git)

// Knowledge — label + optional git
{ label: "my-kb", git: "github:owner/repo", ref: "main", path: "wiki" }
{ label: "local-kb" }                             // local
```

Source → git resolution (`resolveSkillSource`): `owner/repo[/path][@ref]` → `{ git: "github:owner/repo", ref: "<ref or main>", path?: "<path>" }`. Slug resolution falls back to last path segment or repo name lowercased.

**Full example:**

```json
{
  "plugins": [
    { "marketplace": "github:example/marketplace", "plugin": "my-plugin", "ref": "v1.2.3" }
  ],
  "skills": [
    { "source": "example/repo/my-skill@v1.0.0" },
    { "git": "github:example/other-repo", "ref": "main" },
    { "slug": "local-helper" }
  ],
  "knowledge": [
    { "label": "team-wiki", "git": "github:example/team-wiki", "ref": "main" }
  ]
}
```

### slaude.lock

Pinned shas produced by `bun run install-deps`. Every entry records the resolved 40-char `sha` so builds are reproducible.

| Field | Type | Description |
|-------|------|-------------|
| `version` | `1` | Lockfile version literal. |
| `generated_at` | ISO datetime | When the lock was written. |
| `marketplaces` | `Record<string, {sha, plugins}>` | Deduped by `marketplace@ref` — plugin versions come from `marketplace.json`, not the git ref. |
| `skills` | `Record<slug, {git, ref, sha, path?}>` | 40-char sha per skill. |
| `knowledge` | `Record<label, {git, ref, sha, path?}>` | 40-char sha per KB. |

**Installer flags:**

| Flag | What it does | Exit codes |
|------|--------------|------------|
| `bun run install-deps` | Install missing entries, respect lock shas for existing | `0` ok, `2` schema error, `3` git/net error, `4` marketplace error |
| `bun run install-deps --update` | Re-resolve branch refs to latest shas | same |
| `bun run install-deps --frozen` | Fail if any manifest entry is not in the lock (no network at image build) | `0` satisfied, error otherwise |
| `bun run install-deps --check` | Exit `0` if lock satisfies manifest, `1` if drift (no writes) | `0`/`1` |

**Install layout inside `SLAUDE_HOME`:**

| Source | Destination |
|--------|-------------|
| Plugins | `$CLAUDE_CONFIG_DIR/plugins/cache/<marketplace>/<plugin>/<version>/` |
| Skills | `$SLAUDE_HOME/skills/<slug>/` |
| KBs | `$SLAUDE_HOME/knowledge/<label>/` |

> **Dockerfile pattern.** Run `slaude install --frozen` inside the Dockerfile before the runtime stage so the image ships self-contained with no network at boot. Stage clones inside a sibling of the eventual destination (not `$SLAUDE_HOME/.tmp`) so `renameSync` stays on the same filesystem across PVC `subPath` volumes.

**No slaude.json → no-op.** If `~/.slaude/slaude.json` is missing the installer logs `no slaude.json — nothing to install` and exits `0`.

---

## External MCP — .mcp.json <a id="external-mcp"></a>

External MCP servers are declared in `~/.slaude/.mcp.json` (global) or `~/.slaude/personas/<name>/mcp.json` (per-persona overlay in multi-persona mode). Missing file → empty result — slaude still boots.

Loader: `src/gateway/core/external-mcp.ts` → `loadExternalMcp(personaName?)` + `parseExternalMcp(parsed, env)`.

### File shape

```json
{
  "mcpServers": {
    "workbench": {
      "type": "http",
      "url": "https://workbench.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GRAFANA_API_KEY}" }
    },
    "local-tool": {
      "command": "node",
      "args": ["./server.js", "--port", "${PORT}"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  },
  "privateServices": ["workbench"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mcpServers` | `Record<string, McpServerConfig>` | No | Map of server name → config. `type` is `stdio` (requires `command`), `http`, or `sse` (requires `url`). `headers`/`env`/`args` are optional. Bare object without `mcpServers` key is also accepted (parsed as `parsed.mcpServers ?? parsed`). |
| `privateServices` | `string[]` | No | Names that are **credential-stripped** when running inside a `/1on1` locked thread. Entries not in `mcpServers` are warned and dropped. |

**Env substitution:** every `${VAR}` placeholder across `env` values, `headers` values, `url`, and `args` entries is expanded via `env[VAR] ?? ""`. Use it to keep secrets out of the file:

```json
{
  "mcpServers": {
    "grafana": {
      "type": "http",
      "url": "${GRAFANA_URL}",
      "headers": { "Authorization": "Bearer ${GRAFANA_API_KEY}" }
    }
  }
}
```

```bash
# .env companions for the .mcp.json above
GRAFANA_URL=https://grafana.example.com/mcp
GRAFANA_API_KEY=eyJrIjoi…
```

**Trust boundary for private services:** inside a `/1on1` locked thread, each `privateServices` entry is mounted as a `clearCredentials` copy — `env` and `headers` emptied, URL `username`/`password`/`search`/`hash` stripped. Host/path preserved so the server still launches and reaches its endpoint — just anonymous. Source map is never mutated.

**Plugin `.mcp.json` landmine:** `claude-agent-sdk` 0.1.x handles `--plugin-dir` (skills/commands/hooks/agents) but does **not** mount the plugin's `.mcp.json` MCP servers. slaude works around this by loading each installed plugin's `.mcp.json` in `src/config/plugins.ts` (`loadInstalledPluginMcps`) and merging them into `Options.mcpServers`. `npx` is also rewritten to `bunx` so plugins authored for Node still work on slaude's bun-only base image.

**Per-session mount:** the gateway's `McpResolver` resolves `mcpServers` fresh per session; the private-services override is applied when the thread is `/1on1`-locked. `GET /readyz` and `POST /mcp` style flows use this same resolver.

---

## Validation — bun run validate-soul <a id="validation"></a>

Validate `~/.slaude/SOUL.md` against the required schema at any time — locally, in CI, or before a deploy.

```bash
bun run validate-soul
# alias: bun src/cli/validate.ts

# Exit codes
#   0 — ok (all required fields present; warnings may still print)
#   1 — missing required fields (identity.name, manager.userId, or mandate)
#   2 — extraction failure (missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or provider unreachable)
```

**What it does (`src/cli/validate.ts` + `src/soul/validate.ts`):**

1. `loadSoulData()` — cache hit (`~/.slaude/cache/soul.<sha>.json`) → return; otherwise call the provider's `/v1/messages` with `EXTRACTION_PROMPT`, validate with `SoulDataSchema`, assert every extracted Slack id appears verbatim in `SOUL.md`, cache, return. On any failure → regex fallback (`approvers` only).
2. `validateSoul(data)` — check the three required fields; emit warnings for empty `approvers`, empty channels, redundant backup manager, invalid `redactPatterns` regexes.
3. Print `missing` to stderr, `warnings` to stderr, and `ok` to stdout; exit with the code above.

```bash
# Success
$ bun run validate-soul
[validate] ok

# Missing required fields — still exits 1
$ bun run validate-soul
[validate] missing required fields:
  - identity.name
  - mandate
[validate] warnings:
  - approvers is empty — request_approval blocks will fall back to env or accept anyone
  - allowedChannels + trustedChannels both empty — only manager/backup can chat outside DMs

# Extraction failure — no auth configured (exit 2)
$ bun run validate-soul
[validate] failed to load SOUL.md: missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN

# Warnings only — still exit 0 (review but deploy is not blocked)
$ bun run validate-soul
[validate] warnings:
  - approvers is empty — request_approval blocks will fall back to env or accept anyone
[validate] ok
```

> **CI recipe.** Fail the build on `exit 1` (missing identity), allow `exit 0` with warnings (triage later), and treat `exit 2` as a provider/config error — distinct from a bad `SOUL.md`.

```yaml
# .github/workflows/validate.yml
- run: bun run validate-soul
# exit 0 → green (warnings are non-blocking)
# exit 1 → red — SOUL.md missing required fields
# exit 2 → red — extraction failure (check ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)
```

> **When to re-validate.** `SOUL.md` is re-read on every inbound message (`soulData()` applies runtime overlays per call and the extractor cache is keyed by `sha256(SOUL.md)`), but running `validate-soul` explicitly surfaces the `missing`/`warnings` breakdown and the exit code — useful after editing `SOUL.md`, after a `/soul` runtime override, or in a preflight check before `docker build`.

---

## Quick reference — copy-paste starters

```bash
# 1. Tokens — .env
SLACK_BOT_TOKEN=xoxb-1234567890-XXXXXXXXXXXX
SLACK_APP_TOKEN=xapp-1-A111-abc123def456
ANTHROPIC_API_KEY=sk-ant-...

# 2. Minimal SOUL.md → validate → boot
cat > ~/.slaude/SOUL.md << 'MD'
# Persona
## Identity
- Name: Slaude
## Reporting
- Manager: U0MANAGER123
## Mandate
- Own the #engineering Slack surface — triage, ship, keep context warm.
MD
bun run validate-soul   # → [validate] ok
bun run dev

# 3. Full SOUL.md once the team grows — add trusted channels, redaction, approvers
#    See the section cookbook above and the minimal valid example.

# 4. External MCP — .mcp.json with env substitution
cat > ~/.slaude/.mcp.json << 'JSON'
{
  "mcpServers": {
    "grafana": { "type": "http", "url": "${GRAFANA_URL}", "headers": { "Authorization": "Bearer ${GRAFANA_API_KEY}" } }
  },
  "privateServices": ["grafana"]
}
JSON

# 5. Dependencies — slaude.json + lock + frozen install (Dockerfile)
cat > ~/.slaude/slaude.json << 'JSON'
{ "skills": [{ "source": "example/repo/my-skill@v1.0.0" }], "knowledge": [{ "label": "team-wiki", "git": "github:example/wiki", "ref": "main" }] }
JSON
bun run install-deps          # resolve shas → slaude.lock
bun run install-deps --frozen # verify at build time (fails if lock is stale)
```

Related pages: [Getting Started](getting-started/index.md) · [Architecture](architecture/index.md) · [Guides](guides/index.md) · [Deployment & Ops](deployment/index.md)
