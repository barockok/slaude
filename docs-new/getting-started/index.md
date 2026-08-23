# Getting Started

Deploy a Claude Code agent as a teammate in your Slack workspace. One Slack thread equals one persistent Claude session — with a durable persona you define.

## What is Slaude?

Slaude is a Slack-native runtime for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It bridges Slack Socket Mode to the `@anthropic-ai/claude-agent-sdk` so your team can `@mention` an agent that remembers context, writes skills, and asks for approval before mutating anything.

**Core model:**

| Concept | What it means |
|---|---|
| **1 thread = 1 session** | Each Slack thread maps to a persistent Claude session. The SDK `resume` flag keeps conversation history across idle restarts (default TTL: 15 min). |
| **Two-layer persona** | A hardcoded runtime baseline (Slack output rules, approval discipline, engagement model) + your operator-defined `SOUL.md` (name, role, voice, manager, mandate, approvers). You only author the second layer. |
| **Slack output via MCP** | The agent never streams raw text to Slack. All output goes through an in-process MCP server (`mcp__slaude_slack__reply` / `edit` / `upload` / `request_approval`). Tables, code blocks, and links are auto-converted to Slack mrkdwn. |
| **Headless, single-container** | One container = one persona = one `SOUL.md`. Run it on any host that can reach Slack via Socket Mode. Scale to more agents by deploying more containers. |

> **Note:** Slaude is inspired by [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) but is Slack-only and powered by the official Claude Agent SDK.

## Prerequisites

| Requirement | Version / Details | Check |
|---|---|---|
| **Bun** | `>= 1.3` (runtime + package manager) | `bun --version` — install: `curl -fsSL https://bun.sh/install | bash` |
| **Docker** | `>= 24` with Compose v2 | `docker compose version` |
| **Slack workspace** | Admin rights to create apps, or permission to install from manifest | — |
| **Anthropic-compatible provider** | One of the auth options below | — |
| **Git** | Any recent version | `git --version` |

### Auth options (pick one)

| Option | When to use | Env vars |
|---|---|---|
| **API key** | Metered usage, any Anthropic-compatible gateway | `ANTHROPIC_API_KEY=sk-ant-...` |
| **Claude Pro / Max subscription** | Run on your Claude subscription instead of API credits | `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...` (from `claude setup-token`) |
| **Third-party gateway** | OpenRouter, Z.ai, self-hosted | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` + `SLAUDE_MODEL` (required) |

> **Tip:** When using `CLAUDE_CODE_OAUTH_TOKEN`, leave `SLAUDE_MODEL` unset to inherit the subscription's default model. Set `SLAUDE_MODEL` only to pin a specific model or when pointing `ANTHROPIC_BASE_URL` at a non-Anthropic gateway.

## Quickstart (5 minutes)

### 1. Clone and install

```bash
git clone https://github.com/barockok/slaude.git
cd slaude
bun install
```

### 2. Generate the Slack app manifest

```bash
bun run manifest > manifest.json
cat manifest.json
```

This prints the JSON that declares required scopes (`chat:write`, `app_mentions:read`, `assistant:write`, etc.), Socket Mode, and event subscriptions.

### 3. Create the Slack app

1. Go to **https://api.slack.com/apps** → **Create New App** → **From manifest** → paste the contents of `manifest.json` → select your workspace → **Create**.
2. **Basic Information** → **App-Level Tokens** → **Generate Token** → scope `connections:write` → copy the token (`xapp-...`). This is `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → **Install to Workspace** → **Allow** → copy the Bot Token (`xoxb-...`). This is `SLACK_BOT_TOKEN`.
4. **Agents & AI Apps** *(optional but recommended)* → enable **Assistant view** to unlock the animated `assistant.threads.setStatus` indicator ("thinking...", "running `cmd`").
5. **Socket Mode** → confirm it is **Enabled**.

> **Warning:** Reinstall the app to your workspace whenever you regenerate the manifest with changed scopes — otherwise the bot token will lack the new permissions.

### 4. Configure environment

Slaude loads env from `~/.slaude/.env` (host) or `./.env` (repo root / Docker). For local dev, copy the example:

```bash
cp .env.example .env
# or for a persistent home:
mkdir -p ~/.slaude && cp .env.example ~/.slaude/.env
```

Edit `.env` and set at minimum:

```bash
# Slack — from step 3
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# LLM — pick one auth mode
ANTHROPIC_API_KEY=sk-ant-...
# OR
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Optional: only needed for non-Anthropic gateways
# ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
# SLAUDE_MODEL=claude-sonnet-4-6

# Sensible defaults — change as needed
SLAUDE_DEFAULT_MODE=bypass
SLAUDE_AUTO_ALLOW_TOOLS=Read,Grep,Glob,LS
SLAUDE_IDLE_MINUTES=15
SLAUDE_HEALTH_PORT=8080
```

Key environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | **Yes** | — | Bot token `xoxb-...` from OAuth install |
| `SLACK_APP_TOKEN` | **Yes** | — | App-level token `xapp-...` with `connections:write` |
| `ANTHROPIC_API_KEY` | One of this / `CLAUDE_CODE_OAUTH_TOKEN` | — | Metered API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | One of this / `ANTHROPIC_API_KEY` | — | Subscription OAuth token (`sk-ant-oat01-...`) |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Gateway URL for OpenRouter / Z.ai / self-hosted |
| `SLAUDE_MODEL` | Only with `ANTHROPIC_BASE_URL` | SDK default | Provider-qualified model id (e.g. `claude-sonnet-4-6`) |
| `SLAUDE_DEFAULT_MODE` | No | `bypass` (Docker) / `ask` (env.example) | Default permission mode for new threads |
| `SLAUDE_AUTO_ALLOW_TOOLS` | No | `Read,Grep,Glob,LS` | Tools auto-approved without Block Kit prompt |
| `SLAUDE_IDLE_MINUTES` | No | `15` | Minutes before SDK Query closes; next message resumes |
| `SLAUDE_HEALTH_PORT` | No | `8080` | Health/metrics port; `0` disables |

> **Note:** `SLAUDE_DEFAULT_MODE` values: `ask` (prompt per tool), `accept-edits` (auto-allow reads/writes), `bypass` (YOLO — rely on approval gate + persona mandate), `plan` (read-only), `dont-ask` (deny unapproved).

### 5. Seed the persona (SOUL.md)

On first boot Slaude auto-seeds `~/.slaude/SOUL.md` with a starter scaffold. To customize before first boot:

```bash
mkdir -p ~/.slaude   # or ./data for Docker
cat > ~/.slaude/SOUL.md <<'MD'
## Identity
- Name: slaude
- Role: senior platform engineer
- Voice: concise, direct

## Reporting
- Manager: U0XXXXXXXXX
- Manager handle: @you

## Mandate
- Help the team ship; refuse destructive ops without explicit approval.
MD
```

Validate at any time:

```bash
bun run validate-soul
# exit 0 = ok, 1 = missing required fields, 2 = extraction failure
```

Required fields: `identity.name`, `manager.userId`, `mandate`. See [SOUL Guide](../guides/soul.md) for the full schema.

### 6. Run

**Local dev** (with watch):

```bash
bun run dev
# or without watch:
bun run start
```

**Docker** (recommended for persistent deploys):

```bash
# Place persona + env where compose expects them
mkdir -p ./data
cp .env ./data/.env        # or ensure SLACK_* / ANTHROPIC_* are exported
cp ~/.slaude/SOUL.md ./data/SOUL.md  # if you customized it

docker compose up -d --build
docker compose logs -f
```

Docker mounts `./data` → `/data` (`SLAUDE_HOME`) as a persistent volume holding `SOUL.md`, `mcp.json`, `slaude.json`, `db.sqlite`, skills, and knowledge bases.

> **Note:** `docker compose` reads env from `./.env` on the host and forwards it into the container. `~/.slaude/.env` and `./data/.env` are also loaded inside the container via `SLAUDE_HOME`. Any one location works — `./.env` is simplest for Docker.

## Verify Installation

### 1. Health endpoints

Slaude exposes three endpoints on `SLAUDE_HEALTH_PORT` (default `8080`):

```bash
curl -s http://localhost:8080/healthz | jq .
# {"status":"ok"}

curl -s http://localhost:8080/readyz | jq .
# {"status":"ok"}

curl -s http://localhost:8080/metrics | head -n 20
# # HELP slaude_sessions_live Current live sessions
# # TYPE slaude_sessions_live gauge
# slaude_sessions_live 1
```

| Endpoint | Success | Failure indicates |
|---|---|---|
| `GET /healthz` | `200 {"status":"ok"}` | Process not running |
| `GET /readyz` | `200 {"status":"ok"}` | sqlite unreachable |
| `GET /metrics` | `200` Prometheus text | Metrics registry error |

> **Tip:** For Docker, map or expose the health port if you changed it. The default `docker-compose.yaml` relies on the container's `8080`.

### 2. Slack DM test

1. Invite the bot to any channel or just open a **DM** with it.
2. Send:

   ```
   hello — are you there?
   ```

   The bot should reply in-thread. DMs are always engaged (no `@mention` needed).

3. In a public channel, `@mention` it:

   ```
   @slaude what is 2+2?
   ```

   The thread should engage and reply. Mentioning someone else in the same thread disengages the bot.

4. Check logs if nothing happens:

   ```bash
   # local
   # logs print to stdout — look for "[slaude] slack socket mode started" and no "missing env" errors

   # docker
   docker compose logs --tail 100 slaude
   ```

Common first-run issues:

| Symptom | Fix |
|---|---|
| `missing env SLACK_BOT_TOKEN` | `.env` not loaded — confirm it is at `~/.slaude/.env` or `./.env` (local) or `./data/.env` (Docker) |
| `invalid_auth` from Slack | Reinstall the app after manifest changes; confirm `xoxb-` and `xapp-` are not swapped |
| `Socket Mode` connection fails | Verify `SLACK_APP_TOKEN` has `connections:write` and Socket Mode is enabled |
| `ANTHROPIC_API_KEY` / OAuth errors | Confirm exactly one auth mode is set; gateways need `SLAUDE_MODEL` |
| No DM reply but `/healthz` ok | Check `SOUL.md` `## Reporting` → `Manager` is your Slack user ID (`U...`), not your handle |

## Next Steps

| Topic | What you will learn |
|---|---|
| [Installation & Configuration](../installation/index.md) | Full env reference, `ANTHROPIC_BASE_URL` gateways, model selection, Docker vs Kubernetes |
| [Architecture](../architecture/index.md) | Session lifecycle, gateway ↔ agent ↔ MCP flow, sqlite + PVC layout |
| [SOUL & Persona](../guides/soul.md) | Persona schema, approvers, channel trust tiers, redaction |
| [Engagement & Approvals](../guides/engagement.md) | Mention model, `@mention` to engage/disengage, Block Kit approval gate |
| [Skills & Knowledge](../guides/skills.md) | `slaude.json` / `slaude.lock`, installing skills and KB wikis, `sync_manifest` |
| [Deployment & Operations](../deployment/index.md) | Kubernetes single-replica deploy, health probes, Prometheus metrics, log tailing |
| [Examples](../examples/index.md) | Runnable end-to-end: first skill, first KB ingest, custom MCP server |

> **Next:** If you just finished quickstart, go to [Installation & Configuration](../installation/index.md) for the complete environment reference, then [SOUL & Persona](../guides/soul.md) to make the agent yours.
