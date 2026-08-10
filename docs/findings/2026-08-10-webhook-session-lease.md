# Webhook multi-replica: session leases + event forwarding

**Date:** 2026-08-10
**Status:** design (builds on the webhook transport, PR #88)
**Scope:** `SLAUDE_TRANSPORT=webhook` deployments running more than one replica,
opted in via `SLAUDE_CLUSTER=1`. Socket Mode, single-replica webhook, and any
deployment with `SLAUDE_CLUSTER` unset are untouched — no Redis connection is even
opened unless clustering is on.

## Problem

Webhook mode makes slaude horizontally scalable at the HTTP layer, but the runtime
is stateful per thread:

- live sessions are an in-memory map (`AgentManager.#live`) — a thread's SDK Query,
  idle timer, and turn buffers exist on exactly one process;
- SDK `resume` reads the transcript jsonl from local disk;
- session rows live in per-process `bun:sqlite`.

With N replicas behind a plain load balancer, Slack events for one thread land on
a random replica. While a session is live (inside the idle window, default 15m)
its messages MUST reach the replica that holds it. After idle-close, any replica
may pick the thread up via cold resume.

Infra-level stickiness cannot do this: the routing key `(team_id, channel_id,
thread_ts)` is inside the JSON body, invisible to L4/L7 affinity (Slack sends no
cookies, all requests come from Slack's IPs). Hash-based routing (modulo or
consistent) only *approximates* ownership and reshuffles live threads on every
scale event — the elasticity webhook mode exists for.

## Decision

Explicit ownership, not routing math. A **lease** per thread is the single source
of truth for "which replica holds this session right now". Events are accepted by
any replica and **forwarded** to the owner. Infra stays dumb (round-robin
balancing); consistency lives in slaude.

Redis backs the lease and the forwarding channel, but only when clustering is
enabled — this is entirely additive. Socket Mode and non-clustered webhook
deployments never import the Redis client, so a single-replica deploy has the same
zero-extra-dependency footprint it has today.

- **Lease = ownership.** `SET slaude:lease:<team>:<channel>:<thread_ts> <instance> NX EX <ttl>`.
  Claim is atomic; scale-up moves nothing (new replicas win only *new* threads);
  scale-down drains via a graceful-shutdown release.
- **Lease claim = registration.** The lease value is the instance's own id; no
  discovery service, no platform-specific address plumbing. Peers reach the owner
  by publishing to `slaude:instance:<id>`, which the owner subscribed to at boot.
- **`PUBLISH` return = liveness.** Subscriber count 0 → owner is gone → steal the
  lease (atomic compare-and-swap on the instance id) and handle locally.
- **TTL = crash net, not the idle clock.** Explicit lifecycle: heartbeat-refresh
  while the session is in `#live`, explicit `DEL` on idle-close and shutdown. TTL
  expiry only matters when an instance died without releasing. (Refreshing only
  per-message would let the lease lapse mid-turn during a long tool run.)
- **Sessions table stays owner-free.** Durable row answers "what conversation
  exists" (resume id, model, mode); the lease answers "who holds it now". No
  hostname/instance column — that would go stale on crash and need a reaper; TTL
  cleans up for free.
- **Lease is per thread, not per persona.** Multi-persona sessions in one thread
  share a process today; a thread-scoped lease keeps all of a thread's personas on
  one instance, preserving that.

## Message flow

```
Slack event → load balancer (round-robin) → any instance → bolt ack (<3s)
  key = (team_id, channel_id, thread_ts)
  GET slaude:lease:<key>
    = me       → handleMessage locally
    = other    → PUBLISH slaude:instance:<owner> <envelope>
                   receivers==1 → done (owner handles, refreshes its heartbeat)
                   receivers==0 → CAS-steal lease → handleMessage locally (cold resume)
    = nil      → SET NX to claim
                   won  → handleMessage locally (fresh or cold resume via sessions row)
                   lost → re-GET, forward to winner

idle timeout   → manager closes SDK query (existing #armIdle path) → DEL lease
shutdown       → close all live sessions → DEL all owned leases → exit
crash          → no cleanup; TTL expires; next event's PUBLISH sees 0 subscribers → steal
```

The forwarded envelope is the bolt event payload plus dispatch context (persona id,
team id) — not the bolt `args` object (`client` isn't serializable; the receiving
instance re-enters its own gateway routing with its own client). The existing
`seenEvents` dedup guards the direct-delivery + forwarded double-arrival case.

Delivery is at-most-once (pub/sub): the crash window between "delivered to owner"
and "handled" can drop an already-acked event. Accepted for phase 1 — thread
traffic is low and the failure is a user re-ping. If observed in practice, upgrade
the forward channel to Redis Streams (consumer group + `XAUTOCLAIM`) which also
subsumes lease-stealing; don't build both up front.

## Components

| piece | where | what |
| --- | --- | --- |
| `LeaseStore` | `src/cluster/lease.ts` | `claim/get/refresh/release/releaseAll` over Redis; `LocalLeaseStore` no-op impl when clustering is off — no Redis client constructed in that path |
| `Forwarder` | `src/cluster/forwarder.ts` | boot-time `SUBSCRIBE slaude:instance:<self>`; `publish(instanceId, envelope)` returning receiver count; inbound envelopes re-enter gateway routing |
| gateway hook | `src/gateway/core/gateway.ts` | lease check at the top of the message/app_mention entry, before `handleMessage`; steal-and-handle fallback; entirely skipped when clustering is off |
| idle release | `src/agent/manager.ts` | emit a `sessionClosed` agent event from the idle-close and reload paths; gateway releases the lease on it |
| session mirror | `src/db/sessions.ts` | when clustered, write-through the row as JSON to `slaude:session:<key>` on every mutation; claiming instances read the mirror (per-process sqlite isn't visible to siblings) |
| heartbeat | `src/cluster/lease.ts` | one interval per instance refreshing all held leases every `ttl/3` |
| shutdown | `src/server.ts` | on SIGINT/SIGTERM: `releaseAll()` before exit, only when clustered |

`src/cluster/` has no import-time dependency on Redis — the client is constructed
lazily inside `LeaseStore`/`Forwarder` factories, only called when
`env.cluster.enabled()` is true. `bun install` for a non-clustered deploy doesn't
need the redis package to be usable; it's a devDependency-style optional runtime
dep, documented but not required unless `SLAUDE_CLUSTER=1`.

## Config

Names are deployment-target-agnostic — no assumption of Kubernetes, Docker, or any
specific orchestrator. "Instance" is any running slaude process; how it gets an id
is the operator's choice (a Kubernetes pod name, a systemd unit, a plain UUID).

```
SLAUDE_CLUSTER=1              # opt-in; unset → everything above is inert, no Redis client created
SLAUDE_REDIS_URL=redis://…    # required when clustered
SLAUDE_INSTANCE_ID            # this replica's identity for lease ownership; falls back to os.hostname()
SLAUDE_LEASE_TTL_SECONDS      # default 900 (aligned with SLAUDE_IDLE_MINUTES)
```

## Prerequisite: shared transcripts

Cross-instance resume requires the claiming instance to read the transcript the
previous owner wrote. Deployment concern, not code: mount a shared read/write
volume at the Claude config dir (transcripts) and `$SLAUDE_HOME/workspaces`
(session cwds) — a networked filesystem, NFS mount, or platform equivalent, chosen
by the operator. Safe under the lease model because exactly one instance writes a
given thread's files at a time. Without shared storage, a stolen/expired thread
resumes as a fresh session with a history gap — degraded, not broken.

## Known gaps (explicitly out of scope, phase 1)

- **Cron scheduler** runs on every instance → duplicate fires when clustered.
  Needs a singleton leader lease (`slaude:leader`). Phase 2.
- **Other sqlite state** (one-on-one locks, mention-only, ignores, soul overrides)
  is per-process. Same write-through-mirror treatment as sessions, as needed.
  Phase 2.
- **Prometheus metrics** are per-process; aggregation is the scraper's job. Fine
  as-is.

## Alternatives rejected

- **Consistent-hash router in front** — still reshuffles ~1/N live threads per
  scale event; violates the hard-stickiness requirement, and needs a custom
  body-parsing router anyway.
- **Instance-to-instance HTTP forwarding** (address embedded in the lease) —
  works, but adds an internal port, request signing on the hop, stale-address
  handling, and firewall/network-policy surface. Redis is already required for the
  lease; pub/sub reuses it and its `PUBLISH` count doubles as the liveness probe.
- **`owner` column on `sessions`** — stale on crash, needs a reaper, puts a hot
  per-event read on the durable store.
- **Stable per-replica network identity** (e.g. a headless service) — unnecessary
  once the lease carries the instance id directly.
