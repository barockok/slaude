# Webhook multi-replica: session leases + event forwarding

**Date:** 2026-08-10
**Status:** design (builds on the webhook transport, PR #88)
**Scope:** `SLAUDE_TRANSPORT=webhook` deployments with more than one replica. Socket
Mode and single-pod webhook deployments are untouched — everything below is behind
one opt-in flag and no-ops without it.

## Problem

Webhook mode makes slaude horizontally scalable at the HTTP layer, but the runtime
is stateful per thread:

- live sessions are an in-memory map (`AgentManager.#live`) — a thread's SDK Query,
  idle timer, and turn buffers exist on exactly one process;
- SDK `resume` reads the transcript jsonl from local disk;
- session rows live in per-pod `bun:sqlite`.

With N replicas behind a plain Service, Slack events for one thread land on random
pods. While a session is live (inside the idle window, default 15m) its messages
MUST reach the pod that holds it. After idle-close, any pod may pick the thread up
via cold resume.

Infra-level stickiness cannot do this: the routing key `(team_id, channel_id,
thread_ts)` is inside the JSON body, invisible to L4/L7 affinity (Slack sends no
cookies, all requests come from Slack's IPs). Hash-based routing (modulo or
consistent) only *approximates* ownership and reshuffles live threads on every
scale event — the elasticity webhook mode exists for.

## Decision

Explicit ownership, not routing math. A **Redis lease** per thread is the single
source of truth for "which pod holds this session right now". Events are accepted
by any pod and **forwarded over Redis pub/sub** to the owner. Infra stays dumb
(round-robin ingress); consistency lives in slaude.

- **Lease = ownership.** `SET slaude:lease:<team>:<channel>:<thread_ts> <pod> NX EX <ttl>`.
  Claim is atomic; scale-up moves nothing (new pods win only *new* threads);
  scale-down drains via preStop release.
- **Lease claim = registration.** The lease value is the pod name; no discovery
  service, no Downward API IP plumbing. Peers reach the owner by publishing to
  `slaude:pod:<pod_name>`, which the owner subscribed to at boot.
- **`PUBLISH` return = liveness.** Subscriber count 0 → owner is gone → steal the
  lease (atomic compare-and-swap on the pod name) and handle locally.
- **TTL = crash net, not the idle clock.** Explicit lifecycle: heartbeat-refresh
  while the session is in `#live`, explicit `DEL` on idle-close and preStop. TTL
  expiry only matters when a pod died without releasing. (Refreshing only
  per-message would let the lease lapse mid-turn during a long tool run.)
- **Sessions table stays owner-free.** Durable row answers "what conversation
  exists" (resume id, model, mode); the lease answers "who holds it now". No
  hostname column — a column goes stale on crash and would need a reaper; TTL
  cleans up for free.
- **Lease is per thread, not per persona.** Multi-persona sessions in one thread
  share a process today; a thread-scoped lease keeps all of a thread's personas on
  one pod, preserving that.

## Message flow

```
Slack event → ingress (round-robin) → any pod → bolt ack (<3s)
  key = (team_id, channel_id, thread_ts)
  GET slaude:lease:<key>
    = me       → handleMessage locally
    = other    → PUBLISH slaude:pod:<owner> <envelope>
                   receivers==1 → done (owner handles, refreshes its heartbeat)
                   receivers==0 → CAS-steal lease → handleMessage locally (cold resume)
    = nil      → SET NX to claim
                   won  → handleMessage locally (fresh or cold resume via sessions row)
                   lost → re-GET, forward to winner

idle timeout   → manager closes SDK query (existing #armIdle path) → DEL lease
preStop        → close all live sessions → DEL all owned leases → exit
crash          → no cleanup; TTL expires; next event's PUBLISH sees 0 subscribers → steal
```

The forwarded envelope is the bolt event payload plus dispatch context (persona id,
team id) — not the bolt `args` object (`client` isn't serializable; the receiving
pod re-enters its own gateway routing with its own client). The existing
`seenEvents` dedup guards the direct-delivery + forwarded double-arrival case.

Delivery is at-most-once (pub/sub): the crash window between "delivered to owner"
and "handled" can drop an already-acked event. Accepted for phase 1 — thread
traffic is low and the failure is a user re-ping. If observed in practice, upgrade
the forward channel to Redis Streams (consumer group + `XAUTOCLAIM`) which also
subsumes lease-stealing; don't build both up front.

## Components

| piece | where | what |
| --- | --- | --- |
| `LeaseStore` | `src/cluster/lease.ts` | `claim/get/refresh/release/releaseAll` over Redis; `LocalLeaseStore` no-op impl when clustering is off |
| `Forwarder` | `src/cluster/forwarder.ts` | boot-time `SUBSCRIBE slaude:pod:<self>`; `publish(owner, envelope)` returning receiver count; inbound envelopes re-enter gateway routing |
| gateway hook | `src/gateway/core/gateway.ts` | lease check at the top of the message/app_mention entry, before `handleMessage`; steal-and-handle fallback |
| idle release | `src/agent/manager.ts` | emit a `sessionClosed` agent event from the idle-close and reload paths; gateway releases the lease on it |
| session mirror | `src/db/sessions.ts` | when clustering is on, write-through the row as JSON to `slaude:session:<key>` on every mutation; claiming pods read the mirror (per-pod sqlite isn't visible to siblings) |
| heartbeat | `src/cluster/lease.ts` | one interval per pod refreshing all held leases every `ttl/3` |
| shutdown | `src/server.ts` | preStop/SIGTERM: `releaseAll()` before exit |

## Config

```
SLAUDE_CLUSTER=1            # opt-in; unset → all of the above is inert
SLAUDE_REDIS_URL=redis://…  # required when clustered
SLAUDE_POD_NAME=$(POD_NAME) # Downward API metadata.name; falls back to os.hostname()
SLAUDE_LEASE_TTL_SECONDS    # default 900 (aligned with SLAUDE_IDLE_MINUTES)
```

## Prerequisite: shared transcripts

Cross-pod resume requires the claiming pod to read the transcript the previous
owner wrote. Deployment concern, not code: mount an RWX volume at the Claude config
dir (transcripts) and `$SLAUDE_HOME/workspaces` (session cwds). Safe under the
lease model because exactly one pod writes a given thread's files at a time.
Without a shared volume, a stolen/expired thread resumes as a fresh session with
history gap — degraded, not broken.

## Known gaps (explicitly out of scope, phase 1)

- **Cron scheduler** runs on every pod → duplicate fires when clustered. Needs a
  singleton leader lease (`slaude:leader`). Phase 2.
- **Other sqlite state** (one-on-one locks, mention-only, ignores, soul overrides)
  is per-pod. Same write-through-mirror treatment as sessions, as needed. Phase 2.
- **Prometheus metrics** are per-pod; aggregation is the scraper's job. Fine as-is.

## Alternatives rejected

- **Consistent-hash router in front** — still reshuffles ~1/N live threads per
  scale event; violates the hard-stickiness requirement, and needs a custom
  body-parsing router anyway.
- **Pod-to-pod HTTP forwarding** (headless service / Downward API IP in the lease)
  — works, but adds an internal port, HMAC on the hop, stale-IP handling, and
  NetworkPolicy surface. Redis is already required for the lease; pub/sub reuses
  it and its `PUBLISH` count doubles as the liveness probe.
- **`owner_host` column on `sessions`** — stale on crash, needs a reaper, puts a
  hot per-event read on the durable store.
- **StatefulSet stable identities** — unnecessary once the lease carries the pod
  name; Deployment + HPA stays.
