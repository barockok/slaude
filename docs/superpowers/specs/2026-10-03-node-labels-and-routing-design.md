# Node labels and routing

**Date:** 2026-10-03
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-B
**Pairs with:** `2026-10-03-persona-provider-credentials-design.md` (WS-A), whose
resolved credentials this spec's gate protects; `…persona-runtime-config-and-visibility…`
(WS-C), which uses the labels this spec puts on nodes

## 1. Intent

A cluster has machines that differ: one image carries engineering tooling, another
finance tooling, another nothing special. Personas are bound to the machines that
can run them. A turn for a persona is delivered to a machine that carries the
persona's label, and **only such a machine can obtain that persona's credentials**.
Machines of one label scale horizontally; several personas may share a label.

The operator's constraints, which shaped this design:

- There is **no pool concept**. A node carries **labels**: opaque strings, not a
  taxonomy. Meaning is by convention (`finance`, `gpu`, `eu`).
- A persona names **one** label (`runs_on`). Multi-label selectors are later.
- How a node proves its labels is part of the design: the handshake is explicit.
- stdio MCP servers are installed on the machine and chosen per persona **on the
  node**; the gateway does not hold them.
- File isolation is **not** part of this; it comes with sandboxing, and the docs say
  so plainly.

## 2. Scope

**In:** the signed node credential and its minting; verification on every `/v1`
request and the identity it yields; the gate on persona-scoped endpoints, with the
endpoint audit; `personas.runs_on` and its sync; label queues and the dispatch and
worker changes; labels in the node heartbeat; the empty-label signal; warm-session
behaviour on a label change; the node-local stdio MCP manifest; the hardening of
three `/v1` endpoints the audit found.

**Out:** multi-label selectors; a Redis denylist for node credentials; file
isolation; making Redis access per-label (§4.9 states the limit); the Slack alert for
an unserved label (a panel flag and a metric ship first); a software inventory.

## 3. What exists today (verified)

**Auth.** `requireBearer` (`src/gateway/api/auth.ts:130`) is called once, at
`src/gateway/api/index.ts:66`, for every `/v1/*` request. It compares the bearer to
`SLAUDE_NODE_TOKEN` with a constant-time compare and returns only `Response | null`:
**it yields no identity**, so no handler knows anything about the caller except that
the bearer matched. Job tokens are HS256 JWTs (`X-Slaude-Job`, secret
`SLAUDE_JOB_SECRET`, 15 min TTL), minted at enqueue (`dispatch.ts:243`) and
re-minted by `handleTokenRefresh` (`jobs.ts:34`). Claims: `tenant, persona, session,
team, channel, thread, initiator, scope`, optional `job, runAs, remote,
sessionConfigFp`, `exp`. A generic signed-token helper exists:
`src/gateway/auth/jwt.ts` (`encodeJwt`/`decodeJwt`, `exp`-checked, used for the
panel, portal and onboarding tokens).

**Endpoints** (`createV1Api`, `index.ts`). Every one requires the static bearer.
Persona-scoped or secret-bearing, authorised today only by the job token's claims:

| Route | Returns / does |
|---|---|
| `GET\|PATCH /v1/sessions/:id` | session row (persona, channel, thread, model); PATCH mutates it |
| `GET /v1/tenants/:t/runtime` (legacy) | runtime bundle: provider creds, soul, MCP, model |
| `GET /v1/tenants/:t/personas/:p/runtime` | the same bundle (the route nodes use) |
| `GET /v1/tenants/:t/mcp-credentials` | the `runAs` owner's MCP access tokens |
| `POST …/mcp-credentials/refresh` | refreshes one entry; returns access tokens |
| `GET /v1/tenants/:t/remote-key` | a user's SSH private key |
| `POST /v1/tools/:server/:tool` | the whole tool plane: `surface`, `slack` (16 tools), `runtime`, `connect`, `skills`, `kb` |
| `POST /v1/jobs/:id/token-refresh` | **mints** a new job token, identical claims |
| `GET /v1/pending/:id` | a pending approval or permission gate's payload |
| `POST /v1/jobs/:id/ack`, `/fail` | acknowledges a job; logs the caller's body |

A node holding a *stolen job token* reads everything that persona can, and can keep
the token alive indefinitely: refresh is accepted for tokens expired by up to an hour
(`REFRESH_GRACE_SEC`), the refreshed token carries a new `exp` and the same `job`
claim, and nothing bounds the chain. Cross-persona access needs a token for that
persona; the path checks bind the path to the claims.

Three endpoints are weaker than the rest: **`/v1/pending/:id`** requires only the
bearer and is bound to no persona or session (ids are unguessable, but there is no
binding); **`/v1/jobs/:id/ack|fail`** accepts any job id with the bearer alone and
logs the caller-supplied body; **`token-refresh`** has no cap on the chain.

**Queues.** `TURNS_QUEUE = "turns"` and `nodeTurnsQueue(id) = "turns." + id`
(`src/queue/keys.ts`). `dispatch.ts:261` chooses the target: the session's warm node
if `registry.lookup` says it is fresh, else `"shared"`. Dispatch performs **no
persona lookup**. `TurnQueues.enqueueTurn` coalesces into the session's pending job
through a Redis index holding `{queue, jobId}`, so a pending job stays on its queue.
A node runs two BullMQ `Worker`s — shared and its own queue — each with its own
connection and `concurrency` (default 8), so one node can run 16 turns. The reaper
drains only per-node queues (`moveToShared`, hard-coded to `turns`); **nothing
watches the shared queue for jobs no node will claim**. The queue-depth gauge is
labelled `queue="turns"`; the autoscaler and alerts use that query.

**Heartbeat.** `nodes:<id>` holds only the beat timestamp (30 s TTL); `nodeLastBeat`
parses it as a number. `sess:<id>` is a hash `{node, since, lastBeat}`.

**Persona row.** `personas`, `persona_overrides`, `persona_sync_state` exist **only
on Postgres**; sqlite and filesystem personas have no row. Migrations are
`NNNN_slug.sql`, the latest `0012`. Other gateway replicas see a persona change after
a poll of up to ~10 s. `sameDesired` compares fields explicitly, so a new field must
be added there or a change reads as "unchanged".

**Fingerprint.** `sessionConfigFp(lockUser, remote)` is minted only when remote is
enabled and drives a warm-session reboot on the *same node*. It does not move a
session to another node.

**Node MCP.** The node's MCP resolver (`worker.ts:281`) supplies the shims and
`slaude_session`; `manager.ts:1033` merges it with `loadInstalledPluginMcps()`.

**Not present:** any node credential, label, `runs_on`, label queue, mismatch test,
mint CLI, or panel view of nodes.

## 4. Design

### 4.1 The node credential

A signed token, HS256, built on `src/gateway/auth/jwt.ts` with its **own** secret
`SLAUDE_NODE_KEY`. It must not reuse `SLAUDE_JOB_SECRET`: whoever can mint a job
token would otherwise be able to forge a node.

```jsonc
{ "v": 1, "id": "engineering-a", "labels": ["engineering", "eu"], "iat": 1790000000, "exp": 1797776000 }
```

- `labels`: 1 to 8 entries, each `^[a-z0-9][a-z0-9-]{0,31}$`, no duplicates. `default`
  is a normal label, not special in the token.
- `id` is informational (an operator's name for the credential, shown in logs and the
  panel); it is not the node's runtime id.
- `exp` is mandatory; the CLI's default lifetime is 90 days.

**Minting.** An admin CLI that runs where the key is, on the gateway:

```
bun run node-token mint --label engineering [--label eu] [--id engineering-a] [--ttl 90d]
bun run node-token inspect <token>        # decodes and verifies; prints claims, never the key
```

`mint` prints the token once, to stdout, and warns not to put it in a command line or
a log. It reads `SLAUDE_NODE_KEY` from the environment or a file, like `slack-app`.

**Rotation and revocation.** `SLAUDE_NODE_KEY_PREVIOUS` is also accepted when
verifying, so a key can be rotated without a flag day: set both, re-mint and roll the
nodes, then drop the previous. Revocation is by expiry and by rotation. No denylist.

**Scrub.** `SLAUDE_NODE_KEY` and `SLAUDE_NODE_KEY_PREVIOUS` go in the child-env strip
list in `src/agent/child-env.ts`, with a test. The node's own credential is held in
the same env var the node already uses (`SLAUDE_NODE_TOKEN`), which is already
stripped.

### 4.2 Verification and identity

`requireBearer` becomes `authenticateNode(req)` returning
`{ ok: true, node: NodeIdentity } | { ok: false, response }`, with

```ts
type NodeIdentity = { id: string; labels: ReadonlySet<string>; legacy: boolean };
```

- A bearer that verifies as a signed credential yields its claims.
- A bearer equal to `SLAUDE_NODE_TOKEN` yields `{ id: "legacy", labels: {"default"},
  legacy: true }`. The existing deployments keep working unchanged and are
  *the `default` label*.
- Anything else is 401. If neither `SLAUDE_NODE_TOKEN` nor `SLAUDE_NODE_KEY` is set,
  503 as today.

The router threads `NodeIdentity` to the handlers that need it (§4.3) instead of
discarding it. The signed credential is checked on **every** request; there is no
session, so a revoked-by-rotation credential stops working at the next call.

**The handshake.** `GET /v1/node/whoami` returns the verified `{ id, labels, legacy }`.
A node calls it at startup and **refuses to start** if it is rejected, and logs a
warning if the labels it decoded locally from its own token differ from what the
gateway verified. This makes a bad token fail at boot, with a clear message, and
gives operators one place to ask "what does the gateway think this node is".

### 4.3 The gate

For every request that authorises on a job token's persona, the gateway additionally
requires:

```
node.labels ∋ runsOn(claims.tenant, claims.persona)
```

where `runsOn` is the persona's `runs_on`, or `default` when null or the persona has
no row. On failure: **403** with a generic body (`this node may not serve this
agent`) and an error-level log with the node id and persona name.

Covered endpoints, from the audit:

| Endpoint | Gate |
|---|---|
| `…/personas/:p/runtime`, legacy `…/runtime` | required |
| `…/mcp-credentials`, `…/refresh` | required |
| `…/remote-key` | required |
| `/v1/tools/*` | required (every tool call) |
| `/v1/sessions/:id` | required |
| `/v1/jobs/:id/token-refresh` | required, and bounded (§4.4) |
| `/v1/pending/:id` | required, and bound to the caller (§4.4) |
| `/v1/jobs/:id/ack`, `/fail` | node identity required; body bounded (§4.4) |
| `/v1/node/whoami` | node identity only |

The persona→label lookup reads the live persona registry, which other replicas see
up to ~10 s after a change; this staleness is accepted and stated in the docs.

**Scope of the guarantee.** The gate stops a node that does not carry the persona's
label from obtaining its bundle, provider credentials, MCP tokens, SSH key or tool
access, even holding a valid job token for it. It does **not** hide job payloads from
a node that can read Redis (§4.9) and does not isolate files.

### 4.4 Hardening three endpoints

- **`token-refresh`** accepts a token only if the **original issue time is within a
  cap**. Because a refreshed token currently loses its history, the refreshed token
  carries `iat0` (the first issue time); refresh is refused when `now - iat0` exceeds
  `SLAUDE_JOB_TOKEN_MAX_AGE` (default 6 hours; a long turn is far shorter). A token
  from before this change has no `iat0` and is treated as issued at its `iat`.
- **`/v1/pending/:id`** requires the job token and answers only for a gate whose
  recorded channel and thread equal the token's. A mismatch is 404, so existence is
  not revealed. (The gate payloads already carry channel and thread; the plan
  confirms every gate kind records both.)
- **`/v1/jobs/:id/ack|fail`** requires node identity; the logged body is truncated and
  stripped of control characters, so a caller cannot inject log lines.

### 4.5 `personas.runs_on`

- Column: `personas.runs_on text NULL`, additive migration `0013_personas_runs_on.sql`,
  validated against the label regex. Postgres only, like the table. Null means
  `default`.
- `/deploy` payload: `runsOn: "label"`, desired-layer. It is **not overridable** at
  runtime (the override set stays `soul | model | mcp`), so git remains the source of
  truth for where an agent runs.
- sqlite and filesystem personas have no row, so their label is always `default`.
- Files that change: `src/db/personas.ts` (Row, `toDesired`, the SELECT and both
  upserts), `src/persona/effective.ts` (`DesiredPersona`, `mergeEffective`,
  **`sameDesired`**), `src/persona/sync/payload.ts` (`personaSpec`),
  `src/persona/sync/run.ts` (row mapping), `src/persona/types.ts`,
  `src/persona/registry.ts` (a `runsOnFor(personaId)` accessor alongside
  `managedPersonaModel`), `src/cli/personas.ts` (`renderDir`, `exportHome`), the
  panel's persona list, and the tests named in §7.
- A sync that references a label no live node carries is a **warning**, not an error:
  the credential and the persona are provisioned independently.

### 4.6 Queues and dispatch

Names (in `keys.ts`, the only place that builds them):

| Queue | For |
|---|---|
| `turns` | label `default` (unchanged name) |
| `turns.label.<label>` | any other label |
| `turns.<nodeId>` | a node's own warm-session queue (unchanged) |

Keeping `turns` for `default` is deliberate: an existing node, old or new, keeps
consuming it, so a mixed-version cluster behaves during a rolling upgrade. Label
queue names sit in their own namespace; a node whose id starts with `label.` is
refused at startup, so a node id can never collide with a label queue.

**Producer** (`dispatch.ts`):

1. Resolve `label = runsOn(persona)`.
2. Warm-session routing (`registry.lookup`) is used only if the session's node
   **still carries `label`** (§4.8). Otherwise the target is the label queue.
3. `TurnTarget` becomes `{ label } | { node }`; `"shared"` becomes
   `{ label: "default" }`.
4. If the coalesce index points at a pending job on a queue other than the one
   computed, the pending job is moved to the correct queue before appending; a
   persona's label change mid-flight must not strand a message. `moveToShared` is
   generalised to `moveTo(label)`.

**Consumer** (`worker.ts`): one BullMQ worker per label in the node's credential,
plus its own queue; each with its own connection. Total concurrent turns on a node are
bounded by `SLAUDE_NODE_CONCURRENCY` through a node-level semaphore around the
processor (today a node can run twice that, one `concurrency` per worker). Before
running, a node checks the job's persona label against its own and, on a mismatch,
returns the job to its queue and logs; the gateway gate is the enforcement, this is
courtesy.

A job failing with a **403** is permanent: the node reports `fail` (the client never
retries 4xx). BullMQ's bounded attempts then end it in `failed`, and the gateway
posts one generic message in the thread. No retry loop.

**Reaper.** It continues to drain per-node queues, now moving to the persona's label
queue (`moveTo`). The "nothing watches the shared queue" gap is closed in §4.7.

### 4.7 Unserved labels

The reaper-runner (the leader loop) already runs every 30 s. For each label queue it
computes waiting jobs and the number of live nodes holding that label. When waiting is
non-zero and live nodes are zero for longer than a threshold
(`SLAUDE_LABEL_UNSERVED_SECS`, default 60), it:

- sets `slaude_label_unserved{label}` to 1 (a metric the existing alerting can use);
- exposes the label as `unserved` to the panel (WS-C shows it).

A Slack message to the thread is **not** in the first cut. The depth gauge gains a
`label` series, and the autoscaler query changes from `queue="turns"` to
`queue=~"turns.*"`, with one ScaledObject per node deployment keyed on its own label's
queue; this is how a label scales horizontally by itself.

### 4.8 Heartbeat and label change

The heartbeat value stays a bare timestamp, because `nodeLastBeat` parses it. Labels go
in a **new key** `nodelabels:<id>` (a set or JSON string, same TTL), written by
`nodeUp` and `beatNode` in the same transaction, with the key builder in `keys.ts`.
`registry.nodesWithLabel(label)` is a SCAN over live nodes joined to their labels.

**A persona's label changes.**

- New messages go to the new label's queue; warm routing ignores a node that lacks the
  new label; pending coalesced jobs are moved (§4.6).
- The old node's warm session is not forcibly closed: it idles out and unregisters.
- A turn **already in flight** on the old node will start getting 403 on its next
  tool or bundle call and fail; BullMQ's attempt then runs it again on the new label's
  queue. This is accepted: relabelling an agent is an operator action that
  invalidates in-flight work, and the docs say so.
- The session-config fingerprint is not used for this: it reboots a session on the
  same node, which is the wrong remedy.

### 4.9 Stated limits

Nodes reach Redis directly (`SLAUDE_REDIS_URL`). Queue names are therefore **routing,
not access control**: a node could read another label's queue and its job payloads
(message text). What the gate enforces is the **credential path**; a node that takes a
foreign job cannot run it with that persona's credentials. Files are shared until
sandboxing. The docs for this feature say both, in these words, in the first
paragraph.

### 4.10 Node-local stdio MCP

A manifest on the node, from `SLAUDE_NODE_MANIFEST` (default `/etc/slaude/node.json`),
shipped in the image or a ConfigMap. The gateway never reads it.

```jsonc
{
  "version": 1,
  "mcpServers": {
    "tf":  { "command": "terraform-mcp", "args": ["--stdio"], "env": { "TF_TOKEN": "${NODE_TF_TOKEN}" } },
    "gh":  { "command": "gh-mcp" }
  },
  "allow": {
    "platform-bot": ["tf", "gh"],
    "support-bot":  ["gh"],
    "ops-bot":      "*"
  }
}
```

- `allow` maps a persona name to a list of server names, or `"*"` for every server
  in the manifest. **A persona not listed gets nothing.**
- `${VAR}` in `env` is expanded in the slaude process on the node from the node's own
  environment, before the config reaches the agent child, whose environment is scrubbed.
- The manifest is read and validated at node start; an invalid manifest, an `allow`
  entry naming an unknown server, or a non-`stdio` entry stops the node with a clear
  error. A change needs a pod roll, like the image it ships with.
- **Merge point:** the node's MCP resolver (`worker.ts:281`), which knows the
  session's persona (`personas.get(sessionId)`), adds the allowed servers to the shims
  and `slaude_session` it already returns. On a name collision with a gateway-resolved
  server (WS-C), the gateway's wins and the node logs a warning.
- The `<mcp-servers>` block in the system prompt is built from the same map, so the
  agent sees exactly what is mounted.

## 5. Compatibility and rollout

- **Order:** gateways first, then nodes.
- A new gateway with old nodes: old nodes present the static token, are `default`,
  and consume `turns`; personas with no `runs_on` are `default`. Nothing changes.
- A new node with an old gateway: `whoami` does not exist, so the node logs that it
  cannot confirm its labels and runs with the static token as today. A signed credential
  is rejected by an old gateway (401) and the node fails at boot with that message.
- `SLAUDE_NODE_KEY` unset on the gateway means signed credentials are not accepted and
  the legacy token is the only door — today's behaviour.
- The migration is additive and nullable. Rolling back the code leaves the column
  unused.

## 6. Security

- Separate key for node credentials; short, mandatory expiry; rotation with an overlap
  window.
- The label is in a **signed claim**; a node cannot choose its labels.
- The gate and its audit are the point of the feature; a new `/v1` endpoint that
  returns persona-scoped data must be added to the gate table, and a test fails if a
  route is registered without an explicit gate decision (§7).
- No secret in a log: the mint CLI prints the token once; `inspect` prints claims only.
- Public-repo hygiene: labels in docs and tests are generic (`engineering`, `finance`),
  never an organisation's names.

## 7. Testing

**Unit.**
- Credential: mint/verify round trip; wrong key; expired; `labels` empty, too many,
  malformed; `v` unknown; both keys during rotation; a job token is not accepted as a
  node credential and the reverse.
- `authenticateNode`: signed, legacy, neither, tampered.
- Gate matrix: for every covered route, a node with the label passes, a node without it
  gets 403, a legacy node passes only for `default`, a persona with null `runs_on` is
  `default`.
- **Route-coverage test:** enumerates the router's registered routes and fails when one
  has no declared gate decision.
- Hardening: `token-refresh` refuses beyond the cap and keeps `iat0`; `/v1/pending/:id`
  404s on a channel/thread mismatch; `ack|fail` truncates the body.
- Queue names; `moveTo`; coalescing across a label change; warm routing ignored when the
  node lacks the label.
- Manifest: valid, unknown server in `allow`, non-stdio, `"*"`, unlisted persona gets
  nothing, `${VAR}` expansion, collision with a gateway server.
- Scrub list covers the new key variables.

**Existing suites to update** (they assert queue names or the old shapes):
`tests/queue/keys`, `turns-real`, `reaper-real`, `registry-real`;
`tests/integration/warm-cold`, `coalescing`; `tests/node/worker-e2e`,
`worker-health-real`, `dispatch-authority`; `tests/gateway/core/dispatch-*`;
`tests/gateway/api/auth`, `v1`, `token-refresh`, `pending`, `runtime-persona`,
`mcp-credentials`, `remote-key`; `tests/db/personas-schema`, `personas-repo`,
`schema-drift`; `tests/persona/payload`, `run-sync`, `effective`, `registry-db`;
`tests/cli/personas`. The probe and verify scripts that hard-code `TURNS_QUEUE` are
updated together.

**Integration and end to end (`k8s-local`, and the nightly HA suite).** Two node
deployments with different signed labels. Persona A (`engineering`) and persona B
(`finance`): each turn lands on its own deployment; a node deliberately started with
the wrong label is refused a bundle with 403 while holding a valid job token; relabel a
persona and show new turns move; stop every node of one label and show the
`unserved` signal; a cluster of legacy nodes keeps working untouched.

## 8. Release

Touches node authentication, the queue topology, the DB schema and the agent loop: a
release candidate, after WS-A, with notes under the stable name. It is the riskiest
change in the programme; the RC soak runs both verify scripts and the nightly suite
against signed-credential nodes **and** against legacy-token nodes.

## 9. Open decisions

1. **Job-token cap default** (`SLAUDE_JOB_TOKEN_MAX_AGE`): 6 hours proposed; the longest
   legitimate turn decides it.
2. **Node semaphore:** bounding total turns per node to `SLAUDE_NODE_CONCURRENCY` lowers
   today's effective ceiling (up to twice it). Proposed; confirm.
3. **Staleness of `runs_on` at the gate:** accept the ~10 s replica poll, or read the DB
   directly on the credential-bearing routes at the cost of a query per call.
4. **Slack message for an unserved label** after the metric and panel flag.
