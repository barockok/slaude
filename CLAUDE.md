# slaude

Slack-native Claude Code runtime. Onboard AI agent as team member.

## North Star

Like NousResearch/hermes-agent, but Slack-only, powered by Claude Code as engine. Agent has:
- **Soul** — persistent persona/identity file. Defines voice, values, mandate.
- **Skills** — grow over time. New capability = new skill file.
- **Memory** — episodic (what happened) + semantic (what learned).
- **Autonomy** — runs unattended. Asks owner via Telegram only when blocked on important question.

Shell host (folk fork or greenfield) = backend. Multiple sessions, one per agent identity.

## Scope

In: Slack integration only. Single chat surface. Multi-agent (each agent = own slack identity).
Out: Discord, Teams, web chat, CLI UX. Don't dilute focus.

## Owner

Zidni Mubarok <zidmubarock@gmail.com>. Telegram bridge available — use for blocking questions.

## Working Rules

- Granular commits. One logical change per commit.
- Log significant findings/decisions/mistakes as a new `docs/findings/<date>-<slug>.md` file and link it from the Findings Log index below (newest first). Keep this file lean — only the index lives here.
- Autonomous by default. Don't ask trivial; ask via Telegram only when:
  - Irreversible action needed
  - Architecture fork-in-the-road
  - Secret/credential required
- Memory: write surprising/non-obvious facts to `memory/` per skill rules.
- Releases: every release ships a hand-written `docs/releases/<tag>.md` with decent markdown notes — group by category (Features / Fixes / Docs / Internal), explain the *why* not just the commit subject, link findings docs when relevant. The release workflow prefers this file over auto-generated git-log dumps.

## Architecture

```
slaude/
  src/
    agent/         # AgentManager — claude-agent-sdk wrapper, multi-session
      token-budget.ts  # context-window tracking + threshold alerts
      session-mcp.ts   # in-process MCP (token_budget introspection)
    gateway/       # platform adapters; slack-only
      slack/       # slack-bolt Socket Mode adapter, engagement, approval
    soul/          # SOUL.md loader + structured extraction + system prompt
    skills/        # skill discovery + evolution MCP + manifest sync
    knowledge/     # KB loader + MCP tools + ingest engine
    memory/        # memory provider interface (sqlite + markdown)
    db/            # bun:sqlite schema (sessions, kb_ingest_jobs)
    config/        # env, $SLAUDE_HOME, mcp.json loader, manifest schema
    cli/           # manifest emitter, dependency installer
    server.ts      # headless entry
  ~/.slaude/       # runtime home
    SOUL.md        # persona (operator-authored)
    mcp.json       # external MCP servers
    slaude.json    # dependency manifest
    slaude.lock    # pinned dependency shas
    skills/        # installed skills
    knowledge/     # installed KB wikis
    cache/         # extracted SoulData + policy embeddings
    workspaces/    # per-session cwd
    db.sqlite
```

Stack: **Bun + TypeScript**. Deps: `@anthropic-ai/claude-agent-sdk`, `@slack/bolt`, `bun:sqlite`.

### Patterns stolen (folk → slaude)

- `AgentManager extends EventEmitter` — `Map<sessionId, LiveSession>`, async-generator prompt iterable, SDK event fanout (`chunk|thinking|toolCall|toolResult|done`).
- `sessions` table schema (folk db.ts) + add `slack_team_id`, `slack_channel_id`, `slack_thread_ts` w/ unique idx.
- Permission/ask pending maps (`#pendingPermissions`, `#pendingAsks`) → render Slack Block Kit buttons.

### Patterns stolen (hermes → slaude)

- `~/.slaude/SOUL.md` durable identity, separate from per-project `CLAUDE.md`.
- `/personality` runtime overlay (session-only).
- Skill format: `~/.slaude/skills/<name>/SKILL.md` (frontmatter + body). Invocation via `/skill-name`.
- `<memory-context>` XML block injected per-turn from MemoryProvider.
- Slack adapter shape: Socket Mode, dedup by event ts, DM synthetic thread_ts, manifest CLI.

## Open Decisions

- [x] **Greenfield slim core, steal patterns from folk.** I (Zidni) am folk author, license n/a.
- [x] **Bun + TS.** Native sqlite, fast startup, native fetch.
- [x] **Memory store:** start sqlite (turns + facts). Embedding provider deferred. Generic provider interface.
- [x] **Skill format:** claude-code skill compat (`SKILL.md` w/ yaml frontmatter, body w/ `${SLAUDE_*}` substitution).
- [x] **Provider:** any Anthropic-compatible API (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` + provider-qualified `SLAUDE_MODEL`). No claude-code OAuth path.
- [x] **Deploy unit:** one container = one persona = one `SOUL.md`. No `/personality` switch. Multi-agent via multi-deploy.
- [ ] Sandboxing: per-session git worktree vs container-per-session. Defer; per-thread cwd under `$SLAUDE_HOME/workspaces/` for MVP.
- [ ] Multi-tenant slack workspaces: not needed (one deploy = one workspace). Defer indefinitely.

## Findings Log

Entries live in `docs/findings/<date>-<slug>.md`. Add a new file per significant finding/decision/mistake; index it below. Newest first.

- [2026-05-29 — /1on1 mode (per-thread engagement lock)](docs/findings/2026-05-29-one-on-one-mode.md)
- [2026-05-29 — Simulation gateway (Slack-free verification)](docs/findings/2026-05-29-simulation-gateway.md)
- [2026-05-29 — Contextual per-user MCP connections](docs/findings/2026-05-29-contextual-mcp-connections.md)
- [2026-05-25 — Cron & Ignore system audit](docs/findings/2026-05-25-cron-ignore-audit.md)
- [2026-05-22 — Plugin loader chain (install → SDK → MCP)](docs/findings/2026-05-22-plugin-loader-chain.md)
- [2026-05-21 — Writable KB + /ingest](docs/findings/2026-05-21-writable-kb-ingest.md)
- [2026-05-21 — Dependency Manifest Design](docs/findings/2026-05-21-dependency-manifest.md)
- [2026-05-21 — Policy Guardrails (Tier 2 / Tier 3 Design)](docs/findings/2026-05-21-policy-guardrails.md)
- [2026-05-13 — fallback ctx, table emphasis, metrics, stop-guard](docs/findings/2026-05-13-metrics-stop-guard.md)
- [2026-05-11 — context budget tracking](docs/findings/2026-05-11-context-budget-tracking.md)
- [2026-05-11 — external MCP via mcp.json](docs/findings/2026-05-11-external-mcp.md)
- [2026-05-11 — Claude subscription OAuth](docs/findings/2026-05-11-claude-subscription-oauth.md)
- [2026-05-11 — structured-soul + channel-mode gate](docs/findings/2026-05-11-structured-soul-channel-mode.md)
- [2026-05-11 — skill evolution](docs/findings/2026-05-11-skill-evolution.md)
- [2026-05-09 / 2026-05-10 — Slack UX, engagement, approval, CI](docs/findings/2026-05-09-slack-ux-engagement.md)
- [2026-05-08 — MVP bootstrap](docs/findings/2026-05-08-mvp-bootstrap.md)
