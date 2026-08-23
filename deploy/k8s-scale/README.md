# slaude — horizontal-scale Kubernetes manifests

Deploys the gateway/node split (spec: `docs/superpowers/specs/2026-08-24-horizontal-scale-design.md`):
N stateless **gateway** replicas (Slack Events API ingress, `/v1` control
plane, cron/reaper leaders) and M interchangeable **node** workers (BullMQ
consumers running the SDK turns), over external Postgres + Redis and a shared
ReadWriteMany `$SLAUDE_HOME` volume. For the single-persona mono deploy, use
`deploy/k8s/slaude.yaml` instead. Operational runbook (metrics, alerts,
scaling): `docs-new/deployment/scale-operations.md`.

## Prerequisites

- **Postgres and Redis are external.** The manifests reference them by URL
  (`10-secrets.yaml`) and deliberately ship no production datastore pods —
  use managed services (RDS / Cloud SQL / Aiven; ElastiCache / Memorystore /
  Upstash). Redis must run with `maxmemory-policy noeviction` (BullMQ
  requirement). For a self-contained dev cluster only, `90-dev-datastores.yaml`
  provides single-replica in-cluster stand-ins.
- **An RWX-capable StorageClass** for the shared `$SLAUDE_HOME` PVC
  (`30-pvc.yaml`): EFS, Filestore, Azure Files, Longhorn RWX, CephFS, NFS.
- **KEDA** for queue-depth autoscaling (`70-autoscale.yaml`); a CPU-based
  HPA fallback is included for clusters without it.
- An ingress controller + TLS (Slack requires valid HTTPS on the request URL).

## Apply

```sh
# 1. Fill in every REPLACE_ value (or seal the Secret for GitOps):
#    kubeseal --format yaml < deploy/k8s-scale/10-secrets.yaml > deploy/k8s-scale/10-sealed-secrets.yaml
# 2. Set image:, Ingress host, storageClassName, Redis/PG endpoints.
kubectl apply -f deploy/k8s-scale/00-namespace.yaml
kubectl apply -f deploy/k8s-scale/10-secrets.yaml     # or the sealed variant
kubectl apply -f deploy/k8s-scale/20-config.yaml
kubectl apply -f deploy/k8s-scale/30-pvc.yaml
kubectl apply -f deploy/k8s-scale/40-gateway.yaml
kubectl apply -f deploy/k8s-scale/50-node.yaml
kubectl apply -f deploy/k8s-scale/60-ingress.yaml
kubectl apply -f deploy/k8s-scale/70-autoscale.yaml   # KEDA ScaledObject (see file for the HPA fallback)
```

Then point the Slack app at the ingress host — `bun run manifest --mode http
--url https://slaude-gw.example.com` emits the request URLs (and, when
`SLACK_CLIENT_ID` is set, the OAuth redirect URL). Install workspaces via
`https://<host>/slack/oauth/start`, or register manually with
`bun run slack-app add`.

## Notes

- The gateway serves `/slack/*` publicly (via the Ingress) and keeps `/v1`
  + `/metrics` cluster-internal — the Ingress routes only `/slack`.
- `terminationGracePeriodSeconds` on the node Deployment (150) must exceed
  `SLAUDE_NODE_DRAIN_SEC` (120): SIGTERM starts the drain, the kubelet must
  not SIGKILL mid-turn.
- Both Deployments mount the same RWX PVC at `/data` (`SLAUDE_HOME`); the
  gateway renders persona files onto it, nodes read them and the SDK writes
  session transcripts.
- Scale gateways by bumping `replicas` in `40-gateway.yaml`; nodes scale
  automatically on queue depth.
