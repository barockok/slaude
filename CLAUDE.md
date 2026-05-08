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
- Update this file w/ significant findings, decisions, mistakes (so future Claude sessions inherit).
- Autonomous by default. Don't ask trivial; ask via Telegram only when:
  - Irreversible action needed
  - Architecture fork-in-the-road
  - Secret/credential required
- Memory: write surprising/non-obvious facts to `memory/` per skill rules.

## Architecture

```
slaude/
  src/
    agent/         # AgentManager — claude-agent-sdk wrapper, multi-session
    gateway/       # platform adapters; slack-only for now
      slack/       # slack-bolt Socket Mode adapter
    soul/          # SOUL.md loader + system prompt injection
    skills/        # skill discovery + invocation (compat w/ claude-code skills)
    memory/        # memory provider interface; default = sqlite + markdown
    db/            # better-sqlite3 schema (sessions, slack_thread mapping)
    config/        # env, $SLAUDE_HOME (~/.slaude/)
    server.ts      # headless entry
  ~/.slaude/       # runtime home (mirrors hermes ~/.hermes/)
    SOUL.md
    skills/
    config.yaml
    .env
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
- [x] **Memory store:** start sqlite (turns + facts). Embedding provider deferred. Hermes provider interface.
- [x] **Skill format:** claude-code skill compat (`SKILL.md` w/ yaml frontmatter, body w/ `${SLAUDE_*}` substitution).
- [x] **Provider:** any Anthropic-compatible API (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` + provider-qualified `SLAUDE_MODEL`). No claude-code OAuth path.
- [x] **Deploy unit:** one container = one persona = one `SOUL.md`. No `/personality` switch. Multi-agent via multi-deploy.
- [ ] Sandboxing: per-session git worktree vs container-per-session. Defer; per-thread cwd under `$SLAUDE_HOME/workspaces/` for MVP.
- [ ] Multi-tenant slack workspaces: not needed (one deploy = one workspace). Defer indefinitely.

## Findings Log

### 2026-05-08
- Repo init. Research dispatched on hermes-agent + folk.
- Folk research: AgentManager already transport-agnostic. Could fork+strip Electron, but greenfield smaller surface.
- Hermes research: clean SOUL/SKILL/memory pattern. Slack via slack-bolt Socket Mode. `~/.hermes/` home dir.
- Decision: greenfield Bun+TS. Mirror hermes layout, steal folk AgentManager.
- Shipped MVP: config, db, soul, AgentManager, slack adapter (Socket Mode), skill loader, sqlite memory provider, manifest CLI, README. Typecheck green. Not yet exercised end-to-end against a real Slack workspace.
- Mistake: first stab at slack adapter used `import bolt from "@slack/bolt"; const { App } = bolt;` — fails ESM types. Direct named import works: `import { App, LogLevel } from "@slack/bolt"`.
- Mistake: pre-tool-use hook flagged db schema file falsely (no exec call); re-saved verbatim, accepted.
- Note: claude-agent-sdk v0.1.77 installed; v0.2.x available. Defer upgrade until MVP is proven; check breaking changes in `Options.systemPrompt` and `query()` signature first.
- Owner direction (Telegram): (1) provider-agnostic via Anthropic-compatible API, no Claude Code OAuth path; (2) deploy model = one container = one persona = one `SOUL.md`. Locked both decisions; added Dockerfile + docker-compose + k8s manifest stub. Replicas pinned to 1 because Slack Socket Mode is single-leader.
- Owner direction (Telegram): want Hermes-parity Slack UX. Shipped: (1) ReactionTracker — 👀/⚙️/✅/❌ status reactions per inbound message; (2) Presence — `users.profile.set` while busy, ref-counted across sessions; (3) Streamer — one Slack reply per turn that grows via `chat.update` with a ▍ cursor and rolls over past 36k soft cap.
- Mistake (caught before deploy): manager only emitted `done` when the SDK iterable ended, but the persistent prompt iterable never ends → `done` never fired → streamer never flushed. Fixed by emitting `done`/`error` from SDK `result` messages (per-turn) instead. Filed under "subtle bug to remember on every transport that buffers per-turn".
- Tool approval shipped: `AgentManager.setPermissionResolver()` installs an SDK `canUseTool` callback. Slack adapter's `PermissionGate` posts a Block Kit Allow / Always / Deny prompt to the active thread. `SLAUDE_AUTO_ALLOW_TOOLS` env pre-approves safe ops. "Always allow" returns the SDK's `suggestions` as `updatedPermissions` so the user isn't asked again that session.
- Permission modes shipped: per-session `permission_mode` column + slash commands `/mode <ask|accept-edits|bypass|plan|dont-ask>`, `/abort`, `/help`. Mode is persisted and also flipped on a live `Query` via `setPermissionMode()` for in-flight turns. `SLAUDE_DEFAULT_MODE` env sets the default for new sessions.
- Channel-style Slack output: dropped auto-streaming of assistant text. Slack output now flows exclusively through an SDK MCP server (`slaude_slack`) bound per-session, exposing `reply`/`edit`/`react`/`unreact`. Pattern stolen from claude-code Channels. Trade: cleaner UX, no thinking/tool-call noise; risk: agent may forget to call `reply` (mitigated via SOUL.md mandate + adapter posts a "no reply emitted" notice on `done` if nothing surfaced). Inbound user messages are wrapped in `<channel source="slack" channel_id=… thread_ts=… inbound_ts=… user=…>` envelope with explicit reply-via-tool directive.
- Per-session `SlackContext` is mutated across turns (channel/threadTs/inboundTs) so the closure-bound MCP tools keep targeting the right thread for the session lifetime. `AgentManager` exposes `setMcpResolver` mirroring `setPermissionResolver`. `mcp__slaude_slack__*` tools are auto-allowed in the permission gate — they're the only path to user output, so gating them would deadlock.
- Removed `src/gateway/slack/streamer.ts`. Live-edit streaming retired; agents call `mcp__slaude_slack__edit` to revise a prior reply.
- Slack metadata + attachments: inbound envelope now includes `user_id` + `user_name` (resolved via cached `users.info`). Files attached to the Slack message are downloaded with `Authorization: Bearer <bot-token>` to `<working_dir>/attachments/<inbound_ts>/<filename>` and surfaced as `<attachment name=… mimetype=… size=… path=… />` blocks inside the `<channel>` envelope so the agent can `Read` them directly. Empty-text messages are accepted when files are present (file-only DMs).
- Idle TTL shipped (folk-style): `SLAUDE_IDLE_MINUTES` (default 15). `AgentManager.#armIdle` clears+sets a timer on every user msg and turn-end (`result`); on expiry it flushes turn buffer and closes the prompt iterable. The SDK `for await` unwinds, `#live` entry deleted. Next inbound msg in the same thread → `#startSession` re-boots `query()` w/ `resume: row.id` (already set whenever `claude_started=1`). Slack `routes` map (SlackContext) is kept across idle-close so the per-session MCP server still has a live ref when resumed.
