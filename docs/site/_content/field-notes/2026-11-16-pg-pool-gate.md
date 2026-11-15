---
title: "Postgres pool gate: a workaround for a wedged Bun.sql pool"
date: 2026-11-16
---

# Postgres pool gate: a workaround for a wedged Bun.sql pool

**Date:** 2026-11-16

## Problem

The real-Postgres CI jobs hung intermittently, one of PG 14, 16 and 17 per run:
a concurrency test in `tests/db/sessions-boundary.test.ts`, then every later
hook timed out until the 20 minute job limit.

## Evidence

A guarded watchdog in `tests/setup.ts` (it prints `pg_stat_activity` and
`pg_locks` when a query waits on a lock for more than a second or a connection
idles in a transaction for more than two) caught it. There were no lock waits at
all. All ten pooled backends were idle, waiting for the client, with the same
statement as their last query and an age that kept growing; one backend sat idle
in a transaction between a Parse and its Sync. The server had finished and the
client never settled the promises, for the rest of the process. The trigger was
more identical statements in flight than pool connections (20 and 30 way bursts).

## Cause (likely, not proven)

Past the pool size, Bun's Postgres adapter does not queue a statement: it
auto-pipelines the excess onto connections that are already busy. A statement that
is still being prepared, pipelined behind another identical one, fits the stuck
Parse without a Sync. The Bun internals were not read to the end and the failure
could not be reproduced without a real server, so this is an inference from the
dump. Production runs the same client, so a message burst could reach the same state.

## What changed

`PoolGate` (`src/db/drivers/pg.ts`) keeps the work handed to Bun.sql at or below the
connection count, so Bun never has anything to pipeline: statements, transactions
and advisory-lock reservations take a permit, the rest wait in order in our
process. `SLAUDE_PG_POOL` is therefore also the concurrency limit, and is at least
2 (an advisory lock holds one connection and its statements need another).
Observability: `slaude_pg_gate_waiting`, a warning and `slaude_pg_gate_slow_total`
when a wait passes 3 seconds, and an optional `SLAUDE_PG_ACQUIRE_TIMEOUT_MS`.

On the diagnostic branch all three real-Postgres jobs passed the first run and a
rerun with the gate.

## Follow-ups (not tried)

- `BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1` in the environment.
- `prepare: false` on the pool (it changes how parameter types are inferred, so it
  can break queries and needs a real-Postgres soak).
- Which Bun runs in production: the `Dockerfile` uses `oven/bun:1.3-debian` (a floating
  1.3.x tag, whatever it resolves to at build time), `install.sh` installs the
  latest Bun when none is present, and CI pins 1.3.11. Pinning the image to the CI
  version would make a regression like this reproducible.
