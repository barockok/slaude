# Centralized persona runtime — umbrella design and release tracker

**Date:** 2026-10-03 · **Revised:** 2026-10-04 (after an independent design review and the MCP bridge spike)
**Status:** living document. Update it as each workstream lands.
**Children (all written):**
- WS-A `2026-10-03-persona-provider-credentials-design.md`
- WS-B `2026-10-03-node-labels-and-routing-design.md`
- WS-C `2026-10-03-persona-runtime-config-and-visibility-design.md`
- WS-D `2026-10-03-ha-cluster-hardening-design.md`
- WS-E `2026-10-03-ha-release-plan-design.md`

**Builds on:** `docs/internal/superpowers/specs/2026-08-24-horizontal-scale-design.md`,
`docs/superpowers/specs/2026-10-01-personas-as-code-design.md`,
`docs/superpowers/specs/2026-09-18-phase-3-user-scoped-mcp-credentials-design.md`

## 1. Purpose

This document is the single place that says what the finished high-availability cluster looks like, what is
already built, what is still to do, and what must be true before it is released. Individual specs go deep on one
slice; this one keeps the slices from drifting apart and keeps anything from being forgotten.

It covers two things:

1. **The target model** — a centralized gateway that owns every definition of an agent and every durable secret,
   and specialized nodes that only run turns (§2–§4).
2. **Finalizing HA and the cluster setup** — the defects and gaps found while standing the topology up and
   smoke-testing it, and the release gate (§6–§8).

## 2. Target model

An administrator can open the gateway and see what every agent *is*: its soul, its model, its provider credentials
(as a reference), its MCP servers, its knowledge scope, its skills, and which machines run it. Nodes are
interchangeable workers within a label; they hold no agent definition, **no gateway secret and no MCP credential**.
The one secret a node does receive for a session is the LLM provider credential (D17), which is why a node is a
trust domain (D15).

```
                         ┌───────────────────────────────────────────┐
  git (optional) ──sync─▶│ GATEWAY (replicas)                        │
  operator / panel ─────▶│  personas: soul, model, runs_on, provider │
                         │    refs, remote MCP, KB scope             │
  Vault (KV v2) ◀──read──│  resolves provider secrets; owns Slack,   │
                         │  OAuth + MCP credentials (MCP bridge),    │
                         │  cron, queues, panel, portal, KB          │
                         └───────┬───────────────────────────────────┘
                                 │ turns.<label>  (Redis)      /v1 REST: bundle, tools, MCP bridge
                 ┌───────────────┼───────────────────────────┐
                 ▼               ▼                           ▼
          nodes labelled    nodes labelled              nodes labelled
          "engineering"     "finance"                   "default"
          (image has CLIs,  (image has its own          (image as today)
           stdio MCP)        software)
                 │ node Secret: its own credential + Redis URL only.
                 │ every node: shared filesystem for skills/workspaces;
                 │ fetches its persona's bundle (incl. provider env) per session
```

## 3. Decisions

All made with the operator, except where marked as a review change.

| # | Decision | Where it is specified |
|---|---|---|
| D1 | The gateway database is the runtime source of truth for persona, soul, model, remote MCP and (new) provider references. Git is an optional authoring source. | Existing (personas as code) |
| D2 | Centralized means the **administrator can see** every agent definition in the gateway. | WS-C |
| D3 | Nodes are specialized machines with software installed; several personas may share one machine; machines scale horizontally. | WS-B |
| D4 | There is **no pool entity**. A node carries a set of **labels**; labels are opaque strings, not a taxonomy. | WS-B |
| D5 | A persona names **one** label it runs on (`runs_on`). Multi-label selectors are deferred. | WS-B |
| D6 | A node's labels are bound to a **signed node credential**, not self-declared; the label is also signed into each job token. | WS-B |
| D7 | Routing is a queue per label (`turns.<label>`, with `turns` for `default`); a node consumes the queues of the labels it holds plus its own warm-session queue. | WS-B |
| D8 | The credential gate: the gateway releases a persona's runtime bundle and credentials only to a node whose labels include the job token's label. File isolation is **not** part of this; it comes with sandboxing. | WS-B |
| D9 | Provider credentials are per persona, held in HashiCorp Vault (KV v2, static), referenced by the persona, resolved only by the gateway, and **fetched when a session starts, resumes or reloads**. | WS-A |
| D10 | stdio MCP servers, **including plugin MCP servers**, are node-local: defined in a manifest on the node with a per-persona allow-list that defaults to none. The gateway does not hold them. | WS-B |
| D11 | Remote MCP is reached through a **gateway-side MCP bridge**: the node mounts in-process servers that relay to the gateway, which is the MCP client; credentials, OAuth refresh and the agent-versus-user identity choice never leave the gateway. | WS-C |
| D12 | Knowledge is a per-persona list of source ids enforced by the gateway. It is a **retrieval filter, not isolation** (D15). | WS-C |
| D13 | Skills stay on the shared filesystem with a fixed layout (`skills/`, `personas/<name>/skills/`); the panel lists them by reading that layout. | WS-C |
| D14 | Nodes reach the gateway only through its REST API for control and tools. **Today this is false**: nodes load the gateway's whole Secret. WS-B phase 0 makes it true: a node holds only its own credential and the Redis URL, and no Vault, Slack or database access. | WS-B §4.0 |
| D15 | **The node, not the persona, is the trust unit.** Agent children on one node share a user and can read each other's environment and argv. Labels separate trust between nodes, not between personas on a node. This is stated in the docs. | WS-B §4.12, WS-A §9 |
| D16 | Review change: **no per-message secret check and no fingerprint rotation.** A rotated provider key reaches the next session spawn; an urgent rotation uses the existing reload. | WS-A §8 |
| D17 | The LLM provider credential **stays delivered to the node.** A gateway LLM proxy that would keep it off nodes is **parked**; no spike has been run for it. | WS-A §13 |
| D18 | Review change: the **Secret split is phase 0 of WS-B**, shipped staged (warn, then refuse), with dedicated ServiceAccounts and an optional NetworkPolicy, and the exposed secrets rotated. | WS-B §4.0, WS-E §5 |
| D19 | Review change: the `/deploy` payload becomes **versioned and strict**, staged (report, then refuse), so an older gateway cannot silently drop a new field. | WS-D D5.1 |
| D20 | Review change: failures carry **typed codes** and the gateway posts fixed text; raw error text is never posted to Slack. | WS-D D1.6 |

**Changes of mind during the design, kept so they are not re-litigated:** "pool" became labels (D4); "kind" became
labels (D4); a `db://` secret scheme was dropped because `provider_creds` has no per-secret names; software inventory
reporting was dropped from routing (the gateway needs a name match, not a list); static MCP header secrets on nodes
(an option in the first WS-C draft) were replaced by the bridge (D11); fingerprint-based rotation was dropped (D16);
a node-level concurrency semaphore was dropped because it starves idle nodes and hides backlog from the autoscaler.

**The MCP bridge spike (2026-10-03/04), summarised.** A real CLI session used a generic in-process bridge relaying to a
real upstream MCP server. All five tool shapes worked with intact arguments; the credential followed the identity per
call in one live session; the CLI lists tools only at boot, so the **tool list is fixed per child boot** while
per-call credentials still follow `runAs`. A transparent HTTP proxy was investigated and rejected (WS-C §4.2.10).

## 4. Workstreams

### WS-A — Provider credentials by reference (spec revised)

Persona holds `provider` references; the gateway resolves `vault://` (Kubernetes auth only) and `env://` at bundle
build; resolution failure is **fatal and typed**; a node's own env does not stand in (flag, default unchanged); the
gateway's own provider for its own model calls is stated; `auth_token` becomes expressible; the Vault service account is
treated as a secret.
**Depends on:** D5.1 (payload version) for safe field addition. **Done when:** two personas on one cluster each reach the
mock LLM with their own key; a new Vault version reaches a new thread; Vault down fails a fresh start with the fixed
message and no raw error text, while a warm session keeps running.

### WS-B — Node labels and routing (spec revised)

**Phase 0:** split the Secrets, ServiceAccounts, node boot check, rotation. Then: signed node credential with a lifecycle
(expiry gauge, revocation by id, rotation overlap); `authenticateNode` and `whoami`; the label signed into the job token;
a **declarative route table** with a gate decision per route; hardening of `token-refresh`, `/v1/pending`, `ack|fail`, plus
`token-reissue`; `personas.runs_on`; `turns.<label>` queues; typed `LABEL_MISMATCH` and one re-dispatch; the reaper rescues
active jobs on dead nodes' queues; the unserved-label signal; the stdio manifest covering plugin MCP servers.
**Depends on:** phase 0 first. **Done when:** two node deployments with different labels each receive only their personas'
turns; a node holding the wrong label gets 403 on bundle, credentials and tools; a cluster with the legacy door closed
works; a node holding a gateway-only variable warns (then refuses).
**Cuts:** no Redis ACLs, no Slack alert for an unserved label in the first cut, no asymmetric credentials.

### WS-C — Per-persona config on nodes, and visibility (spec revised)

The **MCP bridge**; `kb_sources` enforced in `brainDepsFor`, with `list_kbs`/`search_kbs` scoped and the memory-provider claim
verified first; the skills contract and provenance; the panel read model and screens.
**Depends on:** WS-B (node identity and the gate; labels for the panel view) and D5.3 (the outbound-fetch policy). **Done
when:** a bridged MCP server is callable on a node as the agent and, in a 1:1, as the user, with no MCP secret on the node;
and an administrator can answer "what is this agent and where does it run" from the panel alone.

### WS-D — HA and cluster finalization (spec revised; backlog in §6)

Batches D1 (HTTP-mode Slack correctness, including raw error text), D2 (approvals, portal, `/mcp`), D3 (local cluster and the
verify harness), D4 (verification tasks), and **D5 (foundations and security: versioned payload, the gateway's own model
children, one outbound-fetch policy, manifests)**.

### WS-E — Release (spec revised; gate in §8 and in WS-E §6)

A direct patch release for the fixes and warnings; a release-candidate series for the schema, node-auth, queue and bridge
changes; an honest rollback story; alerts, a capacity check and a rehearsal in the gate.

## 5. What exists versus what is new

| Capability | State |
|---|---|
| Gateway replicas, node workers, shared queue, session locks, reaper | Built; HA suite proves failover |
| Cron claims an occurrence before dispatch | Built |
| Personas in the DB, `/deploy` sync, runtime overrides, tombstones | Built |
| MCP credential store, `runAs`, node projection, single refresher | Built; on nodes it serves **no external server today** |
| Portal onboarding and a connect any replica can finish | Built |
| `/remote` exec on the initiator's machine | Built |
| Fake-Slack wire-level harness for the HA suite | Built |
| Panel with OIDC | Built |
| `provider_creds` table | Built, **no writer**, no `auth_token` kind |
| Per-persona `mcp_json` | Stored, **not consumed on nodes**; the bridge replaces the planned consumption |
| Plugin MCP servers on nodes | Mounted from node disk, **outside any allow-list** |
| Gateway / node Secret separation | **Missing**: nodes load the gateway's whole Secret |
| Node credential, labels, `runs_on`, label queues, route table | **New** |
| Node-local stdio MCP manifest (incl. plugins) | **New** |
| Provider references and the Vault backend | **New** |
| MCP bridge | **New** (spiked) |
| KB scope per persona | **New** |
| Panel agent-definition view | **New** |

## 6. HA and cluster finalization backlog

Sources: the field notes, the smoke-test hand-off, a second-machine rebuild and smoke test, and the investigations and
reviews of 2026-10-03/04. "Observed" means reproduced; "recorded" means taken from a note and not re-run; "reviewed" means
reported by a reviewer against the code and not independently re-run.

| ID | Item | Status |
|---|---|---|
| H1 | In HTTP mode the bot token is read from the environment per message even when the registry holds it; worked around with a Secret and `set env`. | Observed; WS-D D1.1 |
| H2 | In HTTP mode, calls through the transport's shared client go out as the *oldest* registered app. | Recorded; WS-D D1.2 (release-candidate series) |
| H3 | The lazy client lacks methods the code calls (`files.uploadV2`, `chat.delete`, `pins.*`, `conversations.setTopic/setPurpose`, canvases, `files.info`); `chat.postEphemeral` is fixed. | Verified; WS-D D1.3 |
| H4 | A second approval click erases the decision record. | Verified; WS-D D2.1 |
| H5 | `bun run manifest` emits `users.profile:write` as a bot scope, which Slack rejects. | Observed; WS-D D1.5 |
| H6 | `up.sh` races Postgres's temporary init server. | Verified; WS-D D3.1 |
| H7 | The portal page has no unlink button though the API and docs expect one. | Verified; WS-D D2.2 |
| H8 | Slack `/mcp` reads the global list only, so it and the portal can disagree. | Verified; WS-D D2.3 |
| H9 | Unverified: a person actually *sees* the `/link` private reply. | Open; WS-D D4.2 |
| H10 | Unverified: an agent in a 1:1 using a connected credential against a real MCP server. | Open; WS-D D4.3, WS-C bridge test |
| H11 | `kubectl port-forward` pins one pod; any gateway restart silently breaks a tunnel until recycled. | Observed; WS-D D3.5 |
| H12 | `verify-turns.sh`: diagnostics go to stderr and are lost from a captured log; probes use Kubernetes' 1 s default timeout; local limits oversubscribe a 3-CPU node. | Observed; WS-D D3.2 |
| H13 | A verify run ends with the node deployment at 3 replicas. **Cause found:** the local overlay's node HPA (`maxReplicas: 3`, 60 % of a 250 m request) scales it up and holds it for the 10-minute window; the script never changes replicas. | Cause found; WS-D D3.3 |
| H14 | Documentation only: 45 s is the local overlay's lock TTL, 10 minutes is the default; BullMQ stall detection adds a floor of around 30 s. | Doc task; WS-D D4.1 |
| H15 | A persona with no stored provider credentials runs on the node's own env; a failing resolver is swallowed. | Closed by WS-A §5.4 |
| H16 | Per-persona `mcp` is not consumed on nodes. | Closed by the WS-C bridge |
| H17 | The compare-and-set race and the cluster proof for personas as code were never run on real infrastructure. | Recorded; WS-D D4.4 |
| H18 | A `cloudflared` tunnel is a launchd or foreground process on a dev machine; two connectors for one tunnel can coexist unnoticed. | Observed; docs, D4.5 |
| H19 | `up.sh` cannot set the model, and the obvious fix fails because the ConfigMap wins over the Secret in `envFrom`. | Verified; WS-D D3.4 |
| H20 | Local forward ports are hard-coded and unchecked; another local process held one. | Observed; WS-D D3.5 |
| H21 | `/v1/pending/:id` requires only the bearer and is bound to no persona or session; old nodes send no job token there. | Verified; WS-B §4.4 |
| H22 | `/v1/jobs/:id/token-refresh` can renew a job token indefinitely. | Verified; WS-B §4.4 |
| H23 | `/v1/jobs/:id/ack\|fail` accepts any job id with the bearer alone and logs the caller's body. | Verified; WS-B §4.4 |
| H24 | **Corrected.** Nodes mount **no external MCP server** (global or per-persona) but **do** mount plugin MCP servers from node disk, outside any allow-list, spread after the resolver output so they win name collisions. `bundle.mcpJson` and `skillsPaths` are shipped and read by no node code. | Verified in code; to confirm in a node pod; WS-B §4.10, WS-C §4.2 |
| H25 | There is no panel UI for personas; the endpoints exist and the web app never calls them. | Verified; WS-C §4.4 |
| H26 | Nothing watches a queue for jobs no node will claim; a job waiting more than about 75 minutes cannot be token-refreshed. | Verified; WS-B §4.4, §4.7 |
| H27 | A job left **active** on a dead node's own queue has no surviving worker, and the reaper rescues only waiting and delayed jobs. | Reviewed; to reproduce (kill a node during a warm-routed turn); WS-B §4.6 |
| H28 | **Security.** Every node loads the gateway's whole Secret (master key, job secret, DB URLs, Slack secrets). A node could forge job tokens, decrypt stored credentials, and mint any label. | Verified; WS-B §4.0 |
| H29 | **Security (unverified).** `kb_think` synthesis runs a child with `allowedTools: []` and `bypassPermissions` over untrusted content; an empty list may not disable tools in this SDK. | Reviewed; reproduce first; WS-D D5.2 |
| H30 | **Security.** Raw error text (provider and CLI messages) is posted into Slack threads. | Verified; WS-D D1.6 |
| H31 | **Security (unverified).** The memory provider runs on nodes and `agentScope()` resolves to `agent-default`, so personas' transcripts may land in a slice other personas can read. | Reviewed; verify; WS-C §4.1.7 |
| H32 | `list_kbs` and `search_kbs` are unscoped and expose disk paths; KB wikis live on the volume nodes mount. | Verified; WS-C §4.1.4, §4.1.7 |
| H33 | No outbound-fetch protection anywhere (no host allowlist, private-range denial, redirect policy or timeout), including OAuth discovery and token exchange. | Verified; WS-D D5.3 |
| H34 | In `mono`, provider references and stored credentials are never applied (only the node worker installs a child-env resolver). | Verified; WS-A §5.2 |
| H35 | The gateway's own model calls (soul extraction, `kb_think` synthesis, `/model` validation) use the gateway's env provider, not the persona's. | Verified; WS-A §5.5 |
| H36 | An older gateway silently drops payload fields it does not know, so a rollback or an un-upgraded replica loses `runsOn`, `provider` or `kbSources`. | Verified; WS-D D5.1 |
| H37 | The gateway and nodes share the `default` ServiceAccount with its token mounted; no manifest sets a ServiceAccount. | Verified; WS-B §4.0 |

## 7. Sequencing

1. **WS-D D5** where a feature depends on it: D5.1 (payload version) before any new payload field; D5.3 (outbound-fetch
   policy) before the MCP bridge; D5.2 reproduced early, because it is a security question.
2. **WS-B phase 0** (the Secret split, staged) ships with the patch release; it is the precondition for WS-B's gate.
3. **WS-A**: smallest and independent among the features, and it fixes live gaps.
4. **WS-B** (the rest): the riskiest, with the route table and the endpoint audit; it ships as a release candidate.
5. **WS-D** D1, D2 and the harness fixes ride the patch release (D1.2 rides the RC series); H12–H14 and H17 need the cluster
   and gate the release; H9–H10 are verification tasks.
6. **WS-C** after WS-B: the bridge needs node identity and the gate; the panel view needs labels.
7. **WS-E** once the gate is met.

Each workstream goes through its own spec, plan and review. This document is updated when any of them changes scope.

## 8. Release readiness gate

The full gate is WS-E §6. In brief, on a cluster at the documented size: all feature workstreams merged; both verify scripts
pass completely, twice in a row, against signed-credential nodes, legacy-token nodes and a cluster with the legacy door
closed; the nightly HA suite green for three consecutive runs including the RC's commit; a real-Slack runbook pass; the
cluster proof on a managed cluster; the listed defects fixed or consciously deferred; **alerts and runbooks exercised**; a
**capacity check** recorded; a **configured-then-rolled-back rehearsal**; docs and field notes; shipped as `vX.Y.Z-rc.N` first,
soaked, then promoted.

## 9. Deliberately deferred

File isolation between labels and between personas on a node (sandboxing); a gateway LLM proxy to keep provider keys off nodes
(parked, unspiked); Vault dynamic secrets, other auth methods and a second backend; per-tenant Vault prefixes beyond
`{persona}`; changing the provider-env fallback default; multi-label selectors; asymmetric node credentials; a software
inventory reported by nodes; bridging MCP notifications, sampling, prompts and resources; a Slack alert for an unserved label;
moving `mono` onto the bridge.

## 10. Open questions

- WS-B: the job-token caps (6 h refresh, 24 h total age) and whether to close the legacy door by default next.
- WS-C: whether nodes should mount `knowledge/` at all; persona-private skills as first-class targets on nodes; the
  memory-provider fix once verified.
- WS-D: whether D5.2 reproduces; which managed cluster hosts the one-time proof.
- WS-E: soak length; whether v0.44.1 waits for the harness fixes.
- Who owns minting node tokens in a GitOps flow (a CLI on the gateway first; a panel action later).
