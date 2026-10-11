# Capacity check for promoting v0.45.0 (template)

Release gate item 8 (WS-E §6): "a run with several label queues and the node
counts they imply, recording Redis connections (one per worker per node),
memory, and the gateway's added load from the MCP bridge; the numbers are in
the notes, not assumed." This file is where that run is recorded. Copy it to
`docs/superpowers/plans/<date>-capacity-check-<rc>.md`, fill every cell, and
link the copy from the v0.45.0 release notes. A cell that could not be measured
says so (`not measured: <why>`); it is never left blank or estimated.

Use generic names only (labels such as `default`, `finance`, `engineering`;
hosts as `example.com`). Record numbers, not deployment details.

## What to run

1. **Topology.** At least three label queues (`default` plus two others), each
   with its own node Deployment of at least two replicas, and two gateway
   replicas. Record the node count per label and `SLAUDE_NODE_CONCURRENCY`.
   A node runs one BullMQ worker per credential label plus one for its own
   queue, so the expected worker count per node is `labels + 1`.
2. **Baseline (idle).** All pods Ready, no traffic, 10 minutes. Take every
   measurement below once.
3. **Load.** Drive turns into every label at once (the nightly HA suite's
   driver or `deploy/k8s-local/verify-turns.sh` in a loop), including turns
   that call a bridged MCP tool as the agent and, in a 1:1, as the user. Hold it
   for at least 15 minutes. Record the peak of each measurement.
4. **Scale step.** Add one replica to one label's node Deployment under load and
   record the change in Redis connections (it should rise by that node's worker
   count, plus its non-worker clients).
5. **Bridge off.** Repeat step 3 with the same turns but no bridged MCP calls,
   so the gateway's added load from the bridge is the difference.

## How to measure

| Quantity | Where |
|---|---|
| Redis connections | `redis-cli INFO clients` (`connected_clients`), and `CLIENT LIST` grouped by `name`/`addr` to attribute them to pods |
| Redis memory | `redis-cli INFO memory` (`used_memory`, `used_memory_peak`) |
| Postgres connections | `SELECT count(*), application_name FROM pg_stat_activity GROUP BY 2` |
| Postgres memory | the container's working set (`kubectl top pod`), plus `shared_buffers` |
| Gateway CPU and memory | `kubectl top pod -l app.kubernetes.io/component=gateway`, per replica |
| Node CPU and memory | `kubectl top pod -l app.kubernetes.io/component=node` (or per Deployment), per label |
| Queue depth and latency | `slaude_queue_depth`, `slaude_node_queue_claim_latency_seconds` (p50, p95) per label |
| Turn duration | `slaude_node_turn_duration_seconds` (p50, p95) |
| Bridge load on the gateway | gateway CPU and memory in step 3 minus step 5; `slaude_http_requests_total` for the bridge route |
| Gate refusals | `slaude_gate_denied_total` (should stay at 0 in a healthy run) |

## Results

Run: RC tag `________`, date `________`, cluster size `________` (CPUs, memory),
`SLAUDE_NODE_CONCURRENCY=____`.

### Topology

| Label | Node replicas | Workers per node (expected `labels + 1`) | Workers per node (observed) |
|---|---|---|---|
| default | | | |
| | | | |
| | | | |

### Measurements

| Quantity | Idle | Load (peak) | Scale step (delta) | Load without bridge |
|---|---|---|---|---|
| Redis connections (total) | | | | |
| Redis connections per node pod | | | | |
| Redis connections per gateway pod | | | | |
| Redis `used_memory` | | | | |
| Postgres connections | | | | |
| Postgres memory | | | | |
| Gateway CPU (per replica) | | | | |
| Gateway memory (per replica) | | | | |
| Node CPU (per pod, by label) | | | | |
| Node memory (per pod, by label) | | | | |
| Queue depth (max, by label) | | | | |
| Claim latency p95 (by label) | | | | |
| Turn duration p95 | | | | |
| `slaude_gate_denied_total` increase | | | | |

### Bridge

| Quantity | Value |
|---|---|
| Bridged MCP calls during the load step | |
| Gateway CPU added by the bridge (step 3 minus step 5) | |
| Gateway memory added by the bridge | |
| Bridge errors (fixed error text seen in Slack) | |

### Conclusions

- Redis connections per node match `labels + 1` workers plus `____` other
  clients: yes / no (explain).
- Redis `maxclients` headroom at the largest planned node count: `____`.
- Gateway sizing (requests and limits) is sufficient with the bridge: yes / no.
- Anything that changes the documented sizing in `deploy/k8s-scale` or the
  scale-operations guide: `________`.
