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
- **The Postgres server needs pgvector, and a second database for the brain.**
  A gateway refuses to boot on embedded storage: `SLAUDE_DB=pg` with a real
  `SLAUDE_PG_URL` for slaude's data, and `SLAUDE_BRAIN_ENGINE=postgres` for the
  brain. The brain's default PGLite engine is single-writer and clears locks it
  finds at boot, so on the shared volume two gateway replicas would corrupt it.
  Create the brain database with the `vector`, `pg_trgm` and `pgcrypto`
  extensions, as in `deploy/postgres-init/10-brain-database.sql`, and set
  `SLAUDE_BRAIN_DATABASE_URL` (`10-secrets.yaml`). Managed services that
  support pgvector: RDS, Cloud SQL, Azure Flexible Server, Aiven.
- **An RWX-capable StorageClass** for the shared `$SLAUDE_HOME` PVC
  (`30-pvc.yaml`): EFS, Filestore, Azure Files, Longhorn RWX, CephFS, NFS.
- **KEDA** for queue-depth autoscaling (`70-autoscale.yaml`, one
  ScaledObject per label). Without KEDA, leave `70-autoscale.yaml` out and
  apply `optional/node-cpu-fallback-hpa.yaml` instead (a CPU HPA per label).
  Never both: two autoscalers on one Deployment fight over its replicas.
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
kubectl apply -f deploy/k8s-scale/70-autoscale.yaml   # KEDA ScaledObjects, one per label
# or, without KEDA (never both):
# kubectl apply -f deploy/k8s-scale/optional/node-cpu-fallback-hpa.yaml
# or, the same set in one build:
kubectl apply -k deploy/k8s-scale
# optional, on a CNI that enforces NetworkPolicy (read the file first):
kubectl apply -f deploy/k8s-scale/optional/node-egress-networkpolicy.yaml
```

`10-secrets.yaml` holds the gateway's Secret, `slaude-scale-secrets` (master
key, job secret, node key, legacy node token, database URLs, Slack secrets),
one Secret shared by every node deployment, `slaude-scale-node-secrets` (Redis,
the provider env fallback), and one **credential Secret per node deployment**
(`slaude-scale-node-cred-<label>`, holding only that deployment's
`SLAUDE_NODE_TOKEN`). The gateway reads only the Redis URL from the node Secret,
by key. Never load the gateway Secret on a node: the node Deployments set
`SLAUDE_NODE_BOOT_CHECK=refuse`, so a node that finds a gateway-only variable
stops at boot (naming the variable, never its value) and sets
`slaude_node_gateway_secrets_present`; any `SLAUDE_VAULT_*` or `VAULT_*`
variable stops it whatever that setting says. Upgrading a cluster that used one
Secret for both tiers, and the rotation that follows, is described in the
multi-node deploy guide (the Secret split).

### Node labels

`50-node.yaml` runs one Deployment per node label: `slaude-node` for label
`default` (its selector is unchanged from earlier releases) and
`slaude-node-finance` as the example of a second label. Each has its own
credential Secret, PodDisruptionBudget and KEDA ScaledObject on its own queue
(`turns` for `default`, `turns.label.<label>` for any other). Mint each
credential on a gateway and pipe it into its Secret (the command is in
`10-secrets.yaml`); a persona runs on a label through `runsOn` in its
`persona.yaml`. Labels separate trust between **nodes**, not between personas
on the same node, and queue names are routing, not access control: see the
multi-node deploy guide.

Upgrade order is **gateways first, then nodes**. Before the new node Secrets
are applied, the node image must already be at this release (an older node
does not read a credential Secret it does not know about) and queued turns
should be drained.

### Gateway-only configuration

`20-config.yaml` adds `slaude-scale-gateway-config`, loaded by the gateway only:
Vault (off until `SLAUDE_VAULT_ADDR` is set; Kubernetes auth through the
projected `vault-token` volume in `40-gateway.yaml`, audience `vault`),
`SLAUDE_OUTBOUND_INTERNAL_HOSTS` (list any in-cluster identity provider, MCP
server or Vault the gateway reaches on a private address or over http),
`SLAUDE_NODE_LEGACY` and the MCP bridge limits. Nothing in it may move to the
shared ConfigMap: a node refuses to boot with any Vault variable.
`slaude-node-manifest` is the nodes' stdio MCP manifest, mounted at
`/etc/slaude/node.json`; it is empty, so nodes mount no stdio or plugin MCP
server for any persona until you declare one.

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
  automatically on queue depth, per label.
- `optional/node-egress-networkpolicy.yaml` selects every node deployment
  (`slaude.dev/tier: node`) and leaves Postgres and Vault off the allowed
  ports. It needs a CNI that enforces NetworkPolicy.
