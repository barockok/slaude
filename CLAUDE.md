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

### May 11, 2026 (skill evolution)
- Skill-evolution shipped. New SDK MCP server `slaude_skills` mounted alongside `slaude_slack` per session via the existing `McpResolver`. Tools: `list_skills`, `read_skill`, `write_skill`, `delete_skill`. Slug regex `^[a-z0-9][a-z0-9-]{0,63}$` plus a `path.relative(skillsRoot, dir) === slug` check sandboxes writes to `$SLAUDE_HOME/skills/<slug>/` and rejects traversal (`..`, `/`, `.`, empty). Frontmatter values JSON-quoted so `:` / `"` / newlines in `name`/`description` can't break the yaml block. Hot-reload is free — `discoverSkills()` already runs on every inbound Slack message in `adapter.ts`, so a `write_skill` in turn N is invocable as `/<slug>` in turn N+1 without restart.
- Permission gate auto-allows `mcp__slaude_skills__list_skills` and `mcp__slaude_skills__read_skill` (read-only — silent self-introspection is the whole point). `write_skill` and `delete_skill` are NOT auto-allowed; the baseline soul now mandates `mcp__slaude_slack__request_approval` with `category: 'skills'` before either. Defense in depth: even if the persona drops the directive, the permission gate prompts the user (Block Kit Approve / Deny) on the raw tool call.
- "Auto-detect when to evolve" is implemented as a baseline-soul directive, not a runtime hook: at the end of every non-trivial turn (≥1 tool call, or a procedure plausibly worth repeating) the agent is required to (1) list_skills if unsure, (2) capture new procedures as new slugs, (3) refine existing skills with read_skill→write_skill, (4) write nothing if neither applies. Explicit guidance: one-off facts go in memory, not skills.
- Handlers refactored into a named `skillHandlers` export so tests can invoke them directly without spinning up an McpServer. `skillOps` is the pure-IO layer used by both the handlers and tests. Coverage on `src/skills/mcp-tools.ts`: 100% func / 99.31% line. Full suite: 160 pass.

### May 11, 2026 (structured-soul + channel-mode gate)
- Structured-soul shipped (v0.2.1). At boot, `src/soul/extract.ts` runs one ephemeral `POST /v1/messages` (no MCP, no tools) with `RUNTIME_BASELINE + <persona>` as system + an extraction prompt (`src/soul/data.ts:EXTRACTION_PROMPT`), parses the response as JSON, validates via zod (`SoulDataSchema`), and writes the result to `$SLAUDE_HOME/cache/soul.<sha16>.json`. `sha16` = first 16 hex of `sha256(SOUL.md)` — operator edits SOUL → cache miss → re-extract next boot. Cache hits skip the LLM entirely. Fallback chain on extract failure: regex parser (`loadApproverEntries` / `selectApprovers`) so boot never blocks on provider availability.
- Defense in depth on extraction: `assertIdsGroundedInPersona()` rejects the parsed SoulData if ANY Slack id (`manager.userId`, `allowedChannels[]`, `approvers[].userId`) does not appear verbatim in SOUL.md. Stops the model from hallucinating an approver / whitelisted channel the operator never authorised. On reject → regex fallback, no cache write.
- Approval gate now consumes `soulData().approvers` as tier 1; existing regex scope-tier / legacy `category: ids` / env fallback preserved. Logic stays in `selectApproversFrom(entries, summary, hint?)` — pure function shared between regex and structured paths. Identical behaviour when the LLM agrees with the regex parser; the win is robustness when persona prose drifts off the rigid bullet format.
- BREAKING: `allowedUsers` / `SLACK_ALLOWED_USERS` removed entirely. Channel-mode engagement gate replaces it (`adapter.ts`):
  - Channel in `soulData().allowedChannels` → public zone, any user accepted.
  - Anything else (private channel manager added bot to ad-hoc, AND all DMs) → only `soulData().manager.userId` accepted. Approvers retain authority to click Approve / Deny on `request_approval` blocks but cannot chat.
  - `env.slack.approvers()` no longer falls back to `SLACK_ALLOWED_USERS`. Only `SLAUDE_APPROVERS` is honoured as env fallback when SOUL.md has no `## Approvers` section.
- soulData() memoization bug (caught in CI for v0.2.0, fixed in v0.2.1): the sync accessor memoized the regex fallback into module-level `let memo`, so the FIRST call locked the value for the process. Editing SOUL.md between calls (or between tests) returned stale state. Fix: only memoize what `setSoulData()` explicitly seeds (called once at boot in `server.ts`); re-derive cache-file/regex paths on every soulData() call. Tests now pass both as full suite and per-file.
- zod regex landmine: `^[UW][A-Z0-9]{6,}$` rejected short synthetic test ids (U001, U002). Real Slack ids are 9–11 chars, but the strict floor was test-hostile and brittle if Slack ever ships shorter ids. Relaxed to `^[UW][A-Z0-9]+$` (and `^[CGD][A-Z0-9]+$` for channels). The grounding check (id-must-appear-in-persona) is the real safety net, not the length.
- v0.2.0 tag was pushed with the failing tests; CI / release workflows failed but `docker` workflow built+published images anyway (it doesn't run tests). Took the forward-only route — v0.2.1 fixes the bugs, v0.2.0 has no GH release. Amended v0.2.1 notes to cover the full v0.1.1..v0.2.1 diff + migration guide so the gap is documented.
- Live diagnostic: empty approver list in Slack was a data bug, not code — SOUL.md still held the amartha `U06ENBS6PV0` id after the workspace pivot to squadrondevel. Slack rendered the unknown id as blank → looked like an empty allowlist. Fix was `sed s/U06ENBS6PV0/U0AJTUG547L/g ~/.slaude/SOUL.md` + cache clear + restart. Lesson: workspace pivot needs a SOUL.md audit.

### May 11, 2026 (Claude subscription OAuth)
- `CLAUDE_CODE_OAUTH_TOKEN` accepted as alt provider auth. Generated via `claude setup-token` on a machine already logged into Claude Code; lets operators run slaude on a Pro/Max subscription instead of metered API credits. Three touchpoints:
  1. `src/agent/manager.ts` — added `CLAUDE_CODE_OAUTH_TOKEN` to the env-passthrough whitelist for the SDK child. The SDK CLI natively reads this env var and switches to OAuth Bearer against `api.anthropic.com`. No code change inside the SDK is needed.
  2. `src/soul/extract.ts` — direct `fetch /v1/messages`. When only `CLAUDE_CODE_OAUTH_TOKEN` is set (no `ANTHROPIC_API_KEY`), the request carries `Authorization: Bearer <tok>` + `anthropic-beta: oauth-2025-04-20` instead of `x-api-key`. The beta header is mandatory — bearer-token requests without it 401 on Anthropic. API key wins when both env vars are set (explicit > subscription).
  3. `src/config/env.ts` — added `env.provider.oauthToken()` accessor for symmetry / future callers. Not consumed yet outside of the env propagation path.
- Test coverage added: `tests/soul-extract.test.ts` asserts header shape on the OAuth branch + API-key precedence when both present. `tests/config.test.ts` extends the populated-getters case. 175 pass total.
- BREAKING (same release): `SLAUDE_MODEL` semantics changed from "default = claude-sonnet-4-6" to "override; empty = let the SDK pick". `env.model()` returns `""` when unset; `manager.ts` only sets `options.model` when truthy. Rationale: with `CLAUDE_CODE_OAUTH_TOKEN`, Claude Code's CLI already knows the subscription's default model — hardcoding `claude-sonnet-4-6` in slaude either pinned the wrong tier or silently overrode the user's Pro/Max default. With non-Anthropic gateways the operator was already forced to set `SLAUDE_MODEL` (their endpoint doesn't speak Anthropic's default id), so this change is no-op for them. Soul extractor still has its own fallback chain (`SLAUDE_SOUL_PARSE_MODEL || SLAUDE_MODEL || claude-haiku-4-5-20251001`) because it calls `/v1/messages` directly and `model` is a required field.

### May 11, 2026 (external MCP via mcp.json)
- Client-supplied MCP servers shipped. New `$SLAUDE_HOME/mcp.json` (override path via `SLAUDE_MCP_CONFIG` env) declares external stdio/sse/http MCP servers in the same shape Claude Code's mcp.json uses. Loader is `src/config/mcp.ts:loadExternalMcp()` — read once at boot in `src/gateway/slack/adapter.ts` and spread into the resolver alongside the in-process `slaude_slack` + `slaude_skills` servers. Restart slaude after editing the file; there is no hot-reload (deliberate — server lifetimes are tied to SDK Query lifetimes).
- Shape: `{ "mcpServers": { "<name>": { command, args?, env? } | { type: "http" | "sse", url, headers? } } }`. Stdio is implicit when `command` is present (matches Claude Code's mcp.json — no `type: "stdio"` required). HTTP/SSE require explicit `type`.
- `${VAR}` substitution applied to `command`, every entry of `args[]`, every value of `env`, `url`, every value of `headers`. Missing vars expand to empty string (POSIX shell semantics) so a malformed env doesn't crash the boot — typo-detection is the operator's job, not the loader's.
- Reserved-name defence: `slaude_slack` and `slaude_skills` are dropped at load time with a warning so user config cannot shadow the in-process Slack output server (would deadlock the agent — only path to user-visible output).
- Permission posture: `mcp__<external>__*` tools are NOT auto-allowed by `PermissionGate` (only `mcp__slaude_slack__*` plus read-only `mcp__slaude_skills__{list,read}_skill`). External tool calls fall through to the standard Block Kit approve/deny prompt. "Always allow" still grants session-scoped auto-approval on first click.
- Env propagation: stdio child processes inherit `process.env` (Bun default). Loader does not whitelist — operators who care about secret isolation should set explicit `env: {…}` on the server config.
- Test file: `tests/config-mcp.test.ts` covers missing file → `{}`, malformed JSON, missing `mcpServers` root, stdio (implicit type + env+arg expansion), http (header expansion), sse, missing `${VAR}` → empty, stdio without command, http without url, non-object entry, non-array args, reserved-name drop (both names), `SLAUDE_MCP_CONFIG` override. 14 tests; full suite 189 pass. New module at 100% func / 100% line.

### May 11, 2026 (context budget tracking)
- Per-session context-window usage tracking shipped. New pure module `src/agent/token-budget.ts` records `usage` + `modelUsage` from each SDK `result` message and exposes a snapshot {input/output/cache tokens, totalInput, contextWindow, pctUsed, remaining}. `contextWindow` is sourced from `modelUsage[*].contextWindow` (SDK ships the model's advertised cap — no hardcoded table needed; max across entries when multiple models are seen in one result, e.g. subagent w/ a different model). Fallback 200k when modelUsage is empty.
- Threshold helper `evaluateThreshold(sessionId, warnPct, criticalPct)` is edge-triggered: each level fires exactly once per session per state, resets only on `forget()`. Env: `SLAUDE_TOKEN_WARN_PCT` (default 0.8), `SLAUDE_TOKEN_CRITICAL_PCT` (default 0.92, set to 0 to disable critical tier). Out-of-range values fall back to defaults.
- AgentManager owns the `TokenBudget`. On every `result` message: record → emit `tokenUsage` event w/ snapshot → evaluate threshold → emit `tokenWarning` event (level `warn` | `critical`) if crossed. `getTokenSnapshot(sessionId)` accessor exposed for MCP tools / external probes. `forget(sessionId)` runs in the session-teardown `finally` so a re-booted session re-fires thresholds.
- SDK `PreCompact` hook wired through `options.hooks.PreCompact: [{ hooks: [preCompact] }]`. Callback emits `compacting` event with `trigger: 'manual' | 'auto'`. Slack adapter sets the Assistant thread status to "compacting context…" so the user knows there's a pause.
- New in-process MCP server `slaude_session` (`src/agent/session-mcp.ts`). Single tool `token_budget` returns the snapshot as JSON (input/output/cache/total/window/remaining/pct + a `percent_used_human` string). Mounted via the existing `McpResolver` alongside `slaude_slack` / `slaude_skills` / external mcp.json servers. Permission gate auto-allows `mcp__slaude_session__*` (pure read).
- Slack adapter listens for `tokenWarning` → posts a one-shot in-thread notice (warning / critical headline + pct + used/cap + suggestion to `/abort` or summarize-and-reset). Listens for `compacting` → flips status text.
- Soul baseline gained a `## Context budget` section: instructs the persona to call `token_budget` when context feels long, NOT every turn; explains the 80%/92% threshold post + that SDK auto-compacts internally before the cap.
- Landmine: SDK `ModelUsage.contextWindow` is the SOURCE OF TRUTH for the model's cap. Don't hardcode 200k / 1M tables — they go stale when Anthropic ships new tiers. Subagents w/ different models surface in the same `modelUsage` map → take the max so the warning fires at the right percentage of the live session's window, not a smaller subagent's.
- TDD: 16 tests for `TokenBudget`, 4 for `sessionHandlers`, 2 new for env getters. Total suite 211 pass / 392 assertions / 96.66% func / 99.63% line — still above the 0.97 line / 0.80 func threshold.

### May 13, 2026
- `SLAUDE_FALLBACK_CONTEXT_WINDOW` env override added for the `TokenBudget` fallback used when SDK `result.modelUsage` is empty. Default still 200000; set e.g. `1000000` for 1M-ctx models. `TokenBudget` constructor accepts `{ fallbackContextWindow }`; manager wires `env.tokenFallbackContextWindow()`.
- Slack code-block table cells now strip markdown emphasis (`**bold**`, `__bold__`, `*italic*`, `_italic_`, `~~strike~~`) before width calc + render. Reason: code blocks render verbatim — markers would show literal. Definition-list branch untouched (mrkdwn renders normally there).
- Prometheus `/metrics` endpoint shipped on the existing health-server port. Hand-rendered text format in `src/metrics.ts` — no `prom-client` dep. Singleton `metrics` Registry plus pre-declared metric handles (`m.sessionsLive`, `m.turnsTotal{result}`, `m.toolCallsTotal{tool}`, `m.tokensTotal{kind}`, `m.contextWindowPct`, `m.stopGuardBlockedTotal`, `m.stopGuardFailedTotal`, `m.errorsTotal{kind}`, `m.slackDropsTotal{reason}`, `m.userTurnsTotal{user_id,user_name}`). Static labels (`SLAUDE_METRICS_LABELS="agent=hermes,env=prod,team=ai"`) applied to every series at render time. Per-user counter is opt-in via `SLAUDE_METRICS_PER_USER=1` because user-id cardinality blows up in public channels. `metrics.ts` imports `config/env` for dotenv side-effect so `~/.slaude/.env` lands before label parsing at module init.
- "No reply emitted" fallback retired in favor of true enforcement via SDK `Stop` hook. New `setStopGuard(fn)` on `AgentManager` mirrors `setPermissionResolver` / `setMcpResolver`. Adapter installs a guard that returns null when `route.spoke === true` and an instruction string ("call `mcp__slaude_slack__reply` now") when false. Manager's Stop hook returns `{decision: "block", reason}` to make the SDK feed the instruction back to the agent, which continues the turn. Single-shot per turn: `#stopBlocked: Set<sessionId>` cleared on user message + session teardown. If agent stops a second time without spoke, manager logs `[stop-guard] … blocked once but agent still stopping` to stderr and lets the stop through — no Slack notice (drift surfaces in logs, not chat). Auto-evolve safe because `route.spoke` carries over from the prior user-visible turn that satisfied the contract.

### May 21, 2026 (Policy Guardrails — Tier 2 / Tier 3 Design)
- **Policy guardrails design spec drafted** (`docs/guardrails-design.md`). Goal: policy-driven safety layer that enforces based on content semantic similarity + role context, designed to position tier 3 (compliance-managed policies, independent service). See design doc for full architecture.
- **Two-service model within one container**: Policy-service runs on port 8081; agent calls via HTTP on SDK hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`). Shared types (Rule, Decision, PolicyCheckInput) + separate HTTP boundary. Both services supervised by a single `src/server.ts` entry point.
- **Architecture decisions locked in**:
  - **Vector backend**: Chroma (tier 3 ready; swappable policy-store interface allows tier 2 sqlite-vec if needed for testing).
  - **Role source**: remote HTTP (POLICY.md frontmatter `role_source.type: remote_http`); fallback to `## Roles` in SOUL.md for offline operation.
  - **Embedding provider**: EmbeddingGemma 300M (local, Apache 2.0, multilingual, ~50ms/text); pluggable via `EmbeddingProvider` interface. OpenAI + BGE-M3 optional.
  - **Unknown role behavior**: most-restrictive default + onboarding fork (in-channel msg + manager `request_approval`). Prevents silent denials.
  - **Hook enforcement**: `policyCheck(actor, channel, content, hook_point) → Decision{action, rule_id, score, message}`. SDK hooks apply Decision. Gateway does not duplicate policy checks (only role resolution + engagement).
- **Build order** splits into 4 phases: (1) shared modules (EmbeddingProvider, RoleResolver, types), (2) policy-service (loader, Chroma, HTTP server, hot-reload), (3) agent integration (PolicyClient, hooks, supervision), (4) eval + tuning.
- **Blocking decisions remaining** (§14 in design doc):
  - (#4) **Eval corpus source** for threshold tuning: synthetic (fast, unrealistic), prod replay (realistic, slow), or human-curated (covers edge cases, labor-intensive)?
  - (#5) **Gemma runtime**: transformers.js (JS, portable) or ONNX (native bindings, faster)?
- **Non-blocking** (defaults set): POLICY.md frontmatter only (no split with SOUL.md), onboarding in-channel + request_approval, per-container policy-service (no shared cache volume tier 2).
- **Tier 3 path clear**: policy-service HTTP boundary + `PolicyStore` interface abstraction mean `src/policy/` can graduate to independent microservice (docker, k8s) without refactoring agent. POLICY.md stays git-tracked in slaude repo until tier 3, at which point policy source moves to policy-service repo / admin UI.

### May 21, 2026 (Dependency Manifest Design)
- **Dependency manifest design spec drafted** (`docs/superpowers/specs/2026-05-21-dependency-manifest-design.md`). Declarative `slaude.json` + `slaude.lock` for three dependency surfaces: CC plugins (marketplace git), skills (git repo per skill), knowledge bases (Karpathy-style markdown wikis). MCP deliberately excluded — stays in `mcp.json`.
- **Architecture decisions locked in**:
  - **Source model**: git URLs only (tag/branch/sha). No registry for v1. Plugin entry shape: `{marketplace, plugin, ref}` — explicit plugin field, no URL-fragment parsing.
  - **CC plugin compat**: full — `plugin.json` at root, slaude fans out skills/commands/agents/hooks. Slaude doesn't reimplement plugin loading; CC's native loader in `$CLAUDE_CONFIG_DIR/plugins/cache/…` picks everything up.
  - **Install lifecycle**: build-time `slaude install` runs inside Dockerfile before runtime stage. Image ships self-contained. `--frozen` flag guarantees no network at image build. `--update` re-resolves branch refs.
  - **KB model**: LLM-wiki framework (Karpathy-style). Each KB is a cloned markdown wiki; the LLM navigates with Read/Grep/Glob. `slaude_kb` in-process MCP exposes `list_kbs` + `open_kb` (read-only, auto-allowed). No embeddings, no chunking — wiki author owns structure.
  - **Install layout**: plugins → `$CLAUDE_CONFIG_DIR/plugins/cache/<marketplace>/<plugin>/<version>/`, skills → `$SLAUDE_HOME/skills/<slug>/`, KBs → `$SLAUDE_HOME/knowledge/<label>/`. All baked into image, not PVC-mounted (operator files like `slaude.json`/`slaude.lock`/`mcp.json`/`SOUL.md` live on PVC).
  - **Marketplace resolution**: two shapes — self-contained (plugin subdirs in same repo) and index-only (`source.repo` + `source.ref` per plugin, second clone). Self-contained wins on collision.
  - **Lockfile**: sha-pinned. Dedupes marketplaces by `(marketplace, ref)`. Plugin versions come from `marketplace.json`, not git ref.
- **New runtime code needed**: `src/cli/install.ts` (installer), `src/knowledge/loader.ts` + `src/knowledge/mcp-tools.ts` (KB MCP). Plugins and skills need zero runtime changes — CC native loader + existing `discoverSkills()`.
- **Non-goals**: no MCP in manifest, no runtime resolver, no registry/index, no SOUL.md or memory in manifest, no KB embedding stack in slaude.

### May 21, 2026 (Writable KB + /ingest)
- Manifest gains two top-level fields: `slaude_skills` (push target for runtime-authored skills) and `slaude_knowledge` (single writable KB target). `skills[]` / `knowledge[]` are now strictly read-only; `sync_manifest` push-or-pulls them accordingly. `SLAUDE_SKILLS_REPO` env var kept as fallback for back-compat.
- `/ingest` slash command (manager + approvers only) runs a dedicated SDK sub-query against `~/.slaude/knowledge/<label>/` with the KB's README.md as schema. The sub-query reads `raw/`, updates `wiki/`, and pushes at end. No Slack output during the sub-query (no `mcp__slaude_slack__*` tools surfaced; `permissionMode: bypassPermissions` since gate is upstream at `/ingest`).
- Lock file gains `slaude_knowledge.raw_sha` + `slaude_knowledge.wiki_sha` (split). Normal `sync_manifest` calls push only `raw/`; ingest pushes both. Lets us detect "raw captured but un-ingested" state via `raw_sha > wiki_sha`.
- Mutex: sqlite `kb_ingest_jobs` table with UNIQUE partial index on `status='running'` — at most one ingest at a time. Heartbeat every 30s; stale jobs (no heartbeat for 10min) auto-marked `crashed` on next `tryAcquire` call.
- Crash policy: on next `/ingest`, stale-reap promotes any old `running` job to `crashed`. No branch/stash gymnastics — operator sees the failure surface and re-runs.
