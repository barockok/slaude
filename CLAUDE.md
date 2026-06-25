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

- **Public repo — no internal/proprietary references.** This repo is public. Never commit real people's names, company/employer/org names, internal Slack channel names, or internal service / KB / data-source identifiers in code, tests, comments, docs, commit messages, or PR text. Use generic placeholders instead (e.g. `bulk-corpus`, `org/team-directory`, `#team-channel`, `Jane Doe`). Findings docs describe the *mechanism*, never the internal incident specifics or the operator's deployment.
- **Pre-commit hygiene — run BEFORE every `git add`/commit.** A leak in a public repo's history is near-impossible to fully undo (forks/clones/cached SHAs survive a rewrite). Catch it before it lands:
  1. **Scrub scratch artifacts** — never stage runtime/tooling junk: `.handoff`, `.mcp.json` (runtime config; commit `.mcp.json.example` instead), `.playwright-cli/`, `.playwright-mcp/`, stray screenshots/PNGs in repo root, `*.log`. These are gitignored — if one shows in `git status`, it's a new escapee; gitignore it.
  2. **Leak scan the staged diff** for internal references. Quick grep over what you're about to commit:
     ```sh
     git diff --cached -U0 | grep -nIiE 'amartha|\.amartha\.|\.slack\.com|squadrondevel|\b[CUTGW]0[A-Z0-9]{8,}\b|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|vault|deepseek|real-employee-names'
     ```
     Any hit that isn't an intentional placeholder or kept branding (the sim-TUI logo asset) → replace with a generic placeholder before committing.
  3. **Secrets are values, not names** — but treat leaked *secret names* (Vault keys, env var names tied to a real deployment) as sensitive too; they map to the operator's infra.
  4. If a leak already landed, see the history-rewrite playbook: `git filter-repo --invert-paths --path <file>` + `--replace-text <rules>` then force-push; always `git bundle create` a backup first.
- Granular commits. One logical change per commit.
- **No AI co-authorship.** Never add a `Co-Authored-By:` or "Generated with …" trailer naming Claude/Anthropic to commits or PRs, and never commit under an AI author identity. The `.githooks/commit-msg` hook enforces this (enable once per clone: `git config core.hooksPath .githooks`).
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
    knowledge/     # KB loader + brain (gbrain engine: scoped search/think, gated writes) + ingest
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

- [2026-06-20 — Channel-specific soul mandate & approvers: per-channel `## Channel <#Cxxx>` blocks → `ChannelOverride` schema + `effectiveSoulForChannel` resolver (replace semantics); channel mandate injected as `<channel-mandate>` directive; approval-gate + admin-auth resolved per-channel; manager/backup always retained as catchall approvers (no lockout)](docs/findings/2026-06-20-channel-soul-overrides.md)
- [2026-06-20 — Brain as a remote OAuth-protected MCP process (configurable): `BrainBackend` seam routes `brainCall`/`brainAdminCall` to a `LocalBackend` (in-process, default) or `RemoteBackend` (OAuth'd MCP client → `slaude brain-server`); scope+gating stay in slaude (dumb-engine server, two tools `brain_op`/`brain_admin_op`); Keycloak JWT resource-guard (jose JWKS + RFC 9728 PRM); reuses the shared OAuth loopback via `slaude brain connect`; one-writer two-process deploy](docs/findings/2026-06-20-brain-remote-mcp.md)
- [2026-06-19 — Shared always-on OAuth loopback (signed-state demux, verify-before-routing) + surface-aware `/mcp connect` (route via Surface, redact auth URL on settle) + URL-safe `mdToMrkdwn` + mrkdwn flanking fix (#51)](docs/findings/2026-06-19-shared-oauth-loopback-surface-connect.md)

- [2026-06-16 — Re-engage via in-session suppression (hook-only): a `UserPromptSubmit` hook returning `continue:false` (NOT `decision:"block"`, which discards the prompt pre-persist) keeps a disengaged thread's transcript populated without running the model; supersedes the Slack-backfill approach](docs/findings/2026-06-16-reengage-hook-suppress.md)
- [2026-06-15 — Status line secret/path leak: the "is thinking…" indicator inlined raw tool args (Bash command, absolute paths) → secrets + outside-workspace structure broadcast to Slack. Fixed in `status-text.ts` (program-name-only Bash, basename paths, host-only WebFetch, redactSecrets net); shipped v0.25.1](docs/releases/v0.25.1.md)
- [2026-06-15 — Per-source `gather()`: bulk-corpus volume drowns curated pages in the pooled candidate set (cold-retrieval fails where warm-context masks it). Slaude-side per-source fan-out wrapper; gbrain stays stock; upstream promotion deferred](docs/findings/2026-06-15-per-source-gather.md)
- [2026-06-14 — Brain memoize: write-never-lands (kb_put_page FK in /1on1) + write-lands-recall-misses (kb_think ranking) + one-write-path/open_kb/standing-grant cleanup. RESOLVED — all shipped, security-reviewed (#34/#38/#39/#36/#40)](docs/findings/2026-06-14-brain-memoize-failure.md)
- [2026-06-14 — /model per-thread model switch (provider /v1/models validation, pass-through fallback)](docs/findings/2026-06-14-model-switch-command.md)
- [2026-06-13 — KB-first enforcement: from prose to teeth (Stop-hook guard design, shadow-first)](docs/findings/2026-06-13-kb-first-enforcement.md)
- [2026-06-11 — Soul runtime overrides: manager-editable ACLs without redeploy (/soul + soul_override)](docs/findings/2026-06-11-soul-runtime-overrides.md)
- [2026-06-11 — Engagement review: disengage lasted zero messages (sessions.engaged persistence)](docs/findings/2026-06-11-engagement-disengage-durability.md)
- [2026-06-11 — /1on1 transcript sharding: resume breaks on lock flips (projects/ symlink fix)](docs/findings/2026-06-11-1on1-transcript-sharding.md)
- [2026-06-10 — gbrain × slaude: adopt gbrain as brain layer (KB, RBAC, approval, dream cycle, multi-agent)](docs/findings/2026-06-10-gbrain-slaude-kb.md)
- [2026-06-10 — /mcp global connect (manager wires the agent's shared identity; scope = lock state)](docs/findings/2026-06-10-mcp-global-connect.md)
- [2026-06-09 — /mcp OAuth connect in /1on1 (write CLI mcpOAuth store, CLI owns lifecycle)](docs/findings/2026-06-09-mcp-oauth-connect-1on1.md)
- [2026-06-09 — Post as the agent's real Slack user (opt-in xoxp)](docs/findings/2026-06-09-post-as-slack-user.md)
- [2026-06-08 — cron-on-channel + a latent scheduler-boot TDZ crash](docs/findings/2026-06-08-cron-on-channel.md)
- [2026-06-08 — /1on1 OAuth isolation via per-initiator CLAUDE_CONFIG_DIR](docs/findings/2026-06-08-oauth-config-dir-1on1.md)
- [2026-06-08 — Retro: orchestration, gating & continuous evolution (external AI-engineer review)](docs/findings/2026-06-08-orchestration-evolution-retro.md)
- [2026-06-08 — Private services in /1on1 (run as the initiator)](docs/findings/2026-06-08-private-services-1on1.md)
- [2026-06-05 — Sim REPL on OpenTUI (React) — supersedes the raw-mode TUI below](docs/findings/2026-06-05-sim-tui-opentui.md)
- [2026-06-05 — Pinned bordered input box (sim REPL) — superseded by OpenTUI](docs/findings/2026-06-05-pinned-input-box.md)
- [2026-06-04 — Sim REPL: claude-code-grade UX (live status, gate box, group activity)](docs/findings/2026-06-04-repl-claude-code-ux.md)
- [2026-06-03 — Surface abstraction (agent interaction decoupled from Slack)](docs/findings/2026-06-03-surface-abstraction.md)
- [2026-06-03 — Interactive sim against the live agent (--real)](docs/findings/2026-06-03-sim-interactive-real-agent.md)
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
