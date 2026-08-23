# Horizontal scale: gateway / node split

Date: 2026-08-24
Status: approved design, pending implementation plan

## Goal

Run slaude as a multi-tenant, horizontally scalable system. Many Slack apps and personas share one gateway tier. Claude Agent SDK turns run on a pool of interchangeable node processes across machines or pods. No single process, no single replica, no sqlite.

Decisions made during brainstorming:

- Scale both concurrent threads and personas (multi-tenant gateway, stateless node pool).
- SDK session transcripts live on a shared RWX volume; any node can resume any session.
- Nodes pull work from a Redis queue (BullMQ, n8n queue-mode style). Gateway never dials nodes.
- Session map and all gate state move from sqlite to Postgres so the gateway can run N replicas.
- Slack ingress switches from Socket Mode to the Events API over HTTPS.
- Tenant model supports both one-app-per-persona and one-app-installed-to-many-workspaces. Ship the first, keep schema for the second.
- Node tool surface to the LLM is unchanged; node-side MCP handlers call gateway REST.
- No sticky request affinity. Warm sessions are tracked in a registry with heartbeats; routing consults the registry, falls back to cold resume on any node.
- One spec, phased plan with shippable milestones.

## Non-goals

- Replacing the Claude Agent SDK or the one-thread-one-session model.
- Cross-region or multi-cluster.
- Changing the persona two-layer model or SOUL.md schema.
- Changing the sim fixture format. The 26 existing transcripts are the regression gate.

## 1. Topology

```
Slack ──HTTPS events/interactions──▶ [Gateway ×N]  ──▶ Postgres (sessions, tenants, gates, cron, ignores, memory, brain schema)
                                         │  ▲         Redis    (job queues, pub/sub, session registry, node heartbeat, locks)
                                         │  │
                                  enqueue│  │REST /v1/*  (tool calls + control plane)
                                         ▼  │
                                      Redis queues
                                         │ pull (BullMQ worker)
                                         ▼
                                     [Node ×M] ── claude-agent-sdk query() ── RWX volume ($SLAUDE_HOME)
```

### Gateway

Stateless, N replicas behind an ingress. Owns:

- Slack Events API, interactivity, and slash command HTTP receivers (signing secret verified, 3s ack).
- Tenant and Slack app registry.
- Session map (`sessions` table).
- All gates: engagement, channel mode, blocked users, `/1on1`, mention-only, permission gate, approval gate, MCP connect.
- Cron scheduler, leader-elected via Redis lock.
- Brain (gbrain, engine=postgres, in-process).
- `/v1` REST for nodes.
- `/healthz`, `/readyz`, `/metrics`.

### Node

M replicas, HPA on queue depth. Owns:

- BullMQ worker claiming `turn` jobs.
- `AgentManager` (existing core) running `query()`.
- MCP servers with the same tool names and schemas as today, whose handlers call gateway REST.
- Live `Query` objects between turns, subject to idle TTL.
- Per-node `/healthz` and `/metrics`.

Node has no Slack client, no Postgres connection, no brain.

### Shared RWX volume (`$SLAUDE_HOME`)

Holds everything the SDK child process reads or writes: `workspaces/`, `.claude/projects/`, `personas/<name>/.claude`, `oauth/`, `skills/`, `knowledge/`. Gateway renders persona files from Postgres to this volume on change. Nodes treat it as read-mostly; the SDK writes transcripts. No sqlite, no `.env`, no `db.sqlite` on the volume.

## 2. Session lifecycle and routing

### Turn job

A turn is a job on a BullMQ queue. Payload:

```json
{
  "sessionId": "uuid",
  "tenantId": "t_...",
  "personaId": "p_...",
  "messages": [{ "ts": "...", "user": "U...", "text": "...", "files": [] }],
  "jobToken": "<jwt>",
  "enqueuedAt": 1724500000000
}
```

`jobToken` is a short-lived JWT (TTL = max turn duration) minted by the gateway with claims `{tenant, persona, session, team, channel, thread, initiator, scope}`. Nodes present it on every tool call. Gateway derives Slack client, persona, KB scope from the token, never from the request body.

### Session registry (Redis)

- `sess:<sessionId>` hash `{node, since, lastBeat}`, TTL = 2 × heartbeat interval.
- Node heartbeats every 10s for each live `Query` whose child CLI process is alive and whose prompt iterable is open.
- Idle TTL expiry on the node closes the `Query` and deletes the key.
- Node SIGTERM: stop claiming, finish in-flight turns within `SLAUDE_NODE_DRAIN_SEC` (default 120), delete all owned `sess:*` keys and `nodes:<id>`, exit.

### Routing an inbound message

1. Gateway runs the existing pipeline (engagement, channel mode, blocked users, 1on1, mention-only) and `ensureSession` in Postgres.
2. `HGETALL sess:<id>`.
   - Present and `lastBeat` fresh: enqueue to the per-node queue `turns:<nodeId>`.
   - Absent or stale: enqueue to the shared queue `turns`.
3. A node that receives a per-node job for a session it no longer holds cold-resumes locally and re-registers. It never bounces the job.

### Serialization per session

- Node acquires `lock:session:<id>` (SET NX, TTL 10m, extended every 60s while the turn runs) before starting a turn. Lock held by another node: the job is re-queued with a short delay.
- Gateway coalesces: messages arriving while a session has a pending or running job are appended to that job's `messages[]` (BullMQ job update) so the next turn sees all of them, matching today's `pushUser` queue semantics.

### Abort

Gateway publishes `abort:<sessionId>` on Redis pub/sub. The node running that session subscribes and calls `agent.abort(sessionId)`.

### Node health and reaping

- `nodes:<nodeId>` heartbeat key, TTL 30s.
- Gateway reaper (Redis-lock leader) every 30s: for each node key that has expired, delete its `sess:*` entries and move jobs from `turns:<nodeId>` to `turns`.
- Per-node queue jobs carry a stall threshold (5s unclaimed); the reaper moves stalled per-node jobs to the shared queue.

### Cold vs warm turn

Warm: node holds a live `Query`; message is pushed into the open prompt iterable. Cold: node calls `query({ resume: sessionId })`, reading the transcript from the RWX volume. Existing resume-miss retry logic in `AgentManager` applies.

## 3. Gateway REST `/v1` (node-facing)

### Auth

Two headers on every request:

- `Authorization: Bearer <SLAUDE_NODE_TOKEN>` static shared secret, rotated via env.
- `X-Slaude-Job: <jwt>` per-job token (see §2). Required on tool-plane and session endpoints; optional on node registration endpoints.

### Control plane

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/sessions/:id` | Session row: model, working_dir, permission_mode, persona_id, engaged, claude_started |
| `PATCH` | `/v1/sessions/:id` | Update `claude_started`, `model`, `permission_mode` |
| `GET` | `/v1/tenants/:id/runtime` | Runtime bundle: provider credentials, `SOUL.md` text, soul JSON, `mcp.json`, skills overlay paths, default model. ETag cached node-side |
| `GET` | `/v1/pending/:id` | Long-poll (30s) for a pending gate resolution |
| `POST` | `/v1/jobs/:id/ack`, `/v1/jobs/:id/fail` | Telemetry only; BullMQ owns job state |

### Tool plane

Path `/v1/tools/<server>/<tool>`, one-to-one with today's MCP tools, same input schema, same return shape:

- `slack/*`: reply, edit, upload, history, react, request_approval, set_status, ingest
- `surface/*`: soul overrides, one_on_one, mention_only
- `runtime/*`: ignore, cron_*, can_use_tool
- `connect/*`: OAuth connect start and status
- `skills/*`: list, read, write, delete, sync_manifest (gateway writes to RWX; node re-scans per message as today)
- `kb/*`: search, read, think, ingest, memory_prefetch, memory_sync_turn

`slaude_session` (token budget) stays node-local.

### Blocking tools

`request_approval` and `can_use_tool` return `{ pendingId }` immediately. The node long-polls `GET /v1/pending/:id` until resolved, timed out, or the turn is aborted. Gate state lives in Postgres `pending_gates` so any gateway replica can resolve a Block Kit click.

### Direction

Gateway to node communication is Redis only: jobs, `abort:<session>`, `reload:<tenant>` (bust runtime cache). Gateway never opens a connection to a node.

### Shared contracts

`src/tools/contracts/*.ts` exports tool names and zod schemas. Gateway handlers and node shims both import from here. A snapshot test per tool asserts the two sides agree.

## 4. Data layer

### Postgres

Driver: `Bun.sql` or porsager `postgres`. Migrations: numbered SQL files in `src/db/migrations/`, applied on gateway boot under `lock:leader:migrate`.

| Table | Notes |
|---|---|
| `tenants` | `id, name, status, created_at` |
| `slack_apps` | `api_app_id, team_id, tenant_id, persona_id, bot_token (enc), signing_secret (enc), bot_user_id`. PK `(api_app_id, team_id)` |
| `personas` | `id, tenant_id, name, soul_md, soul_json, soul_sha, model_default, mcp_json, created_at, updated_at`. Source of truth; gateway renders to RWX `personas/<name>/` |
| `provider_creds` | `tenant_id, persona_id (nullable), kind (api_key \| oauth_token \| base_url), value (enc)` |
| `sessions` | As today plus `tenant_id`. UNIQUE `(team, channel, thread, persona_id)` |
| `pending_gates` | `id, session_id, kind (perm \| approval \| mcp_connect), payload jsonb, status, resolved_by, resolved_at, expires_at` |
| `seen_events` | `event_id PK, ts`. Dedup across replicas; purge rows older than 1h |
| `ignores`, `cron_jobs`, `one_on_one_locks`, `mention_only_threads`, `soul_overrides`, `kb_ingest_jobs`, `memory_turns`, `memory_facts` | Same shape as sqlite plus `tenant_id` |
| `skill_usage` | Dropped (no readers or writers today) |

Engagement: drop the in-memory `Set`; `sessions.engaged` is the only source.

Encryption at rest: `SLAUDE_MASTER_KEY` (32 bytes base64) drives AES-256-GCM for `(enc)` columns via `src/db/crypto.ts`. Key rotation is out of scope for M1.

### Redis

- BullMQ queues: `turns`, `turns:<nodeId>`.
- Keys: `sess:<id>` (hash), `nodes:<id>` (heartbeat), `lock:session:<id>`, `lock:leader:<role>` for `cron`, `reaper`, `migrate`.
- Pub/sub channels: `abort:<session>`, `reload:<tenant>`, `gate:<pendingId>`.
- Streams: `events:<session>` (capped, MAXLEN ~1000) carrying serialized `AgentEvent`s from node to gateway for metrics, Slack Agents status, and error surfacing.

### Brain

`SLAUDE_BRAIN_ENGINE=postgres`, same Postgres instance, schema `brain`. `LocalBackend` runs on the gateway only. PGLite is retained solely for `bun sim` and tests.

### Repository layer

`src/db/*.ts` modules keep their exported function signatures; internals switch from `bun:sqlite` to Postgres. Sim and unit tests run the same SQL against PGLite.

## 5. Slack ingress (Events API)

### Endpoints (gateway)

- `POST /slack/events`
- `POST /slack/interactions` (Block Kit actions: `slaude_perm:*`, `slaude_appr:*`, `slaude_mcp:*`)
- `POST /slack/commands`
- `GET /slack/oauth/start`, `GET /slack/oauth/callback` (install model B; stubbed until M5)

### Request flow

1. Parse body, read `api_app_id` (and `team_id`), look up `slack_apps`. Unknown app: 404.
2. Verify `X-Slack-Signature` and `X-Slack-Request-Timestamp` with the app's signing secret. Reject if older than 5 minutes.
3. `url_verification`: echo challenge.
4. Dedup: `INSERT INTO seen_events ... ON CONFLICT DO NOTHING`. Conflict: return 200, drop. Honor `X-Slack-Retry-Num`.
5. Return 200 immediately. Hand the event to an in-process async handler.
6. Handler runs the existing `createGateway` pipeline, `ensureSession`, coalesce, enqueue (§2).

Slash commands respond with an ephemeral acknowledgement within 3s and post results via `response_url`.

### Transport

`Transport` interface is unchanged. New `createHttpSlackTransport()` replaces `createSlackTransport()` (Socket Mode) in production. Socket Mode transport is kept for local dev. `SimTransport` is unchanged. The HTTP transport holds `Map<apiAppId, WebClient>` and resolves a client from context.

### Interactions across replicas

A Block Kit click lands on any replica. The handler runs `UPDATE pending_gates SET status, resolved_by, resolved_at WHERE id = $1 AND status = 'pending'`, then `PUBLISH gate:<id>`. The node's long-poll wakes. Approver authorization still comes from `personas.soul_json`.

### Manifest

`bun run manifest --mode http --url https://<host>` emits `event_subscriptions.request_url`, `interactivity.request_url`, `slash_commands[].url`, and omits `socket_mode_enabled`.

## 6. Node runtime

### Process (`bun run node`, `src/node/main.ts`)

1. Boot: `nodeId = <hostname>-<rand>`, set `nodes:<id>`, start heartbeat loop, start `/healthz` and `/metrics` on `:8081`, connect Redis.
2. BullMQ `Worker` on `turns` and `turns:<nodeId>`, concurrency `SLAUDE_NODE_CONCURRENCY` (default 8).
3. Per job: acquire `lock:session:<id>`; `GET /v1/sessions/:id`; `GET /v1/tenants/:t/runtime` (ETag cached); `AgentManager.ensureSession`; `sendMessage(messages)`; await `turn_end` or `error`; release lock; complete job.
4. Keep the `Query` alive after the turn under the existing idle TTL; heartbeat `sess:<id>`. Idle expiry closes the `Query` and deletes the key.
5. Subscribe `abort:<session>` and `reload:<tenant>`.
6. SIGTERM drain as described in §2.

### AgentManager changes

- `SessionStore` interface introduced. Gateway implementation is Postgres; node implementation is REST (`/v1/sessions`).
- `mcpResolver` returns node shims built from `src/tools/contracts`.
- `permissionResolver` calls `/v1/tools/runtime/can_use_tool` and long-polls.
- `memory.prefetch` and `memory.syncTurn` call `/v1/tools/kb/memory_*`.
- Child env comes from the runtime bundle, not the node's process env. `scrubChildEnv` still applies.
- `AgentEvent`s are written to `events:<session>` Redis stream in addition to the in-process emitter.

### Metrics

Node: `slaude_node_sessions_live`, `slaude_node_turns_total`, `slaude_node_turn_duration_seconds`, `slaude_node_queue_claim_latency_seconds`.
Gateway: `slaude_gateway_events_total`, `slaude_queue_depth{queue}`, `slaude_nodes_alive`, `slaude_sessions_warm`.

### Failure matrix

| Failure | Behavior |
|---|---|
| Node dies mid-turn | `lock:session` TTL lapses; BullMQ retries (attempts 2) on another node; cold resume from RWX. Slack replies already posted remain |
| Gateway replica dies | Stateless; ingress routes elsewhere; pending gates are in Postgres |
| Redis down | Gateway returns 503 to Slack (Slack retries up to 3 times); nodes idle and reconnect |
| Postgres down | `/readyz` fails; gateway returns 503 |
| RWX lag or lock | SDK resume-miss triggers the existing retry path in `AgentManager` |

## 7. Code layout

```
src/
├── server.ts                 # gateway entry
├── node/
│   ├── main.ts               # node entry
│   ├── worker.ts             # BullMQ worker, lock, heartbeat, drain
│   ├── shims/*.ts            # createSdkMcpServer from contracts → REST
│   ├── client.ts             # typed fetch wrapper (node token + job token)
│   └── session-store.ts      # SessionStore REST implementation
├── gateway/
│   ├── core/                 # unchanged
│   ├── slack/
│   │   ├── http-transport.ts # Events API receiver, multi-app
│   │   └── socket-transport.ts
│   └── api/
│       ├── auth.ts
│       ├── sessions.ts, tenants.ts, pending.ts
│       └── tools/*.ts        # one file per MCP server
├── tools/contracts/*.ts      # shared zod schemas and tool names
├── db/                       # Postgres implementation, migrations/
├── queue/                    # BullMQ setup, key names, pub/sub helpers
└── agent/manager.ts          # SessionStore injected
```

One package, one Docker image, `SLAUDE_ROLE=gateway|node|mono` selects the entrypoint. `mono` preserves today's single-process behavior. Kubernetes: two Deployments, plus Redis, Postgres, and an RWX PVC.

## 8. Testing

- Contract snapshot test per tool: gateway handler schema equals node shim schema.
- Sim: `bun sim` runs gateway and node in one process with PGLite and an in-memory Redis (`redis-memory-server` or `ioredis-mock`), `SimTransport`. All 26 existing transcript fixtures must pass unchanged.
- Integration (CI, docker compose): real Postgres and Redis, one gateway, two nodes. Scenarios: warm on node A then cold resume on node B; node kill mid-turn and retry; approval click on replica 2 resolves a long-poll; three messages coalesce into one turn; Slack retry dedup.
- Load: k6, 200 concurrent threads, p95 queue claim latency under 500ms.

## 9. Milestones

Each milestone ships independently and is gated by an env flag so the previous behavior remains available.

| M | Scope | Flag |
|---|---|---|
| M1 | `SessionStore` and repo interfaces; Postgres implementation; `bun run migrate-sqlite` one-shot exporter; sim on PGLite. Monolith runs on Postgres | `SLAUDE_DB=sqlite\|pg` |
| M2 | `pending_gates`, `seen_events`, engagement to Postgres. Still one process | (same) |
| M3 | HTTP transport, multi-app registry, `manifest --mode http`. Agent still in-process. Gateway replicas > 1 possible | `SLAUDE_SLACK_MODE=socket\|http` |
| M4 | Contracts, `/v1`, node worker, shims, queues, registry, reaper. Sim covers both roles | `SLAUDE_ROLE=mono\|gateway\|node` |
| M5 | HPA on queue depth, metrics dashboards, docs, OAuth install flow (model B) | n/a |

## 10. Open questions (resolved defaults)

- Postgres driver: default `Bun.sql`; fall back to porsager `postgres` if Bun.sql lacks needed features at M1.
- In-memory Redis for sim: prefer `redis-memory-server`; `ioredis-mock` if it cannot run in CI.
- REST router on gateway: `hono` unless a zero-dependency `Bun.serve` router proves sufficient at M4.
