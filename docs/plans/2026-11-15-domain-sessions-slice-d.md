# Domain sessions, slice D: boundary and locator beside the Slack columns

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: every session and every thread-scoped or channel-scoped row also records WHICH boundary it belongs to (`boundary_id`, a soft reference to the slice B `boundaries` record) and WHICH conversation inside it (`locator`, the opaque thread key), written next to the existing Slack columns. The legacy columns stay authoritative and every unique index and primary key stays exactly as it is. This slice proves, with data, that `(boundary_id, locator)` identifies the same rows as `(slack_team_id, slack_channel_id, slack_thread_ts)`. Moving the unique indexes is a LATER release with its own gate (Follow-up). Nothing here changes which session a message reaches.

Architecture: a cache-only resolver on the write path (`boundaryForCached`, no await before an insert), first sight primes it; dual write at every writer; a periodic bounded fill in the gateway background loop (plus the existing reconciler stage) that fills old and missed rows; a parity check done IN-ROW on rows the legacy query already fetched (no second query, no sampling). Two release candidates: rc.22 writes, migrates and fills; rc.23 adds the in-row check and `slaude domain boundary-check`.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` (slice D: "sessions and thread-scoped tables gain a boundary column read through a resolver, and the unique indexes move after one release"; "A thread is not a boundary. It is an opaque conversation locator inside one. A session identity becomes (agent, boundary, locator)"). Builds on slice B (`docs/plans/2026-11-14-domain-records-slice-b.md`) and slice C (`docs/plans/2026-11-14-domain-access-slice-c.md`, the `SLAUDE_ACCESS_SOURCE` seam).

## Scope

In: additive nullable columns, dual write, resolver, periodic fill, in-row parity, gate for the follow-up.
Out (explicit): any unique index or primary key change; any lookup that returns the new answer; changing job token claims or what a node receives; REST `SessionView` and console additions; boundary merge or delete; non-Slack services; Grid shared channels; DDL on `audit_events`; creating boundaries anywhere except first sight.

## What exists (verified in the tree at rc.21)

- `boundaries (id, kind, service, workspace, value, state, ...)`, `UNIQUE (service, workspace, value)`, `CHECK (service <> 'slack' OR workspace <> '')` (0038). `ensureBoundary` is insert-or-ignore then re-read (`src/db/domain.ts:246`). No code path deletes a boundary; the only delete is `_wipeForTests` (`src/db/domain.ts:381`), which runs with sqlite `PRAGMA foreign_keys = ON` (`src/db/drivers/sqlite.ts:873`).
- First sight (`src/domain/first-sight.ts`): called from `Sessions.createForThread` (`src/db/sessions.ts:80`) and the audit writer. Per-process LRU, queue, `BURST_LIMIT`, drops under caps, `CHANNEL_RE = /^[CGD][A-Z0-9]+$/` (line 47), skipped on a node. Creation is asynchronous and can be dropped, so a session row can exist with no boundary.
- `ensureSession` does find then create (`src/agent/manager.ts:1007-1035`), with a retry-on-unique-violation read. A brand new thread is therefore always "not found" first, then inserted.
- Reconciler (`src/domain/reconcile.ts`): keyset pages of 500, one transaction per page, `RECONCILE_LOCK_KEY` advisory lock plus in-process queue, dry run, capped report lists, one summary audit event. It runs only at gateway boot (`reconcileAtBoot`, `reconcile.ts:891`, called with `void` at `src/gateway/core/gateway.ts:1349`, runs to completion under the lock, no time budget) and from `slaude domain reconcile`.
- Gateway background timers exist (`gateway.ts:731`, `:999`); the periodic fill hangs off that loop.
- Migrations run one file per transaction under one advisory lock (`src/db/migrate.ts:107-117`); the gateway does not start until they finish. `CREATE INDEX CONCURRENTLY` cannot appear in a numbered migration. Latest is 0041, so the next free numbers start at 0042. Sqlite is mirrored by hand in `src/db/drivers/sqlite.ts`, with `tests/db/schema-drift.test.ts`.
- `src/cli/migrate-sqlite.ts:20` states there are no FKs between the copied tables and does not copy `boundaries`.

## Map: every table and path keyed by a Slack thread or channel string

T = (slack_team_id, slack_channel_id, slack_thread_ts); CT = (channel_id, thread_ts); C = channel only.

| Table (migration) | Key today | Team | Class | Change in D |
|---|---|---|---|---|
| sessions (0002, 0013) | UNIQUE (slack_team_id, slack_channel_id, slack_thread_ts, persona_id), idx_sessions_thread | slack_team_id, nullable | T | `boundary_id`, `locator` |
| one_on_one_locks (0003) | PK (channel_id, thread_ts) | team_id (0040), nullable | CT | pair |
| mention_only_threads (0003) | PK (channel_id, thread_ts) | none | CT, team-less | pair, team passed by caller |
| ignores (0003) | thread targets: (channel_id, thread_ts); user rows untouched | none | CT, team-less | pair (thread targets only) |
| cron_jobs (0003, 0013) | slack_* pair and channel_id/thread_ts pair | slack_team_id | T | pair, rule below |
| commitments (0028) | PK (agent_id, source, slug); channel_id, thread_ts | team_id, nullable | CT | pair |
| env_bindings (0018) | PK (channel_id, thread_ts) | none | CT, team-less | pair |
| proactive_posts (0029, 0030) | id; idx (channel_id, message_ts) | team_id, nullable | C | `boundary_id` only |
| channel_wake_state (0037) | PK (agent_id, channel_id) | none | C, team-less | `boundary_id` only |
| audit_events (0032, 0039) | channel_id, thread_ts | none | CT, team-less | NO DDL (D1) |
| remote_targets (0012) | PK (channel_id, thread_ts) | owner's team_id | CT | NONE: legacy table, `setTarget` has no caller outside `src/db/remote.ts`, rows are only read and deleted by `convertLegacy` (`environments.ts:228`) |
| proposals, thread_activity, pending_gates, background_runs | no channel or thread key, or reach a thread through `session_id` | | | none; they inherit the session's boundary |

The team-less tables are mention_only_threads, ignores, env_bindings, channel_wake_state and audit_events. They are safe today only because Slack channel ids are unique per workspace; the follow-up index move removes that dependency.

Cron rule (settled here): the cron session key is `cron:<id>` for channel-target jobs, else `slackThreadTs`, else `cron:<id>` (`src/gateway/slack/cron-scheduler.ts:129`). So for a cron job: channel is `slack_channel_id`, team is `slack_team_id`, `locator = target === 'channel' ? 'cron:' + id : (slack_thread_ts ?? 'cron:' + id)`. The legacy `channel_id`/`thread_ts` pair is the delivery target, not the session key, and is not used for the locator. The sqlite backfill that copies `channel_id`/`thread_ts` into `slack_*` (`drivers/sqlite.ts:718-722`) runs before our columns exist and is left alone; the fill derives from the resulting `slack_*` values.

Code that carries the strings (all unchanged, each considered):
- Gateway lookups: `findByThread` at `gateway.ts:1218, 1235, 2886, 4007, 4018, 4327, 4382, 4683, 4693`; `findAnyByThread` at `2210, 4632, 4653, 4704`; `setEngagedForThread` at `4625`; `teamForThread` (team-less, `sessions.ts:36`) at `gateway.ts:1232` and `src/background/scheduler.ts:577`; the manager's find then create above.
- Writers that already hold the team and must pass it to the team-less tables: `MentionOnly.set` at `gateway.ts:2144` and `:3090`, `Ignores.create` at `:3331`. `teamForThread` is never used by a writer.
- Synthetic locators, stored verbatim and opaque: `channel:<channelId>` (`src/gateway/core/channel-session.ts:8`), `wake:...`, `cron:...` (`src/gateway/panel/enumerator.ts:181`), the DM key, and the archived key `channel-archived:<channelId>:<ms>` below.
- Job payloads and tokens: `JobClaims` carries `team`, `channel`, `thread` (`src/gateway/api/auth.ts`); nodes read `slack_*` via `SessionView` (`src/node/client.ts:50`). Unchanged. Panel and console (`gateway/api/sessions.ts`, `panel/enumerator.ts`, `panel/api.ts`, `SessionsPage.tsx`) unchanged.
- Row-shape copies to update: `SessionRow` in `src/db/schema.ts`, the sqlite `sessions` rebuild at `src/db/drivers/sqlite.ts` ~667-691 (must not drop the new columns), `src/cli/migrate-sqlite.ts` (copy the new columns as plain text, `boundary_id` copied as is, meaningless until the target has run the fill).

## Defects the plan must handle

1. Key rewrite: `archiveChannelSession` rewrites `slack_thread_ts` to `channel-archived:<channel>:<ms>` (`src/db/sessions.ts:238`, called at `gateway.ts:2891` for `/new`) so the next message starts a fresh `channel:<id>` session. If `locator` is not rewritten in the same statement, the archived row and the new row share `(boundary_id, locator, persona_id)` and the follow-up index would fail. Fix: one statement, `UPDATE sessions SET slack_thread_ts = ?, locator = CASE WHEN boundary_id IS NULL THEN locator ELSE ? END, updated_at = ? WHERE id = ?` (a NULL-boundary row gets its locator from the fill, which reads the already-rewritten `slack_thread_ts`).
2. `deleteWakeSessionsBefore` (`sessions.ts:248`) deletes whole rows selected by `slack_thread_ts LIKE 'wake:%'`; it needs no column change but gets a test that rows carrying the pair delete cleanly and nothing resurrects them.
3. Writers that replace columns on conflict: `env_bindings` `bind` overwrites every column on conflict (`environments.ts:181-189`); `convertLegacy` inserts bindings (`environments.ts:228-250`); `channel_wake_state` `noteFinished` and `noteSettled` upsert (`channel-wake-state.ts:90, 103`); `commitments.upsertOpen` uses `COALESCE` on `team_id`. Every one gets the pair on insert and `COALESCE(excluded.x, table.x)` on conflict, so a later write never nulls a filled pair.

## Schema (one migration file per table, DDL only, nullable)

Nine files, each its own transaction, each starting with `SET LOCAL lock_timeout = '2s';` so it fails fast instead of queuing writers behind a long transaction. Never ten ACCESS EXCLUSIVE locks in one transaction. Order, sessions LAST:

```
0042_boundary_one_on_one_locks.sql    ALTER TABLE one_on_one_locks ADD COLUMN IF NOT EXISTS boundary_id TEXT; ... locator TEXT;
0043_boundary_mention_only.sql        mention_only_threads (pair)
0044_boundary_ignores.sql             ignores (pair)
0045_boundary_cron_jobs.sql           cron_jobs (pair)
0046_boundary_commitments.sql         commitments (pair)
0047_boundary_env_bindings.sql        env_bindings (pair)
0048_boundary_proactive_posts.sql     proactive_posts (boundary_id only)
0049_boundary_channel_wake.sql         channel_wake_state (boundary_id only)
0050_boundary_sessions.sql            sessions (pair)
```

- Soft reference: `boundary_id TEXT NULL`, NO foreign key, no default, no `NOT NULL`, no index. Reasons: `migrate-sqlite.ts` copies tables without FKs and without `boundaries`; `_wipeForTests` deletes boundaries with sqlite `foreign_keys` ON; there is no boundary delete path to protect. A future boundary delete path must check references itself (listed in the follow-up).
- No index in this slice: parity is in-row (no lookup by the new columns), and the fill reads by primary key and `boundary_id IS NULL` pages.
- `audit_events`: untouched. Adding a column takes an ACCESS EXCLUSIVE lock on a table every action writes.
- Failure behaviour (runbook): a lock timeout aborts that one migration, earlier files stay applied, and the gateway does not start (migrations run before serve) until a retry at next boot succeeds. The deploy takes `sudo /usr/local/sbin/slaude-backup` first and watches the migration log lines (`migration 004N_... applied`). The old binary keeps running on the old image until the new one boots, so a failed rollout is a failed start, not a half-migrated serve. Rolling replicas of rc.21 ignore the extra columns (`SELECT *`, explicit-column INSERTs) and write NULL.
- Sqlite: `PRAGMA table_info` then `ALTER TABLE ... ADD COLUMN` per table in `drivers/sqlite.ts`, placed AFTER the persona_id rebuild. The drift test compares columns only; both dialects carry the same names.

## Resolver (`src/domain/boundary-for.ts`)

```
boundaryForCached(team, channel): { id: string } | null | undefined   // sync; undefined = unknown, null = known absent
boundaryFor(team, channel): Promise<{ id: string } | null>            // async read, fills the cache, never inserts
primeBoundary(team, channel, id): void                                // first sight calls this after ensureBoundary
locatorOf(threadTs): string | null                                    // verbatim; '' becomes null
```

- Hot path: writers call only `boundaryForCached`. A cache miss writes NULL and starts a deduped, non-awaited `boundaryFor` to warm the cache. No await of the resolver ever precedes a legacy insert.
- Cache: positive entries `RECHECK_MS`, negative `NEG_TTL_MS`, cap `LRU_CAP`, single flight per key, key `slack|<team>|<channel>`. First sight primes it after it creates or finds a boundary.
- `team` null or `''` returns null without a query (never workspace `''`). `workspaceForChannel` (single live workspace, else null) is allowed only for the fill, never for a hot writer.
- `SLAUDE_BOUNDARY_TIMEOUT_MS` (300) on the async read; error or timeout counts `slaude_boundary_resolve_total{outcome}` and leaves the key unknown. On a node it returns undefined and never touches a database.
- Kill switch `SLAUDE_BOUNDARY_WRITE` (default on). Off: writers store NULL pairs, the fill and the check do nothing.

## Data flow

Write: the writer computes (team, channel, thread), reads `boundaryForCached`, and includes `boundary_id` and `locator = locatorOf(thread)` in the same INSERT (NULL when unknown). After first sight ensures a boundary it primes the cache and runs a bounded late fill, `UPDATE <t> SET boundary_id = ?, locator = <thread col> WHERE <channel col> = ? AND boundary_id IS NULL` (team-equal or team NULL where the table has a team), for the tables whose key starts with the channel or team and channel: sessions (`idx_sessions_thread`), one_on_one_locks, mention_only_threads, env_bindings (primary key prefix) and ignores (`idx_ignores_thread`). The other tables (cron_jobs, commitments, proactive_posts, channel_wake_state) have no usable channel index and are covered by the periodic fill within one tick.

Periodic fill (the guarantee): see next section.

Read (rc.23): see Parity.

## Fill: boot reconciler stage plus periodic

- One page function per table in `src/domain/boundary-backfill.ts`, used by (a) reconciler stage 7 (boot and `slaude domain reconcile [--dry-run]`) and (b) the periodic fill. Keyset pages of 500 by primary key, `WHERE boundary_id IS NULL`, one transaction per page, a compare-and-set that never overwrites: `UPDATE ... SET boundary_id = b.id, locator = <thread> FROM boundaries b WHERE b.service = 'slack' AND b.workspace = <team> AND b.value = <channel> AND t.pk IN (page) AND t.boundary_id IS NULL`.
- Periodic fill: every 10 minutes (`SLAUDE_BOUNDARY_FILL_INTERVAL_MS`, 0 disables) in the gateway background loop, at most `SLAUDE_BOUNDARY_FILL_MAX_ROWS` (default 2000) rows per tick across tables, oldest first, under a Postgres advisory lock `BOUNDARY_FILL_LOCK_KEY` (distinct from `RECONCILE_LOCK_KEY`; sqlite uses the in-process queue). A tick that hits the cap continues next tick. Never runs on a node. It never scans or touches `audit_events`.
- Team per row: the row's own team column, else the tenant's single workspace (Postgres from `slack_apps`, sqlite from `liveTeamIds`), else skipped and counted. Never workspace `''`.
- Row classes in the report (`boundaryColumns[table]`): `filled`, `existing`, `ineligible` (channel id fails first sight's `CHANNEL_RE`, so no boundary will ever exist; excluded from the gate), `ambiguous`, `no_workspace`, `no_boundary`, and `handed_to_first_sight`.
- Missing boundary (D6, report only): the fill never creates a boundary. For an eligible `(team, channel)` with no boundary it calls `observeSlackChannel`, so creation goes through first sight's caps and bursts, and counts `handed_to_first_sight`; the next tick fills it. Channel ids present in more than one workspace are listed as `shared_candidates` (informational).
- The existing boot reconcile has no time budget and runs to completion under its lock (`reconcile.ts:891`); this plan does not add one. If a table is large, the periodic fill's per-tick cap is the throttle, and the boot stage fills at most one capped batch per table before leaving the rest to the periodic fill.

## Parity (rc.23, in-row, no second query)

After the legacy row is fetched (`findByThread`, `findAnyByThread`) and after `createForThread` returns, `checkRow(site, row)` compares the row it already holds with `boundaryForCached(team, channel)`. No sampling, no shadow query, no new index, never awaited for anything, never changes the returned row. Outcomes in `slaude_boundary_check_total{site,outcome}`:
- `match`: row has `boundary_id` equal to the cached boundary and `locator = slack_thread_ts`.
- `both_none`: row NULL and the cache says the boundary is known absent.
- `null_row`: row NULL but the cache has a boundary (the fill has not reached it).
- `unresolved`: row NULL and the cache is unknown.
- `mismatch`: row has a `boundary_id` different from the cached boundary. Gate-failing.
- `locator_mismatch`: row has the pair but `locator` differs from `slack_thread_ts`. Gate-failing.
- `unverified`: row has a pair, cache unknown (counted, not failing).
Because the check runs on a row that exists, a brand-new thread (find returns none, then create) produces no outcome from the find, and the post-create check sees the row it just wrote.

`slaude domain boundary-check [--table T] [--json]` (`src/domain/boundary-parity.ts`, read-only, paged by primary key, no `audit_events`): per table, rows with NULL `boundary_id` older than 10 minutes with an eligible channel and a resolvable team (the gate number); rows whose `boundary_id` differs from the boundary resolved from the row's own team and channel; rows whose `locator` differs from the thread column; duplicate `(boundary_id, locator, persona_id)` groups in sessions and duplicate `(boundary_id, locator)` in the CT tables.

## Failure modes

| Failure | Behaviour |
|---|---|
| boundaries read slow or down | cache miss writes NULL, no turn waits; async warm times out, counted |
| first sight drops or queues a channel | NULL until the periodic fill hands it back to first sight and fills it |
| two replicas create the same thread | legacy unique key decides; the pair rides in the same INSERT |
| fill races a live writer or a second runner | compare-and-set on `boundary_id IS NULL`; the loser changes zero rows; advisory lock on Postgres |
| `/new` archives a channel session | pair rewritten in the same statement (defect 1) |
| migration lock timeout | that file aborts, earlier files stay, gateway start fails and retries at next boot; backup and log watch in the runbook |
| rc.21 replica writes NULL during a rolling deploy | the periodic fill fixes it within a tick |
| two workspaces, team-less row | `ambiguous`, listed, never guessed |

## Node role

No database on a node. `boundaryForCached`, the check, the fill and the stage return immediately on `env.role() === "node"`; `tests/db/node-role-guard.test.ts` gains the new modules. Job tokens, `JobClaims` and `SessionView` are not changed; the node never writes the columns.

## Merge and alias interaction

Boundaries have no merge and no alias table (spec: not needed until two services share a room), so `boundary_id` is stable and the resolver is a plain lookup with no alias hop. A guard test asserts that the only code that sets `boundary_id` on an existing row is the compare-and-set fill and the archive statement's locator rewrite. A future boundary merge needs `boundary_aliases` and a transactional repoint, the shape of the user merge ledger. User merges do not touch these columns.

## Multi-workspace future

The resolver always takes the team explicitly. While one workspace is live, `workspaceForChannel` lets the fill place team-less rows; with a second workspace it returns null, so team-less tables are filled only where the writer passed the team (mention-only and ignore writers at `gateway.ts:2144, 3090, 3331` now do) or the channel id exists in exactly one workspace's boundaries; the rest are `ambiguous`. Grid shared channels and `W` ids are out of scope and reported as `shared_candidates`.

## Rollback

1. `SLAUDE_BOUNDARY_WRITE=off` and `SLAUDE_BOUNDARY_FILL_INTERVAL_MS=0`: effective immediately, writers store NULL, nothing reads the columns.
2. Downgrade the binary to rc.21: safe, columns are nullable, unread and unconstrained. No down migrations.
3. Undo a bad fill: `UPDATE <table> SET boundary_id = NULL, locator = NULL` per table (field note). Legacy columns are never written by the new code except the archive statement, which writes the same `slack_thread_ts` it always did.

## Test strategy

Tests first in each task, sqlite and Postgres (`bun test`, `bun run test:pg`).
- Schema: each file applies fresh and on a database holding rc.21 rows; columns NULL; unique and primary key definitions identical to before; no FK on the new columns; no `audit_events` column; a held lock on one table fails only that file within 2 s and the earlier files stay applied; drift test; sqlite rebuild keeps the columns; `migrate-sqlite` carries them.
- Resolver: cache hit, miss then warm, negative TTL, single flight (50 concurrent, one query), timeout, node role, null team and `''` never queried, never inserts, first sight primes.
- Dual write: each writer stores the pair when cached and NULL otherwise, legacy columns byte identical to before (golden rows), an `await` is never issued for the resolver before the insert (spy), conflict paths (`bind`, `convertLegacy`, `noteFinished`, `noteSettled`, `upsertOpen`) keep a filled pair and fill a NULL one.
- Archive: create a channel session, archive it, create the new channel session: no duplicate `(boundary_id, locator, persona_id)` (checked with the boundary-check query), archived row carries the archived locator; archive a NULL-boundary row then fill: locator equals the archived key. `deleteWakeSessionsBefore` removes pair-carrying wake rows.
- Fill: idempotent (second run fills 0), paged (page size 2 over 7 rows), per-tick cap respected, dry run writes nothing, `ineligible` excluded from the gate number, `ambiguous` and `no_workspace` never written, never workspace `''`, `handed_to_first_sight` leads to a fill next tick, two concurrent runners and a live writer end consistent, a non-NULL value is never overwritten, `audit_events` never queried (client spy), cron rule (channel target, thread target, NULL thread).
- Parity: every outcome, a wrong `boundary_id` counts `mismatch` and the legacy row is returned unchanged, a new thread produces no false `new_only`-like outcome (find then create path), check never awaits a query (spy), a golden fixture of 200 threads (DM, channel root, thread, channel session key, wake and cron locators, two personas on one thread, NULL team) agrees between `boundary-check` and the row-level outcomes.
- Concurrency: 20 parallel `createForThread` for one thread yields one row with the pair set once; burst of new channels under first sight caps ends with every eligible row filled after ticks.

## Tasks

### rc.22: schema, dual write, fill (no new reads)

1. Config and metrics: `src/config/env.ts` (`env.boundary.{write,timeoutMs,fillIntervalMs,fillMaxRows}`), `src/metrics.ts` (`boundaryResolveTotal`, `boundaryFillTotal`, `boundaryCheckTotal`), `tests/config/boundary-env.test.ts`. Run `bun test tests/config`.
2. Migrations 0042 to 0050 (one per table, sessions last) and sqlite mirror: `src/db/migrations/00{42..50}_*.sql`, `src/db/drivers/sqlite.ts`, `src/db/schema.ts`, `src/cli/migrate-sqlite.ts`, `tests/db/boundary-columns-schema.test.ts` (including the lock-timeout test). Run `bun test tests/db/boundary-columns-schema.test.ts tests/db/schema-drift.test.ts && bun run test:pg tests/db/boundary-columns-schema.test.ts`.
3. Cache-only resolver and first-sight priming: `src/domain/boundary-for.ts`, `src/domain/first-sight.ts` (prime after ensure), `tests/domain/boundary-for.test.ts`, `tests/db/node-role-guard.test.ts`.
4. Sessions dual write, late fill, and the archive fix: `src/db/sessions.ts` (`createForThread`, `archiveChannelSession`, late fill), `tests/db/sessions-boundary.test.ts`, extend `tests/domain/first-sight-isolation.test.ts`. Tests first: archive and `/new` duplicate test, 20-way race.
5. Dual write for the other tables (cached resolver, `COALESCE` on conflict): `src/db/{one-on-one,mention-only,ignores,cron-jobs,commitments,environments,proactive-posts,channel-wake-state}.ts` including `bind`, `convertLegacy`, `noteFinished`, `noteSettled`; callers `gateway.ts:2144, 3090, 3331` pass the team; helper `src/db/boundary-columns.ts` (`pairFor`); a grep-guard test that fails when a listed writer inserts a thread key without the pair; tests under `tests/db/`. Run `bun test tests/db`.
6. Fill: `src/domain/boundary-backfill.ts`, reconciler stage 7 in `src/domain/reconcile.ts` (report type and formatter), `src/cli/domain.ts` (`--json`), periodic tick in the gateway background loop (`src/gateway/core/gateway.ts`), `tests/domain/boundary-backfill.test.ts`. Run `bun test tests/domain` then `bun run test:pg tests/domain/boundary-backfill.test.ts`.
7. rc.22 release prep: `docs/site/_content/releases/v0.46.0-rc.22.md`, field note `docs/site/_content/field-notes/2026-11-15-domain-sessions-boundary-columns.md` and its CLAUDE.md Findings Log line, spec slice D status line, runbook for the migration lock timeout. Run the CLAUDE.md leak scan, `bun run typecheck && bun test && bun run test:pg`.

### rc.23: in-row check and the gate command

8. In-row check: `src/domain/boundary-check.ts`, wired at `findByThread`, `findAnyByThread` results and after `createForThread` in `src/db/sessions.ts`, `tests/domain/boundary-check.test.ts`, `tests/domain/boundary-golden-parity.test.ts`.
9. `slaude domain boundary-check`: `src/domain/boundary-parity.ts`, `src/cli/domain.ts`, `tests/domain/boundary-parity.test.ts`.
10. rc.23 release prep: release notes, gate checklist file for the follow-up, field note update, Grafana alert text for any non-zero `mismatch` or `locator_mismatch`.

## Rollout

- rc.22: backup before the version bump, deploy through vps-hardening, watch the nine `migration 00NN applied` lines, `verify` 0 FAIL, run `slaude domain reconcile --dry-run` then the real run, read `boundaryColumns`. Soak 3 days. Gate to rc.23: `boundary-check` NULL-older-than-10-minutes (eligible channel, resolvable team) is 0 on every table, `ineligible` and `ambiguous` listed and understood, resolver `error`/`timeout` under 0.1 percent, no change in turn latency p95.
- rc.23: soak 14 days counted from the day the periodic fill first reaches zero on every table (D7), covering cron, wake and a deploy. Gate to the follow-up: `mismatch`, `locator_mismatch` 0 for the whole window; duplicate groups 0; the NULL gate 0; no `ambiguous`.

## Live smoke test (real Slack, sam agent; rc.22, then rc.23)

Placeholders in notes only (T0EXAMPLE, C0EXAMPLE, D0EXAMPLE, U0EXAMPLE). After each step run `slaude domain boundary-check --json` and `SELECT id, slack_channel_id, slack_thread_ts, boundary_id, locator FROM sessions ORDER BY updated_at DESC LIMIT 5`.
1. DM: session carries a `boundary_id` (kind dm) within one fill tick, locator equals the DM thread key.
2. Channel root: mention the agent in a never-seen channel; the row exists at once, the pair appears after first sight (late fill), a second message reuses the session.
3. Thread: reply in that thread; same session, same pair; second persona gets its own row.
4. 1on1: `/1on1` in the thread; the lock row carries the pair; end it; a node-run turn works unchanged.
5. Cron: create a thread cron job and a channel-target job; locators are the thread key and `cron:<id>`; one fire each.
6. Proactive wake: enable proactive for the channel, wait one wake; `channel_wake_state.boundary_id` and a post's `proactive_posts.boundary_id` set; channel session locator is `channel:<id>`.
7. Start over (`/new`) in a channel session: the old row's locator is the archived key, the new session has `channel:<id>`; `boundary-check` shows zero duplicate groups.
8. New-thread burst: post 30 fresh threads in a never-seen channel within a minute; after one fill tick no NULL rows older than 10 minutes, no `mismatch`.
9. Migration lock-timeout drill on a restored backup copy (never production): hold an ACCESS EXCLUSIVE lock on `sessions` in a psql session, start the new binary, expect a clean start failure naming `0050` within about 2 s with 0042 to 0049 applied, release the lock, restart and see it apply. Resolver outage drill (rc.23): `SLAUDE_BOUNDARY_TIMEOUT_MS=1` on one replica; messages still land in the right sessions.

## Follow-up (NOT in this slice): move the unique indexes

Separate plan after the rc.23 gate. Shape: pre-flight (zero duplicates, zero eligible NULLs past the cutoff); the migrator learns a no-transaction migration or a boot task builds `CREATE UNIQUE INDEX CONCURRENTLY` under the advisory lock; the new index sits beside the old one for one full release; readers switch to `(boundary_id, locator)` behind `SLAUDE_BOUNDARY_SOURCE=boundary` with legacy as reverse shadow (the slice C flip pattern); a later release drops the old index; `audit_events` gets its boundary through the read side or a lock-budgeted nullable column; any future boundary delete path must refuse while rows reference it. Gate to start: every Rollout threshold met, owner decisions on D1 and D7, a restore rehearsal on a scratch copy.

## Decisions

Settled by review (defaults applied above): D2 soft reference, no FK; D4 two RCs, rc.23 only the in-row check and the CLI; D5 moot (no sampling); D6 report only, creation stays in first sight; D7 14 days counted from the fill first reaching zero; D8 verbatim locator plus the archive fix; D9 `lock_timeout` 2 s per table file; D10 cut (no REST or console fields).

Still for the owner (recommended default first):
- D1 audit_events: no DDL in D (readers resolve through `session_id` or the resolver); alternative is a lock-budgeted nullable column in the follow-up.
- D3 Column name `locator`; alternative `thread_locator`.
- D11 Periodic fill cadence and size: every 10 minutes, 2000 rows per tick, oldest first; alternative every 5 minutes or a smaller cap on very large tables.
- D12 Gate definition: NULL `boundary_id` older than 10 minutes with an eligible channel and a resolvable team is 0, with `ineligible` rows excluded; alternative a small tolerated percentage.
- D13 Cut `remote_targets` from D entirely (no writer exists). Default yes; alternative add the pair in case `/remote` returns.

## Risks

- A wrong `boundary_id` is harmless now but fatal after the index move: compare-and-set only, in-row `mismatch` and `locator_mismatch`, `boundary-check` recomputation, no repoint path except the archive locator rewrite.
- Hidden writers (a raw insert outside the listed modules, tools, sim): the grep-guard test and per-table NULL counts in `boundary-check`.
- Late fill and the periodic fill on a busy channel or a large table: bounded by one channel's NULL rows and the per-tick cap; failures are retried next tick.
- First sight caps mean new channels are boundaried late; the fill hands them back and the gate is time-bounded.
- Nine migration files mean nine retry points; sessions is last so a stuck lock there leaves the small tables done.
- Sqlite single process relies on the in-process queue instead of an advisory lock; tested with the `unlocked` path plus concurrent writers.
- Scope creep into the index move: nothing here changes a unique index; `SLAUDE_BOUNDARY_SOURCE=boundary` is refused.
- Public repo: tests and notes use T0EXAMPLE, C0EXAMPLE, D0EXAMPLE, U0EXAMPLE and example.com only; run the CLAUDE.md leak scan on every staged diff.
