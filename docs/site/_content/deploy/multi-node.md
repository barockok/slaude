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

`docker-compose.scale.yaml` runs the full topology from the existing Dockerfile: `postgres:16`, `redis:7`, one gateway (Slack **http** mode — Events API on `:8080`), two node workers, `$SLAUDE_HOME` on a shared named volume, healthchecks throughout.

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

> **`SLAUDE_MASTER_KEY` is not rotatable in place.** It encrypts the Slack app secrets in the `slack_apps` registry at rest. Regenerating it orphans every existing row — the old ciphertext can no longer be decrypted, and the gateway will fail to resolve those apps. Keep the key stable across restarts; if you must rotate, re-register every app afterwards.

The single-process deployment stays in `docker-compose.yaml` — the scale file never touches it.

### Delivery semantics under node failure

Turn delivery is **at-least-once, deduplicated to effectively-once** for the common failure windows:

- A node killed **mid-turn** (before any Slack post): BullMQ stall recovery re-delivers the job, and another node runs the turn once.
- A node killed **after the turn but before the BullMQ ack** (the zombie window): the worker writes a `turn-done:<jobId>` marker to Redis the moment the agent turn finishes, *before* any ack. The retried delivery finds the marker and completes the job without re-running the turn — no duplicate Slack posts.
- **Residual window**: a node dying *between its last Slack post and the marker write* (single-digit milliseconds) still replays the turn on retry. This is the irreducible at-least-once residue of a post-to-external-system-then-record design; Slack-side `ts` inspection is the audit trail if it ever fires.

---

## Control panel (`/panel`)

The operator web panel mounts on the gateway tier (`mono`/`gateway` roles, never `node`) when `SLAUDE_PANEL=1`. It has **no password of its own** — it trusts an identity header injected by an SSO/ingress in front of it (oauth2-proxy, Cloudflare Access, …).

```sh
SLAUDE_PANEL=1                       # mount /panel (gateway/mono only)
SLAUDE_PANEL_TRUST_HEADER=1          # REQUIRED — asserts an ingress is in front (fail-closed)
SLAUDE_PANEL_HEADER=x-auth-request-email   # trusted identity header (default shown)
SLAUDE_PANEL_ALLOW=alice@example.com,bob@example.com   # optional allowlist (case-insensitive)
```

> **Security requirement — the ingress MUST strip the client-supplied identity header.** `SLAUDE_PANEL_TRUST_HEADER=1` only *asserts* that an authenticating proxy sits in front; slaude cannot verify it. The proxy MUST unconditionally strip any inbound `x-auth-request-email` (or whatever `SLAUDE_PANEL_HEADER` names) from the *client* request and re-inject it only after it has authenticated the operator. **If the header reaches the gateway un-stripped, any caller can set it and impersonate any operator.** With `SLAUDE_PANEL_TRUST_HEADER` unset the panel refuses every request (fail-closed); a missing header is a `403`.

Cross-replica behaviour: the active-surface lock, the deferred-inbound replay, and the once-per-window "handled in ops panel" notice are all coordinated through Redis (the lock key, a `panel-resume` / `panel-hold` pub/sub pair, and a `panel-notice` NX guard), so an operator can drive a session on one replica while Slack traffic and node `/v1` posts land on another without double-posting or losing messages.

The React app under `src/gateway/panel/web/` builds with Vite (`bun run test:web` covers it under Playwright) — a browser toolchain kept separate from the Bun server, excluded from `bun test` and the server `tsc`.

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
