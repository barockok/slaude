---
title: "What a horizontally scaled gateway may not do"
date: 2026-09-17
---

Gateways and nodes both scale horizontally, so every gateway replica has to be
interchangeable. Three things that are fine for a single process break that, and
a gateway now refuses to boot on any of them, listing every violation at once.

## Socket Mode ingress

Socket Mode delivers Slack events over a websocket, and its consumer is
single-leader. With two gateway replicas, both consume events and both respond.
The deploy docs already said this for the single-process deployment, which is
why it uses the `Recreate` strategy.

A gateway must take Slack over the Events API webhook (`SLAUDE_SLACK_MODE=http`).
Socket Mode is the default when the mode is unset, so a gateway that never chose
a mode is refused too.

## An embedded database for slaude's data

An embedded database lives in one process's files. Replicas on per-pod storage
each get a private copy that silently diverges; replicas on the shared volume
are two writers on one single-writer database.

The quiet version of this: `SLAUDE_DB=pg` without `SLAUDE_PG_URL` selects
in-process PGLite. PGLite reports the pg dialect, so the existing check — which
tested the dialect, not the driver — let it through. The guard checks the driver.

## The brain on its default engine

This one was found by running the topology rather than reading it. Both gateway
replicas crash-looped on a local cluster, killed for exceeding their memory
limit while the brain opened its embedded PGLite database.

The memory was the smaller problem. The brain's home is on the shared volume,
PGLite is single-writer, and at boot the brain deletes any lock it finds —
correctly for its original contract of one process per brain home, where a
leftover lock can only mean a crash. With two replicas, each one deletes the
other's live lock and both write. The production scale manifests shipped two
replicas with the brain on by default.

The brain already had a Postgres engine, written for exactly this, and its
lock-clearing is already limited to PGLite. The fix is configuration: the brain
runs on the Postgres server, in its own `slaude_brain` database. Its own
database rather than slaude's because gbrain creates about seventy tables, some
with names like `config`, `files` and `oauth_tokens`; none collide today, but a
shared namespace would make every future migration a candidate for one.

## Details worth keeping

- The check runs from environment alone, before anything is opened, because
  opening PGLite on the shared volume is itself the harm.
- A brain in remote mode lives in a separate brain-server, so the gateway never
  opens a brain database and the engine check does not apply. The first version
  of the guard missed this and would have refused a correct deployment.
- mono and node are exempt. mono is one process; a node holds no database, no
  brain, and takes no Slack traffic.
- A gateway whose brain database is missing exits and restarts in a loop rather
  than serving without the brain. The guard checks configuration, not that the
  database exists. Not fixed.
- Postgres runs init scripts only on a fresh data directory, so an existing
  volume never gets the brain database from the init script. Operators must
  create it themselves.
