# slaude — local minikube overlay

Runs the horizontal-scale topology from [`deploy/k8s-scale`](../k8s-scale) on a
single-node minikube, with everything the HA work added: two gateway replicas;
node workers for two labels, `default` (two replicas) and `finance` (one), each
deployment with its own signed node credential; in-cluster Postgres and Redis; a
dev-mode Vault holding each persona's provider key; the mock MCP server the MCP
bridge calls; a shared `$SLAUDE_HOME` volume; and a persona set synced as code.
The production manifests are referenced, not copied, so what you run locally is
what ships.

```sh
deploy/k8s-local/up.sh           # create the cluster, build the image, deploy, seed Vault, sync personas, wait
deploy/k8s-local/verify-ha.sh    # failover, credentials, the legacy door, the node boot check, personas as code
deploy/k8s-local/verify-turns.sh # turn delivery, label routing and the gate, rotation, the bridge, unserved, relabel
deploy/k8s-local/down.sh         # delete the cluster (add --purge to drop every generated secret)
```

The step-by-step operator checklist for the mock HA test is
`docs/superpowers/plans/2026-10-05-operator-mock-test-checklist.md`.

## The topology

| Piece | Local form | What it is for |
|---|---|---|
| `slaude-gateway` x2 | the base, trimmed | Slack ingress, `/v1`, `/deploy`, Vault client, MCP bridge |
| `slaude-node` x2 | label `default`, signed credential `local-default` | turns of `default` and `alpha` |
| `slaude-node-finance` x1 | label `finance`, signed credential `local-finance` | turns of `beta`; one replica so stopping it shows an unserved label |
| `vault` | dev mode, in memory, token auth | `secret/slaude/personas/<persona>` holds each persona's key |
| `mock-mcp` | `mock-mcp/server.ts` | the bridge's upstream (one tool, `echo`), and the portal's OAuth test server |
| `dev-postgres`, `dev-redis` | single replicas | datastores |

The persona set is [`personas/local-set.json`](personas/local-set.json):

| Persona | Label | Provider | Also |
|---|---|---|---|
| `default` | `default` | Vault `secret/slaude/personas/default` | |
| `alpha` | `default` | Vault `secret/slaude/personas/alpha` | |
| `beta` | `finance` | Vault `secret/slaude/personas/beta` | `kbSources: [kb-local-finance]`; bridged MCP server `mockmcp` (static bearer from `PERSONA_BETA_MOCKMCP_TOKEN`) |

`up.sh` also creates two knowledge bases on the shared volume,
`knowledge/local-handbook/` and `knowledge/local-finance/`; `beta` may read only
the second. The verify scripts add a `verifier` persona to the set.

What the overlay sets, and why:

- Nodes hold only Redis and their credential. `SLAUDE_PROVIDER_ENV_FALLBACK=0`, so
  every persona's key comes from Vault through its runtime bundle, and a persona
  without one fails its turn instead of running on a node key.
- Nodes run with `SLAUDE_NODE_BOOT_CHECK=refuse` (from the base) and an empty
  stdio MCP manifest at `/etc/slaude/node.json`.
- The gateway has `SLAUDE_VAULT_ADDR=http://vault:8200` with
  `SLAUDE_VAULT_AUTH=token` and `SLAUDE_VAULT_ALLOW_INSECURE=1` (development only;
  production uses Kubernetes auth), `SLAUDE_VAULT_CACHE_TTL=10`,
  `SLAUDE_OUTBOUND_INTERNAL_HOSTS=mock-mcp,vault` and
  `SLAUDE_LABEL_UNSERVED_SECS=20`. The Vault token is a read-only token
  `vault.sh` creates; the root token is in a Secret only the vault pod loads.

Choices `up.sh` takes from the environment:

| Variable | Default | Effect |
|---|---|---|
| `SLAUDE_LOCAL_NODE_AUTH` | `signed` | `legacy`: the `default` deployment presents the shared legacy token instead (label `default` only); `finance` stays signed |
| `SLAUDE_LOCAL_LEGACY_DOOR` | `open` | `closed`: `SLAUDE_NODE_LEGACY=off` on the gateways, so only signed credentials work (needs `NODE_AUTH=signed`) |
| `SLAUDE_LOCAL_SYNC_PERSONAS` | `1` | `0` skips the persona sync (the e2e suite needs a never-synced tenant) |
| `SLAUDE_LOCAL_ALPHA_SLACK_USER`, `SLAUDE_LOCAL_BETA_SLACK_USER` | placeholders | the bot user ids of the Slack apps registered for `alpha` and `beta` |
| `SLAUDE_LOCAL_MANAGER` | unset | your Slack user id, written into every soul as manager (approvals, the manager-only connect card) |

Re-running `up.sh` with another `NODE_AUTH` or `LEGACY_DOOR` value switches the
cluster; the gate in the release plan wants both verify scripts to pass with
signed nodes, with legacy nodes, and once with the door closed.

## Prerequisites

- `minikube`, `kubectl`, `openssl`, `python3` and `bun` (`up.sh` mints the node
  credentials with the repo's own CLI, `src/cli/node-token.ts`).
- A Docker runtime whose VM has at least **5 CPUs and 7.5 GB** of memory. This
  floor is **provisional, to be measured**. The smaller topology (two gateways,
  two nodes, the datastores) ran in a 3 CPU / 3.5 GB minikube node inside a
  4 CPU / 6 GB VM with roughly 100 MB left under load; the finance node, Vault
  and the mock MCP server grew the node to 4 CPU / 4864 MB, and the floor by the
  same margin. It is not yet the smallest that passes `verify-turns.sh` twice in
  a row. `up.sh` warns when the VM is smaller.
  On macOS with colima, `colima ssh -- free -m` shows what is actually
  available; other containers you run share that memory.
- At least **5 GB** of free disk on the Docker host once the cluster is up.
  `up.sh` checks this before building and refuses below it
  (`SLAUDE_LOCAL_MIN_BUILD_FREE_MB` overrides the floor). The node's storage
  lives on the same disk as every other container on that host, so running it
  out of space is not contained to this cluster.

Set `SLAUDE_LOCAL_OVERLAY` to apply a different overlay that builds on this one; used by the e2e suite.

Tune the node with `SLAUDE_LOCAL_CPUS` and `SLAUDE_LOCAL_MEMORY` (MB). The
defaults are 4 CPUs and 4864 MB. A profile created at the old size must be
recreated (`down.sh`, then `up.sh`): an existing profile keeps its size.

The node size, the VM floor and the room the node keeps for itself are written
down once, in [`sizing.env`](sizing.env). The per-pod requests and limits in
`kustomization.yaml`, `vault.yaml` and `mock-mcp/mock-mcp.yaml` are sized
against it: the limits of two gateways, two default nodes, the finance node,
Postgres, Redis, Vault and the mock MCP server sum to no more than the node,
minus a system reserve.
`tests/deploy/local-sizing.test.ts` fails when the two disagree, so change
them together.

Two things about those numbers, both provisional until measured. First, a node
pod holds bun plus one `claude` CLI child per warm session (about 150-200 MB
each), so its limit is 896 Mi: 200 + 3 x 200 = 800 MB for three warm sessions.
The memory sum is then 2 x 448 (gateway) + 3 x 896 (nodes) + 240 (Postgres) + 64
(Redis) + 192 (Vault) + 192 (mock MCP) = 4272 MB, against 4864 - 500 = 4364 MB;
the CPU limits sum to exactly the 3800m available. Second, Keycloak
(`panel.sh`) is an optional add-on left out of that sum: its 1 Gi limit is
overcommitted by design when it runs, and what must fit is requests.

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
`CLAUDE_CODE_OAUTH_TOKEN` are read from that file (plus `SLAUDE_LOCAL_MODEL`,
below). Values are never printed.

They go to the **gateway** only (its own model calls) and into **Vault**:
`vault.sh seed` writes each persona's secret from them (`api_key`, `auth_token`,
`oauth_token`, `base_url`, whichever are set), and each persona's `provider`
references its own secret. Nodes never hold them. Without any, each secret holds
a placeholder key: enough for the verify scripts (their turns are suppressed),
not for a model call. A secret is re-written when `provider.env` changes, so
re-run `up.sh` after changing a key; a `vault.sh rotate` is kept until then.

### Choosing the model

The base ConfigMap sets `SLAUDE_MODEL` to an Anthropic model name, which is
wrong for any other Anthropic-compatible gateway. Set the cluster default with
`SLAUDE_LOCAL_MODEL`, from your shell or the same dotenv file:

```sh
SLAUDE_LOCAL_MODEL=provider/some-model deploy/k8s-local/up.sh
```

It is written to `model.env` (always created; empty keeps the base default) and
merged into the `slaude-scale-config` ConfigMap. It cannot go in `provider.env`:
pods load the Secret first and the ConfigMap second, and the later source wins,
so the base value would override it. This is the cluster default; a persona
that carries its own model (where supported) takes precedence.

Generated files, all gitignored:

| File | Contents | Secret / ConfigMap | Lifetime |
|---|---|---|---|
| `secrets.env` | master key, job-token secret, node key, legacy node token, datastore URLs, the gateway's Vault token, `PERSONA_BETA_MOCKMCP_TOKEN` | `slaude-scale-secrets` (gateway only) | created once, reused; missing keys appended |
| `node.env` | the Redis URL, copied from `secrets.env` | `slaude-scale-node-secrets` (every node) | rewritten every run |
| `node-credentials.env` | the minted signed credentials (`NODE_CRED_DEFAULT`, `NODE_CRED_FINANCE`) | none (source for the next two) | minted once; again when missing, invalid or under 7 days |
| `node-cred-default.env`, `node-cred-finance.env` | one deployment's `SLAUDE_NODE_TOKEN` | `slaude-scale-node-cred-default` / `-finance` | rewritten every run (`NODE_AUTH` decides default's) |
| `vault-root.env` | the dev Vault's root token | `slaude-local-vault` (vault pod only) | created once, reused |
| `deploy.env` | the `/deploy` pipeline token | `slaude-scale-deploy` (gateway only) | created once, reused |
| `provider.env` | model provider credentials | the gateway's Secret; seeded into Vault | rewritten every run |
| `model.env` | the optional `SLAUDE_MODEL` default | merged into `slaude-scale-config` | rewritten every run |
| `gateway.env` | `SLAUDE_NODE_LEGACY=off` when the door is closed | merged into `slaude-scale-gateway-config` | rewritten every run |

`secrets.env` is deliberately never regenerated. The master key encrypts the
Slack app registry at rest, and a new key would orphan every row encrypted under
the old one.

Nodes never load `secrets.env`: a node holding the master key or the job-token
secret could act as the gateway, and the nodes here refuse to boot with one. A
cluster created before this split loaded one Secret into both tiers; re-running
`up.sh` derives the node files from the existing `secrets.env`, keeping every
value. Afterwards treat the job-token secret and the master key as exposed; see
the Secret split section of the multi-node deploy guide (there is no
re-encryption tool for the master key yet, so do not rotate it on a cluster
whose stored credentials you want to keep).

## Operating the local cluster

### Personas: sync, relabel

```sh
deploy/k8s-local/personas.sh sync                          # the set as in personas/local-set.json
deploy/k8s-local/personas.sh sync --relabel beta=default   # beta's next turns run on default nodes
deploy/k8s-local/personas.sh sync                          # and back to finance
```

A sync replaces the whole set; a relabel lasts until the next plain sync (or
`up.sh`). Each sync prints one JSON line with the HTTP status, the gateway's
warnings and each persona's soul hash prefix (what a node logs at session boot as
`soul=`). For a real-Slack run export `SLAUDE_LOCAL_ALPHA_SLACK_USER`,
`SLAUDE_LOCAL_BETA_SLACK_USER` and `SLAUDE_LOCAL_MANAGER` first.

### Provider keys: rotate

```sh
deploy/k8s-local/vault.sh status                  # each persona's secret version, never a value
printf '%s\n' "$NEW_KEY" | deploy/k8s-local/vault.sh rotate alpha   # new version from stdin
deploy/k8s-local/vault.sh rotate alpha            # (from a terminal) a new placeholder
deploy/k8s-local/vault.sh reseed alpha            # back to the value from provider.env
```

`rotate` prints the new version and a sha256 prefix of the value, never the value.
The gateway resolves a reference again once its cached value is older than
`SLAUDE_VAULT_CACHE_TTL` (10 s here), so the next **new thread** uses the new
key; a warm session keeps its key until it is respawned or reloaded. Dev mode
keeps Vault in memory: if the vault pod restarts, every secret, the policy and
the gateway's token are gone (the gateway then fails resolutions with
`outcome="error"` or `denied`) until `vault.sh seed` or `up.sh` runs again. That
is also the quickest way to exercise the Vault alert.

### Node credentials: inspect, revoke, re-mint

The node key is `SLAUDE_NODE_KEY` in the gateway's Secret, so these run on a
gateway; the credential goes in on stdin, never on a command line:

```sh
NS="-n slaude-scale"
# inspect the finance credential (claims only, never the key)
sed -n 's/^SLAUDE_NODE_TOKEN=//p' deploy/k8s-local/node-cred-finance.env | tr -d '\n' \
  | kubectl $NS exec -i deploy/slaude-gateway -- bun run node-token inspect -
# revoke it: every credential with this id issued before now is refused within 30 s
kubectl $NS exec deploy/slaude-gateway -- bun run node-token revoke local-finance
```

After a revoke the finance node gets `401` on its next call, pauses its claim
loops (`slaude_node_auth_paused` = 1, `/readyz` 503, `/healthz` still 200) and
`finance` becomes unserved. To recover, remove the `NODE_CRED_FINANCE` line from
`node-credentials.env` and re-run `up.sh`: it mints a new credential (issued
after the revocation, so accepted) and rolls the pods. `bun run node-token mint`
on a gateway does the same by hand; the token is printed once.

### Node boot check

The node deployments set `SLAUDE_NODE_BOOT_CHECK=refuse`. To see a node refuse a
gateway-only variable without touching the deployment, `verify-ha.sh` runs the
node entry inside a node pod with one fake variable; by hand:

```sh
kubectl -n slaude-scale exec deploy/slaude-node -- sh -c \
  'cd /app && env -i PATH="$PATH" HOME=/tmp SLAUDE_HOME=/tmp/x SLAUDE_ROLE=node SLAUDE_NODE_BOOT_CHECK=refuse SLAUDE_JOB_SECRET=fake bun src/node/main.ts'
# [node] refusing to boot: gateway-only variables are set in this node's environment: SLAUDE_JOB_SECRET. ...
```

### The bridge's upstream: revoke, restore

```sh
kubectl -n slaude-scale exec deploy/mock-mcp -- bun -e 'await fetch("http://localhost:9000/control/revoke",{method:"POST"})'
kubectl -n slaude-scale exec deploy/mock-mcp -- bun -e 'await fetch("http://localhost:9000/control/restore",{method:"POST"})'
```

While revoked the mock answers every bearer with 401, so a bridged call returns
`this agent's connection to mockmcp needs to be re-authorised` and the gateway
posts the connect card (to the manager, in a thread with no `/1on1` lock).


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
| Every node is admitted with exactly its label | `GET /v1/node/whoami` from each node pod with its own credential: 200, labels `['default']` or `['finance']`; signed when the door is closed |
| The legacy door is as configured | the gateway's own `SLAUDE_NODE_LEGACY_TOKEN` against `whoami`: 401 with the door closed, 200 and `legacy` with it open |
| A node holding a gateway-only variable refuses to boot | the node entry, run in a node pod with a clean environment plus a fake `SLAUDE_JOB_SECRET` and the pod's own boot-check mode, must exit non-zero naming the variable and never its value |

The persona sync in `verify-ha.sh` goes through `personas.sh`, so it leaves the
local set synced, plus `verifier`.

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
| A `finance` persona's turns run on `finance` nodes only | two `beta` turns, their label resolved as dispatch resolves it (`runsOnFor` over the live persona rows); their session boots must appear in the finance node's log and in no default node's |
| The label gate | a job token for `beta` (signed `finance`) presented by a **default** node: the bundle is refused with 403; by a finance node: 200; `alpha`'s on a finance node: 403 |
| A rotated key reaches the next new thread | `vault.sh rotate beta`, then fresh bundles (each with a new session's job token) until the key's hash prefix is the rotated one; restored with `vault.sh reseed beta` on exit |
| The MCP bridge | from the finance node with `beta`'s token, `mockmcp` lists `echo` and a call returns `echo: <word>`; `alpha`'s token gets 404 for `mockmcp` |
| An unserved label waits | `slaude-node-finance` scaled to 0; a `beta` turn stays waiting on `turns.label.finance`, the reaper leader exports `slaude_label_unserved{label="finance"} 1`, and the turn runs once the replica is back (restored on exit in any case) |
| A relabel moves the next turn | `personas.sh sync --relabel beta=default`; the next `beta` turn resolves to `default` and boots on a default node; the set is synced back |

Not covered by the scripts, because it needs a turn dispatched by a gateway
(Slack or the e2e suite): an **in-flight** turn being re-dispatched once with
`LABEL_MISMATCH` after a relabel. It is a step of the real-Slack runbook below.

The turns are **suppressed**: the node runs the whole lifecycle — claim, session
lock, completion marker, ack — while the prompt hook stops the model. So the
script needs no model credentials and costs no provider tokens.

Recovery is not instant. A killed node never releases its `lock:session:<id>`,
so the re-delivered turn waits for that lock's TTL before another node can run
it. Production defaults to **10 minutes**; this overlay sets
`SLAUDE_SESSION_LOCK_TTL_MS=45000` so the takeover happens in under a minute and
the script stays quick. The run prints how long it actually took (50 s on a
45 s TTL, last measured). **45 s is this overlay's value, not the default**, and
BullMQ's stall detection (30 s lock and 30 s check, untuned) must fire as well,
so no takeover is faster than about 30 s whatever the TTL.

Both verify scripts pin the node HPA for the run (`maxReplicas` set to
`minReplicas`, restored by an `EXIT` trap; the original value is kept in a
`slaude.dev/original-max-replicas` annotation, so a run killed before its trap
cannot leave it pinned). Left alone the HPA scales to three nodes under turn
load and holds there for ten minutes.

`verify-turns.sh` prints every diagnostic (`!!` lines) to stdout **and** to a
log file named on its first line (`VERIFY_TURNS_LOG` sets the path). A probe
that fails or returns something that is not JSON says which probe and what it
received, and a check it could not measure says so instead of reporting a wrong
value.

## Real-Slack smoke runbook

Run on a release candidate (the release plan's gate, item 4), after both verify
scripts pass. You need a tunnel to the gateway (below), and one Slack app per
persona you test, registered with the gateway (see the webhook-mode guide for
`bun run slack-app add --persona <name>`); export their bot user ids and your
own id (`SLAUDE_LOCAL_ALPHA_SLACK_USER`, `SLAUDE_LOCAL_BETA_SLACK_USER`,
`SLAUDE_LOCAL_MANAGER`) and run `personas.sh sync`. Real provider credentials
must be in `provider.env` (re-run `up.sh`). Each step must pass:

1. **Mention and reply.** In a channel, mention `alpha`; a reply arrives.
2. **Follow-up without a mention.** Reply in that thread without mentioning it;
   it answers.
3. **Approval survives a second click.** Ask for something that needs approval;
   click Approve, then click it again: the card keeps its decision.
4. **`/link`.** Run `/link`; the private reply with the portal link arrives.
5. **Kill the node running a live turn.** Start a long answer from `alpha`, find
   the node logging its session (`kubectl logs -l app.kubernetes.io/component=node`),
   SIGKILL that container (as `verify-turns.sh` does) and watch the answer
   arrive; with the local lock TTL this takes under a minute.
6. **Rotate a provider secret.** `printf '%s\n' "$OTHER_KEY" | vault.sh rotate alpha`;
   wait 10 s; a **new thread** with `alpha` works on the new key (an invalid
   value makes it fail with the fixed provider-credentials message instead;
   `vault.sh reseed alpha` restores it).
7. **Relabel.** Start a long `beta` turn, then `personas.sh sync --relabel beta=default`
   while it runs: the next `beta` turn lands on a default node, and the in-flight
   one is re-dispatched once (its node no longer serves `beta`'s label only if
   you also stop the finance node; otherwise it finishes there, which is also
   correct). `personas.sh sync` puts it back.
8. **A bridged tool as the agent and as the user.** Ask `beta` to call the
   `mockmcp` echo tool; then in a `/1on1` with `beta`, ask again (the call runs
   as you; `mockmcp` is not private, so the static bearer is used).
9. **Revoke the grant upstream.** Revoke the mock (above) and ask `beta` to call
   the tool: the fixed re-authorise error appears, and the connect card is posted
   for the manager. Restore the mock afterwards.

## Alerts to exercise

Every alert in the docs' alerts runbook must be made to fire once and cleared.
The local cluster can produce each one; scrape the gateways on `:8080/metrics`
and the nodes on `:8081/metrics` (`kubectl port-forward` or `forward.sh`):

| Alert | How to make it fire here | How to clear it |
|---|---|---|
| Vault unreachable | `kubectl -n slaude-scale scale deploy/vault --replicas=0`, then start a new thread (or wait for `verify-turns.sh`'s rotation step) | scale back to 1, then `vault.sh seed` (dev mode lost everything) |
| A label with no live node | `kubectl -n slaude-scale scale deploy/slaude-node-finance --replicas=0` and send `beta` a message (or `verify-turns.sh`) | scale back to 1 |
| A node credential close to expiry | mint a credential with `--ttl 10d` on a gateway, put it in `node-cred-finance.env` by hand and `kubectl apply` the overlay without `up.sh` (which would re-mint) | re-run `up.sh` |
| A rising rate of 403 from the gate | `verify-turns.sh` produces a few (`[v1] gate denied:` lines); for a steady rate, swap the two credential files and apply the overlay | re-run `up.sh` |
| The legacy door in use while a node key is set | `SLAUDE_LOCAL_NODE_AUTH=legacy up.sh` | `up.sh` (signed) |
| A node pod holding gateway-only variables | the boot check refuses before the gauge is useful; to see the gauge, set `SLAUDE_NODE_BOOT_CHECK=warn` and add any gateway-only variable to the node deployment (`kubectl set env`) | re-apply the overlay |
| A node paused on a refused credential | `node-token revoke local-finance` (above) | re-mint as above |

## Rollback rehearsal

The release plan requires one configured-then-rolled-back rehearsal; the docs'
rollback runbook has the procedure. This cluster has every feature configured
(Vault references, `beta` on `finance`, `kbSources`, signed credentials; close
the door with `SLAUDE_LOCAL_LEGACY_DOOR=closed up.sh`). To rehearse:

1. Remove the settings through a sync: edit a copy of `personas/local-set.json`
   without `runsOn` and `kbSources` (the `provider` blocks are added by the sync
   script; skip that by syncing with an older image, or accept the table in the
   runbook), or choose to accept the table.
2. Build the older release's image as `slaude:local` (check out the older tag
   and run `up.sh` from it, gateways first: `kubectl rollout status` the gateway
   before the nodes roll), with `SLAUDE_LOCAL_NODE_AUTH=legacy` and the door open,
   since an older gateway refuses signed credentials.
3. Check a turn for each persona and compare with the runbook's table; then roll
   forward (this checkout's `up.sh`) and check each persona is back on its label,
   scope and provider.

Record what ran and what differed. Steps 1 and 2 were written from the runbook,
not yet run on this overlay.

## Reaching the cluster from your machine

```sh
deploy/k8s-local/forward.sh gateway    # localhost:$SLAUDE_LOCAL_PORT (8080)
deploy/k8s-local/forward.sh keycloak   # localhost:8180, after panel.sh
deploy/k8s-local/forward.sh mock-mcp   # localhost:9000, after mock-mcp/mock-mcp.sh
```

A bare `kubectl port-forward svc/...` binds one pod and goes quiet when that
pod is replaced; anything using it (a browser, a tunnel) just fails. `forward.sh`
forwards to one named pod and, every few seconds, checks that its process is
alive, that the pod is still a ready endpoint of the Service, and that the
forwarded port answers; it rebinds when any of those fails. It refuses to start
when the local port is already taken, because a second forward on a busy port
can quietly bind another loopback address while the old listener keeps
answering. Run one per terminal.

`SLAUDE_LOCAL_PORT` moves the gateway port. The Keycloak (8180) and mock MCP
(9000) ports are written into URLs the pods also use, so `panel.sh` and
`mock-mcp.sh` refuse any other value rather than break the login redirect.

### Putting a local tunnel in front of the gateway

To receive real Slack events the gateway needs a public HTTPS name. Use a
tunnel from a hostname you control (`slaude.example.com` below) to the local
forward. What has gone wrong before:

- **One process owns the forward.** The tunnel points at `localhost:8080`, and
  that port is whatever holds it. Run `forward.sh gateway` and nothing else on
  that port, so a rollout does not silently strand the tunnel on a dead pod.
- **List the tunnel's connectors first.** A second connector for the same
  tunnel can be running unnoticed on the machine (an old terminal, a service
  started at login), and traffic is split between them, so half the requests
  reach a stale forward. Before debugging anything else, list the tunnel's
  connectors and stop all but the one you mean.
- **A Slack Request URL fails silently.** When the path is down, the Events API
  Request URL flips to "didn't respond" and stays that way after the path
  heals. Press **Retry** in the Slack app's Event Subscriptions page once
  `curl https://slaude.example.com/healthz` answers.
- **Recycle the forward after any rollout.** `up.sh`, `panel.sh` and
  `mock-mcp.sh` restart the gateway; `forward.sh` rebinds by itself, but a
  hand-run `kubectl port-forward` does not.

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
  handled it. The Slack leg itself still needs a tunnel. So does the one-time
  re-dispatch of an in-flight turn after a relabel, which only the dispatching
  gateway performs.
- **Vault Kubernetes auth.** The local gateway uses a token; the projected
  ServiceAccount token and the Vault role binding are only exercised on a
  cluster with a real Vault.
- **Label isolation of Redis and files.** Every node can read every queue and
  the shared volume; the gate protects credentials, not job payloads. The
  verify scripts prove the gate, not isolation.

## Troubleshooting

### A persona's turn fails with the provider-credentials message

The nodes run with the fallback off, so a persona whose bundle carries no key
fails. Check `vault.sh status` (a restarted vault pod has lost everything: run
`vault.sh seed`), then the gateway log for `[provider.cred.resolve]` lines (they
give the outcome, never the path or value).

### `personas.sh sync` answers 422

The JSON line carries the gateway's error, which names the persona and field
and never a value. A `vault://` reference outside `SLAUDE_VAULT_ALLOWED_PREFIXES`,
or an `http` base URL whose host is not in `SLAUDE_OUTBOUND_INTERNAL_HOSTS`, is
refused at sync.

### The finance node never becomes ready

Its log says why: a `401` at the `whoami` handshake means its credential does
not verify (minted under another `SLAUDE_NODE_KEY`, expired or revoked): remove
`NODE_CRED_FINANCE` from `node-credentials.env` and re-run `up.sh`. A
`refusing to boot` line names a variable it must not hold.

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
| Two replicas per label, KEDA per label | `finance` has one replica and no autoscaler |
| Vault (external), Kubernetes auth | dev-mode Vault in the cluster, token auth, plain http |
| Provider env fallback configurable | off; nodes hold no provider key |
| No in-cluster MCP server | the mock MCP server, listed in `SLAUDE_OUTBOUND_INTERNAL_HOSTS` |
| RWX storage class of your choice | minikube `standard` (hostpath) |
| External managed Postgres and Redis | in-cluster dev stand-ins |
| Ingress with TLS | none; the Service is kept |
| KEDA queue-depth autoscaling | CPU HPA fallback, capped at three nodes |
| Node drain 120 s, grace 150 s | drain 30 s, grace 45 s |
| Production-sized requests | trimmed to fit a laptop (see `sizing.env`) |
| Kubernetes' default probe timing (1 s timeout, 3 failures) | 5 s timeout, 5 failures and a `startupProbe`, patched in this overlay only |

Plain `kubectl apply -k` refuses this overlay, because it references files
outside its own directory. `up.sh` renders it with the load restrictor relaxed:

```sh
kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/k8s-local | kubectl apply -f -
```
