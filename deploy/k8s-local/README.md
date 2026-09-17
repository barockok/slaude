# slaude — local minikube overlay

Runs the horizontal-scale topology from [`deploy/k8s-scale`](../k8s-scale) on a
single-node minikube: two gateway replicas, two node workers, in-cluster
Postgres and Redis, and a shared `$SLAUDE_HOME` volume. The production manifests
are referenced, not copied, so what you run locally is what ships.

```sh
deploy/k8s-local/up.sh          # create the cluster, build the image, deploy, wait
deploy/k8s-local/verify-ha.sh   # prove failover against real Kubernetes and Redis state
deploy/k8s-local/down.sh        # delete the cluster (add --purge to drop secrets)
```

## Prerequisites

- `minikube`, `kubectl` and `openssl`.
- A Docker runtime with about **3.5 GB** free for the minikube node. On macOS
  with colima, `colima ssh -- free -m` shows what is actually available; other
  containers you run share that memory.

Tune the node with `SLAUDE_LOCAL_CPUS` and `SLAUDE_LOCAL_MEMORY` (MB). The
defaults are 3 CPUs and 3500 MB.

## Model credentials

The cluster boots and passes every HA check with **no credentials at all**.
Nodes just cannot run a model turn until provider credentials exist.

`up.sh` takes them from your shell, or from a dotenv file you point it at:

```sh
ANTHROPIC_API_KEY=... deploy/k8s-local/up.sh
# or
SLAUDE_LOCAL_ENV_FILE=./.env deploy/k8s-local/up.sh
```

Only `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` are read from that file. Values are never printed.
Re-run `up.sh` to rotate them.

Generated files, both gitignored:

| File | Contents | Lifetime |
|---|---|---|
| `secrets.env` | master key, node bearer, job-token secret, datastore URLs | created once, reused |
| `provider.env` | model provider credentials | rewritten every run |

`secrets.env` is deliberately never regenerated. The master key encrypts the
Slack app registry at rest, and a new key would orphan every row encrypted under
the old one.

## What `verify-ha.sh` proves

| Check | How |
|---|---|
| Both tiers run two ready replicas | Deployment status |
| Gateway readiness reaches Postgres | `/readyz` through the Service, from inside the cluster |
| Internal API refuses unauthenticated callers | `/v1` without the node bearer returns 401 |
| One reaper leader is elected | Redis lock key holds an owner |
| The shared volume is shared | a write on one gateway is read back on every app pod |
| A gateway can be lost while serving | 30 s of traffic through the Service while a pod is deleted; longest outage must stay under one second |
| A crashed leader is replaced | SIGKILL through the container runtime, then the lock owner must change within the TTL |
| A crashed node is detected and pruned | its heartbeat must expire, the worker restart, and the reaper remove it from the registry |

Crashes use SIGKILL from the container runtime on purpose. `kubectl delete
--force` still delivers SIGTERM, and a leader that releases its lock on the way
out says nothing about what happens when a process actually dies.

## What it cannot prove

- **Datastore HA.** Postgres and Redis are single replicas here by design.
  Production uses managed services.
- **Losing a whole Kubernetes node.** minikube's hostpath storage honours
  `ReadWriteMany` only because every pod shares one node. A multi-node cluster
  needs real RWX storage (NFS, Longhorn, CephFS) before this check means
  anything.
- **Slack end to end.** Slack cannot reach a laptop. The gateway runs the
  Events API in HTTP mode, which boots with an empty app registry, so nothing
  here needs Slack credentials. To receive real events, put a tunnel in front
  of `svc/slaude-gateway` and register the app with `bun run slack-app add`.
  Socket Mode avoids the tunnel but refuses to start without real tokens.
- **Failover of a turn in flight.** That needs a message source and model
  credentials; the checks above cover the machinery a turn depends on.

## Differences from `deploy/k8s-scale`

| Production | Local |
|---|---|
| Image pulled from a registry | built into minikube, never pulled |
| RWX storage class of your choice | minikube `standard` (hostpath) |
| External managed Postgres and Redis | in-cluster dev stand-ins |
| Ingress with TLS | none; the Service is kept |
| KEDA queue-depth autoscaling | CPU HPA fallback, capped at three nodes |
| Node drain 120 s, grace 150 s | drain 30 s, grace 45 s |
| Production-sized requests | trimmed to fit a laptop |

Plain `kubectl apply -k` refuses this overlay, because it references files
outside its own directory. `up.sh` renders it with the load restrictor relaxed:

```sh
kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/k8s-local | kubectl apply -f -
```
