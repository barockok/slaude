# slaude — local minikube overlay

Runs the horizontal-scale topology from [`deploy/k8s-scale`](../k8s-scale) on a
single-node minikube: two gateway replicas, two node workers, in-cluster
Postgres and Redis, and a shared `$SLAUDE_HOME` volume. The production manifests
are referenced, not copied, so what you run locally is what ships.

```sh
deploy/k8s-local/up.sh          # create the cluster, build the image, deploy, wait
deploy/k8s-local/verify-ha.sh   # prove failover against real Kubernetes and Redis state
deploy/k8s-local/verify-turns.sh # prove a turn survives losing the node running it
deploy/k8s-local/down.sh        # delete the cluster (add --purge to drop secrets)
```

## Prerequisites

- `minikube`, `kubectl`, `openssl` and `python3`.
- A Docker runtime with about **3.5 GB** of free memory for the minikube node.
  On macOS with colima, `colima ssh -- free -m` shows what is actually
  available; other containers you run share that memory.
- At least **5 GB** of free disk on the Docker host once the cluster is up.
  `up.sh` checks this before building and refuses below it
  (`SLAUDE_LOCAL_MIN_BUILD_FREE_MB` overrides the floor). The node's storage
  lives on the same disk as every other container on that host, so running it
  out of space is not contained to this cluster.

Set `SLAUDE_LOCAL_OVERLAY` to apply a different overlay that builds on this one; used by the e2e suite.

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

Generated files, all gitignored:

| File | Contents | Secret | Lifetime |
|---|---|---|---|
| `secrets.env` | master key, node bearer, job-token secret, datastore URLs | `slaude-scale-secrets` (gateway only) | created once, reused |
| `node.env` | the node bearer and the Redis URL, copied from `secrets.env` | `slaude-scale-node-secrets` (node only) | rewritten every run |
| `deploy.env` | the `/deploy` pipeline token | `slaude-scale-deploy` (gateway only) | created once, reused |
| `provider.env` | model provider credentials | both: the gateway's own calls, and the nodes' provider env fallback | rewritten every run |

`secrets.env` is deliberately never regenerated. The master key encrypts the
Slack app registry at rest, and a new key would orphan every row encrypted under
the old one.

Nodes never load `secrets.env`: a node holding the master key or the job-token
secret could act as the gateway. A cluster created before this split loaded one
Secret into both tiers; re-running `up.sh` derives `node.env` from the existing
`secrets.env` and moves the nodes onto the node Secret, keeping every value.
Afterwards treat the job-token secret and the master key as exposed and rotate
them; see the Secret split section of the multi-node deploy guide.

## What `verify-ha.sh` proves

| Check | How |
|---|---|
| Both tiers run two ready replicas | Deployment status |
| Gateway readiness reaches Postgres | `/readyz` through the Service, from inside the cluster |
| Internal API refuses unauthenticated callers | `/v1` without the node bearer returns 401 |
| One reaper leader is elected | Redis lock key holds an owner |
| The brain runs on Postgres, not embedded PGLite | gbrain's tables exist in the separate `slaude_brain` database |
| The shared volume is shared | a write on one gateway is read back on every app pod |
| A gateway can be lost while serving | 30 s of traffic through the Service while a pod is deleted; longest outage must stay under one second |
| A crashed leader is replaced | SIGKILL through the container runtime, then the lock owner must change within the TTL |
| A crashed node is detected and pruned | its heartbeat must expire, the worker restart, and the reaper remove it from the registry |
| A node needs no persona directory | sync a persona set (extraction cache seeded through the gateway's own `writeSoulCacheEntry`, a signed entry in its pod-local cache, so no model), delete the persona's directory from the volume, run a suppressed turn, then a node log must carry `persona=verifier soul=<sha256 prefix of the synced text>`; the deploy token must be on the gateway and absent from every node |
| A warm node session picks up a changed soul | after that turn, sync soul B (seeded the same way), run a second suppressed turn in the **same** session (`turns.ts again`), and a node log must carry `session=<that session> persona=verifier soul=<sha256 prefix of B>`; not yet run on a cluster |

Crashes use SIGKILL from the container runtime on purpose. `kubectl delete
--force` still delivers SIGTERM, and a leader that releases its lock on the way
out says nothing about what happens when a process actually dies.

## What `verify-turns.sh` proves

`verify-ha.sh` proves the infrastructure survives; this proves a **turn** does.

| Check | How |
|---|---|
| Turns reach nodes through the real queue | enqueued from inside a gateway pod, with the deployment's own Redis, Postgres and key prefix |
| A turn survives losing the node running it | SIGKILL the node mid-flight; every turn must still carry a completion marker, with nothing left waiting, active, delayed or failed |
| A turn is never run twice | the completion marker is per job, so a re-delivered turn cannot be double-counted |
| Delivery works with a node already down | a second batch, enqueued while one node is gone, must complete on the survivor |
| One cron occurrence fires once across two gateways | the occurrence is claimed before dispatch, so exactly one turn job exists for it, and the schedule has already moved on |

The turns are **suppressed**: the node runs the whole lifecycle — claim, session
lock, completion marker, ack — while the prompt hook stops the model. So the
script needs no model credentials and costs no provider tokens.

Recovery is not instant. A killed node never releases its `lock:session:<id>`,
so the re-delivered turn waits for that lock's TTL before another node can run
it. Production defaults to **10 minutes**; this overlay sets
`SLAUDE_SESSION_LOCK_TTL_MS=45000` so the takeover happens in under a minute and
the script stays quick. The run prints how long it actually took (50 s on a
45 s TTL, last measured).

## What it cannot prove

- **Datastore HA.** Postgres and Redis are single replicas here by design.
  Production uses managed services.
- **The brain under concurrent writes.** A gateway refuses to boot on embedded
  storage, so the brain runs on the Postgres server in its own `slaude_brain`
  database, and the check above confirms it is there. Every gateway replica
  still bootstraps knowledge sources at boot and schedules nightly
  maintenance; those rely on gbrain's cycle-lock table to take turns, which
  this script does not exercise.
- **Losing a whole Kubernetes node.** minikube's hostpath storage honours
  `ReadWriteMany` only because every pod shares one node. A multi-node cluster
  needs real RWX storage (NFS, Longhorn, CephFS) before this check means
  anything.
- **Slack end to end.** Slack cannot reach a laptop. The gateway runs the
  Events API in HTTP mode, which boots with an empty app registry, so nothing
  here needs Slack credentials. To receive real events, put a tunnel in front
  of `svc/slaude-gateway` and register the app with `bun run slack-app add`.
  Socket Mode is not an option: a gateway refuses to boot on it, because its
  websocket consumer is single-leader and replicas would duplicate responses.
- **Slack-driven turns.** `verify-turns.sh` drives turns through the queue
  directly, which is the path a Slack message reaches after the gateway has
  handled it. The Slack leg itself still needs a tunnel.

## Troubleshooting

### `minikube start` times out creating the host (colima)

Symptom: `Exiting due to DRV_CREATE_TIMEOUT: create host timed out in 360
seconds`, with the verbose log (`--alsologtostderr -v=5`) looping on:

```
libmachine: Error dialing TCP: dial tcp 127.0.0.1:<port>: connect: connection refused
```

The node container is fine. minikube runs on macOS and dials the node's SSH on
a port Docker published inside the colima VM, and colima is failing to forward
new ports from the VM to the Mac. Confirm it layer by layer:

```sh
P=$(docker port slaude-local 22 | awk -F: '{print $NF}')
colima ssh -- bash -c "</dev/tcp/127.0.0.1/$P" && echo "open inside the VM"
nc -z -G 3 127.0.0.1 "$P" || echo "refused on the Mac"
grep -a "failed to set up forwarding" ~/.colima/_lima/colima/ha.stderr.log | tail -3
```

If the port is open inside the VM, refused on the Mac, and the colima host agent
log shows `failed to set up forwarding ... exit status 255`, this is the cause.
It affects every container that publishes a new port, not just minikube.

Restarting colima re-establishes forwarding, but stops every running container.
The non-disruptive workaround is to add the forwards through colima's own SSH
control socket while `minikube start` is waiting:

```sh
S=~/.colima/_lima/colima/ssh.sock
SSH_PORT=$(grep -aoE -- '-p [0-9]+ 127\.0\.0\.1' ~/.colima/_lima/colima/ha.stderr.log | tail -1 | awk '{print $2}')
for p in $(docker port slaude-local | awk -F: '{print $NF}' | sort -u); do
  ssh -F /dev/null -o IdentityFile="$HOME/.colima/_lima/_config/user" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes \
    -o User="$USER" -o ControlPath="$S" -T -O forward \
    -L "127.0.0.1:$p:127.0.0.1:$p" -N -f -p "$SSH_PORT" 127.0.0.1
done
```

These forwards are loopback-only and disappear when colima restarts. A new
minikube node publishes new ports, so repeat this after `down.sh` and `up.sh`.

Running the same forward by hand succeeds while the host agent's own attempt
fails; why the agent's invocation fails was not established.

### Docker is nearly out of disk space

minikube builds the image inside its node, and the node's storage is a volume on
the Docker host's disk, shared with every other container there. An observed
build consumed more than 2.7 GB and was still running when that disk reached
100%, which is why `up.sh` now requires 5 GB free before it starts.

Check with `colima ssh -- df -h /` and `docker system df`. Build cache is the
least disruptive thing to reclaim (`docker builder prune`). Removing one of two
tags of the same image frees only the layers they do not share, which can be far
less than the listed size. Growing colima's disk requires restarting colima,
which stops its running containers.

**Stopping the build client does not stop the build.** Killing `minikube image
build` only disconnects the client; BuildKit inside the node keeps writing. If a
build is filling the disk, delete the node, which removes its storage at once:

```sh
minikube delete -p slaude-local
```

### Deleting a claim does not reset its data

minikube's hostpath storage names each volume's directory after its claim, and
the directory can outlive the claim. Deleting and recreating `dev-postgres-data`
reattaches the old data, so Postgres skips its init scripts and the brain
database is never created. `up.sh` creates the brain database if it is missing.
To truly reset local Postgres, empty the directory while it is scaled down:

```sh
kubectl -n slaude-scale scale deploy dev-postgres --replicas=0
minikube -p slaude-local ssh -- "sudo sh -c 'rm -rf /tmp/hostpath-provisioner/slaude-scale/dev-postgres-data/*'"
kubectl -n slaude-scale scale deploy dev-postgres --replicas=1
```

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
