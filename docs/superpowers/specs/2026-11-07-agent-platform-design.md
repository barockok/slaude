# Agent platform: identity, mandates, access, audit, memory, console

Date: 2026-11-07. Status: draft for review.

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
Role       = owner > manager > approver > member      (deny is a separate flag, always wins)
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
| `role` | `owner` \| `manager` \| `approver` \| `member` |
| `deny` | boolean; a deny row for a user blocks them even where a channel grant admits |
| `created_by`, `created_at`, `expires_at` (nullable), `note` |

Effective grants for a persona = **soul-derived grants** (computed, read-only, `source=soul`)
+ **stored grants** (`source=console`). Soul mapping:

- manager, backup manager -> `user` `manager`
- approvers (global and per-channel) -> `user` `approver` (channel-scoped approvers keep their channel)
- trusted and allowed channels -> `channel` `member`
- DM allowlist -> `user` `member` (DM only, flagged `dm_only`)
- blocked users -> `user` deny

Admission for a message from user U in channel C to persona P (`src/access/admission.ts`):

1. If any deny applies to U for P -> drop (`blocked_user`).
2. If U holds manager or owner for P -> admit.
3. If C is a DM: admit when U holds any non-deny user grant for P (member covers the DM allowlist).
4. Else admit when C has a channel grant for P, or U holds a user grant for P that is not
   `dm_only`, or a workspace grant exists for P.
5. Otherwise drop (`not_granted`).

This replaces `channelModeAdmits` and the blocklist step in `preTurnDropReason`. The persona is
resolved **before** admission (it already is for app routing and mentions; the default persona
otherwise), and the persona's own soul is used for soul-derived grants. A named persona with no
manager in its own soul inherits the default persona's manager and backup, so existing
deployments keep working.

Role checks elsewhere move to one function `roleOf(persona, user, channel?)`: admin slash
commands, `request_approval` approvers, brain manager-tier ops, and the tool permission card.

### Tool permission cards: who may click

Today any viewer of the card can approve (`permission-gate.ts`, click handler takes
`body.user.id` with no check). New rule: the clicker must be the turn initiator, the `/1on1`
lock owner, or hold approver or higher for the persona. Others get an ephemeral refusal and the
card stays pending. The decision and the refusal are both audited.

### Audit trail

Table `audit_events` (append-only; no update or delete path in code; retention purge only,
default 365 days, `SLAUDE_AUDIT_RETENTION_DAYS`):

| column | meaning |
|---|---|
| `id` | text pk (ulid-like, time sortable) |
| `at` | epoch ms |
| `tenant_id`, `persona` | scope |
| `actor_kind` | `slack_user` \| `operator` \| `agent` \| `system` |
| `actor_id` | Slack user id, operator subject, agent id, or `system` |
| `action` | dotted verb, e.g. `gate.permission.decided`, `gate.approval.decided`, `gate.approval.refused`, `gate.expired`, `grant.created`, `grant.revoked`, `proposal.decided`, `memory.shared_write`, `panel.session.control`, `persona.override.set` |
| `target_kind`, `target_id` | e.g. `tool` + tool name, `grant` + id |
| `decision` | `allow` \| `always` \| `deny` \| `expired` \| `refused` \| null |
| `session_id`, `channel_id`, `thread_ts` | context, nullable |
| `summary` | short human line (redacted, no secrets) |
| `details` | JSON (redacted with the existing secret-key redaction) |

Writers: permission gate, approval gate (including brain shared and admin writes), gate
expiry sweep, proposal decisions, grant changes, panel operator actions (replacing stdout-only
audit lines, which stay as a log mirror). `pending_gates` keeps its 24 h purge; the audit row is
the durable record.

Read API: `GET /panel/api/audit?persona&action&actor&since&until&cursor` and per-session
`GET /panel/api/sessions/:id/audit`.

### Memory (rebrand of kb)

- User-facing name is **Memory**. A **memory store** is a brain source. Store kinds: `agent`
  (private mind), `shared`, `public`, `personal` (`user-<id>`), `profile`, `library`
  (`kb-<label>`, installed wikis).
- Agent tools gain `memory_*` names (`memory_search`, `memory_think`, `memory_get`,
  `memory_list`, `memory_save`, `memory_delete`, `memory_graph`, `memory_about`,
  `memory_thread_history`, `memory_stores`). The `kb_*` names remain as aliases for one minor
  release and are hidden from the built-in skill text.
- Console: Memory page lists stores with page counts and last write; a store page lists pages;
  a page view shows content, type, tags, and links. Read-only in phase 1, except delete of a
  page in the agent or shared store by a superadmin, which is audited.
- Gaps against the platform, tracked for phase 2: per-page version history and rollback
  (check gbrain support first), explicit per-mandate attachment with `read_only` or
  `read_write`, and isolation of `kb-*` stores (today a filter on a shared volume).

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
- Console nav: Overview, Agents, Sessions, Approvals and audit, Access, Memory, Environments,
  Credentials. Agent detail tabs: Overview, Mandates, Access, Memory, Activity.
- Portal nav: My account (linked Slack identities), Integrations, My agents (agents the person
  holds a grant on, with their role).
- Backend: existing panel and portal APIs stay; new endpoints are added under the same auth.
  The static servers point at the new build output.

## Error handling

- Admission failures are drops with a reason label (`not_granted`, `blocked_user`), metric and
  log as today; no reply leaks to the sender.
- Grant table read failures fail closed for non-managers (drop) and log once per minute.
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

Phase 1 (this branch): permission-card authorisation, audit trail, grants and admission with
per-persona roles, mandate read model, memory tool rebrand and read-only memory pages, new
console and portal on the new design system, integration test instructions.

Phase 2: mandates in personas-as-code with tool policy, memory attachments, environment and
budget; environment-based dispatch; memory versions; run records for crons and heartbeat; cost
per session and agent in the console.

## Out of scope

Multi-tenant wiring, removing the `slackUserId` requirement for app-only personas, outcome
graders, webhooks.
