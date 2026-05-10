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
- Provider-swap landmine: when `ANTHROPIC_BASE_URL` is repointed at a non-Anthropic gateway (DeepSeek, OpenRouter, …), claude-cli's 1P event export still tries to phone home and the child process exits with code 1. Fixed by injecting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` + `DISABLE_TELEMETRY/AUTOUPDATER/BUG_COMMAND/ERROR_REPORTING=1` into the SDK child env.
- Stale `resume` id across providers: marking `claude_started=1` after a turn on provider A means the SDK passes `resume: <session-id>` to provider B which has no record → `No conversation found with session ID` → exit 1. Manager now buffers child stderr, detects that string on query() throw, calls `Sessions.clearStarted(id)`, and re-boots `#startSession` with the same `firstText` (and a `retried` guard so the `finally` block doesn't tear down the freshly-rebooted session). User sees no error.
- Slack event delivery quirk in private channels: `message.groups` event subscription must be enabled in the app config (separate from `groups:history` scope) for in-thread replies w/o `@mention` to reach the bot. If it's not, only `app_mention` events arrive — users have to re-mention every reply. Logged via the `app.use` event firehose so this is visible at startup.
- Health endpoints: Bun-native HTTP server on `SLAUDE_HEALTH_PORT` (default 8080). `/healthz` returns 200 always w/ uptime+live-session count (liveness); `/readyz` runs `SELECT 1` on the sqlite db and returns 503 on failure (readiness). K8s manifest wires both probes. Set port to 0 to disable.
- Slack metadata + attachments: inbound envelope now includes `user_id` + `user_name` (resolved via cached `users.info`). Files attached to the Slack message are downloaded with `Authorization: Bearer <bot-token>` to `<working_dir>/attachments/<inbound_ts>/<filename>` and surfaced as `<attachment name=… mimetype=… size=… path=… />` blocks inside the `<channel>` envelope so the agent can `Read` them directly. Empty-text messages are accepted when files are present (file-only DMs).
- Idle TTL shipped (folk-style): `SLAUDE_IDLE_MINUTES` (default 15). `AgentManager.#armIdle` clears+sets a timer on every user msg and turn-end (`result`); on expiry it flushes turn buffer and closes the prompt iterable. The SDK `for await` unwinds, `#live` entry deleted. Next inbound msg in the same thread → `#startSession` re-boots `query()` w/ `resume: row.id` (already set whenever `claude_started=1`). Slack `routes` map (SlackContext) is kept across idle-close so the per-session MCP server still has a live ref when resumed.

### 2026-05-09 / 2026-05-10
- Slack Agents API status indicator shipped: `assistant.threads.setStatus`-backed `Status` helper drives the animated "thinking…" / "running <verb> <target>…" text next to the bot name in threads. Pattern stolen from hermes (`gateway/platforms/slack.py:send_typing`). Auto-disables on `missing_scope`/`not_in_assistant_thread`. Manifest now declares `assistant_view` + `assistant:write` scope so fresh installs unlock it. Status text is humanized in the adapter (`humanizeToolStatus`) — Bash → "running `<cmd>`", Read → "reading <file>", Grep/Glob/Edit/Write/TodoWrite/WebFetch all mapped, mcp__slaude_slack__* mapped to "replying"/"editing reply"/"uploading <file>"/"reacting :name:"/"requesting approval".
- Presence + reactions degrade gracefully on missing scope/wrong-token-type (auto-disabled after first failure with a single log line) so an under-provisioned install boots without log spam. Presence requires `xoxp` (user token) — disabled by default; opt-in via `SLACK_USER_TOKEN`. `Reactions` printed `needed`/`provided` scopes on failure for fast diagnosis.
- Diagnostic firehose: `app.use` middleware logs every Bolt event (`[slack-evt] type/subtype ch=… ts=…`); `auth.test` runs at startup and prints granted scopes next to the manifest's declared scopes — caught more than one mismatch during testing. SDK child stderr piped to console as `[claude-cli] …`.
- Provider-swap landmine fix (already noted) + transparent `resume` retry: after `Sessions.clearStarted`, manager re-boots the same prompt with `resume=false` so the user doesn't see the failure. A `retried` guard prevents the outer `finally` from tearing down the fresh session.
- Engagement model (channels/groups): per-thread `engaged` set. `@mention slaude` engages → handle this msg + plain follow-ups. `@mention someone else` disengages → drop. Plain msg in disengaged thread → drop. DMs always engaged. Replaces the prior "always require @mention in channels" rule, which lost flow once a conversation was going. The earlier "auto-handle every in-thread reply once a session exists" was wrong (intrusive — grabbed messages clearly aimed at human colleagues).
- Markdown → Slack mrkdwn converter (`format.ts:mdToMrkdwn`) applied in `mcp__slaude_slack__reply` / `edit`. Carves out fenced/inline code via control-char sentinels first, then transforms the rest: `**X**`/`__X__` → `*X*`; single `*X*`/`_X_` → `_X_`; `~~X~~` → `~X~`; `[t](u)` → `<u|t>`; `# heading` → `*heading*`; `- /  *` → `• `. Italic pass runs FIRST (while bold markers are still `**`) to avoid eating bold. Tables (`| … | --- | …`) render as either a padded monospace block (total width ≤ 60) or a bold-keyed definition list (wider — Slack thread panel wraps long rows otherwise). Legacy operator-style trap: model wraps reply in ```fence``` and then bold/italic inside shows literal — soul mandate now bans whole-reply fences.
- Files attachment from agent: `mcp__slaude_slack__upload` wraps `WebClient.files.uploadV2` to post a local file (image/PDF/log) to the active thread. Optional `initial_comment` runs through `mdToMrkdwn`. Auto-allowed via the `mcp__slaude_slack__*` permission-gate prefix; underlying API call needs `files:write` scope.
- Approval gate (manager-style, agent-driven): new `mcp__slaude_slack__request_approval(summary, tools?, files?, risks?, category?)` pairs with running the session in `bypass`/YOLO mode. Posts Block Kit Approve/Deny; resolves via the click's `response_url` so buttons clear instantly (PermissionGate updated to do the same). Returns `{approved, by, note?}`. The agent self-organizes the high-level checkpoint per soul mandate; per-tool gating disabled.
- Approver allowlist sources, in priority order: persona scope-described entries → legacy persona "category: ids" / fenced JSON → env `SLAUDE_APPROVERS` → env `SLACK_ALLOWED_USERS` → anyone. Modern format under `## Approvers` is `<id-or-mention>: <scope description>` per line; runtime tokenizes both scope and the agent's plan summary (lowercase, simple stem, stopword-stripped) and selects approvers whose tokens overlap. Catchall keywords (`anything`/`any`/`all`/`default`/`*`/`catchall`/`everything`) make an entry always eligible. The agent does NOT pass user IDs — security boundary: parsing happens server-side at click time, so a buggy/jailbroken model can't redirect approval to a friendlier user.
- Permission gate fixes: (1) "Always allow" without SDK suggestions used to do nothing; now falls back to a session-scoped `addRules:[{toolName}]` PermissionUpdate so Bash etc. stop prompting after the first approval; (2) `chat.update` lagged behind `ack()` so users double-clicked; switched to `respond({replace_original: true})` which fires against the click's response_url and is much faster.
- Adapter `route.spoke` now flips on `reply` / `edit` / `upload` (any user-visible tool), not just `reply` — turns that upload a file no longer trigger the "(no reply emitted)" fallback.
- Soul split: `RUNTIME_BASELINE` (immutable, in code) defines slack output discipline, formatting, approval discipline, engagement; `<persona>` (operator's `~/.slaude/SOUL.md`) defines identity (name, role, voice, manager, audience, mandate). `STARTER_PERSONA` is now a scaffold operators must fill — no behavioral defaults baked in. Baseline is intentionally identity-neutral ("you operate as a Claude Code agent reachable through Slack") so it doesn't fight a persona that names the agent something else.
- Slack workspace pivot: amartha workspace had restricted scope and admin-gated re-install; moved to a personal `squadrondevel-4wz1192` workspace where full scopes (chat:write, files:write, reactions:write, message.* histories, etc.) install cleanly. `assistant:write` and `users.profile:write` still missing on that install (status falls back to disabled gracefully).
- CI / Docker / release shipped: `bun test --coverage` runs 137 tests across `tests/*.test.ts` covering every pure module + Slack helper (format, commands, soul/loader, skills, db/sessions, memory, attachments, status, reactions, presence, users, approval-gate, permission-gate, health, env, home). `bunfig.toml` enforces `coverageThreshold = 0.97`; current run hits **99.55%** lines / 98.29% funcs. Untested integration glue (server, adapter, manager, mcp-tools, manifest CLI) is excluded by virtue of not being imported from any test — Bun coverage only counts touched modules. `.github/workflows/ci.yml` runs typecheck + coverage on push/PR. `.github/workflows/docker.yml` builds linux/amd64+arm64 and pushes to GHCR (`ghcr.io/<owner>/slaude`) on main + `v*.*.*` tag with semver/sha/latest tag matrix; PRs build but don't push. `.github/workflows/release.yml` fires on `v*.*.*` tag, runs the test suite, generates a changelog from `git log <prev>..<tag>`, and creates a GitHub release (auto-prerelease when tag contains `-`). Cutting a release: `git tag v0.1.0 && git push --tags`.
- Test isolation pattern: `tests/setup.ts` is preloaded via `bunfig.toml` and creates a fresh `$SLAUDE_HOME` per `bun test` run via `mkdtempSync`, so `db/schema` bootstrap, `soul/loader` writes, and the `~/.slaude/.env` dotenv loader all hit a tmp dir instead of the operator's real home. Same setup seeds a `.env` with quoted/single/plain entries so the dotenv branches get covered on first import.
- AbortSignal abort tests need a microtask between `gate.request()` and `controller.abort()` — the async `await postMessage` in the gate hasn't reached the `addEventListener` line yet at the moment we synchronously call abort. Without the `await new Promise(setTimeout, 5)` interleave, the abort fires with no listener registered, and the request hangs forever (caught: 5s timeout in CI).
