# slaude

Slack-native Claude Code runtime. Onboard an AI agent as a teammate in your Slack workspace.

> Inspired by [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), but Slack-only and powered by the official `@anthropic-ai/claude-agent-sdk`.

## What it is

- One **Slack thread** = one persistent **claude-code session**. Replies in the thread continue the conversation; resumed via SDK `resume:`.
- Durable identity in `~/.slaude/SOUL.md` (the agent's voice, values, mandate).
- Skills, memory, and tooling grow over time in `~/.slaude/`.
- Headless. Run on a server, point Slack at it via Socket Mode.

## Status

Early MVP. See `CLAUDE.md` Findings Log for what's wired and what's not.

Wired: Slack Socket Mode listener · DM + `@mention` routing · per-thread session resume · SOUL.md system-prompt injection · sqlite persistence.

Not wired yet: skills, memory provider, permission UX over Block Kit, MCP server config UI.

## Setup

### 1. Install

```sh
git clone <this repo> slaude
cd slaude
bun install
```

### 2. Create the Slack app

Generate an app manifest:

```sh
bun run manifest > manifest.json
```

In Slack:
1. <https://api.slack.com/apps> → **Create New App** → **From manifest** → paste `manifest.json`.
2. Under **Basic Information** → **App-Level Tokens** → create a token with scope `connections:write` (used as `SLACK_APP_TOKEN`, starts with `xapp-`).
3. **OAuth & Permissions** → install to workspace → grab the bot token (`xoxb-...`).
4. **Socket Mode** → enable.
5. **Event Subscriptions** → enable. (Manifest already declares the event subscriptions.)

### 3. Configure env

Copy `.env.example` to `~/.slaude/.env` (or to `./.env` if you're using docker compose).

Any **Anthropic-compatible** provider works — point `ANTHROPIC_BASE_URL` at the gateway of your choice (Anthropic direct, OpenRouter, Z.ai, self-hosted), set `SLAUDE_MODEL` to the provider-qualified model id.

```sh
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1   # optional
SLAUDE_MODEL=claude-sonnet-4-6
SLACK_ALLOWED_USERS=U01ABCD,U02EFGH                 # optional allow-list
```

### 4. Run

Local dev:

```sh
bun run dev      # autoreload
# or
bun run start
```

Or container (one container = one persona = one `SOUL.md`):

```sh
docker compose up -d --build
```

Or Kubernetes — see `deploy/k8s/slaude.yaml`. Replicas pinned to 1 because Slack Socket Mode is single-leader. Spin up additional Deployments to onboard additional agents.

Invite the bot to a channel, `@slaude do something`, or DM it directly.

## Layout

See `CLAUDE.md` for the full architecture overview and decision log.

```
src/
  agent/manager.ts       # claude-agent-sdk runtime, multi-session
  gateway/slack/         # bolt Socket Mode adapter
  soul/loader.ts         # SOUL.md → system prompt
  db/                    # sqlite (sessions keyed by slack thread)
  config/                # $SLAUDE_HOME paths + env
  cli/manifest.ts        # slack manifest emitter
  server.ts              # headless entry
~/.slaude/               # runtime home
  SOUL.md                # durable identity
  skills/<name>/SKILL.md # (planned) per-agent skills
  db.sqlite
  workspaces/<thread>/   # per-session cwd
```

## License

UNLICENSED — private project. Author: Zidni Mubarok.
