# Node labels and routing

**Date:** 2026-10-03 · **Revised:** 2026-10-04 (after design review)
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-B
**Pairs with:** WS-A (`…persona-provider-credentials…`), whose resolved credentials the
gate protects; WS-C (`…persona-runtime-config-and-visibility…`), which uses the labels and
the node identity defined here

## 1. Intent

A cluster has machines that differ: one image carries engineering tooling, another finance
tooling, another nothing special. Personas are bound to the machines that can run them. A
turn for a persona is delivered to a machine that carries the persona's label, and **only such
a machine can obtain that persona's credentials**. Machines of one label scale horizontally;
several personas may share a label.

The operator's constraints:

- There is **no pool concept**. A node carries **labels**: opaque strings, not a taxonomy.
- A persona names **one** label (`runs_on`). Multi-label selectors are later.
- How a node proves its labels is part of the design: the handshake is explicit.
- stdio MCP servers are installed on the machine and chosen per persona **on the node**; the
  gateway does not hold them.
- File isolation is **not** part of this; it comes with sandboxing, and the docs say so.

**What the review added, as hard requirements of this spec:**

1. **The gate protects nothing while a node holds the gateway's secrets.** Today every node
   loads the same Secret as the gateway. Splitting it is **phase 0** of this workstream (§4.0),
   not a follow-up.
2. **The node, not the persona, is the trust unit.** Children on one node share a user and can
   read one another's environment and argv. Labels separate *nodes*; they do not separate
   personas that share a node. The docs say this in the first paragraph (§4.12).

## 2. Scope

**In:** the Secret split and node boot check (phase 0); the signed node credential, its
lifecycle and its minting; verification on every `/v1` request and the identity it yields;
the gate, with the endpoint audit and a declarative route table; hardening of four weak `/v1`
endpoints; `personas.runs_on`; label queues, dispatch, worker, reaper and relabel behaviour;
the unserved-label signal; labels in the node heartbeat; the node-local stdio MCP manifest,
including plugin MCP servers.

**Out:** multi-label selectors; Redis per-label access control (§4.12); file isolation; a Slack
alert for an unserved label (a metric and a panel flag first); a software inventory;
asymmetric node credentials (§9).

## 3. What exists today (verified)

**Secrets.** The node Deployment loads `slaude-scale-secrets` through `envFrom`
(`deploy/k8s-scale/50-node.yaml:33-37`), the same Secret the gateway uses: it holds
`SLAUDE_MASTER_KEY`, `SLAUDE_JOB_SECRET`, `SLAUDE_PG_URL`, `SLAUDE_BRAIN_DATABASE_URL`, the Slack
client and signing secrets, `SLAUDE_OAUTH_STATE_SECRET` and the provider key
(`10-secrets.yaml`). No node or agent code reads `SLAUDE_JOB_SECRET`. The child-env scrub strips
only a fixed subset; the Postgres, Redis and Slack values reach the agent child, and the rest is
readable from the parent through `/proc`. A node that holds `SLAUDE_JOB_SECRET` plus its own
credential can forge a job token for any persona on its label and any `runAs`, and through the
credential endpoints read any user's MCP tokens and SSH key. No manifest sets a
`serviceAccountName`; gateway and nodes share `default` with the token mounted.

**Auth.** `requireBearer` (`src/gateway/api/auth.ts:130`) is called once, at
`src/gateway/api/index.ts:66`, for every `/v1/*` request. It compares the bearer to
`SLAUDE_NODE_TOKEN` (constant time) and returns only `Response | null`: **no identity**. Job
tokens are HS256 JWTs (`X-Slaude-Job`, secret `SLAUDE_JOB_SECRET`, 15-minute TTL), minted at
enqueue (`dispatch.ts:243`) and re-minted by `handleTokenRefresh` (`jobs.ts:34`). Claims: `tenant,
persona, session, team, channel, thread, initiator, scope`, optional `job, runAs, remote,
sessionConfigFp`, `exp`. `src/gateway/auth/jwt.ts` is a generic signed-token helper (`encodeJwt`
and `decodeJwt`, `exp`-checked). `SLAUDE_NODE_TOKEN` is overloaded: the gateway reads it as the
value to accept, and a node reads the same name as its own credential.

**The router** is an if-chain (`index.ts:69-180`), not a table; there is nothing to enumerate.

**Endpoints** (all require the static bearer). The audit below was re-derived from the router:

| Route | Returns / does |
|---|---|
| `GET\|PATCH /v1/sessions/:id` | session row (persona, channel, thread, model); PATCH mutates it |
| `GET /v1/tenants/:t/runtime` (legacy) | runtime bundle: provider creds, soul, MCP, model |
| `GET /v1/tenants/:t/personas/:p/runtime` | the same bundle (the route nodes use) |
| `GET /v1/tenants/:t/mcp-credentials` | the `runAs` owner's MCP access tokens |
| `POST …/mcp-credentials/refresh` | refreshes one entry |
| `GET /v1/tenants/:t/remote-key` | a user's SSH private key |
| `POST /v1/tools/:server/:tool` | the whole tool plane: `surface`, `slack` (16 tools), `runtime`, `connect`, `skills`, `kb` |
| `POST /v1/jobs/:id/token-refresh` | **mints** a new job token with identical claims |
| `GET /v1/pending/:id` | a pending approval or permission gate's payload |
| `POST /v1/jobs/:id/ack`, `/fail` | acknowledges a job; logs the caller's body |

A node holding a *stolen job token* reads everything that persona can and can keep the token
alive indefinitely: refresh accepts a token expired by up to an hour (`REFRESH_GRACE_SEC`) and
returns one with a new `exp`, with no cap from the original issue. Three endpoints are weaker
still: **`/v1/pending/:id`** needs only the bearer and is bound to no persona or session (and the
node's `getPending` sends **no job token**, so binding it to the token would break old nodes);
**`ack|fail`** accept any job id with the bearer and log the caller's body; **`token-refresh`**
is uncapped.

**Failure paths (this changed the design).** A `403` on a tool call comes back to the model as an
`isError` result (`node/shims/index.ts:74-75`) and the turn can still finish "done" with the
reply lost silently. A `403` on the bundle is a plain error: the node client never retries 4xx,
the processor throws, and BullMQ retries the job on the **same queue** (`attempts: 2`,
`turns.ts:104-110`), never "on the new label's queue".

**Queues.** `TURNS_QUEUE = "turns"` and `nodeTurnsQueue(id) = "turns." + id`
(`src/queue/keys.ts`). `dispatch.ts:261` picks the warm node if `registry.lookup` says it is fresh,
else `"shared"`; dispatch does **no persona lookup**. `enqueueTurn` coalesces into the session's
pending job through a Redis index holding `{queue, jobId}`, so a pending job stays where it is. A
node runs two BullMQ `Worker`s — shared and its own — each with its own connection and
`concurrency` (default 8). The reaper drains only **waiting, delayed and prioritised** jobs from a
dead node's own queue (`reaper.ts:31, 75`); an **active** job left on a dead node's queue has no
surviving worker (stall recovery runs only in Workers attached to that queue) and is not
rescued. Nothing watches the shared queue for jobs no node will claim. The depth gauge is
`queue="turns"`; the autoscaler is a KEDA Redis-list trigger on `slaude:bull:turns:wait`
(`70-autoscale.yaml:41`).

**Heartbeat.** `nodes:<id>` holds only the beat timestamp (30 s TTL), parsed as a number by
`nodeLastBeat`. `sess:<id>` is a hash `{node, since, lastBeat}`.

**Persona row.** `personas`, `persona_overrides`, `persona_sync_state` exist **only on Postgres**;
sqlite and filesystem personas have no row. Other gateway replicas see a persona change after a
poll of up to ~10 s. The sync upserts unconditionally; `sameDesired` only decides what the sync
*reports* as changed.

**MCP on a node.** The node's resolver (`worker.ts:281`) supplies the shims and `slaude_session`.
`manager.ts:1033-1036` then spreads `pluginMcps` (read from the node's local disk by
`loadInstalledPluginMcps`, `plugins.ts:89`) **after** the resolver output, so plugin servers
**do** run on nodes, **win** name collisions, and are not covered by any allow-list. The
`<mcp-servers>` block in the system prompt is built from the resolver map only, so plugin servers
run but are not listed there. `strictMcpConfig` is not set.

**Not present:** any node credential, label, `runs_on`, label queue, mismatch test, mint CLI, route
table, or panel view of nodes.

## 4. Design

### 4.0 Phase 0 — split the Secrets, and make the node check

This ships first, with or without the rest, because everything else assumes it.

**Two Secrets.**

| Secret | Holds | Mounted by |
|---|---|---|
| gateway | `SLAUDE_MASTER_KEY`, `SLAUDE_JOB_SECRET`, `SLAUDE_NODE_KEY` (+ `_PREVIOUS`), `SLAUDE_NODE_LEGACY_TOKEN`, `SLAUDE_PG_URL`, `SLAUDE_BRAIN_DATABASE_URL`, Slack secrets, `SLAUDE_OAUTH_STATE_SECRET`, `SLAUDE_VAULT_*`, `PERSONA_*`, deploy tokens, and the gateway's own provider | gateway only |
| node | the node's credential (`SLAUDE_NODE_TOKEN`), `SLAUDE_REDIS_URL`, `SLAUDE_GATEWAY_URL`, and — only while the fallback is on — a provider key | node only |

**ServiceAccounts.** The gateway runs under its own ServiceAccount; node pods set
`automountServiceAccountToken: false`.

**NetworkPolicy (recommended in the manifests).** Nodes may reach Redis, the gateway, the LLM
provider and what their stdio servers need; they may not reach Postgres or Vault. A node has no
legitimate use for either.

**The node refuses to boot** if any gateway-only variable is present in its environment. The check
names the variable and nothing else. It is staged: in the first release it **logs a warning and
increments a metric**, so an existing cluster sees the problem before it is stopped; in the next
it refuses, with `SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1` as a documented, temporary escape.

**Rotation.** After the split, `SLAUDE_JOB_SECRET` and `SLAUDE_MASTER_KEY` are treated as exposed on
any cluster that ran nodes with the shared Secret, and rotated. Rotating the master key re-encrypts
stored credentials; the plan includes that procedure. This is stated in the release notes.

### 4.1 The node credential

A signed token, HS256, built on `src/gateway/auth/jwt.ts` with its **own** secret `SLAUDE_NODE_KEY`.
It must not reuse the job secret: whoever can mint a job token could otherwise forge a node.

```jsonc
{ "v": 1, "id": "engineering-a", "labels": ["engineering", "eu"], "iat": 1790000000, "exp": 1797776000 }
```

- `labels`: 1 to 8 entries, each `^[a-z0-9][a-z0-9-]{0,31}$`, no duplicates. `default` is an ordinary
  label.
- `id` names the credential for logs, the panel and revocation; it is not the node's runtime id.
- `exp` is mandatory; the CLI's default lifetime is 90 days.

**Because HMAC means "whoever can verify can mint",** the key lives only in the gateway Secret
(§4.0). That is why the split is a prerequisite. Asymmetric credentials are deferred (§9).

**Minting.** An admin CLI that runs where the key is, on the gateway:

```
bun run node-token mint --label engineering [--label eu] [--id engineering-a] [--ttl 90d]
bun run node-token inspect <token>        # decodes and verifies; prints claims, never the key
bun run node-token revoke <id>            # see below
```

`mint` prints the token once and warns not to put it in a command line or a log.

**Lifecycle (the credential is a scheduled outage otherwise).**

- A gauge `slaude_node_credential_expiry_seconds{id}` is exported by the gateway for credentials it
  has seen, and `whoami` logs a warning when fewer than 14 days remain. An alert rule is part of the
  docs.
- **Revocation by id:** `node-token revoke <id>` writes a row to `node_revocations(id,
  revoked_before)` in Postgres; the verifier rejects a credential whose `id` has a row with
  `iat < revoked_before`, with a 30-second cache. This avoids "rotate the global key to revoke one
  node, which re-mints every label".
- **Key rotation:** `SLAUDE_NODE_KEY_PREVIOUS` is also accepted when verifying, so a key rotates
  without a flag day: set both, re-mint and roll nodes, then drop the previous.

**Scrub.** `SLAUDE_NODE_KEY`, `SLAUDE_NODE_KEY_PREVIOUS` and `SLAUDE_NODE_LEGACY_TOKEN` go in the
child-env strip list, with a test.

### 4.2 Verification and identity

`requireBearer` becomes `authenticateNode(req)` returning
`{ ok: true, node: NodeIdentity } | { ok: false, response }`, with

```ts
type NodeIdentity = { id: string; labels: ReadonlySet<string>; legacy: boolean };
```

- A bearer that verifies as a signed credential yields its claims.
- A bearer equal to **`SLAUDE_NODE_LEGACY_TOKEN`** yields `{ id: "legacy", labels: {"default"}, legacy:
  true }`. The gateway reads this under a **new variable name**; a node keeps reading
  `SLAUDE_NODE_TOKEN` for its own credential. (For compatibility the gateway also accepts the old
  `SLAUDE_NODE_TOKEN` as the legacy value, with a deprecation warning.)
- Anything else is 401. If neither a key nor a legacy token is set, 503 as today.

**The legacy door is a permanent downgrade path unless closed.** A node holding the shared static
token is `default`, and a persona with a null `runs_on` is `default`, so every unlabelled persona
stays reachable with one shared secret. Therefore: `SLAUDE_NODE_LEGACY=off` rejects the legacy token
outright; the gateway logs a warning and increments `slaude_node_legacy_auth_total` whenever it is
used **while `SLAUDE_NODE_KEY` is set**; and the release gate requires a cluster that runs with the
legacy door closed (§8 of the release plan).

The router threads `NodeIdentity` to the handlers that need it. The credential is checked on
**every** request; there is no session, so a revoked credential stops at the next call.

**The handshake.** `GET /v1/node/whoami` returns the verified `{ id, labels, legacy, expiresInSec }`.
A node calls it at startup. It **exits only on a 401** (a bad or revoked credential, with a clear
message) and **retries network errors** with backoff, so a cluster cold start does not crash-loop.
It logs a warning when fewer than 14 days remain.

### 4.3 The gate

**The label is signed into the job token.** At dispatch the gateway resolves
`label = runsOn(persona)` and signs it into the job token (`claims.label`) and into the job payload.
For every request that authorises on a job token, the gateway then requires:

```
claims.label ∈ node.labels
```

No registry read is involved, so there is no staleness window between gateway replicas, and a node
cannot be told "your label is right" by a replica that has not yet seen a relabel. The *live*
`runs_on` is re-checked at **token refresh** and at **claim** (§4.6): if it differs from
`claims.label`, the refresh is refused and the job is moved. A job token from before this change has
no `label` and is treated as `default`.

On failure: **403** with a generic body (`this node may not serve this agent`) and an error-level log
with the node id and persona.

**Route table.** The router becomes a declarative table: each route declares its method, path
pattern, auth requirement (`node`, `node+job`) and a **required `gate` field** (`label`, `none`
with a written reason). A test enumerates the table and fails when a route has no gate decision;
that is what "every route has been considered" means, and it is only possible with a table.

| Endpoint | Gate |
|---|---|
| `…/personas/:p/runtime`, legacy `…/runtime` | label |
| `…/mcp-credentials`, `…/refresh` | label |
| `…/remote-key` | label |
| `/v1/tools/*` | label (every call; includes the MCP bridge of WS-C) |
| `/v1/sessions/:id` | label |
| `/v1/jobs/:id/token-refresh` | label, and bounded (§4.4) |
| `/v1/pending/:id` | label, and bound to the session (§4.4) |
| `/v1/jobs/:id/ack`, `/fail` | node identity; body bounded (§4.4) |
| `/v1/jobs/:id/token-reissue` | label, node identity, bounded (§4.4) |
| `/v1/node/whoami` | node identity only |

**What the gate does and does not guarantee.** A node without the persona's label cannot obtain its
bundle, provider credentials, MCP tokens, SSH key or tool access, even holding a valid job token for
it. It does **not** hide job payloads from a node that can read Redis, and it does not isolate files
or processes (§4.12).

### 4.4 Hardening four endpoints

- **`token-refresh`** is capped by **total job age**. The refreshed token carries `iat0` (the first
  issue time); refresh is refused when `now - iat0` exceeds `SLAUDE_JOB_TOKEN_MAX_AGE` (default 6
  hours). A token from before this change is treated as issued at its own `iat`. The cap is measured
  from `iat0`, not from the grace window.
- **`/v1/pending/:id`** is bound to the caller by **session**: it answers only when the gate row's
  `sessionId` equals the caller's `claims.session` (the column exists, `pending-source.ts:16`), else
  404 so existence is not revealed. Old nodes send no job token there, so a **tokenless** call is
  accepted **only from the legacy identity**, behind `SLAUDE_NODE_ALLOW_TOKENLESS_PENDING` (on by
  default for one release, with a deprecation warning).
- **`ack|fail`** require node identity; the logged body is truncated and stripped of control
  characters.
- **`token-reissue`** (new): a job that waited longer than `JOB_TOKEN_TTL + grace` (about 75 minutes)
  cannot be refreshed and would be unrunnable, which is exactly what happens to an unserved label.
  When a node claims such a job it calls `token-reissue`; the gateway re-mints the token from the
  job's own data after the label gate and **only if the job exists in the queue and its total age is
  under a cap** (`SLAUDE_JOB_MAX_AGE`, default 24 hours).

### 4.5 `personas.runs_on`

- Column: `personas.runs_on text NULL`, an additive migration whose **number is assigned at merge
  time**, validated against the label regex, Postgres only like the table. Null means `default`.
- `/deploy` payload: `runsOn: "label"`, desired-layer, **not overridable** at runtime (the override set
  stays `soul | model | mcp`), so git remains the source of truth for where an agent runs.
- sqlite and filesystem personas have no row, so their label is always `default`.
- Files that change: `src/db/personas.ts` (Row, `toDesired`, the SELECT and both upserts),
  `src/persona/effective.ts` (`DesiredPersona`, `mergeEffective`, `sameDesired` so the *report* is
  right), `src/persona/sync/payload.ts` (`personaSpec`), `src/persona/sync/run.ts`,
  `src/persona/types.ts`, `src/persona/registry.ts` (a `runsOnFor(personaId)` accessor beside
  `managedPersonaModel`), `src/cli/personas.ts` (`renderDir`, `exportHome`), the panel's persona
  list, and the tests in §7. The WS-A and WS-C fields join the same lists.
- A sync that references a label no live node carries is a **warning**, not an error.

### 4.6 Queues, dispatch, the worker and relabel

Names (in `keys.ts`, the only place that builds them):

| Queue | For |
|---|---|
| `turns` | label `default` (unchanged name) |
| `turns.label.<label>` | any other label |
| `turns.<nodeId>` | a node's own warm-session queue (unchanged) |

Keeping `turns` for `default` is deliberate: an existing node, old or new, keeps consuming it, so a
mixed-version cluster behaves during a rolling upgrade. A node whose id starts with `label.` is
refused at startup, so a node id can never collide with a label queue.

**Producer** (`dispatch.ts`):

1. Resolve `label = runsOn(persona)` and put it in both the job token and the job **payload**.
2. Warm-session routing (`registry.lookup`) is used only if the session's node **still carries `label`**
   (§4.8). Otherwise the target is the label queue.
3. `TurnTarget` becomes `{ label } | { node }`; `"shared"` becomes `{ label: "default" }`.
4. If the coalesce index points at a pending job on a different queue than the one computed, the
   pending job is moved to the correct queue before the message is appended (`moveTo(label)`,
   generalising `moveToShared`). A relabel must not strand a message.

**Consumer** (`worker.ts`): one BullMQ worker per label in the node's credential, plus its own queue,
each with its own connection. **There is no node-level semaphore** (an earlier draft had one):
holding claimed jobs *active* while they wait would starve idle nodes and hide the backlog from the
autoscaler, which reads the wait list. Per-worker `concurrency` is `SLAUDE_NODE_CONCURRENCY`, and the
docs state that a node's ceiling is `workers × concurrency` so operators size it themselves.

**On claim,** a node compares the job payload's `label` with its own. A mismatch calls
`moveTo(label)` for the payload's label, which puts the job on the right queue — it is **not** a
delayed re-queue on its own queue (that was the 500 ms hot-loop pattern).

**A gate 403 is typed and handled by the gateway, not by BullMQ.**

- The node client maps a gate 403 to a `GateDenied` error. In the tool shims it becomes an `isError`
  result **and sets a flag on the session**; at turn end the worker sees the flag and **fails the job
  with the code `LABEL_MISMATCH`** instead of acknowledging "done". A 403 on the bundle fails the job
  the same way, with BullMQ's `UnrecoverableError`, so it is not retried on the same queue.
- On `LABEL_MISMATCH` the gateway (the dispatch follower) **re-dispatches the turn once** to the
  persona's current label queue (a counter in the job data bounds it at one) and posts nothing; if the
  second attempt also fails the user sees one fixed message.

**Reaper.** For a dead node's own queue the reaper now rescues **active jobs whose lock has expired**
as well as waiting and delayed ones, moving them to the persona's label queue with `moveTo`. This closes
a gap that exists today for warm-routed turns, independent of labels. (Backlog item, with a kill-a-node-
mid-turn test.)

### 4.7 Unserved labels

The reaper-runner (leader loop, every 30 s) computes, for every label **in use**, waiting jobs and live
nodes holding it. "In use" cannot come from heartbeats (a label with no live node has none), so it is the
union of the distinct `runs_on` values of live personas and the `turns.label.*` queues that exist in
Redis. When waiting is non-zero and live nodes are zero for longer than `SLAUDE_LABEL_UNSERVED_SECS`
(default 60), it sets `slaude_label_unserved{label}` to 1 and exposes the label as `unserved` to the
panel. A Slack message is **not** in the first cut.

**Autoscaling.** The KEDA trigger is a Redis list length, so each label needs its own ScaledObject with
its own `listName` (`slaude:bull:turns.label.<label>:wait`) targeting that label's node Deployment. A
label should keep **at least two replicas** for HA; the docs state the cost. The depth gauge gains a
`label` series, and the metrics, alert and probe queries that hard-code `queue="turns"` are updated.

### 4.8 Heartbeat and label change

The heartbeat value stays a bare timestamp (`nodeLastBeat` parses it). Labels go in a **new key**
`nodelabels:<id>` (same TTL), written by `nodeUp` and `beatNode` in one transaction, the key builder in
`keys.ts`. `registry.nodesWithLabel(label)` joins live nodes to their labels. **A node with no
`nodelabels:` key (an old node) is treated as `{default}`**, so warm routing keeps working during a
rolling upgrade.

**When a persona's label changes:** new messages go to the new label; warm routing ignores a node that
lacks it; pending coalesced jobs are moved (§4.6); the old node's warm session idles out and
unregisters. A turn already in flight keeps the label signed into its token. It ends with
`LABEL_MISMATCH` and is re-dispatched once (§4.6) only if its node no longer carries that label, so the
gate refuses its next call, or if a refresh at claim is refused. A turn on a node that still carries the
old label finishes there. To stop it, re-credential the node without the label or abort the turn. The session-config fingerprint is not used: it reboots a session on the same node, which
is the wrong remedy.

### 4.9 Stated limits

Nodes reach Redis directly. Queue names are therefore **routing, not access control**: a node could read
another label's queue and its job payloads (message text). What the gate enforces is the **credential
path**; a node that takes a foreign job cannot run it with that persona's credentials. Files are shared
until sandboxing. The docs for this feature say both, in these words, in the first paragraph.

### 4.10 Node-local stdio MCP

A manifest on the node from `SLAUDE_NODE_MANIFEST` (default `/etc/slaude/node.json`), in the image or a
ConfigMap. The gateway never reads it.

```jsonc
{
  "version": 1,
  "mcpServers": {
    "tf":  { "command": "terraform-mcp", "args": ["--stdio"], "env": { "TF_TOKEN": "${NODE_TF_TOKEN}" } },
    "gh":  { "command": "gh-mcp" }
  },
  "allow": { "platform-bot": ["tf", "gh"], "support-bot": ["gh"], "ops-bot": "*" }
}
```

- `allow` maps a persona name to a list of server names, or `"*"` for every server in the manifest. **A
  persona not listed gets nothing.**
- **The allow-list is keyed on the persona from the verified job claims**, never on the unsigned
  `personaId` in the Redis payload.
- `${VAR}` in `env` is expanded in the slaude process on the node from the node's own environment before
  the config reaches the child, and a stdio server is given an **explicit minimal environment** (its own
  `env` plus `PATH` and a small fixed set), not the child's.
- The manifest is read and validated at node start; an invalid manifest, an `allow` entry naming an
  unknown server, or a non-stdio entry stops the node with a clear error. A change needs a pod roll.

**The allow-list must cover every stdio server a node mounts, including plugin MCP servers.** Today
`loadInstalledPluginMcps` mounts every plugin MCP on every node for every persona, after the resolver
output. So:

- plugin MCP servers are mounted **only if** the manifest allow-lists them for the persona (they are
  declared in the manifest like any other server; a plugin that is installed but not listed is not
  mounted);
- the merged config is built with the **resolver output last** so a gateway-resolved server wins a name
  collision, with a node warning, and `strictMcpConfig: true` is set so the CLI does not read a project
  `.mcp.json` or any other source;
- the `<mcp-servers>` block in the system prompt is built from the **merged** map, and its "additional
  servers may come from `.mcp.json` in the working directory" sentence is removed.

### 4.11 Compatibility and rollout

- **Order:** gateways first, then nodes, for every step.
- New gateway, old nodes: old nodes present the static token, are `default`, and consume `turns`;
  personas without `runs_on` are `default`; nothing changes. Old nodes send no `nodelabels:` (treated as
  `{default}`) and no job token to `/v1/pending` (tolerated for one release).
- New nodes, old gateway: a node with the static token behaves as before; a node with a signed credential
  is rejected (401) at boot with that message.
- `SLAUDE_NODE_KEY` unset: signed credentials are not accepted and the legacy token is the only door.
- The Secret split (§4.0) is staged: a warning first, refusal one release later.
- The migration is additive and nullable. Rolling the code back leaves the column unused; the release
  plan carries the **configured-then-rolled-back** runbook, because the old code ignores `runs_on` and
  would run every persona on `default`.

### 4.12 The trust model, stated

A node is one trust domain. Every agent child on it runs as the same user as the node process, so one
child's Bash tool, a plugin subprocess or a prompt-injected turn can read the node process's environment
and the other children's environment and argv (`/proc/<pid>/environ`, `cmdline`). Therefore **labels
separate trust between nodes; they do not separate personas that share a node.** Put personas that must
not see each other's secrets on nodes with different labels. Redis is reachable from every node and files
are shared (§4.9). Sandboxing is where the finer boundary comes from; this spec does not claim it.

## 5. Security summary

- Gateway secrets never reach a node (§4.0), and a node's own credential is the only secret it needs.
- A separate key for node credentials, with expiry, a lifecycle gauge, revocation by id and a rotation
  overlap.
- The label is a **signed claim** in both the node credential and the job token.
- A route table whose every route has a recorded gate decision, enforced by a test.
- No secret in a log: the mint CLI prints once; `inspect` prints claims only; `ack|fail` bodies are
  bounded.
- The legacy door can be closed, and its use is measured.
- Public-repo hygiene: generic labels in docs and tests (`engineering`, `finance`).

## 6. Testing

**Unit.**
- Credential: round trip; wrong key; expired; `labels` empty, too many, malformed; unknown `v`; both
  keys during rotation; revoked id; a job token is not accepted as a node credential and the reverse.
- `authenticateNode`: signed, legacy (new variable and old, with warning), neither, tampered, legacy off.
- **Gate matrix**, for every route in the table: a node with the label passes, one without gets 403, a
  legacy node passes only for `default`, a job token with no `label` is `default`.
- **Route-table test**: fails when a route has no gate decision.
- Hardening: `token-refresh` refused past `MAX_AGE` and keeps `iat0`; `/v1/pending/:id` 404 for another
  session, tokenless accepted only for legacy and only while the flag is on; `ack|fail` truncation;
  `token-reissue` refused without the label or past the age cap.
- Queue names; `moveTo`; coalescing across a relabel; warm routing ignored when the node lacks the label;
  an old node with no `nodelabels:` is `{default}`.
- `GateDenied` → `LABEL_MISMATCH` and one re-dispatch, not a BullMQ retry loop; a tool-call 403 does not
  end the turn "done".
- Reaper rescues an **active** job with an expired lock on a dead node's queue.
- Manifest: valid; unknown server in `allow`; non-stdio; `"*"`; unlisted persona gets nothing; `${VAR}`
  expansion; minimal env; **a plugin MCP not in the allow-list is not mounted**; collision with a gateway
  server (gateway wins); `strictMcpConfig`; the `<mcp-servers>` block matches the merged map.
- Scrub list covers `SLAUDE_NODE_KEY*` and `SLAUDE_NODE_LEGACY_TOKEN`; the node boot check names the
  offending variable and not its value.

**Existing suites to update** (they assert queue names or the old shapes): `tests/queue/keys`,
`turns-real`, `reaper-real`, `registry-real`; `tests/integration/warm-cold`, `coalescing`,
`node-kill-retry`; `tests/node/worker-e2e`, `worker-health-real`, `dispatch-authority`;
`tests/gateway/core/dispatch-*`; `tests/gateway/api/auth`, `v1`, `token-refresh`, `pending`,
`runtime-persona`, `mcp-credentials`, `remote-key`; `tests/db/personas-schema`, `personas-repo`,
`schema-drift`; `tests/persona/payload`, `run-sync`, `effective`, `registry-db`; `tests/cli/personas`.
The probe and verify scripts that hard-code `TURNS_QUEUE` are updated together.

**Integration and end to end (`k8s-local`, the nightly HA suite).** Two node deployments with different
signed labels and the **split Secrets**. Persona A (`engineering`) and persona B (`finance`): each turn
lands on its own deployment; a node deliberately started with the wrong label is refused a bundle with
403 while holding a valid job token; a node pod started with a gateway-only variable refuses to boot (or
warns, in the first release); relabel a persona and show new turns move and an in-flight turn is
re-dispatched once; kill a node during a warm-routed turn and show the active job is recovered; stop
every node of one label and show the `unserved` signal; a cluster of legacy nodes keeps working
untouched; a cluster with the legacy door closed works.

## 7. Release

Touches node authentication, the queue topology, the DB schema, the agent loop and the deploy manifests:
a release candidate, after WS-A, with notes under the stable name. Phase 0 (the Secret split) can ship
earlier as a warning-only change (release plan). The soak runs both verify scripts and the nightly suite
against signed-credential nodes **and** against legacy-token nodes.

## 8. Open decisions

1. **Job-token caps:** `SLAUDE_JOB_TOKEN_MAX_AGE` (6 hours) and `SLAUDE_JOB_MAX_AGE` (24 hours) proposed;
   the longest legitimate turn and the longest acceptable queue wait decide them.
2. **Whether to close the legacy door by default** in the release after this one.
3. **Slack message for an unserved label** after the metric and the panel flag.
4. **Whether the NetworkPolicy ships in the base manifests** or only the local overlay and the docs.

## 9. Deferred

Asymmetric (Ed25519) node credentials, so gateways hold only a public key and minting happens off-cluster;
revisit if minting must leave the cluster. With the Secrets split, HMAC is adequate. A per-label Redis
ACL; a Slack alert for an unserved label; multi-label selectors.
