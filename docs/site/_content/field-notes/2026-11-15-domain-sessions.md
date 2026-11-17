---
title: "Domain sessions: a boundary and a locator beside the Slack columns"
date: 2026-11-15
---

# Domain sessions: a boundary and a locator beside the Slack columns

**Date:** 2026-11-15

## Problem

A session is found by `(slack_team_id, slack_channel_id, slack_thread_ts,
persona_id)`, and so are a dozen other rows: one-on-one locks, mention-only
threads, thread ignores, cron jobs, commitments, environment bindings. The
domain model (slice B) gave every channel a boundary record, but nothing that
is keyed by a thread knew which boundary it belonged to. A later release has
to move the unique indexes to `(boundary, locator)`. Moving an index is not
reversible in practice, so first we need proof, from production data, that the
new key names exactly the same rows as the old one. Slice D records the pair
and measures it. It changes no reader and no key: rc.21 was already live on
Postgres, so every step had to be additive and had to be unable to slow or fail
a turn or a session create.

The design and the table map are in
`docs/plans/2026-11-15-domain-sessions-slice-d.md`; the spec is
`docs/superpowers/specs/2026-11-12-domain-model-and-references.md`.

## What changed

### Columns, one migration per table

Migrations `0042` to `0050` add `boundary_id TEXT` (and `locator TEXT` where a
thread key exists) to nine tables. A boundary id is a soft reference: no foreign
key, no default, no `NOT NULL`, no index. There is no code path that deletes a
boundary, `migrate-sqlite` copies tables without `boundaries`, and tests wipe
boundaries with sqlite foreign keys on, so a foreign key would only add a way
to fail. Each file is its own transaction and starts with
`SET LOCAL lock_timeout = '2s'`: an `ALTER TABLE` takes an exclusive lock, and
without a timeout a long-running reader would queue every writer behind the
ALTER. With it a busy table fails that one file within about two seconds, the
gateway does not start, and the next boot retries; the earlier files stay
applied. `sessions` is last so that a stuck lock there leaves the small tables
done. `audit_events` gets nothing: every action writes to it, and an exclusive
lock on it is the one DDL this slice refuses to take.

Test limit worth knowing: PGLite has one connection, so a real held lock cannot
be tested. The suite checks the file shape, that `SET LOCAL` does not leak out of
the transaction, and that a failing last file leaves the earlier ones applied
and a retry finishes. The lock drill against a restored backup is part of the
deploy checks.

### A resolver that cannot make a turn wait

`boundaryForCached(team, channel)` is synchronous and reads a per-process
cache: `undefined` is unknown, `null` is known absent. On a miss it answers
unknown at once and starts one deduped read to warm the next call. Writers call
only this function, so no insert ever waits for the boundaries table, and a slow
or dead table costs a NULL, not latency. The async read has a timeout, single
flight, and never inserts. A missing team, an empty team and a channel id first
sight would never record are answered without a query, and a Slack boundary is
never looked up under workspace `''`. A node has no database and always answers
unknown. First sight primes the cache after its transaction commits, and an
"absent" read that lands after a priming never overwrites it.

### Dual write

Upserts keep the pair that belongs to the row's own key: a commitment re-saved
into another channel, thread or known workspace takes the new pair (NULL if the
writer could not resolve it), never the old one; under the same key a filled
pair is kept and a NULL one is completed. The `migrate-sqlite` command copies
the pair as NULL because it does not copy `boundaries`.


`createForThread` and the other writers store the pair in the same INSERT when
the cache knows the boundary, and NULL otherwise. The locator is only ever set
together with its boundary, and it is the thread column verbatim, including
synthetic keys (`channel:<id>`, `wake:...`, `cron:...`). Cron jobs use the key
the scheduler uses (`cron:<id>` for a channel target, else the thread, else
`cron:<id>`), not the legacy delivery pair. Writers that upsert on conflict
(`bind`, `convertLegacy`, `noteStart`, `noteFinished`, `noteSettled`,
`upsertOpen`, the lock and mention-only upserts) take `COALESCE` so a later
write never nulls a filled pair. The tables that have no team column
(mention-only, thread ignores, environment bindings, channel wake state) take
the team from the caller when it holds one; otherwise the row is written NULL
and the fill places it. A hot writer never guesses a workspace.

### The fill

Three paths complete rows, all compare-and-set on `boundary_id IS NULL` so a
filled row is never overwritten and a second runner or a live writer changes
zero rows:

- the late fill after first sight creates a boundary, for the sessions of that
  channel and workspace, at most 500 rows;
- the reconciler stage (`slaude domain reconcile [--dry-run] [--json]`, report
  field `boundaryColumns`) at boot, one capped batch per table;
- the periodic tick in the gateway background loop (every 10 minutes, at most
  2000 rows across tables, under a Postgres advisory lock distinct from the
  reconciler's; sqlite uses an in-process flag).

Each row is its own statement-level compare-and-set (no page transaction, so no
long lock hold), and the statement computes the locator from the thread column
itself instead of writing a value read in the page scan: a `/new` between the
scan and the write would otherwise have re-created the duplicate the archive fix
prevents. The statement also pins the channel and team the boundary was
resolved from. A second step repairs a stale locator on a filled row (an rc.21
replica or a rollback rewrote only the thread column); it never touches the
boundary. The periodic tick keeps a cursor per table so a capped tick resumes
where it stopped, looks at a bounded number of rows, and runs no COUNT scans.

The fill never creates a boundary. An eligible channel with no boundary is
handed to first sight, which creates it under its own caps and bursts, and the
next run fills the rows. A row with no team column is placed only when the
tenant has one workspace, and such a row is filled only when its boundary
already exists (`team_unknown` otherwise): the workspace it really belongs to
may be one that was connected earlier, and first sight must not fabricate a
boundary for a guess; with several it is `ambiguous`, with none
`no_workspace`, and is never written. Channel ids first sight rejects are
`ineligible` and excluded from the gate. A row with no thread key is
`no_locator`.

### The `/new` archive fix

`archiveChannelSession` frees a channel session's key by rewriting
`slack_thread_ts` to `channel-archived:<channel>:<ms>`. Had `locator` kept the
old `channel:<id>`, the archived row and the new session would share
`(boundary_id, locator, persona_id)` and the future index would refuse the new
one. The statement now rewrites both columns together, and leaves a NULL
locator alone when the boundary is NULL, because the fill derives the locator
from the already rewritten thread column.

### Measuring it: the in-row check and `boundary-check` (rc.23)

The proof is built so it cannot add load. `checkRow` runs on a session row the
legacy lookup already fetched and compares its pair with the process's boundary
cache: no shadow query, no sampling, nothing awaited, never an exception into
the caller, and the legacy row is returned untouched. Seven outcomes land in
`slaude_boundary_check_total{site,outcome}`; only `mismatch` and
`locator_mismatch` fail the gate, while `null_row`, `unresolved` and
`unverified` just say the fill or the cache has not caught up. A new thread has
no row to check at the find, so it counts once, on the row the create wrote.

`slaude domain boundary-check` is the batch version: it pages every table by
primary key and recomputes the boundary from the row's own team and channel, so
it catches what the cache could not (a stale id, a boundary that no longer
exists, a locator that drifted from the thread column, a duplicate
`(boundary_id, locator, persona_id)` group). Its gate number is NULL boundaries
older than ten minutes on an eligible channel with a resolvable workspace;
channels first sight never records, workspaces it cannot decide and young rows
are reported separately so a stuck row is visible without failing the gate.

## Mistakes and decisions worth keeping

- The first thought was to resolve the boundary before the insert and await it.
  That puts the boundaries table on every session create, which is exactly the
  failure this slice must not add. Cache-only plus a repair path is slower to
  converge and cannot hurt a turn.
- The late fill is team-equal only. The plan also allowed rows with a NULL team;
  with two workspaces that could attach the wrong boundary. Those rows wait for
  the periodic fill, which only places a team-less row in a single workspace.
- A wrong `boundary_id` is harmless today and fatal after the index move, so
  there is no repoint path: the only statements that set `boundary_id` on an
  existing row are the compare-and-set fills, and a guard test fails the build if
  another module adds one.
- `remote_targets` is not touched. It is a legacy table with no writer outside
  its own module; `convertLegacy` reads it and derives the pair for the binding
  it creates.
- The fill's per-run cap counts rows written, and pages go in primary key order,
  not oldest first.

## Follow-ups

After the rc.23 soak (14 days counted from the day the periodic fill first
reaches zero on every table, covering cron, wake and a deploy) with zero
mismatches, zero duplicate groups and zero eligible NULL rows, a separate plan
moves the unique indexes. That move is not part of this slice. Not in this
slice: any index or key change, REST or console fields, boundary merge or delete,
non-Slack services.
