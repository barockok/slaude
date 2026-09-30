# Finalising HA: claiming a cron occurrence, and proving a turn survives

**Date:** 2026-09-29

Two gaps were left after the horizontal-scale work. Cron could fire an
occurrence twice across a leadership change, and nothing verified the claim the
deploy docs make — that a turn survives losing the node running it.

## Cron fired twice because the row stayed due

`next_run_at` advanced only when the turn completed, and the re-entry guard was
an in-process `Set`. So for the whole duration of a cron turn the row still
looked due to everyone else. A cron leader dying mid-turn handed the same
occurrence to its successor, which ran it again, and two gateways ticking
together could do the same.

The occurrence is now claimed before anything is dispatched, by a
compare-and-set on the `next_run_at` the tick observed:

```sql
UPDATE cron_jobs SET next_run_at = ?
WHERE id = ? AND next_run_at = ? AND active = 1 AND paused = 0
```

Exactly one claimer can win that, whatever else is running, on SQLite and
Postgres alike. The completion handlers only record the outcome now; they no
longer move the schedule. A dispatch that throws gives the occurrence back,
since nothing ran.

**What this trades.** Before, an occurrence could run twice; now it can be
missed if a gateway dies between claiming and enqueueing. That window is
milliseconds, and once a turn is enqueued the queue owns its redelivery — where
before the exposure lasted the entire turn. Neutralising the claim makes the
two-replica test fail, which is the point of having it.

## Verifying a turn, without Slack and without tokens

`verify-ha.sh` proves the infrastructure survives — replicas, heartbeats, leader
election, the reaper, the shared volume — but it never drove a turn, because
Slack cannot reach a laptop. Its own README listed turn failover as something it
could not prove, on the grounds that it would need a message source and model
credentials.

Neither is true. A turn job can be enqueued through the real queue from inside a
gateway pod, which is exactly the path a Slack message reaches once the gateway
has handled it. And a turn message carries a `suppress` flag: the node runs the
entire lifecycle — claim, session lock, completion marker, ack — while the
prompt hook stops the model. So `verify-turns.sh` needs no model credentials and
costs no provider tokens.

It enqueues a batch, kills the node running it, and asserts every turn still
carries a completion marker with nothing left waiting, active, delayed or
failed. Then it does the deterministic half — a second batch with the node
already gone — and finally fires one cron occurrence and asserts the two
gateways dispatch it once between them.

## What writing the test found

**A lost node blocks its session for up to ten minutes.** The first runs failed:
six of eight turns completed, and the queue looked drained. The missing two were
in BullMQ's **delayed** state, which the drain check had ignored. A killed node
never releases its `lock:session:<id>`, so the re-delivered turn hits
held-by-other and is re-queued in a loop until that lock's TTL expires. The TTL
defaults to ten minutes, renewed every sixty seconds.

Nothing is lost and nothing runs twice — it is a latency bound, not a
correctness one — but it is far longer than BullMQ's own stall recovery, and the
docs implied recovery was prompt. The bound is now documented, and the script
counts delayed jobs as pending so the same thing cannot hide again.

The TTL is also now tunable: `SLAUDE_SESSION_LOCK_TTL_MS` and
`SLAUDE_SESSION_LOCK_EXTEND_MS`, defaults unchanged at ten minutes and one
minute. The TTL must stay at least three times the renewal cadence or the
process refuses to start, since a late renewal would otherwise cost a live node
its session mid-turn. The local cluster runs 45 s and 5 s, where a killed node's
turn was measured taking over in **50 seconds** — the TTL is the bound, exactly
as the mechanism predicts.

**Two probe bugs worth naming**, because both produced convincing false
failures. Creating the probe's sessions with a placeholder model string made the
agent child fail to boot, which reads exactly like a delivery failure. And the
probe's own cleanup deleted session rows while turns were still retrying, so the
turns then failed with "session not found" — a self-inflicted error that masked
the real cause.
