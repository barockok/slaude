---
title: Multi-Node Deployment
description: Run slaude horizontally — gateway replicas + node workers over Postgres, Redis and a shared volume. Local dev loop, docker compose topology, and the multi-node test surface.
---

# Multi-Node Deployment

The horizontal-scale split (spec: `docs/internal/superpowers/specs/2026-08-24-horizontal-scale-design.md`) separates the **gateway** (Slack ingress, `/v1` REST, queue dispatch, reaper leader) from **node workers** (BullMQ consumers running the actual SDK turns). State lives in Postgres (sessions, gates, dedup) and Redis (queues, warm-session registry, locks, pub/sub, event streams); `$SLAUDE_HOME` is a shared volume (SOUL.md, skills, workspaces).

```mermaid
flowchart TB
  Slack["Slack Events API"]
  GW["gateway — SLAUDE_ROLE=gateway, :8080<br/>/slack/events · /slack/interactions · /v1 · /healthz · /metrics"]
  PG[("Postgres")]
  Redis[("Redis<br/>turn queues · session registry · locks · events")]
  N1["node-1<br/>SLAUDE_ROLE=node · bun run worker · /v1 client"]
  N2["node-2<br/>SLAUDE_ROLE=node · bun run worker · /v1 client"]

  Slack --> GW
  GW <--> PG
  GW -->|enqueueTurn| Redis
  Redis -->|claim / heartbeat / event streams| N1
  Redis -->|claim / heartbeat / event streams| N2
  N1 -->|/v1| GW
  N2 -->|/v1| GW
```

Roles are env flags. `SLAUDE_ROLE=mono` (the default) keeps the single-process behavior, and nothing here changes the mono deploy.

---

## Local dev loop

Prereqs: a real Redis and (optionally) a real Postgres. BullMQ cannot run on an in-memory mock — the multi-node paths always need real Redis.

```sh
docker run -d --name slaude-redis -p 6379:6379 redis:7
docker run -d --name slaude-pg -p 5432:5432 \
  -e POSTGRES_USER=slaude -e POSTGRES_PASSWORD=slaude -e POSTGRES_DB=slaude postgres:16
```

**Multi-node sim** — the full transcript-fixture suite through the real queue path (gateway role + N in-process node workers, StubAgent on the node side over the REST shim tool plane):

```sh
# PGLite (in-process Postgres) + real Redis
SLAUDE_DB=pg SLAUDE_REDIS_URL=redis://localhost:6379 bun sim run --nodes 2

# real Postgres + real Redis
SLAUDE_DB=pg SLAUDE_PG_URL=postgres://slaude:slaude@localhost:5432/slaude \
  SLAUDE_REDIS_URL=redis://localhost:6379 bun sim run --nodes 2
```

All 26 fixtures must pass unchanged — same transcripts as the mono sim, no `--nodes`-specific fixtures.

**Scenario tests** — warm→cold resume, node kill mid-turn + BullMQ retry, approval click on replica 2, message coalescing, Slack retry dedup across replicas:

```sh
SLAUDE_REDIS_TEST_URL=redis://localhost:6379 bun test ./tests/integration
```

They gate on `SLAUDE_REDIS_TEST_URL` (skipped without it), run under random Redis key prefixes, and clean up after themselves. Add the `SLAUDE_DB=pg` / `SLAUDE_PG_URL` envs to run them against PGLite or real Postgres. The rest of the real-Redis surface lives in `tests/queue` (queue primitives) and `tests/node` (gateway↔node E2E), same gate.

---

## docker compose (gateway + 2 nodes)

`docker-compose.scale.yaml` runs the full topology from the existing Dockerfile: Postgres 16 with pgvector, `redis:7`, one gateway (Slack **http** mode — Events API on `:8080`), two node workers, `$SLAUDE_HOME` on a shared named volume, healthchecks throughout.

> **Gateway requirements.** Gateways and nodes both scale horizontally, so every gateway replica must be interchangeable. `SLAUDE_ROLE=gateway` refuses to boot unless all three hold, and lists every violation at once:
>
> - **Slack over the Events API webhook** (`SLAUDE_SLACK_MODE=http`). Socket Mode's websocket consumer is single-leader, so replicas would duplicate responses. Socket Mode is the default when unset.
> - **slaude data on a Postgres server** (`SLAUDE_DB=pg` and `SLAUDE_PG_URL`). `SLAUDE_DB=pg` without a URL selects in-process PGLite, which each replica would hold privately.
> - **The brain on Postgres** (`SLAUDE_BRAIN_ENGINE=postgres` and `SLAUDE_BRAIN_DATABASE_URL`), or disabled, or in remote mode. The default PGLite engine is single-writer and clears locks it finds at boot, so replicas on the shared volume would corrupt it. The brain gets its own `slaude_brain` database with the `vector`, `pg_trgm` and `pgcrypto` extensions; `deploy/postgres-init` creates it on a fresh volume.

```sh
cat > .env <<EOF
SLAUDE_NODE_TOKEN=$(openssl rand -hex 24)
SLAUDE_JOB_SECRET=$(openssl rand -hex 24)
SLAUDE_MASTER_KEY=$(openssl rand -base64 32)
ANTHROPIC_API_KEY=sk-ant-…        # nodes need LLM auth to run real turns
EOF

# The gateway refuses to boot while the slack_apps registry is empty —
# register your Slack app first (one-off container, same env):
docker compose -f docker-compose.scale.yaml run --rm gateway \
  bun run slack-app add --api-app-id A… --team-id T… \
  --bot-token xoxb-… --signing-secret …

docker compose -f docker-compose.scale.yaml up --build -d
docker compose -f docker-compose.scale.yaml ps    # all five services → healthy
```

Point your Slack app's Events API request URL at the gateway's `:8080/slack/events` (interactions at `/slack/interactions`). The stack boots and reports healthy without ANTHROPIC creds — turns just won't run until the nodes have them. Scale nodes by adding services (or `docker compose … up --scale`-style tooling of your choice); each worker names itself `<hostname>-<rand>` and registers its own per-node queue.

> **`SLAUDE_MASTER_KEY` is not rotatable in place.** It encrypts the Slack app secrets in the `slack_apps` registry and every MCP credential at rest. Regenerating it orphans every existing row — the old ciphertext can no longer be decrypted, the gateway will fail to resolve those apps, and every connected MCP integration has to be reconnected. Keep the key stable across restarts. A gateway refuses to boot without a usable key.

The single-process deployment stays in `docker-compose.yaml` — the scale file never touches it.

### MCP credentials

Every MCP credential — the agent's own shared identity per persona, and each person's own from their 1:1 — is held by the gateway in Postgres, encrypted under `SLAUDE_MASTER_KEY`. `/mcp connect` and `/mcp disconnect` write there; on a gateway they no longer write files to the shared volume.

A node never holds the grant itself. At the start of each turn it fetches the **access tokens** for the identity the turn runs as, and writes them into a config directory that belongs to that session on that pod. Refresh tokens and client secrets never leave the gateway. When a token expires the gateway refreshes it, either as the node fetches at turn start or when the agent reports the server as needing authorization mid-turn, and the node's next call uses the new one.

What a deployment needs:

- **A writable pod-local path on every node**, `SLAUDE_NODE_CONFIG_ROOT` (default `/config-home`). The Kubernetes manifests mount an `emptyDir` there. In docker compose each container's own filesystem already is one. It must not be on the shared volume: the agent writes its credentials file by renaming over it, which silently un-shares any file two processes share.
- **The shared volume stays ReadWriteMany** for transcripts. Session config homes link their `projects/` directory back onto it, so a session resumed on another node still finds its history.
- **Nothing to migrate by hand.** On boot each gateway imports credentials still on disk from before this existed. It is insert-only and never overwrites anything already stored, so every replica can run it. It leaves the files in place so a rollback still works. A person's credentials import only once their Slack user is linked to an account with `/link`. Until then they stay on disk, and the person reconnects after linking.

Losing a node pod loses nothing: a node holds no credential the gateway does not. If a provider revokes a grant, the owner reconnects. For a person that happens in their 1:1. For the agent's shared identity a manager reconnects it.

### Delivery semantics under node failure

Turn delivery is **at-least-once, deduplicated to effectively-once** for the common failure windows:

- A node killed **mid-turn** (before any Slack post): BullMQ stall recovery re-delivers the job, and another node runs the turn once. Not immediately, though: a killed node never releases its `lock:session:<id>`, so the re-delivered turn waits for that lock's TTL to expire — **10 minutes by default** — before another node can run it. Nothing is lost or duplicated; the turn is late. Tune it with `SLAUDE_SESSION_LOCK_TTL_MS` and `SLAUDE_SESSION_LOCK_EXTEND_MS` (defaults 600000 and 60000). The TTL must stay at least three times the renewal cadence, or a late renewal could cost a live node its session mid-turn; the process refuses to start otherwise. The local cluster runs 45000/5000, where a killed node's turn was measured taking over in 50 seconds.
- A node killed **after the turn but before the BullMQ ack** (the zombie window): the worker writes a `turn-done:<jobId>` marker to Redis the moment the agent turn finishes, *before* any ack. The retried delivery finds the marker and completes the job without re-running the turn — no duplicate Slack posts.
- **Residual window**: a node dying *between its last Slack post and the marker write* (single-digit milliseconds) still replays the turn on retry. This is the irreducible at-least-once residue of a post-to-external-system-then-record design; Slack-side `ts` inspection is the audit trail if it ever fires.

---

### Verifying it yourself

Two scripts, both against the local scale cluster from `deploy/k8s-local`:

- `verify-ha.sh` — the infrastructure: two of each tier, heartbeats, leader election, the reaper, the shared volume, credential placement, and recovery from killing a gateway, the reaper leader and a node.
- `verify-turns.sh` — the turn path itself: it enqueues turns through the real queue from inside a gateway pod, kills the node running them, and asserts every turn still completes exactly once with nothing left pending or failed; then it fires one cron occurrence and asserts the two gateways dispatch it once between them.

`verify-turns.sh` uses suppressed turns, so the whole lifecycle runs — claim, session lock, completion marker, ack — without a model call, and it costs no provider tokens. It reports how long recovery actually took, which is dominated by the session-lock TTL above.

## The Secret split

A node needs four things: its own credential, Redis, the gateway's URL and, while the provider env fallback exists, a provider key. Everything else the gateway holds lets its holder act as the gateway. With `SLAUDE_JOB_SECRET` a node can mint a job token for any persona and any `runAs`, and through the credential endpoints read any person's MCP tokens and remote-execution key. With `SLAUDE_MASTER_KEY` it can decrypt every stored credential. The database URLs give it every tenant's rows. Every agent child on a node runs as the node's user, so whatever the node holds, a prompt-injected turn can read.

So each tier gets its own Secret:

| Secret (`deploy/k8s-scale/10-secrets.yaml`) | Holds | Loaded by |
|---|---|---|
| `slaude-scale-secrets` | `SLAUDE_MASTER_KEY`, `SLAUDE_JOB_SECRET`, `SLAUDE_PG_URL`, `SLAUDE_BRAIN_DATABASE_URL`, the Slack client and signing secrets, `SLAUDE_OAUTH_STATE_SECRET`, deploy tokens, the gateway's provider key | gateways, through `envFrom` |
| `slaude-scale-node-secrets` | `SLAUDE_NODE_TOKEN`, `SLAUDE_REDIS_URL`, the provider env fallback | nodes, through `envFrom`; gateways read `SLAUDE_NODE_TOKEN` and `SLAUDE_REDIS_URL` from it by key |

`SLAUDE_GATEWAY_URL` is not secret and stays a plain variable in `50-node.yaml`. `docker-compose.scale.yaml` already gives each tier only its own variables.

The manifests also give the gateway its own ServiceAccount (`slaude-gateway`, in `40-gateway.yaml`), and node pods mount no ServiceAccount token (`automountServiceAccountToken: false`). slaude makes no Kubernetes API call in either tier.

**A node reads no database.** Before the split a node still read the `/1on1` lock straight from Postgres at session start. The gateway now signs the lock into the job token (the `lock` claim), and the node builds the session-mode block from it. In the node role, embedded storage is refused: `SLAUDE_DB` without `SLAUDE_PG_URL`, sqlite, or the brain's embedded PGLite. Anything that still asks for it fails with `NodeDbAccessError` and a logged stack, rather than silently reading an empty in-process database.

**The optional NetworkPolicy.** `deploy/k8s-scale/optional/node-egress-networkpolicy.yaml` allows node egress only to DNS, the gateway on 8080, port 6379 and port 443. It works by port: nodes cannot reach Postgres on 5432 or Vault on 8200, but a Postgres or Vault served on 443 or 6379 would still be reachable. Narrow the 6379 rule with a `to:` block naming your Redis. `/remote` sessions reach the initiator's machine over SSH through the tailnet, so add egress rules for those ports if you use `/remote`. The policy is optional because it only works on a CNI that enforces NetworkPolicy, and it may need your Redis and provider ports. Neither `kustomization.yaml` includes it.

**The node boot check.** At boot a node looks for gateway-only variables in its environment. The list is in `src/config/gateway-only-env.ts`, and the [configuration reference](../reference/configuration.md#queue-redis) repeats it under `SLAUDE_NODE_BOOT_CHECK`. The node reports variable names, never values:

- `SLAUDE_NODE_BOOT_CHECK=warn` (the default in this release): the node logs one warning, sets the gauge `slaude_node_gateway_secrets_present` to the number of offending variables, and boots. Alert on `max(slaude_node_gateway_secrets_present) > 0`.
- `SLAUDE_NODE_BOOT_CHECK=refuse`: the node exits non-zero. `SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1` turns the refusal back into a warning. Use it only as a temporary escape.

A later release makes `refuse` the default. Finish the split while the check only warns. The same list, plus `SLAUDE_NODE_TOKEN` and `SLAUDE_REDIS_URL`, is stripped from the agent child's environment in every role. A `${NAME}` placeholder in `.mcp.json` that names a gateway-only variable is left unexpanded, with the name logged. The runtime bundle never carries the MCP config.

**Known gap: the gateway's `.env` is on the shared volume.** At boot every process loads `$SLAUDE_HOME/.env` (`/data/.env` in these manifests) into its environment, for any variable not already set. That file sits on the shared volume, which nodes and their agent turns can write. A turn on a node can therefore set a gateway variable the manifests leave unset, for example `SLAUDE_SLACK_API_URL`, and it takes effect when a gateway next restarts. The split does not close this. Until it is fixed, set every variable the gateway relies on explicitly in its Secret or ConfigMap, and watch that file.

### Upgrading a cluster that used one Secret

Before this release both Deployments loaded `slaude-scale-secrets`. That Secret is now the gateway's, so it keeps its name and contents. Upgrade gateways first, then nodes:

1. Create the node Secret from the values the cluster already uses. The command copies the node token, the Redis URL, and whichever of the four provider variables are present. It never prints them:

   ```sh
   kubectl -n slaude-scale get secret slaude-scale-secrets -o json \
     | jq '{apiVersion, kind, type,
            metadata: {name: "slaude-scale-node-secrets", namespace: .metadata.namespace},
            data: (.data | {SLAUDE_NODE_TOKEN, SLAUDE_REDIS_URL,
                            ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN}
                         | with_entries(select(.value != null)))}' \
     | kubectl apply -f -
   ```

   You can leave the provider variables out if every tenant's runtime bundle carries provider credentials. A managed tenant (personas as code) or a database persona with no stored provider credentials needs them.
2. Apply `40-gateway.yaml`. Gateways roll onto their ServiceAccount and read the node token and Redis URL from the node Secret, which holds the same values.
3. Apply `50-node.yaml`. Nodes roll onto the node Secret. Each new node pod should log no gateway-secrets warning, and `slaude_node_gateway_secrets_present` should read 0.
4. Keep your copy of `10-secrets.yaml` (or its sealed form) in the two-Secret shape, so the next apply does not undo the split.
5. Deal with what nodes were exposed to (below).

On the local cluster (`deploy/k8s-local`), re-running `up.sh` does steps 1 to 4. It derives `node.env` from the existing `secrets.env`, so every value is kept.

### What nodes were exposed to

Any cluster that ran nodes with the shared Secret must treat `SLAUDE_JOB_SECRET` and `SLAUDE_MASTER_KEY` as exposed to every node pod and to every agent turn that ran on one. The same applies to the other values in that Secret: the database passwords inside the URLs, the Slack client and signing secrets, and `SLAUDE_OAUTH_STATE_SECRET`. Rotate those with each provider's own procedure.

**Rotating `SLAUDE_JOB_SECRET`.** Job tokens are minted when a turn is enqueued and checked against the current secret. A token minted under the old secret fails after the change, including on refresh. Turns already queued or running would then lose their tool calls. Wait until `slaude_queue_depth` is 0 and no turn is running, then do this:

1. Write the new value (`openssl rand -hex 24`) into `slaude-scale-secrets`.
2. Run `kubectl -n slaude-scale rollout restart deploy/slaude-gateway`.

Nodes never hold the job secret, so they need no change. While the rollout runs, replicas with the old secret and replicas with the new one serve side by side. A token minted by one can fail on the other, so expect a few failed tool calls if turns start during the rollout.

**`SLAUDE_MASTER_KEY` cannot be rotated yet.** slaude has no command that re-encrypts stored data under a new key. That tool is a planned follow-up and does not exist. **Do not simply change the key.** Data encrypted under the old key then fails to decrypt with an error, and some of it is read at gateway boot. A managed tenant's personas are decrypted when the gateway loads persona state, so a gateway with a new key can fail to start. The persona sync that would repair them needs a running gateway.

Until the tool exists there are two honest choices:

- **Keep the key and record the exposure.** Finish the split, so the key stops reaching nodes, and rotate once the re-encryption tool ships.
- **Rotate by discarding everything encrypted.** This loses data, so take a database backup first and try it on a copy. With every gateway stopped and **before** changing the key, remove each encrypted value:

  ```sql
  DELETE FROM slack_apps;          -- bot tokens and signing secrets
  DELETE FROM provider_creds;      -- stored provider credentials
  DELETE FROM mcp_credentials;     -- every MCP credential, the agents' and each person's
  DELETE FROM remote_keys;         -- remote-execution key pairs
  DELETE FROM portal_oauth_flows;  -- OAuth flows in progress
  DELETE FROM slack_oauth_flows;
  DELETE FROM persona_overrides;   -- runtime persona overrides, all of them
  UPDATE personas SET user_token = NULL, mcp_json = NULL;
  ```

  Then set the new key and start the gateways. Next, recreate what was removed. Register every Slack app again with `bun run slack-app add`, or reinstall it through `/slack/oauth/start`. Enter the provider credentials again. Run the persona sync again, which re-encrypts user tokens and MCP config from the repository's `PERSONA_*` values. Runtime overrides are gone and must be set again. People reconnect their MCP servers with `/mcp connect`, and a manager reconnects the agents' shared identities. Each `/remote` user runs `/remote key` again, which generates a new key pair, and authorizes its public key on their machine. Soul-cache entries re-extract on their own.

Either way, finish the split first. Rotating while nodes still load the gateway Secret only exposes the new key the same way.

## Control panel (`/panel`)

The operator web panel mounts on the gateway tier (`mono`/`gateway` roles, never `node`) when `SLAUDE_PANEL=1` — see [Control panel](panel.md) for what it does, how to enable it, and OIDC setup.

Cross-replica behaviour specific to this topology: the active-surface lock, the deferred-inbound replay, and the once-per-window "handled in ops panel" notice are all coordinated through Redis (the lock key, a `panel-resume` / `panel-hold` pub/sub pair, and a `panel-notice` NX guard), so an operator can drive a session on one replica while Slack traffic and node `/v1` posts land on another without double-posting or losing messages.

---

## Load

Spec §8 budgets **p95 queue claim latency under 500ms at 200 concurrent threads**. Two harnesses:

```sh
# In-process (CI-friendly): cluster harness + stub agent, real Redis (+ PG per env).
# Samples every enqueuedAt→claim delta directly; fails when p95 > budget.
SLAUDE_REDIS_URL=redis://localhost:6379 bun scripts/load/claim-latency.ts --threads 200
# local baseline: p95 ≈ 325ms (2 nodes × concurrency 100 — capacity sized to the
# burst, so the number measures queue overhead, not backlog wait)

# Full HTTP path (compose stack): signed Slack envelopes at 200 VUs via k6.
# Register an app with a known signing secret first (see the script header).
k6 run scripts/load/k6-turns.js -e GATEWAY_URL=http://localhost:8080 \
  -e SIGNING_SECRET=load-secret -e APP_ID=A0LOAD -e TEAM_ID=T0LOAD
```

The k6 script gates the HTTP ack path (Slack's 3s ack budget, held at p95 < 500ms) and leaves claim latency to a metrics scrape of the nodes' `:8081/metrics`; the in-process script is the one that enforces the claim-latency budget, since it keeps the full distribution instead of a last-value gauge. In CI the load leg is `workflow_dispatch` only (`.github/workflows/load.yml`) — deliberately not part of the PR gate.

---

## CI

`.github/workflows/ci.yml` runs the multi-node surface on every push/PR:

- **scale** job: `bun sim run --nodes 2` against service containers (once PGLite + Redis 7, once Postgres 16 + Redis 7, scratch database per leg), then the six scenario tests, then a `docker compose -f docker-compose.scale.yaml config` validation.
- **compose-smoke** job: builds the image and boots the REAL multi-process topology — separate gateway and node containers over Postgres + Redis + shared volume — registers a dummy Slack app, and polls gateway `/healthz` plus both nodes' `/healthz` and `/readyz` to 200 before tearing down.
- **pglite** / **postgres** jobs carry a Redis 7 service so `tests/queue`, the `tests/node` E2E and `tests/integration` run armed instead of skipping.
- **load** (`load.yml`, manual): the claim-latency smoke above against real services.
