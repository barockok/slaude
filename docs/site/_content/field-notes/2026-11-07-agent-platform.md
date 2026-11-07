---
title: "Agent platform: identity, mandates, access, audit, memory and a new console"
date: 2026-11-07
---

# Agent platform: identity, mandates, access, audit, memory and a new console

**Date:** 2026-11-07
**Status:** Built on a branch, unreleased. It adds two tables (`audit_events`, `agent_grants`; migration 0032 with a sqlite mirror) and changes who may decide a tool permission card, so it ships as `v0.46.0-rc.1` first. Checked with unit and gateway tests (fake Slack, sim transport, PGLite), a Playwright smoke against the built console and portal with a stub API, and agent-run integration scenarios against a local dev stack. **Not run against a live model or real Slack.**

Spec: `docs/superpowers/specs/2026-11-07-agent-platform-design.md`. Plan: `docs/superpowers/plans/2026-11-07-agent-platform.md`.

## Why

The panel and portal did not feel ready, and the domain under them had grown by accretion. A persona was an identity, but its job description lived inside SOUL.md prose. Admission and approvals read only the default persona's soul, even for a named persona. Approvals left no durable record. Anyone who could see a channel could talk to every agent bound to it, and anyone who could see a tool permission card could approve it.

## The mapping to the Claude platform

The Claude platform's agent console (Agents, Sessions, Deployments, Environments, Memory, Credential vaults) gives a clean vocabulary. slaude maps onto it like this:

| Platform | slaude | Note |
|---|---|---|
| Agent (a job definition) | **Mandate** of an agent | In slaude the agent is an *identity*: a persona with a Slack user, a soul and a memory home. The platform's agent is closer to a *job* that identity holds. |
| Deployment (cron, events, budget) | Mandate **triggers** (any admitted message, a channel block, a cron, the heartbeat) | Run records are phase 2. |
| Environment | **Environment** (named execution config) vs **node** (host capacity) | A node is capacity with labels and a credential, not a config. Phase 1 only makes both visible. |
| Session | Session (one Slack thread) | The console shows the timeline, chat and the session's audit events. |
| Memory store | **Memory store** (a brain source: `agent-<id>`, `shared`, `user-<id>`, `profile-*`, `kb-*`) | `kb` is renamed to memory. |
| Credential vault | Stored MCP credentials and provider references | Unchanged here. |
| Workspace roles | Console roles (superadmin, operator) plus **agent grants** | slaude goes further: access per agent and per person. |

What stays unique to slaude: the agent is a teammate with its own Slack identity, voice and memory; `/1on1` runs as the person with their credentials; proactivity is held back by code (heartbeat, promises, `pass`); the agent improves itself (background learning, skill proposals); human approvers are chosen by context inside the conversation; and everything is self-hosted on any Anthropic-compatible provider, with personas as code.

## A structured soul per persona

Named personas had no structured soul at runtime. `soulData()` and `effectiveSoulForChannel()` were process-wide views of the default soul, so a named persona's managers, channels and approvers were the default persona's.

`soulDataFor(persona)` now parses a named persona's stored `soul_json` (extracted at sync, parsed once per registry snapshot). Fallback is **per unit**, not per field: a persona takes a unit whole from its own soul when it names any part of it, and whole from the default persona otherwise. The units are managers (manager and backup together), channels (trusted and allowed together), the DM allowlist, blocked users, and approvers (the global list and every channel block's list as one unit). A persona that names no approver inherits the default's approvers but never the default's channel mandates. An unparseable `soul_json` falls back whole and warns once.

The invariant the admission truth table pins: **with no stored grants, a persona admits exactly what it admits today.** That includes a named persona whose `soul_json` carries only identity and mandate.

`/soul trust|allow|dm|block` still writes the global `soul_overrides` and applies to the default persona only. Named personas are tuned with stored grants.

## Grants and `roleOf`

A grant is `(persona, subject, role)` where the subject is a user, a channel's members, or everyone in a workspace, and the role is `manager > approver > member`, with a separate `deny` flag that always wins. Effective grants are the **soul-derived** ones (computed in memory: managers, approvers channel-scoped where the soul scopes them, trusted and allowed channels, the DM allowlist as `dm_only` members, blocked users as denies) plus the **stored** ones in `agent_grants`.

Admission is a pure function over them: a deny drops; a manager is admitted; in a DM a member grant admits; in a channel a channel grant, a stored member grant (not `dm_only`) or a workspace grant admits; otherwise the drop keeps the `whitelist` label so dashboards keep working. Stored grants only widen (member, workspace) or narrow (deny).

**Approver is approval-only.** The first draft let an approver chat in DMs and unlisted channels; review caught that it widened reach, and an approver alone is now never admitted.

`roleOf(persona, user, channel?)` is the one role function. It replaces the role checks in `/1on1`, the admin slash commands, `/heartbeat`, the agent-tool admin checks, proposal cards and the approval gate's approver resolution for named personas. It is channel-aware for approvers with replace semantics: in a channel whose block names its own approvers, only those count (plus managers), so a global approver no longer holds admin commands there.

Stored grants are cached per persona for 5 s and invalidated on create or revoke in the process that made the change. A failed read caches the soul-only result for 2 s, logs, and increments `slaude_grants_read_failures_total`. It never drops managers or trusted-channel traffic because of a database blip.

## The permission card fix

A tool permission card's click handler resolved the gate for whoever clicked. Any viewer could approve a `Bash` call.

Now each permission row carries the turn's initiator and persona, and a click is authorised **before** any resolve, publish or waiter delivery: the clicker must be the initiator, the thread's `/1on1` lock owner, or hold approver or manager on the persona. A refused click gets an ephemeral note, the card stays pending, and the refusal is audited (`gate.permission.refused`). A click with no user id is refused; a failing role or lock lookup refuses with an audit row.

Building it found a second hole. The first version stamped the initiator from the session's route context, but every delivered message rewrites that context, so a **bystander posting mid-turn** (during a cron, a panel turn or another person's turn) became the initiator and could approve. The initiator is now the **sole Slack sender of the inputs the turn is processing**. On the node path it is the job token's initiator only when it is the job's sole recorded sender. Anything else (several senders, a panel, cron, heartbeat or background turn) stamps no initiator and needs an approver or manager.

The approval gate also tightened: a named persona's approvers are its users with approver or manager; with none, the default persona's managers. The legacy approver list, `SLAUDE_APPROVERS` and "anyone may click" remain the default persona's fallbacks only, so **a named persona's card never falls back to anyone**.

## The audit trail

`audit_events` is append-only at the code level: insert and a retention purge are the only write paths. Retention defaults to 365 days (`SLAUDE_AUDIT_RETENTION_DAYS`).

- **One writer** (`src/audit/`) with two sinks: the table and one JSON line on stdout. The panel's operator actions call it too, so the two cannot drift. The stdout line is now `evt: "audit"` (it was `evt: "panel.audit"`) and is written first, so it survives a database failure. A failed sink never blocks the decision; it logs and increments `slaude_audit_write_failures_total`.
- **Redaction parity with cards.** Approval cards and the audit trail share one bounded redaction walker (header values, capability URLs, secret keys, cycles, a node cap). The summary is capped at 500 characters and details at 16 KB.
- **Id-keyed indexes.** The id starts with a zero-padded epoch, so `since`, `until` and the purge are id ranges and each index ends in `id`: one index serves both the filter and `ORDER BY id DESC`. `id` and `action` are `COLLATE "C"` on Postgres so ranges compare bytewise like sqlite.
- **Actions:** `gate.permission.decided|refused|expired|cancelled`, `gate.approval.decided|refused|expired`, `gate.mcp_connect.decided`, `grant.created|revoked`, `proposal.decided`, `ignore.set|cleared`, `one_on_one.locked|unlocked`, `soul.override.set|cleared`, `persona.sync`, `panel.session.control`, `panel.persona.onboard`, `memory.page.viewed`.

`pending_gates` keeps its 24 h purge; the audit row is the durable record.

## Mandates as a read model

SOUL.md stays authoritative, so a mandate is computed, not stored: the soul's `## Mandate` (global), each `## Channel` block (including blocks that only set approvers or proactive settings), each active cron for the persona, and the heartbeat when enabled. Each has a stable id, kind, title, instructions, triggers, approvers and source.

The approvers a mandate lists come from `approversFor(persona, channel)`, the same function the approval gate uses for a named persona, so the console shows who can actually approve at runtime rather than a second reading of the soul.

## The console and portal

`src/gateway/panel/web` and `src/gateway/portal/web` were replaced, not restyled, by one codebase in `src/web/` (React and Vite, a small router on `history`) with two entries: the **console** at `/panel/` and the **portal** at `/portal/`.

- **Design tokens** follow the Claude platform console's neutral system (warm grays, 8 px radius, 14 px body, 32 px controls). Every component reads semantic `--sl-*` names from `src/web/ui/tokens.css`, so a re-theme edits one file. Light and dark follow `prefers-color-scheme` with a `data-theme` override.
- **Console pages:** Overview, Agents (Overview, Mandates, Access, Activity tabs), Sessions (timeline, chat, audit), Approvals and audit, Access, Memory, Environments. Grants are edited by superadmins only; console roles stay an email allowlist the page shows but cannot edit.
- **Portal pages:** My account (linked Slack identities), Integrations, My agents (agents the person holds a grant on, with the role).
- **Compatibility contract:** `/panel/auth/*` stays the only unauthenticated panel path; the portal auth, `/portal/link?t=` and `/portal/oauth/callback` paths and every existing JSON API are unchanged. The build scripts, the Dockerfile web stage and the unbuilt-app guard moved to the new `dist` paths in one commit.
- **Private memory stores.** Personal (`user-*`) and profile (`profile-*`) stores hold what one person told an agent. They are hidden from operators, `403` on their pages, and every page a superadmin opens in one is audited as `memory.page.viewed` (store and slug, no content).

## Memory rebrand

The agent's memory tools carry `memory_*` names (`memory_save`, `memory_search`, `memory_think`, `memory_get`, `memory_list`, `memory_delete`, `memory_graph`, `memory_thread_history`, `memory_stores`, `memory_search_stores`). The old `kb_*` names (and `list_kbs`, `search_kbs`) stay mounted as aliases with the same schema and handler, because a resumed session keeps calling the names it saw. `SLAUDE_AUTO_ALLOW_TOOLS` expands either name to both, the profile write guard matches both, and gated dispatch still classifies by gbrain operation, so the `kb` and `kb-admin` approval categories keep their strings.

`slaude_v1_tool_calls_total` counts a memory tool under its new name with an `alias` label (`true` when a node called the old name), so the remaining alias traffic is visible before the aliases are retired. `SLAUDE_MEMORY_TOOL_ALIASES=0` stops mounting the aliases, in process and on node shims; the REST tool plane accepts the old names either way.

## Agent-run integration scenarios

`tests/integration-agent/` holds step-by-step scenarios an AI agent runs against a local dev stack (fake Slack or the sim transport, a mock model, a scratch home), reporting expected, observed and a verdict per step: default admission parity, stored grants, named persona access, permission card authorisation, the approval audit trail, retention, mandates, the memory console, console and portal smoke, and the memory aliases. They add the real process, database, wire and browser on top of the unit floor. Nothing there runs in CI.

## Known gaps and phase 2

- **Phase 2:** mandates in personas as code with tool policy, memory attachments (read only or read write per mandate), environment and budget; dispatch reading the label from an environment instead of `persona.runsOn`; memory page versions and rollback; run records for crons and heartbeat; cost per session and agent in the console.
- **Cross-replica grant staleness.** A grant change applies at once on the replica that made it and within the 5 s cache TTL on the others.
- **Filesystem personas have no structured soul** (no per-persona LLM extraction), so they take every unit from the default persona.
- **The default persona's approvals stay scope-matched** (keyword match of the plan against each approver's scope); named personas' approvers are eligible for every category. The mandate view lists the default's approvers without the per-request match.
- **The persona definition view** (provider references, MCP routes, skills, knowledge scope) is API only for now (`GET /panel/api/personas/:name`); the agent page shows identity, mandates, access and activity.
- **`docs/internal/architecture.html` is stale**: it predates grants, the audit trail and the new web apps.
