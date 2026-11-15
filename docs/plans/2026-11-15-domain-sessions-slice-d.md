# Domain sessions, slice D: boundary and locator beside the Slack columns

> For Claude: use superpowers:executing-plans, task by task. One task per commit. A release boundary is a hard stop: soak, check the gate, then continue.

Goal: every session and every thread-scoped or channel-scoped row also records WHICH boundary it belongs to (`boundary_id`, a reference to the slice B `boundaries` record) and WHICH conversation inside it (`locator`, the opaque thread key), written next to the existing Slack columns. The legacy columns stay authoritative and every unique index stays exactly as it is. This slice only proves, with data, that `(boundary_id, locator)` identifies the same rows as `(slack_team_id, slack_channel_id, slack_thread_ts)`. Moving the unique indexes is a LATER release with its own gate (see Follow-up). Nothing in this slice changes which session a message reaches.

Architecture: one resolver `boundaryFor(team, channel)` (`src/domain/boundary-for.ts`, cached, read-only, never creates a record); dual write at every writer; a new reconciler stage fills old rows in pages under the existing advisory lock; a shadow helper computes the lookup the second way after the legacy answer and counts disagreement, like the slice C access seam (`src/access/decide.ts`). Two release candidates so the release that first writes the columns is not the release that first reads them: rc.22 writes and backfills, rc.23 adds shadow reads.

Spec: `docs/superpowers/specs/2026-11-12-domain-model-and-references.md` (slice D: "sessions and thread-scoped tables gain a boundary column read through a resolver, and the unique indexes move after one release"; "A thread is not a boundary. It is an opaque conversation locator inside one. A session identity becomes (agent, boundary, locator)"). Builds on slice B (`docs/plans/2026-11-14-domain-records-slice-b.md`: `src/db/domain.ts` `ensureBoundary`, `src/domain/first-sight.ts`, `src/domain/reconcile.ts`) and slice C (`docs/plans/2026-11-14-domain-access-slice-c.md`: the `SLAUDE_ACCESS_SOURCE` seam and its metrics).

## Scope

In: additive nullable columns and dual write; resolver; backfill; shadow parity; read-only console fields; the gate for the follow-up.
Out (explicit): any unique index or primary key change; any lookup that returns the new answer; changing job token claims or what a node receives as authority; boundary merge; non-Slack services; Grid shared channels; DDL on `audit_events`.

## What exists (verified in the tree at rc.21)

- `boundaries (id, kind, display_name, service, workspace, value, state, ...)`, `UNIQUE (service, workspace, value)`, `CHECK (service <> 'slack' OR workspace <> '')` (migration 0038). `ensureBoundary` is insert-or-ignore then re-read, never downgrades state (`src/db/domain.ts:246`).
- First sight (`src/domain/first-sight.ts`): `observeSlackChannel` is called from `Sessions.createForThread` (`src/db/sessions.ts:80`) and from the audit writer via `observeFromAudit`. It uses a per-process LRU (`LRU_CAP` 5000, `RECHECK_MS` 10 min, `NEG_TTL_MS` 30 s), a bounded queue and burst summaries, is skipped when `env.role() === "node"`, and never throws into the caller. Creation is asynchronous: a session row can be written BEFORE its boundary exists.
- `workspaceForAudit`/`liveOnly` pick the workspace when a row carries no team: the session's team, else the single live workspace, else nothing.
- Reconciler (`src/domain/reconcile.ts`): keyset pages of `PAGE_SIZE` 500, one transaction per page, `RECONCILE_LOCK_KEY` Postgres advisory lock plus an in-process queue, dry run, a report with `skipped` reasons (`ambiguous`, `no_workspace`), a capped mismatch list, one summary audit event, never writes workspace `''`. Stage 5 already places `subject_ref`, `subject_user_id` and `one_on_one_locks.team_id` the same way.
- Shadow seam pattern: `env.access.source()` read per call, `m.accessShadowTotal` counter, `logOncePerMinute`, a timeout, fall back to legacy.
- Migrations run one file per transaction under an advisory lock (`src/db/migrate.ts`), so `CREATE INDEX CONCURRENTLY` cannot appear in a numbered migration. Next free number: 0042. Sqlite is mirrored by hand in `src/db/drivers/sqlite.ts` (PRAGMA table_info then ALTER), with a drift test (`tests/db/schema-drift.test.ts`).

## Map: every table and path keyed by a Slack thread or channel string

Key forms: T = (slack_team_id, slack_channel_id, slack_thread_ts); CT = (channel_id, thread_ts) with no team; C = channel only.

| Table (migration) | Key today | Team column | Class | Change in D |
|---|---|---|---|---|
| sessions (0002, 0013) | UNIQUE (slack_team_id, slack_channel_id, slack_thread_ts, persona_id); idx_sessions_thread | slack_team_id, nullable | T | `boundary_id`, `locator`; readers: findByThread, findAnyByThread, teamForThread, setEngagedForThread, archiveChannelSession, listSessions, updatedSince, latestAppOf |
| one_on_one_locks (0003) | PK (channel_id, thread_ts) | team_id (0040), nullable, backfilled | CT | `boundary_id`, `locator` |
| mention_only_threads (0003) | PK (channel_id, thread_ts) | none | CT | `boundary_id`, `locator` |
| ignores (0003) | target_type 'thread': (channel_id, thread_ts); 'user' rows untouched | none | CT | `boundary_id`, `locator` (thread targets only) |
| cron_jobs (0003, 0013) | two pairs: slack_* (session key) and channel_id/thread_ts (delivery target) | slack_team_id | T and CT | `boundary_id`, `locator` derived from the slack_* pair when present, else channel_id/thread_ts (task 5 confirms which pair is the thread the job belongs to and tests both) |
| commitments (0028) | PK (agent_id, source, slug); channel_id, thread_ts NOT NULL | team_id, nullable | CT | `boundary_id`, `locator` |
| env_bindings (0018) | PK (channel_id, thread_ts) | none | CT | `boundary_id`, `locator` |
| remote_targets (0012) | PK (channel_id, thread_ts); team_id is the OWNER's team | team_id | CT | `boundary_id`, `locator` |
| proactive_posts (0029, 0030) | id; idx (channel_id, message_ts) | team_id, nullable | C | `boundary_id` only (message_ts is a message, not a locator) |
| channel_wake_state (0037) | PK (agent_id, channel_id) | none | C | `boundary_id` only |
| audit_events (0032, 0039) | channel_id, thread_ts, no team | none | CT | NO DDL (see Decisions D1); read side resolves through session_id |
| proposals (0021, 0026) | agent, scope; slack_team_id only | slack_team_id | none | none (no channel or thread) |
| thread_activity (0023), pending_gates (0004), background_runs (0019), skill_usage | session_id or agent scope | none | derived | none: they reach a thread through `sessions.id`, so they inherit the session's boundary |
| node_plugins, heartbeat_*, mcp_credentials, accounts | not conversation keyed | | | none |

Non-table code that carries the strings (all stay as they are; each is listed so a reviewer can see it was considered):
- Slack adapter and gateway (`src/gateway/core/gateway.ts`): `Sessions.findByThread` at 1218, 1235, 2886, 4007, 4018, 4327, 4382, 4683, 4693; `findAnyByThread` at 2210, 4632, 4653, 4704; `setEngagedForThread` at 4625; `teamForThread` at 1232 and `src/background/scheduler.ts:577`; the session manager (`src/agent/manager.ts:1007-1035`) calls `findByThread` then `createForThread`. Engagement restore and mention-only recording use `findAnyByThread`.
- Synthetic locators: channel sessions use `channel:<channelId>` (`src/gateway/core/channel-session.ts`), wake runs use `wake:...`, cron runs `cron:...` (`src/gateway/panel/enumerator.ts:181`), DMs use a synthetic thread key. The locator is stored verbatim and treated as opaque; nothing parses it.
- Job payloads and tokens: `JobClaims` (`src/gateway/api/auth.ts`) carries `team`, `channel`, `thread`; the node reads them through `decodeClaims`/`lockFromClaims` (`src/node/session-lock.ts`) and gets `SessionView` with `slack_*` fields over REST (`src/node/client.ts`). Unchanged in this slice (see Node role).
- Panel and console: `src/gateway/api/sessions.ts` (row to API), `src/gateway/panel/enumerator.ts`, `src/gateway/panel/api.ts` (1on1 end, channel labels), `src/web/console/pages/SessionsPage.tsx`, `session/SessionDetailPage.tsx`, `src/web/console/dev/{fixtures,stub}.ts`. Read-only additions only.
- Other copies of the row shape: `src/db/schema.ts` `SessionRow`, `src/cli/migrate-sqlite.ts` (sqlite to Postgres table copy), the sqlite `sessions` rebuild at `src/db/drivers/sqlite.ts` ~667-691.

Findings that shape the plan:
1. Five tables key by (channel_id, thread_ts) with no team. They are safe today only because Slack channel ids are unique per workspace. With two workspaces the team must come from the writer's context; the resolver never guesses it on the hot path (see Multi-workspace).
2. Sessions are created BEFORE first sight creates the boundary, so the dual write will often see "no boundary yet". The plan closes that gap with a bounded late fill after first sight, plus the reconciler, and never creates the boundary from the writer.
3. `audit_events` is the large, append-only table. Its `channel_id`, `thread_ts` have no team and rows are written on every action. It gets no DDL in this slice.

## Schema (migration 0042, DDL only, nullable, no defaults, no indexes)

```
SET LOCAL lock_timeout = '5s';   -- fail fast and retry at next boot rather than queue behind a long transaction

ALTER TABLE sessions             ADD COLUMN IF NOT EXISTS boundary_id TEXT REFERENCES boundaries (id);
ALTER TABLE sessions             ADD COLUMN IF NOT EXISTS locator     TEXT;
-- same pair on: one_on_one_locks, mention_only_threads, ignores, cron_jobs,
--               commitments, env_bindings, remote_targets
ALTER TABLE proactive_posts      ADD COLUMN IF NOT EXISTS boundary_id TEXT REFERENCES boundaries (id);
ALTER TABLE channel_wake_state   ADD COLUMN IF NOT EXISTS boundary_id TEXT REFERENCES boundaries (id);
```

- No column default (a default rewrites nothing on Postgres 11+, but "NULL means not yet resolved" must stay unambiguous). No `NOT NULL`. No index on the new columns in this slice: the shadow query uses them only on sampled lookups, and an index built in a numbered migration would lock. The follow-up builds its indexes concurrently (see Follow-up).
- `audit_events`: untouched. `ALTER ... ADD COLUMN` takes an ACCESS EXCLUSIVE lock even when it is metadata only, and on a table written by every action it would queue writers behind any long reader.
- Foreign key to `boundaries(id)`: all values start NULL so validation is trivial, and it makes a console "delete boundary" fail while sessions still point at it (a wanted guard; task 2 tests it). Test wipe helpers (`_wipeForTests` in `src/db/domain.ts` and the table modules) must delete referencing rows first.
- Sqlite mirror: `PRAGMA table_info` then `ALTER TABLE ... ADD COLUMN ... REFERENCES boundaries (id)` for each table, placed AFTER the persona_id table rebuild (`drivers/sqlite.ts` ~667) so a rebuild cannot drop them. `tests/db/schema-drift.test.ts` compares columns only; nothing to allowlist because both dialects carry the same names.
- Mixed-version safety: rc.21 replicas run `SELECT *` and explicit-column INSERTs; extra nullable columns are ignored by them, and rows they write get NULL, which the reconciler fills.

## Resolver API (`src/domain/boundary-for.ts`)

```
boundaryFor(team: string | null, channel: string, o?: { tx? }): Promise<{ id: string; state: State; kind: string } | null>
boundaryForCached(team: string | null, channel: string): { id: string } | null | undefined   // sync, cache only
locatorOf(threadTs: string | null | undefined): string | null                                // verbatim, '' becomes null
workspaceForChannel(channel: string): string | null    // single live workspace, else null; never ''
```

Rules:
- Read only. A miss returns null and the caller writes NULL. Creation stays in first sight (`observeSlackChannel`), which `createForThread` already calls. The resolver never inserts, so it cannot cause the burst or the race that first sight already bounds.
- Cache: positive entries kept `RECHECK_MS` (boundaries have no merge and ids never change; the TTL only covers console deletion), negative entries `NEG_TTL_MS`, cap `LRU_CAP`. Concurrent misses for one key share one in-flight promise (single flight). Cache key `slack|<team>|<channel>`.
- `team` null or `''` returns null without a query (Slack boundaries require a workspace, and the lookup `workspace = ''` must never run). When a writer has no team, it may pass `workspaceForChannel`, which answers only while exactly one workspace is live.
- Timeout `SLAUDE_BOUNDARY_TIMEOUT_MS` (default 300). A timeout or error returns null, counts `slaude_boundary_resolve_total{outcome=error|timeout}`, logs once per minute, and never throws. The caller's write proceeds with NULL columns.
- On `env.role() === "node"` it returns null and never touches a database.
- Metric: `slaude_boundary_resolve_total{outcome=hit|miss|negative|error|timeout|no_team}`.

## Data flow

Write (rc.22): message arrives, the existing path computes (team, channel, thread). The writer calls `boundaryFor(team, channel)`; hit: it inserts the legacy columns plus `boundary_id` and `locator = locatorOf(thread)`; miss: legacy columns only. After first sight creates the boundary it runs `lateFill(team, channel, boundaryId)`: `UPDATE sessions SET boundary_id = ?, locator = slack_thread_ts WHERE slack_team_id = ? AND slack_channel_id = ? AND boundary_id IS NULL` (bounded to one channel by the existing `idx_sessions_thread` prefix; a failure is logged and left to the reconciler).

Read (rc.23): the legacy query runs and its row is returned. Then, sampled and not awaited, the shadow helper resolves the boundary and runs the same lookup by `(boundary_id, locator, persona_id)`, compares row ids, and counts the outcome. The caller never waits on it and never sees its row.

Backfill: the reconciler stage fills old rows page by page (see Backfill).

## Dual write sites (rc.22)

| Writer | File | Team source | Notes |
|---|---|---|---|
| createForThread | `src/db/sessions.ts` | `thread.team_id` | resolver, then INSERT with extra columns; first-sight call unchanged; schedule lateFill after first sight |
| one-on-one lock | `src/db/one-on-one.ts` `lock` | `teamId` input, else team of the session, else live single | `setOpen`, `setLocked` update only legacy fields |
| mention-only set | `src/db/mention-only.ts` | session team, else live single | |
| ignore create (thread) | `src/db/ignores.ts` | same | skip for user targets |
| cron create | `src/db/cron-jobs.ts` | `slack_team_id` | CAS paths (`claimDue`) untouched |
| commitment upsert | `src/db/commitments.ts` | `team_id` | `COALESCE(excluded.boundary_id, commitments.boundary_id)` like `team_id` |
| env bind | `src/db/environments.ts` `bind` | session team | conflict path keeps existing columns |
| remote target | `src/db/remote.ts` `setTarget` | thread's team, not the owner's `team_id` unless equal | |
| proactive post | `src/db/proactive-posts.ts` `recordPost` | `team_id` | |
| channel wake | `src/db/channel-wake-state.ts` `noteStart` insert path | session team or live single | updates never rewrite it |

Rule for every site: a failure to resolve is never an error; the legacy write is the only thing that can fail the call. Dual write is behind `SLAUDE_BOUNDARY_WRITE` (default on; `off` skips the resolver and writes NULLs, the kill switch).

## Backfill (reconciler stage 7, `src/domain/reconcile.ts`)

- Runs inside `reconcile()` after stage 3 has created session-channel boundaries, under the same advisory lock and queue, in `slaude domain reconcile [--dry-run]` and at gateway boot (never blocking readiness; the boot call keeps its existing time budget and resumes on the next run).
- Per table, keyset pages of `PAGE_SIZE` by primary key (`sessions.id`; composite key tables by `(channel_id, thread_ts)`), `WHERE boundary_id IS NULL`, one transaction per page. The write is a compare-and-set: `UPDATE ... SET boundary_id = b.id, locator = <thread> FROM boundaries b WHERE b.service = 'slack' AND b.workspace = <team> AND b.value = <channel> AND t.pk IN (page) AND t.boundary_id IS NULL`. It never overwrites a non-NULL value, so it is idempotent and safe to race with a live writer or a second runner. A fully filled table costs one read per page and no transaction.
- Team per row: the row's own team column; else the tenant's single workspace (Postgres from that tenant's `slack_apps`, sqlite from `liveTeamIds`); else skipped and counted. A Slack boundary is never written or looked up with workspace `''`.
- Rows whose boundary does not exist: for channel ids found only in these tables, the stage creates the boundary through `ensureBoundary` as `observed` (kind `dm` for `D` ids), like stage 3; counted `boundary_created`.
- Report (`ReconcileReport.boundaryColumns[table]`): `filled`, `existing`, `skipped: { ambiguous, no_workspace, no_boundary, no_channel }`, plus a capped list (`MISMATCH_LIST_CAP`) of ambiguous rows and of channel ids that exist in more than one workspace (`shared_candidates`, informational for the follow-up). `formatReconcileReport` prints one line per table. One summary audit event only when something was filled; no per-row events.
- Huge tables: only `sessions` (and, in time, `commitments`/`proactive_posts`) can be large. Page size stays 500, an optional `SLAUDE_BACKFILL_PAGE_PAUSE_MS` (default 0) sleeps between pages, and the boot run stops after its budget and logs the remainder. `audit_events` is NOT backfilled and NOT scanned by this stage.

## Shadow parity (rc.23)

`SLAUDE_BOUNDARY_SOURCE`: `legacy` (no resolver call) or `shadow` (default). `boundary` is refused at config parse in this slice: unknown values read as `legacy`, `boundary` logs a warning and also reads as `legacy`. `SLAUDE_BOUNDARY_SHADOW_SAMPLE` (default 0.25, soak at 1) and `SLAUDE_BOUNDARY_SHADOW_MAX_INFLIGHT` (default 16, excess is dropped and counted).

`src/domain/boundary-shadow.ts`: `shadowLookup({ site, legacy, boundary, locator, run })`, called after the legacy row exists. Outcomes in `slaude_boundary_shadow_total{site,outcome}`:
- `match`: same row id (or both none).
- `mismatch`: both found a row, different ids. Gate-failing.
- `new_only`: new path found a row, legacy found none. Gate-failing (the cross-wire sign).
- `legacy_only_null`: legacy found a row whose `boundary_id` is NULL (expected until backfill completes; has its own threshold).
- `legacy_only`: legacy found a row with a non-NULL boundary, new path found none. Gate-failing.
- `no_boundary`, `no_team`, `new_error`, `dropped`: informational.
Logging uses `logOncePerMinute` per (site, outcome) and only internal ids (boundary id, row id), never message text.

Shadow sites, one id per call site: `sessions.findByThread`, `sessions.findAnyByThread`, `sessions.teamForThread` (compares the team of the boundary the channel resolves to), `one_on_one.find`, `mention_only.find`, `environments.findBinding`, `remote.findTarget`, `ignores.findActiveForThread`, `cron.countForeignThreadJobs`, `commitments.get`.

## Failure modes

| Failure | Behaviour |
|---|---|
| boundaries table slow or down | resolver times out, returns null, writer stores NULL, reader returns legacy; no turn blocked; counters rise |
| first sight queue full or dropped | boundary absent, NULL columns, reconciler fills later |
| writer race (two replicas, same thread) | legacy unique key decides; columns are written in the same INSERT, so they cannot disagree with the row they sit on |
| reconciler races a live writer | CAS `boundary_id IS NULL`, loser changes zero rows |
| two runners | advisory lock plus queue; `unlocked` test path proves the CAS alone is safe |
| migration lock timeout | migration aborts and retries at next boot (5 s lock_timeout); the old code runs meanwhile; page an operator if it repeats |
| rolling deploy, rc.21 replica writes NULL | filled by next reconcile |
| boundary deleted in console | FK refuses while referenced; if no row references it, nothing to repair |
| row team NULL, two workspaces | skipped as `ambiguous`, listed, never guessed |
| workspace removed | boundary remains (never deleted by sync); rows keep pointing at it |

## Node role (no database on nodes)

`boundaryFor`, the shadow helper and the reconciler stage return immediately on `env.role() === "node"` (same guard as first sight) and `tests/db/node-role-guard.test.ts` gains the new modules. Job tokens (`JobClaims`) and the queue payload are NOT changed: they keep `team`, `channel`, `thread`, and are not authority for boundary identity. The REST `SessionView` served to nodes may carry optional `boundary_id` and `locator` (absent from an older gateway, ignored by an older node), so a node never needs a lookup; the node never writes the columns.

## Merge and alias interaction

Boundaries have no merge today and no alias table (spec: boundary merge is not needed until two services share a room). `boundary_id` is therefore stable and `boundaryFor` is a plain lookup with no alias hop. If boundary merge ships later it needs `boundary_aliases` and a repoint of these columns in one transaction, exactly the shape of `resolveUserId` plus the user merge ledger; a test in this slice asserts that no code path updates `boundary_id` except the CAS fill (guarding against a later silent repoint). User merges (slice C) do not touch these columns: they hold boundaries, not users.

## Multi-workspace future

- The key is `(service, workspace, value)` already; the resolver takes the team explicitly. With one connected workspace the `workspaceForChannel` fallback covers writers that lack a team; the moment a second workspace connects it returns null, so tables without a team column stop being filled on the hot path and the reconciler marks them `ambiguous` unless the row's channel id exists in exactly one workspace's boundaries (a unique-value lookup, not a guess).
- Today's CT tables are only safe while channel ids are unique across workspaces. The follow-up index move is what removes that dependency; this slice only adds the evidence (`shared_candidates`).
- Grid shared channels (one C id in several workspaces) and `W` ids are out of scope and reported, never merged.

## Rollback

1. Flip `SLAUDE_BOUNDARY_SOURCE=legacy` (reads) and `SLAUDE_BOUNDARY_WRITE=off` (writes): no deploy needed, effective on the next call.
2. Downgrade the binary to rc.21: safe, the columns are nullable and unread. No down migration is run; the columns stay.
3. Undo a bad backfill: `UPDATE <table> SET boundary_id = NULL, locator = NULL` per table (documented in the field note; the CAS refills it later). Legacy columns were never touched, so no data is lost.

## Test strategy

Tests first in each task. Postgres and sqlite both (`bun test`, `bun run test:pg`).
- Schema: migration applies fresh and on an rc.21 database with rows; new columns NULL; unique indexes unchanged (assert index definitions are identical to before); FK refuses deleting a referenced boundary; drift test green; sqlite persona rebuild keeps the columns; sqlite to Postgres copy (`migrate-sqlite`) carries them.
- Resolver: hit, miss, negative TTL, TTL expiry, single flight (50 concurrent calls, one query), timeout returns null, workspace `''` and null team never queried, node role never opens the database, never inserts.
- Dual write: each writer stores the pair when the boundary exists, NULLs when it does not, and the legacy columns are byte identical to the pre-change output (golden row snapshots per table). Failure of the resolver does not fail the write.
- Late fill: session created before its boundary, then first sight, then lateFill sets exactly that channel's sessions; a different channel is untouched; no overwrite.
- Backfill: idempotent (second run `filled: 0`), paged (page size 2 over 7 rows), dry run writes nothing, `ambiguous` and `no_workspace` reported and never written, never workspace `''`, two concurrent runners and a concurrent live writer produce one consistent state, DM `D` ids make kind `dm`, a row with a stale non-NULL value is not overwritten.
- Golden parity: a fixture of 200 threads (DM, channel root, thread, channel session key, wake and cron synthetic locators, two personas on one thread, a thread with NULL team) loaded through the real writers; for each, `findByThread` and the boundary lookup return the same session id; run again after backfill of a copy with columns cleared.
- Shadow: injected mismatch (a row with the wrong `boundary_id`) is counted `mismatch` and the legacy row is still returned; `new_only` and `legacy_only` likewise; the caller never awaits the shadow (a hanging shadow does not delay the return); inflight cap drops and counts; sample 0 never queries.
- Concurrency: 20 parallel `createForThread` for one thread (legacy unique key yields one row, columns set once); resolver plus first sight for a new channel under burst.
- Large tables: a test that `audit_events` has no new column and that the reconciler stage issues no statement mentioning `audit_events` (spy on the db client); a 50k-row `sessions` fixture backfills in pages with each page transaction under a row cap.
- Drift: a repo test fails if any writer file in the dual write table inserts a thread key without the pair (grep guard), so a new writer cannot forget it.

## Tasks

### rc.22: schema, resolver, dual write, backfill (no new reads)

1. Config and metrics.
   - Files: `src/config/env.ts` (`env.boundary.{write,source,shadowSample,shadowMaxInflight,timeoutMs}`), `src/metrics.ts` (`boundaryResolveTotal`, `boundaryShadowTotal`, `boundaryFillTotal`), `tests/config/boundary-env.test.ts`.
   - Tests first: defaults, unknown source reads `legacy`, `boundary` reads `legacy` with a warning, sample clamped to 0..1.
   - Run: `bun test tests/config/boundary-env.test.ts`.
2. Migration 0042 and sqlite mirror.
   - Files: `src/db/migrations/0042_boundary_columns.sql`, `src/db/drivers/sqlite.ts`, `src/db/schema.ts` (`SessionRow` gains optional `boundary_id`, `locator`), `src/cli/migrate-sqlite.ts`, `tests/db/boundary-columns-schema.test.ts`.
   - Tests first: fresh and upgrade, index definitions unchanged, FK refusal, no `audit_events` column, sqlite rebuild, sqlite to Postgres copy.
   - Run: `bun test tests/db/boundary-columns-schema.test.ts tests/db/schema-drift.test.ts && bun run test:pg tests/db/boundary-columns-schema.test.ts`.
3. Resolver.
   - Files: `src/domain/boundary-for.ts`, `tests/domain/boundary-for.test.ts`; add to `tests/db/node-role-guard.test.ts`.
   - Tests first: the Resolver rules above.
   - Run: `bun test tests/domain/boundary-for.test.ts tests/db/node-role-guard.test.ts`.
4. Sessions dual write and late fill.
   - Files: `src/db/sessions.ts` (`createForThread`, new `lateFillSessions`), `src/domain/first-sight.ts` (call `lateFill` after a boundary is ensured, inside its existing never-throws guard), `tests/db/sessions-boundary.test.ts`, extend `tests/domain/first-sight-isolation.test.ts`.
   - Tests first: golden row, NULL when absent, 20-way create race, late fill scope, resolver failure does not fail the insert.
   - Run: `bun test tests/db/sessions-boundary.test.ts tests/db/sessions-channel.test.ts tests/domain`.
5. Dual write for the thread tables.
   - Files: `src/db/{one-on-one,mention-only,ignores,cron-jobs,commitments,environments,remote}.ts`, `src/db/boundary-columns.ts` (one helper `pairFor(team, channel, thread)` returning `{ boundary_id, locator }`), matching tests under `tests/db/`.
   - First read `src/db/cron-jobs.ts` and `src/gateway/slack/mcp-tools.ts` cron creation to settle which pair names the thread; record the answer in the test names.
   - Tests first: per table golden row and NULL case; `bind`/`setTarget` conflict path keeps the first values.
   - Run: `bun test tests/db`.
6. Dual write for channel tables.
   - Files: `src/db/proactive-posts.ts`, `src/db/channel-wake-state.ts`, tests.
   - Run: `bun test tests/db/channel-wake-state.test.ts tests/db/boundary-channel-tables.test.ts`.
7. Reconciler stage 7.
   - Files: `src/domain/reconcile.ts` (stage, report type, formatter), `src/domain/boundary-backfill.ts` (per-table page functions, so `reconcile.ts` does not grow past reading size), `src/cli/domain.ts` (`--json` includes the new section), `tests/domain/boundary-backfill.test.ts`.
   - Tests first: the Backfill list above, including the `audit_events` spy.
   - Run: `bun test tests/domain/boundary-backfill.test.ts tests/domain` then `bun run test:pg tests/domain/boundary-backfill.test.ts`.
8. Read-only exposure.
   - Files: `src/gateway/api/sessions.ts` (optional `boundary_id`, `locator`), `src/node/client.ts` (optional fields on `SessionView`), console Sessions list and detail show the boundary link when set, Boundaries page shows a session count by `boundary_id`; `src/web/console/dev/{fixtures,stub}.ts`.
   - Tests first: API shape with and without the fields; an old node ignores them.
   - Run: `bun test tests/gateway tests/node && bun run typecheck`.
9. rc.22 release prep.
   - Files: `docs/site/_content/releases/v0.46.0-rc.22.md`, field note `docs/site/_content/field-notes/2026-11-15-domain-sessions-boundary-columns.md` and its CLAUDE.md Findings Log line, spec slice D status line.
   - Run: pre-commit hygiene from CLAUDE.md, `bun run typecheck && bun test`, `bun run test:pg`.

### rc.23: shadow reads (legacy still authoritative)

10. Shadow helper.
    - Files: `src/domain/boundary-shadow.ts`, `tests/domain/boundary-shadow.test.ts`.
    - Tests first: every outcome, never awaited, inflight cap, sample 0 and 1, log rate limit, errors swallowed.
11. Wire sessions lookups.
    - Files: `src/db/sessions.ts` (`findByThread`, `findAnyByThread`, `teamForThread`), `tests/db/sessions-shadow.test.ts`, `tests/domain/boundary-golden-parity.test.ts`.
    - Tests first: golden parity fixture, injected `mismatch` returns the legacy row.
12. Wire the thread-table lookups.
    - Files: the finders of the tables in the Shadow sites list, tests.
13. Parity check for the gate.
    - Files: `src/domain/boundary-parity.ts`, `src/cli/domain.ts` (`slaude domain boundary-check [--table T] [--json]`), tests.
    - Read-only SQL per table: rows with NULL `boundary_id` (count and oldest `updated_at`), rows whose `boundary_id` does not equal the boundary resolved from the row's own team and channel, duplicate `(boundary_id, locator, persona_id)` groups in sessions and duplicate `(boundary_id, locator)` in the CT tables (must be 0 for the follow-up). Paged by primary key, no `audit_events`.
    - Run: `bun test tests/domain/boundary-parity.test.ts`.
14. rc.23 release prep, gate checklist file for the follow-up, field note update, soak notes.

## Rollout

- rc.22: take `sudo /usr/local/sbin/slaude-backup` before the version bump, deploy through vps-hardening, `verify` 0 FAIL. Check the migration applied, run `slaude domain reconcile --dry-run` and read the `boundaryColumns` section, then the real run; expect `ambiguous` and `no_workspace` to be 0 on a single-workspace deployment. Soak 3 days with `SLAUDE_BOUNDARY_WRITE=on`. Gate to rc.23: `slaude domain boundary-check` shows NULL `boundary_id` only on rows younger than 10 minutes, zero `skipped.no_boundary`, resolver `error`/`timeout` under 0.1 percent of calls, no growth in turn latency p95.
- rc.23: first run with `SLAUDE_BOUNDARY_SHADOW_SAMPLE=1` for the smoke test, then the default 0.25. Soak at least 14 days (two weekly cycles, including cron, wake and a deploy). Gate to the follow-up: `mismatch`, `new_only`, `legacy_only` all 0 for the whole window; `legacy_only_null` under 0.01 percent and 0 for rows older than 10 minutes; `boundary-check` duplicate groups 0; no `ambiguous` rows; Grafana alert on any non-zero `mismatch`/`new_only`/`legacy_only` (panel text in the release note).

## Live smoke test (real Slack, sam agent, rc.22 then rc.23 with sample 1)

Use placeholders in notes only: workspace T0EXAMPLE, channel C0EXAMPLE, DM D0EXAMPLE, user U0EXAMPLE. After each step run `slaude domain boundary-check --json` and the SQL `SELECT id, slack_channel_id, slack_thread_ts, boundary_id, locator FROM sessions ORDER BY updated_at DESC LIMIT 5`.
1. DM: send a DM to the agent; session row has a `boundary_id` of kind `dm` (after late fill if the first message created it), locator equals the DM thread key.
2. Channel root: mention the agent in a channel never seen before; the row exists immediately, `boundary_id` appears within seconds (late fill), a second message in the same thread reuses the session.
3. Thread: reply in the thread of step 2; same session id, same `(boundary_id, locator)`; reply as a second persona if configured, one session per persona.
4. 1on1: `/1on1` in the thread; `one_on_one_locks` row carries the pair; end it; node-run turn (job token unchanged) works; console session detail shows the boundary link.
5. Cron: create a thread cron job; row carries the pair; wait one fire (or trigger it); the run posts and the cron session locator is the `cron:` form.
6. Proactive wake: enable proactive for the channel, wait one wake; `channel_wake_state.boundary_id` is set, `proactive_posts.boundary_id` set on a post, the channel-session locator is `channel:<id>`.
7. Failure drill (rc.23): stop only the resolver by setting `SLAUDE_BOUNDARY_TIMEOUT_MS=1` on one replica; messages still land in the right sessions; `timeout` counter rises; restore.
8. Shadow outcomes: `slaude_boundary_shadow_total` shows only `match` (and `legacy_only_null` for pre-backfill rows, then none).

## Follow-up (NOT in this slice): move the unique indexes

A separate plan after the rc.23 gate passes. Shape only: (a) a pre-flight that proves zero duplicate `(boundary_id, locator, persona_id)` in sessions and zero NULL `boundary_id` on rows older than the cutoff; (b) the migrator learns a no-transaction migration so `CREATE UNIQUE INDEX CONCURRENTLY` can run, or the index is built by a boot task under the advisory lock; (c) new unique index added next to the old one for one full release; (d) readers switch to `(boundary_id, locator)` behind `SLAUDE_BOUNDARY_SOURCE=boundary` with legacy as the reverse shadow (the slice C flip pattern); (e) only a further release drops the old index and makes columns NOT NULL where the data allows; (f) `audit_events` gets its boundary through the read side or a later nullable column added in a window with a lock budget. Gate for starting it: every threshold in Rollout met, an owner decision on D1 and D7, and a restore rehearsal on a scratch copy.

## Decisions needed from the owner (recommended default first)

- D1 audit_events: no DDL in D; readers resolve `(session_id -> sessions.boundary_id)` or `(team, channel_id)` through the resolver. Alternative: a nullable `boundary_id` added in the follow-up inside a lock-budgeted window. Default: no DDL.
- D2 Foreign key on the new columns: yes, nullable FK (a console delete of a referenced boundary is refused). Alternative: soft reference with no constraint.
- D3 Column name `locator` (matches the spec wording). Alternative `thread_locator`.
- D4 Two release candidates (writes, then shadow reads). Alternative: one rc with `SLAUDE_BOUNDARY_SOURCE=legacy` first. Default: two.
- D5 Shadow sample default 0.25 (1 during smoke). Alternative: 1.0 always.
- D6 Reconciler may create `observed` boundaries for channel ids found only in non-session tables. Default yes. Alternative: report only.
- D7 Soak length before the index move: 14 days and two RCs. Alternative: 7 days.
- D8 Locator form: store the existing thread key verbatim and opaque (including `channel:`, `wake:`, `cron:`). Alternative: normalise synthetic keys to a typed prefix now (not recommended: it changes the key before the index move).
- D9 `lock_timeout` 5 s in 0042 and accept a boot retry. Alternative: no timeout (risk of queueing writers behind a long transaction).
- D10 Expose `boundary_id` and `locator` on the node REST `SessionView` (optional). Default yes. Alternative: console only.

## Risks

- Cross-wire: a wrong `boundary_id` on a row would be harmless now (unread) but fatal after the flip. Mitigation: CAS-only fill, the `boundary-check` recomputation, `mismatch`/`new_only` gates, golden parity, and no repoint code path.
- Hidden writers: a raw `INSERT INTO sessions` or `cron_jobs` somewhere other than the listed modules (gateway tools, `src/gateway/slack/mcp-tools.ts`, sim, tests). Mitigation: the grep guard test and `boundary-check` NULL counts by table.
- Late fill cost on a very busy channel: bounded by one channel's NULL rows and the existing index prefix; a failure falls back to the reconciler.
- Cache staleness after a console boundary delete: positive TTL 10 minutes; FK refuses deletes that matter.
- First sight burst caps (`BURST_LIMIT`) mean boundaries for a flood of new channels arrive late: NULLs rise for a while; the gate is time-bounded (rows older than 10 minutes), not absolute.
- Sqlite single process: the in-process queue replaces the advisory lock; tested with `unlocked` plus concurrent writers.
- Shadow load: at most 1 extra indexed query per sampled lookup, not awaited, capped in flight.
- Scope creep into the index move: this plan changes no unique index and refuses `SLAUDE_BOUNDARY_SOURCE=boundary`.
- Public repo: tests and notes use T0EXAMPLE, C0EXAMPLE, D0EXAMPLE, U0EXAMPLE and example.com only; run the CLAUDE.md leak scan on the staged diff before every commit.
