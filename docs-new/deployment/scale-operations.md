---
title: Scale Operations
description: Operating the gateway + node topology — the full metric surface, what to alert on, sample PromQL, and scaling behavior.
---

# Scale Operations

Runbook for the horizontal-scale topology ([multi-node.md](multi-node.md),
manifests in `deploy/k8s-scale/`). Everything here is scrapeable from
`/metrics` on gateway `:8080` and node `:8081` (Prometheus text format; no
prom-client dependency). Static labels via `SLAUDE_METRICS_LABELS` — set at
least `role=gateway|node` per Deployment so the series below are separable.

## Metric surface

### Gateway

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `slaude_gateway_events_total` | counter | `type` | Slack events accepted + dispatched (post-signature, post-app-lookup) |
| `slaude_http_requests_total` | counter | `route`, `status` | Every `/slack/*` ingress response, 200s and rejects |
| `slaude_slack_drops_total` | counter | `reason` | Events dropped by gates before a turn |
| `slaude_queue_depth` | gauge | `queue` | Turn jobs waiting + delayed + prioritized on the shared queue † |
| `slaude_nodes_alive` | gauge | — | Live node heartbeat keys † |
| `slaude_sessions_warm` | gauge | — | Sessions registered warm on some node † |
| `slaude_v1_tool_calls_total` | counter | `server`, `tool` | REST tool-plane invocations from nodes |
| `slaude_v1_job_events_total` | counter | `event` | Node job telemetry (`ack`\|`fail`) |

† Exported only by the current **reaper leader** replica. Aggregate with
`max()` across gateway pods; a replica that loses leadership keeps its last
values, so never `sum()` these.

### Node

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `slaude_node_sessions_live` | gauge | — | Warm SDK `Query` sessions held by this node |
| `slaude_node_turns_total` | counter | `result` | Turn jobs processed (`done`\|`error`\|`skipped`\|`requeued`) |
| `slaude_node_turn_duration_seconds` | histogram | — | Wall-clock turn duration |
| `slaude_node_queue_claim_latency_seconds` | histogram | — | enqueue→claim latency (SLO: p95 < 500ms, spec §8) |

### Agent runtime (emitted wherever the `AgentManager` runs — nodes in this topology, the single process in mono)

| Metric | Type | Labels |
|---|---|---|
| `slaude_sessions_live` | gauge | — |
| `slaude_turns_total` | counter | `result` |
| `slaude_tool_calls_total` | counter | `tool` |
| `slaude_tokens_total` | counter | `kind`, `channel_id`, `model` |
| `slaude_context_window_pct` | gauge | — |
| `slaude_errors_total` | counter | `kind` |
| `slaude_stop_guard_blocked_total` / `slaude_stop_guard_failed_total` | counter | — |
| `slaude_disengaged_suppressed_total` | counter | — |
| `slaude_user_turns_total` | counter | `user_id`, `user_name` (opt-in `SLAUDE_METRICS_PER_USER=1`) |

## What to alert on

**No workers** — turns queue but nothing runs. Page immediately.

```promql
max(slaude_nodes_alive) == 0
```

**Queue depth growing** — arrival rate exceeds drain rate; check node
health/scaling before the backlog turns into user-visible latency.

```promql
max(slaude_queue_depth{queue="turns"}) > 25
and deriv(max(slaude_queue_depth{queue="turns"})[10m:1m]) > 0
```

**Claim latency SLO** — spec §8: p95 enqueue→claim under 500ms.

```promql
histogram_quantile(0.95,
  sum by (le) (rate(slaude_node_queue_claim_latency_seconds_bucket[5m]))) > 0.5
```

**Reaper leader missing** — the leader gauges stop being exported entirely
(every gateway replica down, or leadership stuck). Dead nodes then go
unreaped and their queued jobs strand until it returns.

```promql
absent(slaude_nodes_alive)
```

**Turn error rate** — provider failures, lock losses, resume misses.

```promql
sum(rate(slaude_node_turns_total{result="error"}[10m]))
  / sum(rate(slaude_node_turns_total[10m])) > 0.05
```

**Ingress rejects** — a spike of 401s means a signing-secret mismatch (rotated
in Slack but not in `slack_apps`); 404s mean events from an unregistered app.

```promql
sum by (status) (rate(slaude_http_requests_total{route="/slack/events",status!="200"}[5m])) > 0
```

Useful non-alert panels: mean turn duration
(`rate(..._duration_seconds_sum[5m]) / rate(..._duration_seconds_count[5m])`),
warm-session ratio (`max(slaude_sessions_warm)` vs `sum(slaude_node_sessions_live)`),
token spend by model/channel (`rate(slaude_tokens_total[1h])`).

## Scrape config

Gateway pods expose `/metrics` on the `http` port (8080), nodes on `health`
(8081). With the Prometheus Operator, one PodMonitor per Deployment; plain
Prometheus:

```yaml
scrape_configs:
  - job_name: slaude-scale
    kubernetes_sd_configs:
      - role: pod
        namespaces: { names: [slaude-scale] }
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        regex: slaude
        action: keep
      - source_labels: [__meta_kubernetes_pod_container_port_name]
        regex: http|health
        action: keep
```

## Scaling behavior

- **Nodes** scale on queue depth via KEDA (`deploy/k8s-scale/70-autoscale.yaml`
  — redis list-length trigger on the BullMQ wait list; prometheus and CPU-HPA
  variants documented in the file). Scale-down is deliberately slow: a reaped
  node's warm sessions cold-resume elsewhere from the shared volume, but the
  warmth is lost.
- **Gateways** are stateless; scale `replicas` manually on ingress volume.
  Leaders (cron, reaper) elect via Redis locks — any replica count is safe.
- **Draining**: node SIGTERM stops claiming, finishes in-flight turns within
  `SLAUDE_NODE_DRAIN_SEC` (120s), deregisters. `terminationGracePeriodSeconds`
  (150) must stay above the drain window.
