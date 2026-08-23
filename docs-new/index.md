# slaude

> **Slack-native Claude Code runtime. One Slack thread = one persistent session.**

[![CI](https://github.com/barockok/slaude/actions/workflows/ci.yml/badge.svg)](https://github.com/barockok/slaude/actions/workflows/ci.yml) [![Docker](https://github.com/barockok/slaude/actions/workflows/docker.yml/badge.svg)](https://github.com/barockok/slaude/actions/workflows/docker.yml) [![Release](https://github.com/barockok/slaude/actions/workflows/release.yml/badge.svg)](https://github.com/barockok/slaude/actions/workflows/release.yml) [![codecov](https://codecov.io/gh/barockok/slaude/branch/main/graph/badge.svg)](https://codecov.io/gh/barockok/slaude) [![Latest release](https://img.shields.io/github/v/release/barockok/slaude?sort=semver)](https://github.com/barockok/slaude/releases/latest) [![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh) ![version](https://img.shields.io/badge/version-v0.41.0-blue)

**Onboard an AI agent as a teammate in your Slack workspace.** Inspired by [hermes-agent](https://github.com/NousResearch/hermes-agent), rebuilt Slack-only on the official `@anthropic-ai/claude-agent-sdk`. One container, one persona, every thread remembers.

```bash
bunx slaude --help        # or: git clone && bun install && bun run dev
# Press / then type to search docs  •  v0.41.0  •  MIT
```

---

## Start here

| | Section | What you will find | Time |
|---|---|---|---|
| 1 | [**Getting Started**](getting-started/index.md) | 5-minute quickstart, prerequisites, first DM test | 5 min |
| 2 | [**Installation & Config**](installation/index.md) | Full env reference, `ANTHROPIC_BASE_URL` gateways, model selection, `SOUL.md` schema | 10 min |
| 3 | [**Architecture**](architecture/index.md) | Session lifecycle, gateway ↔ agent ↔ MCP flow, sqlite + PVC layout | 8 min |
| 4 | [**Guides**](guides/index.md) | Persona, engagement model, approvals, skills, brain & KB, slash commands | — |
| 5 | [**API & Skills Reference**](api/index.md) | MCP tools (`slaude_slack`, `slaude_skills`, `slaude_kb`), CLI, manifest schema, metrics | — |
| 6 | [**Deployment & Ops**](deployment/index.md) | Docker & Kubernetes, health probes, Prometheus, simulation gateway | — |

> **New to slaude?** Start with [Getting Started](getting-started/index.md). Already running? Jump to [Architecture](architecture/index.md) or [Guides](guides/index.md).

---

## Why slaude

| Feature | What it means |
|---|---|
| **One thread = one session** | Each Slack thread maps to a persistent Claude session. SDK `resume:` keeps history across idle restarts (`SLAUDE_IDLE_MINUTES`, default 15). |
| **Two-layer persona** | Hardcoded runtime baseline (Slack output, approval discipline, engagement) + your `~/.slaude/SOUL.md` (name, role, voice, manager, mandate, approvers). You only author the second layer. |
| **Slack output via MCP** | Agent never streams raw text to Slack. Every reply goes through `mcp__slaude_slack__reply` / `edit` / `upload` / `request_approval`. Markdown auto-converts to Slack mrkdwn; tables become monospace blocks or definition lists. |
| **Manager-style approvals** | Agent runs YOLO and calls `request_approval(summary)` when it needs to mutate. Approver allowlist is parsed from `SOUL.md`; keyword-matching picks who can approve what. The agent never chooses user IDs. |
| **Engagement model** | `@mention` engages a thread, mentioning someone else disengages, plain replies in an engaged thread are handled. DMs are always engaged. `/1on1` locks a thread to you + manager. |
| **Skills that evolve** | `~/.slaude/skills/<slug>/SKILL.md` hot-reloads every turn. Agent authors its own skills via `mcp__slaude_skills__write_skill`; `sync_manifest` pushes them to git so they survive redeploys. |
| **Knowledge bases** | Karpathy-style markdown wikis. Agent navigates with `Read`/`Grep`/`Glob` — no embeddings, no chunking. Writable KB (`raw/` → `wiki/` via `/ingest`) compounds across the fleet. |
| **Simulation gateway** | Verify engagement, channel-mode, and approval buttons with no Slack workspace. Runs the same `createGateway` against an in-memory transport. `bun sim run` gates CI. |

---

## Architecture at a glance

[![slaude architecture thumbnail](../docs/architecture.png)](architecture/index.md)

One diagram, five layers: **Slack surface → gateway/slack trust boundary → agent (claude-agent-sdk) → modules → persistence + observability → runtime home (PVC)**. The gateway enforces every security decision; the model only supplies text.

**[Open full architecture →](architecture/index.md)** · Source: [`docs/architecture.html`](../docs/architecture.html) (regenerate PNG via headless Chrome — see file header)

---

## Trust boundary

> The LLM extracts `SOUL.md` into typed JSON; every Slack ID it returns is checked against the raw `SOUL.md` text before any gate uses it. Channel-mode, blocked-user, engagement, approver authorization, and per-tool permission all run deterministically in the gateway — never in the model. A jailbroken persona can mislead an approver but cannot redirect or self-approve.

See [Architecture — Trust boundary](architecture/index.md#trust-boundary) for the full enforcement chain.

---

## Install

```bash
git clone https://github.com/barockok/slaude.git
cd slaude
bun install
bun run manifest > manifest.json   # paste into api.slack.com/apps → From manifest
cp .env.example ~/.slaude/.env     # fill SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
bun run dev                        # or: docker compose up -d --build
```

Full steps: [Getting Started](getting-started/index.md) · [Installation & Config](installation/index.md)

---

## Explore

| Path | Description |
|---|---|
| [Guides — SOUL & Persona](guides/soul.md) | Identity, reporting, channel trust tiers, approvers, redaction |
| [Guides — Engagement & Approvals](guides/engagement.md) | Mention model, disengage, Block Kit Approve/Deny, `/1on1` |
| [Guides — Skills & Knowledge](guides/skills.md) | `slaude.json` / `slaude.lock`, installing skills and KB wikis |
| [API Reference](api/index.md) | Every `mcp__slaude_*` tool, CLI commands, manifest schemas |
| [Deployment](deployment/index.md) | K8s single-replica, `/healthz` `/readyz` `/metrics`, logs |
| [Examples](examples/index.md) | Runnable end-to-end: first skill, first ingest, custom MCP server |

---

<footer>

**slaude v0.41.0** · [GitHub](https://github.com/barockok/slaude) · [Releases](../docs/releases/v0.41.0.md) · [All releases](../docs/releases/) · [Findings](../docs/findings/) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md) · MIT © Zidni Mubarok

</footer>
