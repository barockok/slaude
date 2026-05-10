# slaude

Slack-native Claude Code runtime. Onboard an AI agent as a teammate in your Slack workspace.

> Inspired by [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), but Slack-only and powered by the official `@anthropic-ai/claude-agent-sdk`.

## What it is

- One **Slack thread** = one persistent **claude-code session**. SDK `resume:` keeps the conversation across idle restarts.
- A two-layer persona: hardcoded runtime baseline (Slack output, formatting, approval discipline, engagement) + operator-defined `~/.slaude/SOUL.md` (name, role, voice, manager, audience, mandate).
- Slack output flows exclusively through an in-process MCP server (`mcp__slaude_slack__*`) — no auto-streaming, no tool-call noise.
- Manager-style approvals: agent runs in YOLO and self-organizes a high-level approval checkpoint before mutating ops; SOUL.md defines who's authorized to approve which kind of work.
- Headless. Run on a server, point Slack at it via Socket Mode.

## Features

- **Channel-style output** — agent replies via `mcp__slaude_slack__reply` / `edit` / `upload` / `react` / `unreact` / `request_approval`. Plain assistant text never reaches Slack.
- **Markdown → Slack mrkdwn** — `**bold**` / `*italic*` / lists / fenced code / links / headings auto-converted at post time. Tables render as monospace blocks (narrow) or definition lists (wide).
- **Slack Agents API status** — animated "thinking…" / "running `<cmd>`" / "reading `<file>`" next to the bot name (when `assistant:write` scope granted).
- **Engagement model** — `@mention` engages a thread, `@mention` someone else disengages, plain replies in an engaged thread are handled. DMs always engaged.
- **File attachments both ways** — Slack files attached by users are downloaded to the session working dir and surfaced as `<attachment>` blocks; agent uploads files via `mcp__slaude_slack__upload`.
- **Approval gate** — `mcp__slaude_slack__request_approval(summary, …)` posts Block Kit Approve/Deny. Approver allowlist parsed from SOUL.md scope-described entries; runtime keyword-matches the agent's plan summary against each approver's scope; the agent never picks user IDs.
- **Slash commands in thread** — `/mode <ask|accept-edits|bypass|plan|dont-ask>`, `/abort`, `/help`. Per-session `permission_mode` persists.
- **Idle TTL with resume** — `SLAUDE_IDLE_MINUTES` (default 15). On expiry the SDK Query closes silently; next inbound message re-boots with `resume: row.id`.
- **Provider-agnostic** — any Anthropic-compatible API (Anthropic direct, OpenRouter, DeepSeek, Z.ai, self-hosted gateway, …). Telemetry / autoupdater / bug-reporter disabled in the SDK child so non-Anthropic gateways don't crash the CLI.
- **Health endpoints** — `/healthz` (liveness) + `/readyz` (sqlite ping) on `SLAUDE_HEALTH_PORT` (default 8080). K8s probes wired in `deploy/k8s/slaude.yaml`.
- **One container = one persona** — multi-agent via multi-deploy.

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
2. **Basic Information** → **App-Level Tokens** → create a token with scope `connections:write` (this is your `SLACK_APP_TOKEN`, starts with `xapp-`).
3. **OAuth & Permissions** → **Install to workspace** → grab the bot token (`xoxb-…`). Reinstall any time the manifest's scopes change.
4. **Agents & AI Apps** → enable assistant view (unlocks `assistant.threads.setStatus` for the animated status indicator).
5. **Socket Mode** → enable.

### 3. Configure env

Copy `.env.example` to `~/.slaude/.env` (or to `./.env` if you're using docker compose / running with `bun src/server.ts` from the repo root — Bun auto-loads `./.env`).

Any **Anthropic-compatible** provider works — point `ANTHROPIC_BASE_URL` at your gateway and set `SLAUDE_MODEL` to its model id.

```sh
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1   # optional
SLAUDE_MODEL=claude-sonnet-4-6

# Optional: lock who can talk to the bot / approve plans.
SLACK_ALLOWED_USERS=U01ABCD,U02EFGH
SLAUDE_APPROVERS=U01ABCD                              # falls back to SLACK_ALLOWED_USERS

# Defaults — see .env.example for the full list.
SLAUDE_DEFAULT_MODE=bypass                            # YOLO; rely on approval-gate + soul mandate
SLAUDE_AUTO_ALLOW_TOOLS=Read,Grep,Glob,LS
SLAUDE_IDLE_MINUTES=15
SLAUDE_HEALTH_PORT=8080
```

### 4. Edit the persona

`~/.slaude/SOUL.md` is auto-seeded with a starter scaffold on first run. Fill in:

- **Identity** — Name, Role, Voice
- **Reporting** — Manager Slack user id + handle
- **Audience** — who can address the agent (also enforced via `SLACK_ALLOWED_USERS`)
- **Values / Mandate** — operating principles + what this deploy is for
- **Approvers** — one `<id-or-mention>: <free-text scope>` per line. The runtime keyword-matches plan summaries against each scope. Catchall keywords (`anything` / `*` / `default`) make an entry always eligible.

```md
## Approvers

- <@U0XXXXXXXXX>: anything                ; manager, catchall
- <@U999>:        database migrations, schema, prod data, SQL
- <@U777>:        deploys, infra, kubernetes, rollbacks
- <@U888>:        external comms, customer messages, emails
```

The hardcoded runtime baseline (Slack output discipline, formatting rules, approval discipline, engagement model) is composed in front of your persona automatically — don't re-state those in SOUL.md.

### 5. Run

Local dev:

```sh
bun run dev      # autoreload
# or
bun run start
```

Container (one container = one persona = one `SOUL.md`):

```sh
docker compose up -d --build
```

Kubernetes — see `deploy/k8s/slaude.yaml`. Replicas pinned to 1 because Slack Socket Mode is single-leader. Onboard additional agents via additional Deployments.

Invite the bot to a channel, `@slaude do something`, or DM it directly.

## Layout

```
src/
  agent/manager.ts          # claude-agent-sdk runtime, multi-session, idle TTL
  gateway/slack/
    adapter.ts              # bolt Socket Mode wiring + engagement state
    mcp-tools.ts            # slaude_slack MCP server (reply/edit/upload/react/request_approval)
    permission-gate.ts      # SDK canUseTool → Block Kit prompt
    approval-gate.ts        # agent-driven request_approval gate
    status.ts               # assistant.threads.setStatus indicator
    reactions.ts            # 👀/⚙️/✅/❌ status reactions
    presence.ts             # users.profile.set (xoxp only)
    format.ts               # markdown → Slack mrkdwn (incl. tables)
    attachments.ts          # download Slack files into session dir
    users.ts                # users.info name resolution (TTL cache)
    commands.ts             # /mode /abort /help
  soul/loader.ts            # runtime baseline + SOUL.md persona, approver parsing
  db/                       # sqlite (sessions keyed by slack thread)
  config/                   # $SLAUDE_HOME paths + env
  cli/manifest.ts           # slack manifest emitter
  health.ts                 # /healthz + /readyz
  server.ts                 # headless entry
~/.slaude/                  # runtime home
  SOUL.md                   # persona (operator-defined)
  db.sqlite
  workspaces/<thread>/      # per-session cwd
    attachments/<ts>/       # downloaded Slack files
```

See `CLAUDE.md` for the full architecture overview and decision/findings log.

## Roadmap / TODO

- **Wiki-style memory (collaborative + portable)** — replace the sqlite-only memory store with a portable, mountable directory of markdown files (think Karpathy's LLM Wiki, or a git wiki). Goals:
  - Mountable as a volume → swap, back up, ship between deploys.
  - Git-collaborative → multiple slaude runtimes (different personas / different machines) commit, pull, merge. Memory compounds across the fleet over time.
  - Per-runtime contributions → each runtime can write back what it learned; another runtime picks it up on next pull.
  - Two scopes side-by-side: **shared wiki** (cross-persona knowledge) + **persona-private** (this agent's own episodic + semantic memory, never shared).
- **Skill evolution** — let the agent author / refine its own `~/.slaude/skills/<name>/SKILL.md` files when it discovers a repeatable capability. Hot-reload skills without a restart.
- **Session control tools** — MCP tool to restart / reset / fork the current Slack-thread session (clear `claude_started`, drop working dir, re-boot with a fresh resume id).
- **Manager session** — a dedicated "manager" thread/persona where the operator can ask the agent to install a new MCP server, add/remove tools, swap models, edit SOUL.md, or reconfigure approvers — instead of editing files on the host. Changes propagate to live sessions.
- **Live monitor web view** — read-only browser UI to peek inside any active session. Shows the live SDK event stream (thinking, tool calls + args, tool results, MCP traffic, permission prompts, current cwd) for a chosen Slack-thread session. Pure observability, no interaction — like attaching a read-only Claude Code window to a running agent.

## License

UNLICENSED — private project. Author: Zidni Mubarok.
