# Agent platform: identity, mandates, access, audit, memory, console

Date: 2026-11-07. Status: approved by architecture review (second pass: agree; field-level
fallback folded in).

## Why

The panel and portal do not feel ready, and the domain model under them has grown by
accretion: a persona is an identity, but its job description lives inside SOUL.md prose,
admission and approvals read only the default persona's soul, approvals leave no durable
record, and anyone who can see a channel can talk to every agent bound to it.

The Claude platform's agent console (Agents, Sessions, Deployments, Environments, Memory,
Credential vaults) gives a clean reference vocabulary. This spec maps slaude onto it,
keeps what is unique to slaude, and fixes the gaps that block a usable console.

## Mapping to the Claude platform

| Platform | slaude (target) | Notes |
|---|---|---|
| Agent (job definition: model, system, tools, MCP, skills; versioned) | **Mandate** of an Agent | slaude's agent is an identity; the platform's agent is a job. |
| Deployment (cron + initial events + budget, run log) | Mandate **trigger** (cron, heartbeat, channel, DM) + **run** records | Crons and heartbeat already exist; runs become visible. |
| Environment (sandbox config, reused) | **Environment** = named execution config placed on a node pool by label | Node = host capacity, not the config. |
| Session (events, cost, viewer) | Session (per Slack thread) | Console shows transcript, cost, gates, audit. |
| Memory store (versioned files, read_only or read_write attach) | **Memory store** = brain source (`agent-<id>`, `shared`, `user-<id>`, `profile-*`, `kb-*`) | Rebrand kb to memory; attach per mandate. |
| Credential vault | Credentials (`mcp_credentials`, provider refs) | Unchanged in this spec; listed in console. |
| Permission policy (always_allow, always_ask, auto) | Tool policy per mandate | Phase 2. |
| Workspace roles | Console roles (superadmin, operator) + **agent grants** | slaude goes further: per-agent, per-user access. |

## What is unique to slaude (keep)

1. The agent is a teammate with its own Slack identity, soul (voice, values), and memory.
2. Speaker-aware scoping: `/1on1` runs as the user with their credentials; profiles per person.
3. Proactivity under code-enforced restraint (heartbeat, promises, `pass`).
4. Self-improvement (background learning, skill evolution, proposals to the manager).
5. Human approvers chosen by context inside the conversation.
6. Self-hosted, any Anthropic-compatible provider, personas as code.

## Domain model (target)

```
Principal  = a person: Slack identity (team_id, user_id), optionally linked to an account
Agent      = identity: persona row/soul, Slack user and/or app(s), memory home agent-<id>
Mandate    = a job the agent holds: instructions, triggers, approvers, (phase 2) tool policy,
             memory attachments, environment, budget
Grant      = (agent, subject, role)   subject: user | channel-members | everyone-in-workspace
Role       = manager > approver > member      (deny is a separate flag, always wins;
             "owner" is not a grant: console superadmin covers it)
AuditEvent = append-only record of every decision and administrative change
Environment= named execution config + node label selector + kind (node | remote-user-machine)
```

### Agent

No schema change. An agent is a persona. `agent_id` keeps its current derivation
(`slackUserId` for named personas). Removing the `slackUserId` requirement for app-only
personas is deferred to its own change because the id anchors brain slices.

### Mandate

Phase 1 is a **read model**, not a new source of truth. SOUL.md stays authoritative (personas
as code), so a mandate is computed from what already exists:

- `global`: the soul's `## Mandate` (trigger: any admitted message).
- `channel:<id>`: each `## Channel` block (trigger: messages in that channel), its approvers
  and proactive settings.
- `cron:<id>`: each active `cron_jobs` row for the persona (trigger: schedule).
- `heartbeat`: the `## Proactive` block when enabled (trigger: watched sources).

`src/mandate/` exposes `listMandates(persona) -> Mandate[]` with a stable `id`, `kind`,
`title`, `instructions`, `triggers[]`, `approvers[]`, `source` (`soul` | `cron` | `proactive`),
and the last run time when known. The console's agent page shows these as one list.

Phase 2 (not this branch): a `mandates` section in the personas-as-code payload with tool
policy, memory attachments, environment and budget, compiled into the same read model.

### Access: grants and admission

Decision: **channel membership is a grant** (option A). Today's behaviour is preserved by
seeding grants from the soul, and per-user grants or denies refine it.

Table `agent_grants`:

| column | meaning |
|---|---|
| `id` | text pk |
| `tenant_id` | default `default` |
| `persona` | persona name (`default` for the default persona) |
| `subject_kind` | `user` \| `channel` \| `workspace` |
| `subject_id` | Slack user id, channel id, or team id |
| `role` | `manager` \| `approver` \| `member` |
| `deny` | boolean; a deny row for a user blocks them even where a channel grant admits |
| `created_by`, `created_at`, `expires_at` (nullable), `note` |

Grants are keyed by persona **name**. A tombstoned persona's grants stay in the table (inert);
a persona renamed in git is a new persona and its grants must be re-created (documented in the
console). `expires_at` is filtered at read time (`expires_at IS NULL OR expires_at > now`); no
sweep.

#### Structured soul per persona

Named personas have no structured soul at runtime today: `soulData()` and
`effectiveSoulForChannel()` are process-wide views of the default soul. Add
`soulDataFor(persona)` in `src/soul/`:

- managed tenants (Postgres): parse `personas.soul_json` (already extracted at sync,
  `persona/sync/run.ts`);
- filesystem personas and sqlite: none in phase 1 (LLM extraction per persona is deferred).
- Fallback is **per unit**: P takes a unit whole from its own soul when it names any part of
  it, and whole from the default persona otherwise (also when P has no structured soul at all).
  The units: managers (manager and backup manager together), channels (trusted and allowed
  channels together), the DM allowlist, blocked users, and approvers. Approvers are one unit
  covering the global list and every channel block's approver list; a persona that names no
  approver anywhere inherits the default's global and channel-block approvers, never the
  default's channel mandates. Invariant:
  **with no stored grants, a named persona admits exactly what it admits today.** The truth table
  pins the case of a named persona whose `soul_json` carries only identity and mandate.
- `/soul trust|allow|dm|block` keeps writing `soul_overrides` (no persona column) and applies
  only to the default persona's soul, before grant derivation. Named personas are tuned with
  stored grants. No schema change to `soul_overrides`.

#### Grant derivation

Effective grants for a persona = **soul-derived grants** (computed in memory, read-only,
`source=soul`) + **stored grants** (`source=console`). Soul mapping:

- manager, backup manager -> `user` `manager`
- approvers (global, and per-channel with replace semantics as in `effectiveSoulForChannel`,
  manager and backup always appended) -> `user` `approver`, channel-scoped where the soul scopes
  them. Approver is an approval right, **not** a chat right.
- trusted and allowed channels -> `channel` `member`
- DM allowlist -> `user` `member` flagged `dm_only`
- blocked users -> `user` deny

#### Admission

For a message from user U in channel C to persona P (`src/access/admission.ts`, pure function
over the effective grants):

1. A deny for U on P -> drop (`blocked_user`).
2. U holds `manager` on P -> admit.
3. C is a DM: admit when U holds a `member` grant on P (soul `dm_only` or stored). Approver alone
   does not admit.
4. C is not a DM: admit when C has a channel grant on P, or U holds a **stored** `member` grant on
   P without `dm_only`, or a workspace grant exists on P.
5. Otherwise drop with reason `whitelist` (the existing metric label, so dashboards keep working).

With no stored grants this is exactly today's `channelModeAdmits` plus blocklist, which the
admission truth-table tests pin. Stored grants only widen (member, workspace) or narrow (deny).

Drop order in `preTurnDropReason` stays: missing identity, self-echo, caller step (dedup claim),
ignore gate (so `/unignore` keeps its bypass), then admission (replacing blocklist plus channel
mode).

Persona threading: every router path already passes `dispatch.personaId` to `handleMessage`,
but `preTurnDropReason(args)`, `ingressDrops(args)` and `consultGate` (which drops
`o.personaId`) read the default soul. They take the persona id:
`preTurnDropReason(args, { personaId })`, `ingressDrops(args, personaId)`.

Failure: soul-derived grants are in memory, so when the `agent_grants` read fails admission
degrades to soul-only (today's behaviour), logs once a minute and increments
`slaude_grants_read_failures_total`. It never drops managers or trusted-channel traffic because of
a DB blip.

#### One role function

`roleOf(persona, user, channel?) -> "manager" | "approver" | "member" | null` (channel-aware for
approvers only). It replaces the role checks in: the `/1on1` lock manager check, the admin slash
command checks (which today use the global soul's approvers, not channel-effective ones), the
`/soul` and `/heartbeat` manager checks, and approval-gate `#resolveApprovers` for named personas.
For named personas `roleOf` returns approver without the default persona's scope keyword
matching (`selectApproversFrom`), so a named persona's scoped approvers are eligible for every
category in phase 1; the default persona keeps scope matching.

The approval gate resolves approvers in two ways:

- **A named persona** uses `approversFor(persona, channel)`: every user whose role on it
  (channel-aware) is approver or manager. With none, the default persona's managers; with none
  there either, nobody (the card times out denied). It has no legacy category map,
  `SLAUDE_APPROVERS` or "anyone" fallback.
- **The default persona** keeps its chain: the channel-effective soul approvers with scope
  matching, then the legacy category map, then `SLAUDE_APPROVERS`, then "anyone". The resolved
  list is then filtered by deny grants on the default persona (`loadGrants("default")`; a user
  deny row excludes); when the filter empties a non-empty list, nobody may approve.

At click time the gate refuses (`gate.approval.refused`) a clicker with a deny grant on the
card's persona, for both kinds and also when the card admits anyone, so a deny added after the
card was posted applies.

### Tool permission cards: who may click

Today any viewer of the card can approve (`permission-gate.ts`, click handler takes
`body.user.id` with no check). Clicks land on any replica, so the authorisation inputs must be in
the `pending_gates` row:

- Stamp `initiator` (Slack user id or null) and `persona` into the `perm` row payload at create
  time: in process from the session route context (`ctx.userId`, `session.persona_id`); on the
  node path from `JobClaims.initiator` and `JobClaims.persona`, available where
  `permissions.open` is called.
- Rule: the clicker may decide when they are the initiator, the `/1on1` lock owner of the thread,
  or `roleOf(persona, clicker, channel)` is `approver` or `manager`. Turns with no human initiator
  (panel chat `origin: panel`, cron, heartbeat, background) require approver or manager.
- The check runs **before** the guarded `resolve`, so an unauthorised click never consumes the
  row (same pattern as the approval gate). The refusal is an ephemeral message; the card stays
  pending; the refusal is audited (`gate.permission.refused`).
- The stray-row cancel path (own in-process row with no waiter) stays independent of the clicker.
- The sim transport passes `body.user.id`, so sim scenarios must click as the initiator or an
  approver; existing sim YAML flows are updated where needed.

### Audit trail

Table `audit_events`: append-only at the code level (insert and a retention purge are the only
write paths), retention default 365 days via `SLAUDE_AUDIT_RETENTION_DAYS`:

| column | meaning |
|---|---|
| `id` | text pk, time sortable (cursor) |
| `at` | epoch ms |
| `tenant_id`, `persona` | scope |
| `actor_kind` | `slack_user` \| `operator` \| `agent` \| `system` |
| `actor_id` | Slack user id, operator email or subject, agent id, or `system` |
| `action` | dotted verb (list below) |
| `target_kind`, `target_id` | e.g. `tool` + tool name, `grant` + id |
| `decision` | `allow` \| `always` \| `deny` \| `expired` \| `cancelled` \| `refused` \| null |
| `session_id`, `channel_id`, `thread_ts` | context, nullable |
| `summary` | short human line, redacted |
| `details` | JSON, redacted key-wise |

Indexes: `(tenant_id, persona, id)`, `(session_id, id)`, `(actor_id, id)`. The id starts with the
zero-padded epoch ms, so time bounds (`since`, `until`) and the retention purge are id ranges and
one index serves both the filter and `ORDER BY id DESC`; `at` stays for display.

Actions in phase 1: `gate.permission.decided|refused|expired|cancelled`,
`gate.approval.decided|refused|expired`, `gate.mcp_connect.decided`, `grant.created`,
`grant.revoked`, `proposal.decided`, `ignore.set|cleared`, `one_on_one.locked|unlocked`,
`soul.override.set|cleared` (Slack `/soul` and panel overrides), `persona.sync`,
`panel.session.control`, `panel.persona.onboard`.

One writer, `src/audit/`, with two sinks: the table and the existing stdout JSON line
(`panel/auth/audit.ts` becomes a caller of the writer, so they cannot drift). Redaction uses the
existing secret redaction (`redactSecrets` in `status-text.ts`) on `summary` and on every string
value in `details`; keys matching the secret-key pattern are replaced. Audit write failures never
block a decision: they log and increment `slaude_audit_write_failures_total`.

`pending_gates` keeps its 24 h purge; the audit row is the durable record.

Read API: `GET /panel/api/audit?persona&action&actor&session&since&until&cursor` and
`GET /panel/api/sessions/:id/audit`.

Schema: `audit_events` and `agent_grants` go into both `drivers/sqlite.ts` and a new Postgres
migration (`tests/db/schema-drift.test.ts` enforces parity). A DB schema change ships as an RC
per CLAUDE.md.

### Memory (rebrand of kb)

Terms, to avoid collisions with the existing episodic `src/memory/` provider and the
`/v1/tools/memory/*` node API:

- **Memory** (user-facing) = everything the agent knows. Two parts: **memory stores** (brain
  sources, semantic) and **conversation memory** (episodic, `src/memory/`, unchanged).
- Store kinds: `agent` (private mind, `agent-<id>`), `shared`, `public`, `personal`
  (`user-<id>`), `profile` (`profile-*`), `library` (`kb-<label>`).

Agent tools: `memory_search`, `memory_think`, `memory_get`, `memory_list`, `memory_save`,
`memory_delete`, `memory_graph`, `memory_thread_history`, `memory_stores`, `memory_search_stores`
(new names), with the `kb_*` names kept as aliases (required: resumed sessions keep calling them).
`memory_about` already exists and keeps its name. Required alongside:

- `SLAUDE_AUTO_ALLOW_TOOLS` expands aliases both ways.
- `profile-write-guard.ts` matches both `kb_memoize` and `memory_save`.
- Gated dispatch classifies by gbrain op, so it is unaffected; the `kb` and `kb-admin` approval
  categories keep their strings.
- Prompt text moves to the new names: `src/soul/runtime/core.md`, the built-in memory skill,
  `skills/how-slaude-works`, `background/pass-tools.ts`, `proactive/commitment-index.ts`.

This is the widest-blast change in the spec, so it is the last task on the branch and can be
split into its own RC.

Console: Memory page lists stores with page counts; a store page lists pages; a page view shows
content, type, tags and links. Read-only in phase 1.

Phase 2 gaps against the platform: per-page versions and rollback (check gbrain first), explicit
per-mandate attachment with `read_only` or `read_write`, isolation of `kb-*` stores.

### Environments and nodes

Node stays the capacity unit (credential, labels, liveness in Redis). An **Environment** is the
config a turn runs in. Phase 1 makes both visible without changing dispatch:

- Console Environments page: node pools (labels, live nodes, last heartbeat from Redis) and
  each persona's `runsOn` label; personal environments (`environments` table) per user with
  kind and owner, secrets never shown.
- Phase 2: `environments` gains `kind: node` with `label`, packages, and network policy; a
  mandate names an environment; dispatch reads the label from the environment instead of
  `persona.runsOn`.

### Console (new web)

The existing `src/gateway/panel/web` and `src/gateway/portal/web` are replaced, not restyled.

- One codebase `src/web/` (React 19 + Vite, no new runtime deps beyond a router written in
  ~50 lines on `history`), with two entries: `console` (served at `/panel/`, operator) and
  `portal` (served at `/portal/`, every person). Shared `src/web/ui/` components and
  `src/web/ui/tokens.css`.
- Design tokens follow the Claude platform console (neutral warm grays, `#151515` dark page,
  `#fcfcfb` light page, 8 px radius, 14 px body, 32 px controls). Tokens are semantic
  (`--sl-*`) so the color theme can be swapped in one file later. Light and dark via
  `prefers-color-scheme` plus a `data-theme` override.
- Layout: top bar (product name, search, docs, user), left nav, page header (title, one-line
  description, primary action), filter row, table or detail.
- Console nav (phase 1): Overview, Agents, Sessions, Approvals and audit, Access, Memory,
  Environments (one read-only list: node pools, persona `runsOn`, personal environments without
  secrets). Credentials is phase 2. Agent detail tabs: Overview, Mandates, Access, Activity.
- Console roles stay an email allowlist file (`panel/auth/roles.ts`); the Access page shows them
  but cannot edit them. It edits agent grants (superadmin only).
- Portal nav: My account (linked Slack identities), Integrations, My agents (agents the person
  holds a grant on, with their role).
- Compatibility contract (must not change): `/panel/auth/*` stays the only unauthenticated panel
  path; `/portal/auth/login|callback|refresh|logout|me`; `/portal/link?t=` (server-rendered
  identity binding page); `/portal/oauth/callback`; existing panel and portal JSON APIs. The
  static apps keep serving `web/dist` at `/panel/` and `/portal/`; build scripts
  (`panel:build`, `portal:build`, `web:build`), the Dockerfile web stage and its `COPY` paths,
  and the unbuilt-app guard are updated to the new `src/web/` output paths in the same commit.

## Error handling

- Admission failures are drops with a reason label (`not_granted`, `blocked_user`), metric and
  log as today; no reply leaks to the sender.
- Grant table read failures degrade to soul-only admission (today's behaviour) and log once a
  minute.
- Audit write failures never block the decision path; they log and increment
  `slaude_audit_write_failures_total`.
- Permission click by an unauthorised user: ephemeral message, card unchanged.

## Testing

- Unit: admission truth table (soul-derived and stored grants, deny precedence, DM, named
  persona fallback), `roleOf`, audit writer redaction, mandate read model, memory tool aliases.
- DB: migrations for sqlite and Postgres (PGLite in tests), append-only audit API.
- Gateway: permission card refusal path with the sim transport; approval decisions produce
  audit rows.
- Web: Playwright smoke against the built console with fixture API.
- Agent-run integration scenarios: `tests/integration-agent/` holds step-by-step instructions
  an agent can execute against a dev stack (sim Slack, mock LLM) with expected observations.

## Phasing

Phase 1 (this branch, in order): audit trail; permission-card authorisation; per-persona
structured soul, grants, admission and `roleOf`; mandate read model; new console and portal on
the new design system with the new read and grant APIs; integration test instructions; memory
tool rebrand last.

Phase 2: mandates in personas-as-code with tool policy, memory attachments, environment and
budget; environment-based dispatch; memory versions; run records for crons and heartbeat; cost
per session and agent in the console.

## Out of scope

Multi-tenant wiring, per-persona `soul_overrides`, LLM soul extraction for filesystem personas, removing the `slackUserId` requirement for app-only personas, outcome
graders, webhooks.

## Review changes

An independent architecture review (verdict: agree with changes) corrected these points, all
folded in above: named personas have no structured soul at runtime (added `soulDataFor` with
default fallback); `soul_overrides` is global (kept, default persona only); the first draft's
admission widened DM and unlisted-channel reach for approvers (approver is now approval-only);
persona must be threaded into `preTurnDropReason`, `ingressDrops` and `consultGate`; permission
rows must carry initiator and persona and be checked before resolve; audit writers, indexes,
redaction and schema parity were incomplete; the memory rename needs aliases, auto-allow and
profile-guard handling and must not collide with episodic memory; the console needs an explicit
compatibility contract and a smaller phase 1; `owner` had no source; grant read failure must
degrade to soul-only rather than drop.
