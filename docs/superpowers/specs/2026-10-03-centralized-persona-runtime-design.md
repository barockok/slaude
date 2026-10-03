# Centralized persona runtime — umbrella design and release tracker

**Date:** 2026-10-03
**Status:** living document. Update it as each workstream lands.
**Children:** `2026-10-03-persona-provider-credentials-design.md` (written);
node labels and routing (to be written); per-persona config on nodes and
administrator visibility (to be written)
**Builds on:** `2026-08-24-horizontal-scale-design.md`,
`2026-10-01-personas-as-code-design.md`, `2026-09-18-phase-3-user-scoped-mcp-credentials-design.md`

## 1. Purpose

This document is the single place that says what the finished high-availability
cluster looks like, what is already built, what is still to do, and what must be
true before it is released. Individual specs go deep on one slice; this one keeps
the slices from drifting apart and keeps anything from being forgotten.

It covers two things:

1. **The target model** — a centralized gateway that owns every definition of an
   agent, and specialized nodes that only run turns (§2–§4).
2. **Finalizing HA and the cluster setup** — the defects and gaps found while
   standing the topology up and smoke-testing it, and the release gate (§6–§8).

## 2. Target model

An administrator can open the gateway and see what every agent *is*: its soul, its
model, its provider credentials (as a reference), its MCP servers, its knowledge
scope, its skills, and which machines run it. Nodes are interchangeable
workers within a label; they hold no definition of their own and no durable
secret.

```
                         ┌───────────────────────────────────────────┐
  git (optional) ──sync─▶│ GATEWAY (replicas)                        │
  operator / panel ─────▶│  personas: soul, model, runs_on, provider │
                         │    refs, remote MCP, KB scope             │
  Vault (KV v2) ◀──read──│  resolves secrets; owns Slack, OAuth      │
                         │  refresh, cron, queues, panel, portal     │
                         └───────┬───────────────────────────────────┘
                                 │ turns.<label>   (Redis)
                 ┌───────────────┼───────────────────────────┐
                 ▼               ▼                           ▼
          nodes labelled    nodes labelled              nodes labelled
          "engineering"     "finance"                   "default"
          (image has CLIs,  (image has its own          (image as today)
           stdio MCP)        software)
                 │ every node: shared filesystem for skills/workspaces;
                 │ fetches its persona's bundle from the gateway per session
```

## 3. Decisions (all made with the operator)

| # | Decision | Where it is specified |
|---|---|---|
| D1 | The gateway database is the runtime source of truth for persona, soul, model, remote MCP and (new) provider references. Git is an optional authoring source. | Existing (personas as code) |
| D2 | Centralized means the **administrator can see** every agent definition in the gateway. | Visibility workstream |
| D3 | Nodes are specialized machines with software installed; several personas may share one machine; machines scale horizontally. | Labels workstream |
| D4 | There is **no pool entity**. A node carries a set of **labels**; labels are opaque strings, not a taxonomy ("kind"). | Labels workstream |
| D5 | A persona names **one** label it runs on (`runs_on`). Multi-label selectors are deferred; a combined label expresses the same thing. | Labels workstream |
| D6 | A node's labels are bound to a **signed node credential**, not self-declared. | Labels workstream |
| D7 | Routing is a queue per label (`turns.<label>`); a node consumes the queues of the labels it holds plus its own warm-session queue. | Labels workstream |
| D8 | The credential gate: the gateway releases a persona's runtime bundle and credentials only to a node holding that persona's label. File isolation is **not** part of this; it comes with sandboxing. | Labels workstream |
| D9 | Provider credentials are per persona, held in HashiCorp Vault (KV v2, static), referenced by the persona, resolved only by the gateway at session start, resume and reload. | Provider-credentials spec |
| D10 | stdio MCP servers are **node-local**: defined in a manifest on the node (image or ConfigMap), with a per-persona allow-list that defaults to none. The gateway does not hold them. | Labels workstream |
| D11 | Remote MCP and its credentials stay gateway-resolved, per persona. | Per-persona config workstream |
| D12 | Knowledge is a per-persona list of source IDs enforced by the gateway; nodes never touch KB content. | Per-persona config workstream |
| D13 | Skills stay on the shared filesystem with a fixed layout (`skills/`, `personas/<name>/skills/`); the panel lists them by reading that layout. | Visibility workstream |
| D14 | Nodes reach the gateway only through its REST API for control and tools; they hold no Vault, Slack or database access. | All |

**Changes of mind during the design, kept so they are not re-litigated:** "pool"
became labels (D4); "kind" became labels (D4); a `db://` secret scheme was
dropped because `provider_creds` has no per-secret names; software inventory
reporting was dropped from routing (the gateway needs a name match, not a list).

## 4. Workstreams

### WS-A — Provider credentials by reference (Spec: written)

Persona holds `provider` references; the gateway resolves `vault://` and
`env://` at bundle build; rotation reboots warm sessions through the
session-config fingerprint; no silent fallback to a node's own env (flag, default
unchanged); `auth_token` becomes expressible.
**Depends on:** nothing. **Done when:** two personas on one cluster each reach the
mock LLM with their own key; a Vault version bump reaches the next turn; Vault
down fails a fresh start closed with a generic message.

### WS-B — Node labels and routing (Spec: to be written)

Signed node credential carrying labels, minted by an admin CLI; `personas.runs_on`;
`turns.<label>` queues; the credential gate on every `/v1` endpoint that returns
persona-scoped data, with an audit of those endpoints; node-local stdio MCP
manifest with an allow-list; an alert when a label has no live node.
**Depends on:** WS-A for the gate to protect something real (can proceed in
parallel). **Done when:** two node deployments with different labels each receive
only their personas' turns; a node holding the wrong label gets 403 on bundle and
credentials; the legacy static node token still works as label `default`.
**Cuts for the first release:** no Redis token denylist (revoke by expiry and key
rotation); the empty-label alert is a panel flag first, Slack message later.

### WS-C — Per-persona config on nodes, and visibility (Spec: to be written)

Per-persona remote `mcp_json` consumed on nodes (today stored, not consumed);
per-persona KB source list enforced by the gateway; the panel shows, per persona,
soul, model, provider references (never values), MCP, KB scope, skills (read from
the fixed layout), the label it runs on and the live nodes holding that label.
**Depends on:** WS-B for the label view. **Done when:** an administrator can answer
"what is this agent and where does it run" from the panel alone.

### WS-D — HA and cluster finalization (backlog in §6)

Defects and gaps found by standing up and smoke-testing the topology, and the test
harness's own fragility.

### WS-E — Release (§8)

Release candidate, soak, notes under the stable name, docs, promote.

## 5. What exists versus what is new

| Capability | State |
|---|---|
| Gateway replicas, node workers, shared queue, session locks, reaper | Built; HA suite proves failover |
| Cron claims an occurrence before dispatch | Built |
| Personas in the DB, `/deploy` sync, runtime overrides, tombstones | Built |
| MCP credential store, `runAs`, node projection, single refresher | Built |
| Portal onboarding and a connect any replica can finish | Built |
| `/remote` exec on the initiator's machine | Built |
| Fake-Slack wire-level harness for the HA suite | Built |
| Panel with OIDC | Built |
| `provider_creds` table | Built, **no writer**, no `auth_token` kind |
| Per-persona `mcp_json` | Stored, **not consumed on nodes** |
| Node labels, `runs_on`, label queues, signed node credential | **New** |
| Node-local stdio MCP manifest | **New** |
| Provider references and the Vault backend | **New** |
| KB scope per persona | **New** |
| Panel agent-definition view | **New** |

## 6. HA and cluster finalization backlog

Sources: the field notes, the smoke-test hand-off, and a second-machine rebuild
and smoke test. "Observed" means reproduced; "recorded" means taken from a note and
not re-run.

| ID | Item | Status |
|---|---|---|
| H1 | In HTTP mode the bot token is read from the environment per message even when the registry holds it (`missing env …`); worked around with a Secret and `set env`. | Observed, open |
| H2 | In HTTP mode, calls through the transport's shared client go out as the *oldest* registered app. | Recorded, open |
| H3 | The lazy client lacks methods the code calls. `chat.postEphemeral` is fixed; the rest are unaudited. | Partly fixed; audit open |
| H4 | A second approval click erases the decision record. | Recorded, open |
| H5 | `bun run manifest` emits `users.profile:write` as a bot scope, which Slack rejects. | Observed, open |
| H6 | `up.sh` can fail when `pg_isready` passes against Postgres's temporary init server. | Recorded, open |
| H7 | The portal page has no unlink button though the API and docs expect one. | Recorded, open |
| H8 | Slack `/mcp` reads the global list only, so it and the portal can disagree. | Recorded, open |
| H9 | Unverified: a person actually *sees* the `/link` private reply. | Open |
| H10 | Unverified: an agent in a 1:1 using a connected credential against a real MCP server. | Open |
| H11 | `kubectl port-forward` pins one pod; any gateway restart silently breaks a tunnel until recycled. A tunnel went down mid-test this way. | Observed; harness fix open |
| H12 | `verify-turns.sh`: on a 4 CPU / 6 GB host two cron probes reported *could not measure* and pods restarted (liveness and readiness probes timed out, `context deadline exceeded`, with the node under load). Right-size requests and probe timeouts, document the sizing floor, and make the probe report *why* it could not measure (the diagnostic lines were missing from the log). | Observed, open |
| H13 | After an interrupted `verify-turns.sh`, the node deployment was left at 3 replicas instead of 2. Root cause not established. | Observed once, investigate |
| H14 | Two notes disagree on how long a killed node's session lock delays a re-delivered turn (45 s takeover versus a 10-minute TTL). Measure and reconcile. | Open |
| H15 | A persona with no stored provider credentials runs on the node's own env. | Closed by WS-A (flag) |
| H16 | Per-persona `mcp` is not consumed on nodes. | Closed by WS-C |
| H17 | The compare-and-set race and the cluster proof for personas as code were never run on real infrastructure. | Recorded, open |
| H18 | A `cloudflared` tunnel is a launchd or foreground process on a dev machine; two connectors for one tunnel can coexist unnoticed. Document the local-tunnel runbook. | Observed, docs |
| H19 | `up.sh` takes the provider only from four named variables; `SLAUDE_MODEL` is never set, so every turn and the soul extraction fail with "model not found" until set by hand. | Observed, open |
| H20 | Deployment hygiene on a shared dev machine: another local process held the port the gateway forward needs. Make the forward port configurable and fail loudly when it is taken. | Observed, harness |

## 7. Sequencing

1. **WS-A** first: smallest, independent, fixes live gaps, and gives the gate
   something to protect.
2. **WS-B** next, with the endpoint audit; it is the riskiest (node token, queue
   topology, `/v1` auth) and ships as a release candidate.
3. **WS-D** items are scheduled against what they block: H1–H5, H19 are small
   product or tooling fixes that can ride with any release candidate; H12–H14 and
   H17 need the cluster and gate the release; H9–H10 are verification tasks.
4. **WS-C** after WS-B, since its panel view needs labels.
5. **WS-E** once the gate in §8 is met.

Each workstream goes through its own spec, plan and review. This document is
updated when any of them changes scope.

## 8. Release readiness gate

All of the following, on a cluster at the documented size:

- WS-A, WS-B and the WS-C items needed for the panel view are merged.
- `verify-ha.sh` and `verify-turns.sh` pass completely (no *could not measure*) on a
  4 CPU / 6 GB host, twice in a row.
- The nightly HA suite (fake Slack plus the mock LLM) is green on `main`.
- H1, H2, H3, H4, H5, H6, H19 are fixed or consciously deferred with a note; H12,
  H13, H14 and H17 are resolved or measured and documented.
- Docs: configuration reference, deploy guide, provider-credentials page, a runbook
  for local tunnels, and a field note for each workstream.
- Shipped as `vX.Y.Z-rc.N` first (this touches the DB schema, the agent loop and
  node auth), soaked, then promoted with `scripts/promote-rc.sh`. Release notes live
  under the stable name from the first RC.

## 9. Deliberately deferred

File isolation between labels (belongs to the sandboxing work; until then the shared
filesystem is not a boundary and the docs say so); Vault dynamic secrets; a second
secret backend; per-tenant Vault prefixes; changing the provider-env fallback
default; multi-label selectors; a software inventory reported by nodes; a Redis
denylist for node tokens.

## 10. Open questions

- WS-B: the exact list of `/v1` endpoints that return persona-scoped data (the
  audit is part of that spec).
- WS-C: whether skills should also carry a "requires" note that the panel can
  compare against a node's manifest (a display, not a routing input).
- Who owns minting node tokens in a GitOps flow (a CLI on the gateway first; a
  panel action later).
