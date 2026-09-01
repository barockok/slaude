---
title: What is slaude?
description: A Slack-native Claude Code runtime. One Slack thread is one persistent session, with a persona you write, an approval gate, and skills that grow.
---

slaude runs Claude Code as a teammate inside a Slack workspace. One Slack thread
maps to one persistent session. The SDK `resume:` id keeps that conversation
across idle restarts, so a thread you left yesterday continues today.

It is Slack-only by design, and headless: run it on a server, and point Slack at
it over Socket Mode. One container runs one persona. Add an agent by adding a
deployment.

```bash
git clone https://github.com/barockok/slaude.git
cd slaude
bun install
bun run manifest > manifest.json   # paste into api.slack.com/apps → From manifest
cp .env.example ~/.slaude/.env     # fill SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
bun run dev                        # or: docker compose up -d --build
```

## Where to go next

:::cards 3
- [Getting started](start/getting-started.md) — Quickstart, prerequisites, and a first DM test.
- [Architecture](start/architecture.md) — Session lifecycle, the trust boundary, persistence.
- [Configuration](reference/configuration.md) — Every environment variable, the SOUL.md schema, the manifest.
- [Engagement and approvals](guides/engagement.md) — Mentions, the approval gate, `/1on1`, slash commands.
- [API reference](reference/api.md) — The `mcp__slaude_*` tools, the CLI, and the metric surface.
- [Deployment](deploy/index.md) — Docker, Kubernetes, multi-node scale-out, health probes.
:::

## Why slaude

| Feature | What it means |
|---|---|
| **One thread, one session** | Each Slack thread maps to a persistent Claude session. `resume:` keeps the history across idle restarts, controlled by `SLAUDE_IDLE_MINUTES` (15 by default). |
| **Two-layer persona** | A hardcoded runtime baseline covers Slack output, approval discipline, and engagement. Your `~/.slaude/SOUL.md` covers name, role, voice, manager, mandate, and approvers. You author only the second layer. |
| **Slack output through MCP** | The agent never streams raw text to Slack. Every reply goes through `mcp__slaude_slack__reply`, `edit`, `upload`, or `request_approval`. Markdown converts to Slack mrkdwn, and a table becomes a monospace block or a definition list. |
| **Manager-style approvals** | The agent calls `request_approval(summary)` before it mutates anything. The approver allowlist comes from `SOUL.md`, and keyword matching decides who may approve what. The agent never chooses a user id. |
| **Engagement model** | An `@mention` engages a thread. An `@mention` of somebody else disengages it. Plain replies in an engaged thread are handled, and DMs are always engaged. `/1on1` locks a thread to you and the manager. |
| **Skills that evolve** | `~/.slaude/skills/<slug>/SKILL.md` reloads every turn. The agent writes its own skills with `mcp__slaude_skills__write_skill`, and `sync_manifest` pushes them to git, so they survive a redeploy. |
| **Knowledge bases** | Plain markdown wikis, in the style of Karpathy's LLM wiki. The agent navigates with `Read`, `Grep`, and `Glob`. There are no embeddings and no chunking. A writable KB turns `raw/` into `wiki/` through `/ingest`. |
| **Simulation gateway** | Check engagement, channel mode, and the approval buttons with no Slack workspace. It runs the same `createGateway` against an in-memory transport, and `bun sim run` gates CI. |

## Architecture at a glance

[![slaude architecture](assets/img/architecture.png)](start/architecture.md)

Five layers: the Slack surface, the gateway trust boundary, the agent on
`claude-agent-sdk`, the modules, and persistence with observability, all on top
of the runtime home. The gateway makes every security decision. The model
supplies only text.

[Open the full architecture](start/architecture.md). The diagram source is
[`docs/internal/architecture.html`](https://github.com/barockok/slaude/blob/main/docs/internal/architecture.html),
and its header explains how to regenerate the PNG with headless Chrome.

## Trust boundary

The model extracts `SOUL.md` into typed JSON. Every Slack id it returns is
checked against the raw `SOUL.md` text before any gate uses it. Channel mode,
blocked users, engagement, approver authorization, and per-tool permission all
run deterministically in the gateway, never in the model.

A jailbroken persona can mislead an approver. It cannot redirect an approval or
approve its own work. The full enforcement chain is in
[Architecture](start/architecture.md#trust-boundary).
