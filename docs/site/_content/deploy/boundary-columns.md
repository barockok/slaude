---
title: Boundary columns rollout
description: Deploy checks for the nullable boundary_id and locator columns (rc.22): the migration runbook, what to watch while the columns fill, rollback, and a live smoke test.
---

# Boundary columns rollout

From rc.22, sessions and thread-scoped rows record a `boundary_id` and a
`locator` next to the Slack columns. Nothing reads them yet and no key
changes, so a deploy changes no behaviour. This page is the runbook. The design
is in the [domain sessions field note](../field-notes/2026-11-15-domain-sessions.md).

## Before the deploy

1. Take a backup: `sudo /usr/local/sbin/slaude-backup`.
2. Deploy as usual. The gateway runs the migrations before it serves.

## Watch the migration

Nine log lines, in order:

```
migration 0042_boundary_one_on_one_locks applied
...
migration 0050_boundary_sessions applied
```

Each file is its own transaction and begins with `SET LOCAL lock_timeout = '2s'`.

| What you see | What it means | What to do |
|---|---|---|
| All nine lines, gateway serving | Done. | Continue below. |
| A start failure naming one of `0042` to `0050` and `lock timeout` | A long query held a lock on that table. That file rolled back, earlier files stay applied, the gateway did not start. | Find and end the long transaction, then restart. The retry applies the rest. The previous release keeps serving until the new one boots. |
| An rc.21 replica still running | It ignores the columns and writes NULL. | Nothing; the periodic fill completes those rows within a tick. |

## After the deploy

1. `slaude verify` shows 0 FAIL.
2. Run `slaude domain reconcile --dry-run`, then `slaude domain reconcile`, and
   read the `boundaryColumns` block of the report (use `--json` for numbers).
   Per table: `filled` (written), `complete` (already carried a boundary), and
   what was left:
   - `ineligible`: a channel id that first sight never records; no boundary
     will exist, not a problem.
   - `ambiguous` / `no_workspace`: a row with no team in a tenant with several
     (or no) workspaces. Never written, never guessed.
   - `no_boundary` and `handed to first sight`: the channel had no boundary
     yet; first sight creates it and the next fill completes the rows.
   - `no_locator`: a row with no thread key.
3. The periodic fill runs every 10 minutes (`SLAUDE_BOUNDARY_FILL_INTERVAL_MS`)
   and at most `SLAUDE_BOUNDARY_FILL_MAX_ROWS` rows a tick. Metrics:
   `slaude_boundary_fill_total{table,outcome}` and
   `slaude_boundary_resolve_total{outcome}`. Watch that resolver `error` and
   `timeout` stay far below 0.1 percent of lookups and that turn latency does
   not move.
4. Soak for three days. Rows with a NULL `boundary_id` older than 10 minutes,
   on an eligible channel with a resolvable workspace, should reach zero.

## Rollback

1. `SLAUDE_BOUNDARY_WRITE=off` and `SLAUDE_BOUNDARY_FILL_INTERVAL_MS=0`:
   effective at once, writers store NULL and nothing fills.
2. Downgrading to rc.21 is safe: the columns are nullable, unread and
   unconstrained. There are no down migrations.
3. To undo a bad fill: `UPDATE <table> SET boundary_id = NULL, locator = NULL`
   per table. The Slack columns are never written by the new code except by the
   `/new` archive statement, which writes the same thread key it always did.

## Live smoke test (real Slack)

Use placeholders in notes (`T0EXAMPLE`, `C0EXAMPLE`, `D0EXAMPLE`,
`U0EXAMPLE`). After each step, read the newest sessions:

```sql
SELECT id, slack_channel_id, slack_thread_ts, boundary_id, locator
FROM sessions ORDER BY updated_at DESC LIMIT 5;
```

1. **DM.** Message the agent: the session gets a `boundary_id` (kind `dm`)
   within one fill tick, and the locator equals the DM thread key.
2. **Channel root.** Mention the agent in a never-seen channel: the row exists
   at once, the pair appears after first sight, a second message reuses the
   session.
3. **Thread.** Reply in that thread: same session, same pair. A second persona
   gets its own row.
4. **One-on-one.** `/1on1` in the thread: the lock row carries the pair; end it;
   a node-run turn works unchanged.
5. **Cron.** Create a thread cron job and a channel-target job: locators are the
   thread key and `cron:<id>`; one fire each.
6. **Proactive wake.** Enable proactive for a channel and wait one wake:
   `channel_wake_state.boundary_id` and a post's `proactive_posts.boundary_id`
   are set, and the channel session's locator is `channel:<id>`.
7. **Start over.** `/new` in a channel session: the old row's locator is the
   `channel-archived:...` key, the new session has `channel:<id>`.
8. **Burst.** Post 30 fresh threads in a never-seen channel within a minute;
   after one fill tick no row stays NULL.
9. **Lock-timeout drill, on a restored copy only, never production.** Hold an
   `ACCESS EXCLUSIVE` lock on `sessions` in a psql session, start the new
   binary, and expect a clean start failure naming `0050` within about two
   seconds with `0042` to `0049` applied. Release the lock, restart, and see it
   apply.
