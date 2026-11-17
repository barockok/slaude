# Agent platform phase 1 implementation plan

> **For Claude:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to execute this
> plan task by task. Spec: `docs/superpowers/specs/2026-11-07-agent-platform-design.md` (read it
> first; it is the source of truth when this plan is terse).

**Goal:** durable approval audit, authorised permission cards, per-persona grants and admission,
a mandate read model, a new console and portal on the Claude-console design tokens, agent-run
integration test instructions, and the kb to memory rebrand.

**Architecture:** new modules `src/audit/`, `src/access/`, `src/mandate/`; new tables
`audit_events` and `agent_grants` (sqlite bootstrap and a Postgres migration); gateway admission
and role checks call one `admit()` and one `roleOf()`; new web codebase `src/web/` replaces
`src/gateway/panel/web` and `src/gateway/portal/web`.

**Tech stack:** Bun + TypeScript, `bun test`, sqlite (`bun:sqlite`) and Postgres/PGLite through
`src/db` (`db.run`, `db.one`, `db.all`), React 19 + Vite, Playwright.

## Rules for every task

- Read `CLAUDE.md` first. Public repo: generic placeholders only (`U0000000001`-style ids are
  fine in tests only if they do not match `\b[CUTGW]0[A-Z0-9]{8,}\b`; prefer `UALICE`, `CTEAM`).
- TDD: write the failing test, see it fail, implement, see it pass.
- Run `bun run typecheck` and the touched test files before committing; run `bun test` for the
  full suite at the end of tasks 2, 5 and 9.
- Before every commit run the leak scan from `CLAUDE.md` on the staged diff.
- No AI co-author trailers. Granular commits, message style `feat(scope): ...`, `fix(scope): ...`.
- No emoji, no em dashes in any text you write (code comments, docs, UI copy).
- Do not touch unrelated files. Do not reformat files.

---

### Task 1: audit table and writer

**Files**
- Create `src/db/migrations/0032_audit_and_grants.sql` (both tables: `audit_events` and
  `agent_grants`, columns per spec; Postgres types `BIGINT` for times, `BOOLEAN` for `deny`,
  `JSONB` or `TEXT` for `details` following existing migrations' convention).
- Modify `src/db/drivers/sqlite.ts` (mirror both tables, `INTEGER` times, `INTEGER` deny).
- Modify `tests/db/schema-drift.test.ts` only if an allowlist entry is genuinely required
  (prefer none; both tables carry `tenant_id`).
- Create `src/db/audit-events.ts`: `insert(ev)`, `list(filter, cursor, limit)`,
  `purgeOlderThan(ms)`. No update or delete other than purge.
- Create `src/audit/index.ts`: `audit(ev: AuditInput): Promise<void>` that fills `id`
  (time-sortable: zero-padded epoch ms + random suffix), `at`, redacts, inserts, and also
  writes the JSON stdout line. Never throws: catches, logs, increments
  `slaude_audit_write_failures_total` (follow the metrics module pattern in `src/metrics*`).
- Create `src/audit/redact.ts`: redact `summary` and every string value in `details`
  recursively with `redactSecrets` from `src/gateway/slack/status-text.ts` (check exact export);
  keys matching that module's secret-key regex get value `"[redacted]"`.
- Wire retention: call `purgeOlderThan(retentionDays)` where `PendingGates.purgeSettledOlderThan`
  is called (`src/gateway/core/gateway.ts:817`). Env `SLAUDE_AUDIT_RETENTION_DAYS` (default 365)
  read via `src/config/env.ts` style.
- Tests: `tests/audit/audit.test.ts` (insert and list round trip on sqlite; cursor pagination
  ordering newest first; filters persona, action, actor, session; redaction of a token-like
  string and a `password` key; write failure does not throw), and the drift test passes.

**Commit:** `feat(audit): append-only audit_events table and writer`

### Task 2: audit writers

Wire `audit()` at every decision point. Each call carries persona, actor, action, target,
decision, session/channel/thread context, and a short summary.

- `src/gateway/slack/permission-gate.ts`: decided (allow, always, deny), expired, cancelled
  (abort or post failure paths). Action `gate.permission.*`, target `tool` + tool name.
- `src/gateway/slack/approval-gate.ts`: decided, refused (non-approver click), expired.
  Action `gate.approval.*`, target kind `approval`, target id the scope or category.
  Brain shared and admin writes flow through here; include `category` in details.
- `/mcp connect` gate decisions (`src/gateway/core/gateway.ts` near the `mcp_connect` gate, grep
  `mcp_connect`): `gate.mcp_connect.decided`.
- Expiry sweep in `src/db/pending-gates.ts` callers (`sweepExpired`): one `gate.*.expired` row per
  expired gate (call from the caller, keep the DB module free of audit imports).
- Proposals decisions (`src/background/proposal-cards.ts`): `proposal.decided`.
- `/ignore`, `/unignore*` handlers: `ignore.set|cleared`.
- `/1on1` lock set and clear: `one_on_one.locked|unlocked`.
- `/soul` overrides (Slack) and panel `PUT|DELETE personas/:name/overrides/:field`:
  `soul.override.set|cleared`.
- Persona sync (`src/persona/sync/run.ts`, see the `db/personas.ts:292` comment):
  `persona.sync` with revision and counts.
- Panel operator actions: make `src/gateway/panel/auth/audit.ts` call `audit()` (the writer keeps
  the stdout line, so remove the duplicate stdout write there). Actions `panel.session.control`,
  `panel.persona.onboard`, and keep the existing action strings in details.
- Tests: extend existing gate tests (`tests/approval-gate.test.ts`, permission gate tests: grep
  `slaude_perm` under `tests/`) to assert an audit row exists after a decision and after expiry;
  one test per other writer where a test harness already exists, otherwise a unit test of the
  helper that builds the event.

**Commit:** several commits are fine, one per writer group. Run full `bun test` at the end.

### Task 3: permission card authorisation

- Payload stamping: at gate creation add `initiator` (string or null) and `persona` to the `perm`
  row payload. In-process: resolver in `permission-gate.ts` (~line 640) gets them from the
  session route context; find where `ctx.userId` and the session persona are available
  (`routes.get(sessionId)`, `session.persona_id`). Node path: `open()` (~line 582) is called from
  `gateway.ts` near line 4231 with `JobClaims`; pass `claims.initiator` and `claims.persona`.
- Authorisation function `canDecidePermission({ clicker, initiator, lockOwner, persona, channel })`
  in `src/access/permission-auth.ts`: true when clicker == initiator, or clicker == lock owner of
  the thread, or `roleOf(persona, clicker, channel)` is approver or manager. Until Task 5 lands
  `roleOf`, implement it here against `soulData()` manager, backup, approvers (global plus the
  channel's effective approvers via `effectiveSoulForChannel`), and Task 5 swaps the call.
- Click handler: run the check before any `PendingGates.resolve` or bus publish. On refusal:
  ephemeral "Only the requester or an approver can decide this." and `audit` with
  `gate.permission.refused`. Leave the stray-row cancel path untouched.
- Sim: grep `tests/` and `e2e/` and `src/gateway/sim/` for flows that click permission buttons;
  make them click as the initiator. Do not weaken the rule for the sim.
- Tests: `tests/access/permission-auth.test.ts` truth table; a gateway-level test using the sim
  transport: non-initiator click is refused and the row stays `pending`; initiator click decides;
  manager click decides; cron-origin turn (no initiator) requires approver.

**Commit:** `fix(security): only the requester or an approver can decide a tool permission card`

### Task 4: structured soul per persona, grants repo, admission, roleOf

- `src/soul/per-persona.ts`: `soulDataFor(personaName): SoulData`. Default persona returns
  `soulData()` (which already applies `soul_overrides`). Named persona: parse `soul_json` from the
  managed persona row (find the accessor used by `src/background/scheduler.ts:536` and
  `src/agent/manager.ts:1191`; reuse it), then apply the **field-level fallback** to the default
  soul for manager, backupManager, trustedChannels, allowedChannels, dmAllowedUsers,
  blockedUsers, approvers. No structured soul: return the default soul's ACL fields.
  Also `effectiveSoulForChannelFor(personaName, channelId)` with the same replace semantics as
  `effectiveSoulForChannel` (`src/soul/extract.ts` ~355) for channel approvers.
- `src/db/agent-grants.ts`: `listForPersona(tenant, persona, now)` (filters expired at read),
  `create`, `revoke(id)` (hard delete is fine for grants; the audit row records it),
  `listAll(tenant)`.
- `src/access/grants.ts`: `deriveSoulGrants(soul, channelApproverMap)` and
  `effectiveGrants(persona, stored)`, types `Grant { subjectKind, subjectId, role, deny,
  dmOnly, source: "soul" | "console", channelId? }`.
- `src/access/admission.ts`: pure `admit({ grants, userId, channelId, isDM }) ->
  { ok: true } | { ok: false, reason: "blocked_user" | "whitelist" }` implementing the five
  steps in the spec exactly.
- `src/access/role.ts`: `roleOf(persona, userId, channelId?)` returning
  `"manager" | "approver" | "member" | null`, plus a cached loader of stored grants
  (short TTL, e.g. 5 s, invalidated on create or revoke in-process) whose read failure degrades
  to soul-only and increments `slaude_grants_read_failures_total`, logging at most once a minute.
- Tests: `tests/access/admission.test.ts` truth table. Must include: default persona parity with
  `channelModeAdmits` for trusted, allowed, unlisted, DM with and without allowlist, manager,
  backup, blocked; approver alone is not admitted in DM or unlisted channel; stored member grant
  admits in unlisted channel; stored deny beats trusted channel; workspace grant; expired grant
  ignored; named persona with only identity in `soul_json` admits exactly like the default; named
  persona with its own manager and channels uses its own. `tests/access/role.test.ts` for
  channel-scoped approver replace semantics and read-failure degradation.

**Commit:** `feat(access): per-persona soul ACLs, agent grants, admission and roleOf`

### Task 5: wire admission and roles into the gateway

- `preTurnDropReason(args, { personaId, afterSelfEcho })`, `ingressDrops(args, personaId)`;
  `consultGate` passes `o.personaId`. Replace the blocklist block and the channel-mode block with
  one `admit()` call using `effectiveGrants(personaId)`. Keep order: identity, self-echo, caller
  step, ignore gate, admission. Keep the drop reason strings and log lines equivalent
  (`blocked_user`, `whitelist`).
- Delete `channelModeAdmits` once no caller remains; update the tests that pin it
  (`grep -rl channelModeAdmits tests`) to the new admission (behaviour identical).
- Replace role checks with `roleOf`: `/1on1` lock `isMgr` (~2402), admin slash checks
  (~2820-2895), `/soul` and `/heartbeat` manager-only checks, approval-gate `#resolveApprovers`
  for named personas (default persona keeps `selectApproversFrom` scope matching), brain
  manager-tier check (`GatedCallDeps.managers`), and Task 3's `canDecidePermission`.
- Tests: existing gateway tests stay green; add a test where a named persona on its own app is
  admitted in its own soul's channel and dropped elsewhere; a test where a stored member grant
  lets a user chat in an unlisted channel.
- Run the full suite.

**Commit:** `feat(access): gateway admission and role checks per persona`

### Task 6: mandate read model

- `src/mandate/index.ts`: `listMandates(personaName): Promise<Mandate[]>` with
  `Mandate { id, kind: "global"|"channel"|"cron"|"heartbeat", title, instructions, triggers:
  string[], approvers: string[], source: "soul"|"cron"|"proactive", channelId?, lastRunAt? }`.
  Sources: soul `## Mandate` (use the existing soul accessor), channel blocks via
  `channelMandate()` (`src/soul/extract.ts` ~350) on the persona's soul (`soulDataFor`), active
  `cron_jobs` rows for the persona (`src/db/cron-jobs.ts`; `lastRunAt` from `last_run_at`), and the
  `## Proactive` block (`src/soul/proactive.ts`) when enabled.
- Tests: `tests/mandate/mandate.test.ts` with a fixture soul containing a global mandate, two
  channel blocks, proactive enabled, and two cron rows (one paused, excluded).

**Commit:** `feat(mandate): read model over soul, channel blocks, crons and heartbeat`

### Task 7: console and portal APIs

Add to `src/gateway/panel/api.ts` (same auth guard; mutations superadmin only and audited):

- `GET /panel/api/agents`: personas with name, slackUserId, model, runsOn, live, mandate count,
  grant count. `GET /panel/api/agents/:name`: plus mandates and effective grants (soul and
  console, with `source`).
- `GET /panel/api/agents/:name/grants`, `POST` (body `{subjectKind, subjectId, role, deny,
  expiresAt?, note?}`, zod-validated), `DELETE /panel/api/agents/:name/grants/:id`. Audit
  `grant.created|revoked`.
- `GET /panel/api/audit` with filters and cursor; `GET /panel/api/sessions/:id/audit`.
- `GET /panel/api/memory/stores` (brain sources with kind and page count; use the brain module's
  list functions, never raw SQL on gbrain tables), `GET /panel/api/memory/stores/:id/pages?cursor`,
  `GET /panel/api/memory/pages/:slug?store=` (content, type, tags, links). Read-only.
- `GET /panel/api/environments`: node pools from Redis (`nodes:*`, `nodeset`, `nodelabels:`; empty
  list in mono), persona `runsOn`, personal environments from `src/db/environments.ts` without
  `secrets` or `endpoint`.
- `GET /panel/api/console-roles`: the email allowlist (read-only).
- Portal `src/gateway/portal/api.ts`: `GET /portal/api/my-agents`: for each linked Slack identity,
  personas where `roleOf` is non-null or a stored grant names the user, with role.
- Tests: extend the panel and portal API tests (find them under `tests/` by grepping
  `panel/api` and `portal/api`) for auth (operator vs superadmin), validation, audit rows on
  grant changes, and secret fields never present in environments output.

**Commit:** one per endpoint group.

### Task 8: web foundation (replaces old panel and portal web)

- Create `src/web/` with `vite.console.config.ts` (root `src/web/console`, base `/panel/`,
  outDir `src/web/console/dist`, dev proxy `/panel/api` and `/panel/auth` like the old config) and
  `vite.portal.config.ts` (base `/portal/`, outDir `src/web/portal/dist`, proxy `/portal`).
- `src/web/ui/`: `tokens.css` (exists; do not change values), `base.css` (reset, body uses
  `--sl-page-bg`, `--sl-text`, `--sl-font-sans`, `--sl-text-body`), components in TSX: `AppShell`
  (top bar 48 px, left sidebar 256 px, content), `Sidebar`, `NavItem`, `PageHeader` (title 24/32,
  description, actions), `Button` (primary, secondary, ghost, danger; 32 px; radius 8),
  `IconButton`, `Input`, `Select`, `SearchField`, `FilterChip`, `Table` (header row, 45 px rows,
  hairline separators, skeleton rows), `Badge` (neutral, accent, success, warning, danger),
  `Tabs`, `Card`, `EmptyState`, `Dialog`, `Toast`, `CodeBlock`, `KeyValue`, `Skeleton`,
  `ThemeToggle` (system, light, dark via `data-theme`). Inline SVG icons only, no icon library.
  Layout must work at phone width (sidebar collapses to a top menu button).
- `src/web/lib/router.ts`: tiny history router (`useRoute`, `Link`, `navigate`, params), under 80
  lines. `src/web/lib/api.ts`: fetch wrapper with JSON errors and 401 redirect to the auth login.
- Update `src/gateway/panel/static.ts` and `src/gateway/portal/static.ts` to serve the new dist
  directories; keep the unbuilt-app guard behaviour.
- Update `package.json` scripts `panel:dev`, `panel:build`, `portal:dev`, `portal:build`,
  `web:build`, `test:web`, and the `Dockerfile` web stage and `COPY` paths.
- Delete `src/gateway/panel/web/` and `src/gateway/portal/web/` and their Playwright fixtures that
  only targeted the old UI (keep the Playwright config, retarget it in Task 11).
- Verify: `bun run web:build` succeeds; `bun run typecheck`; static tests pass.

**Commit:** `feat(web): new console and portal foundation on design tokens`

### Task 9: console pages

Pages (each with loading skeletons, empty state, error state):
- Overview: counts (agents, live sessions, pending approvals, audit events 24 h), recent audit.
- Agents list and agent detail with tabs Overview (identity, model, runsOn, live), Mandates
  (Task 6 data; source badge), Access (effective grants table with source badge; superadmin can
  add and revoke console grants via dialog; soul grants read-only with a note that they come from
  SOUL.md), Activity (audit filtered by persona).
- Sessions list and session detail: rebuild the timeline, chat-as-operator and control bar
  features of the old panel on the new components (old code in git history:
  `git show HEAD~N:src/gateway/panel/web/app/Detail.tsx` etc. for behaviour only, not style),
  plus an Audit tab per session.
- Approvals and audit: filterable table (persona, action, actor, decision, time range), row
  detail drawer with redacted details JSON.
- Access: console roles (read-only) and all grants across agents.
- Memory: stores, store pages, page view.
- Environments: node pools, persona placement, personal environments.
- Verify with `bun run web:build` and a manual Playwright screenshot pass in both themes at
  1440 px and 390 px widths (deviceScaleFactor 1). Run full `bun test`.

**Commit:** one per page group.

### Task 10: portal pages

- My account (linked Slack identities, unlink), Integrations (list, connect, disconnect, the
  existing connect flow), My agents (Task 7 endpoint). Same shell, nav limited to these.
- Keep `/portal/link?t=` server-rendered page untouched.

**Commit:** `feat(web): portal on the new design system`

### Task 11: web tests

- Retarget `tests/panel-web/` Playwright config to the new builds with a fixture API (route
  interception) covering: console loads, nav to each page, grant add dialog validation, audit
  filter, theme toggle, portal pages render. Run with `--trace off`.

**Commit:** `test(web): playwright smoke for console and portal`

### Task 12: agent-run integration test instructions

Create `tests/integration-agent/`:
- `README.md`: purpose (an AI agent executes these against a dev stack and reports pass or fail
  per step), prerequisites, how to start the stack (sim gateway `bun run sim`, mock LLM as in the
  2026-09-30 mock LLM field note, or `docker-compose.dev.yml`), how to sign in to the console in
  dev, how to report results (a markdown table per scenario: step, expected, observed, verdict).
- One file per scenario, each with Setup, Steps (numbered, exact commands or UI actions),
  Expected observations, Cleanup:
  `01-admission-default-parity.md`, `02-stored-grants.md`, `03-named-persona-acl.md`,
  `04-permission-card-authorisation.md`, `05-approval-audit-trail.md`, `06-audit-retention.md`,
  `07-mandates-view.md`, `08-memory-console.md`, `09-console-and-portal-smoke.md`,
  `10-memory-tool-aliases.md`.
- Use only generic placeholder names and ids.

**Commit:** `test: agent-run integration scenarios for the agent platform`

### Task 13: memory rebrand

- `src/tools/contracts/kb.ts`: add `memory_*` names per spec mapping (`kb_search` ->
  `memory_search`, `kb_think` -> `memory_think`, `kb_get_page` -> `memory_get`, `kb_list_pages`
  -> `memory_list`, `kb_memoize` -> `memory_save`, `kb_delete_page` -> `memory_delete`,
  `kb_graph` -> `memory_graph`, `kb_thread_history` -> `memory_thread_history`, `list_kbs` ->
  `memory_stores`, `search_kbs` -> `memory_search_stores`); `kb_*` remain as aliases with identical
  handlers; `memory_about` unchanged. Find every place tools are registered or matched by name
  (grep `kb_memoize`, `kb_search`, `list_kbs` across `src/`).
- `SLAUDE_AUTO_ALLOW_TOOLS` (`autoAllowFromEnv` in permission-gate): expand aliases both ways.
- `src/agent/profile-write-guard.ts`: match both names.
- Prompt and skill text to the new names: `src/soul/runtime/core.md`, built-in memory skill under
  `src/soul/builtin/skills/`, `skills/how-slaude-works/SKILL.md`, `src/background/pass-tools.ts`,
  `src/proactive/commitment-index.ts`. Keep gated-dispatch category strings `kb` and `kb-admin`.
- Tests: alias parity (both names registered, same handler), auto-allow expansion, profile guard
  for both names; update tests that assert prompt text.
- Run the full suite.

**Commit:** `feat(memory): memory_* tool names with kb_* aliases`

### Task 14: docs and release notes

- Field note `docs/site/_content/field-notes/2026-11-07-agent-platform.md` (mechanism only: the
  mapping, grants and admission invariant, permission card fix, audit, console) and the index line
  in `CLAUDE.md` Findings Log (newest first). Do not otherwise edit `CLAUDE.md` except updating the
  "Memory — KB only" rule's tool names to `memory_save`, `memory_search`, `memory_think`.
- Release notes `docs/site/_content/releases/v0.46.0.md` (Features, Fixes, Docs, Internal; note
  the schema change means an RC first).
- Update `docs/internal/architecture.html` only if trivial; otherwise leave a note in the field
  note that it is stale.

**Commit:** `docs: agent platform field note and release notes`
