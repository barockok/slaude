# Domain records, slice B: users, bindings, boundaries

> For Claude: use superpowers:executing-plans, task by task.

Goal: store users, their bindings, boundaries and merge aliases as records, backfilled from existing data and created on reference. Nothing reads them for access yet (slice C does).

Architecture: four new tables on both dialects, one repo module `src/db/domain.ts` (every function takes an optional `tx`), one resolver `src/refs/resolve.ts`, dual write from the identity paths, an idempotent reconciler for backfill, hooks at sync and at first sight. Access, sessions and audit readers do not change in this slice, so the risk is the write paths and the backfill, not the readers.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md`. This plan amends it in one place: observed records are created wherever a session or audit row is written (see Decisions), not on every event.

## Schema (migration 0038, DDL only)

```
users          (id PK, created_at, updated_at, kind 'person'|'bot'|'agent' default 'person',
                display_name NULL)
bindings       (id PK, user_id -> users.id, service, kind, workspace NOT NULL default '',
                value, state 'declared'|'observed'|'verified', created_at, updated_at,
                verified_at NULL, source TEXT,
                UNIQUE (service, kind, workspace, value),
                CHECK (service <> 'slack' OR workspace <> ''))
boundaries     (id PK, created_at, updated_at, kind 'channel'|'group'|'dm', display_name NULL,
                service, workspace NOT NULL default '', value, state,
                UNIQUE (service, workspace, value),
                CHECK (service <> 'slack' OR workspace <> ''))
user_aliases   (old_id PK, user_id -> users.id, merged_at, audit_event_id NULL)
```

- Email is a binding: service `email`, kind `address`, workspace `''`. Slack: service `slack`, kind `user`, workspace = team id. OIDC: service `oidc`, kind `subject`, workspace = issuer.
- No `merged_into` column: `user_aliases` is the only merge record.
- No tenant_id (deployment-global like accounts). Add the four tables to `NO_TENANT_TABLES`. The drift test compares columns only, so unique keys and CHECKs get their own test on both dialects. Mirror in `drivers/sqlite.ts`.
- accounts and slack_identities stay the authority in this slice. Bindings are a projection kept in step.
- Grid `W...` user ids and `workspace` grant subjects are out of scope (spec leaves Grid undecided).

## Tasks, in order

1. Schema: migration, sqlite mirror, drift allowlist, unique and CHECK tests, upgrade test (fresh and existing).
2. Repo and resolver `src/db/domain.ts`, `src/refs/resolve.ts`.
   - `ensureUser`, `ensureBinding` (insert-or-ignore on the unique key then re-read, never downgrades a state), `ensureBoundary`, `resolveRef`, `preferredBinding`. All take `tx`.
   - Adopt rule: when a verified binding (portal link, OIDC login) targets a value already held by a different observed or declared user, the bindings move to the account's user and the other user id is written to `user_aliases`. This is the minimal merge needed here; the proof path from the spec, restricted to a single-step adopt of an unverified record, never a merge of two verified records (that is a conflict, left for slice C console).
   - Audit events: `user.created`, `binding.created`, `boundary.created`, `user.adopted`. Backfill writes one summary event per run, not one per row.
   - Race test on the unique key.
3. Dual write, before any backfill: portal link completion, `unlinkSlackIdentity` (remove or demote the binding), account email refresh on login (update the email binding, do not leave a stale verified one), account deletion cascade. `linkSlackIdentity` plus its binding in one transaction.
4. Backfill as an idempotent reconciler, not a migration step.
   - Runs at gateway boot after Slack auth, under a Postgres advisory lock (sqlite: single process), and as `slaude domain reconcile [--dry-run]`.
   - Sources: accounts, slack_identities (verified), then grants, sessions and audit actors for Slack ids not yet bound (observed; grant subjects declared).
   - Workspace resolution per tenant: from that tenant's `slack_apps` row on Postgres, from the live Slack auth on sqlite. A row with NULL `slack_team_id`, a grant subject or an audit actor is attributed only when the tenant has exactly one workspace; otherwise skipped and counted in the report.
   - Email collisions: two accounts with the same email keep their own verified bindings only if distinct after normalisation; a collision creates no second binding and is listed in the report as a conflict for the console. Emails are normalised by the slice A rule before use.
   - Reconciles rows missed by old replicas during a rolling deploy.
5. Sync: bindings and boundaries are ensured inside `applySync` (`src/db/personas.ts`) with its `tx`. The dry-run branch reports would-create without writing. Created records are listed in the report. `--strict` refuses a reference that would create a record (default off). Sync is Postgres-only, so sqlite deployments get records from first sight only. Non-Slack references resolve to declared records and still grant nothing.
6. First sight: records are created as observed wherever a session or audit row is written (admitted, engaged or refused), through a per-process LRU so the hot path adds no query. Failure is logged and never blocks a turn.
7. Console, read only: Users and Boundaries lists with preferred binding and state, unmatched flag for declared-only records. Conflict and undo UI waits for slice C.
8. Docs, field note, release notes `v0.46.0-rc.18`, CLAUDE.md log line, spec amendment.

## Decisions (confirmed by review)

- Workspace is resolved per tenant from the connected workspace, never hardcoded and never `''` for Slack.
- Observed records follow session and audit writes, which amends spec lines 151 to 153 (slices C and D key on refused actors too).
- Strict sync off until slice C, because nothing can verify a declared email before then.

## Verification

- Repo, dual-write, reconciler (idempotent, rerun, two-runner race) and sync tests on sqlite and Postgres (`SLAUDE_DB=pg`).
- Upgrade rehearsal: `sudo /usr/local/sbin/slaude-backup`, restore to a scratch copy, run `slaude domain reconcile --dry-run`, compare counts with accounts, slack_identities and grants.
- RC rule: `rc.18`, backup before the version bump, deploy through vps-hardening, `verify` 0 FAIL, Slack smoke with the sam agent, check the reconcile report in the log.
