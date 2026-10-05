# HA delivery process and tracker

**Date:** 2026-10-04
**Specs:** `docs/superpowers/specs/2026-10-03-*.md` (umbrella plus WS-A to WS-E), approved by the operator
**Branch:** `ha/dev` (integration branch; nothing here merges to `main`, tags or releases without the operator's
explicit go, per WS-E §7)

## How the work is done and checked

Work is split into units. Each unit goes through the same loop, with the roles separated so that nobody marks
their own work complete.

| Role | Who | Does | Does not |
|---|---|---|---|
| Orchestrator | the lead session | writes the unit brief from the spec, owns git and merges, re-runs typecheck, the unit's tests and the leak scan itself, decides accept or reject | trust an agent's report without re-running it |
| Implementer | a subagent in its own git worktree off `ha/dev` | writes the test first, implements, commits granularly, reports requirement → code → test | merge, push, tag, touch a live cluster, add an AI trailer |
| Reviewer 1 — spec compliance | a *different* subagent | checks every requirement of the unit against the diff and asks whether each test would fail without the behaviour | edit anything |
| Reviewer 2 — adversarial | a third subagent, for units that touch credentials, node auth, the gate, queues or the MCP bridge | looks for secret leakage, auth bypass, SSRF, races, mixed-version breaks, scope creep | edit anything |

A unit is **accepted** only when: both reviewers return PASS (or all BLOCKER and MAJOR findings are fixed and
re-reviewed), `bun run typecheck` exits 0, the unit's tests pass, the leak scan is clean, and the orchestrator has
merged it into `ha/dev` and re-run the affected suites on the merged result. Fix rounds are capped at two per unit;
anything still open is recorded here as an open issue and the work continues.

Guardrails for every agent: public-repo rules from `CLAUDE.md`, generic placeholders only, no real secrets, no
commands against the operator's running cluster (offline validation only), no pushes, no AI co-author trailers.

At the end the whole branch is verified together: the full test suite against Redis and Postgres, the typecheck, the
shellcheck set CI uses, the manifest builds, a cross-unit review by a fresh reviewer, and a written list of what the
operator needs to run on the real cluster.

## Units

Status values: `todo`, `in progress`, `in review`, `accepted`, `blocked`.

### Stage 1 — patch-release class and foundations

| Unit | Content | Spec | Status |
|---|---|---|---|
| U1 | Versioned `/deploy` payload, unknown fields reported | WS-D D5.1 | accepted |
| U2 | Slack HTTP-mode correctness, scopes, typed failure text | WS-D D1.1, D1.3, D1.5, D1.6 | accepted |
| U3 | Approval cards, portal unlink, `/mcp` per persona | WS-D D2.1–D2.3 | accepted |
| U4 | Local cluster and verify harness, runbooks | WS-D D3.1–D3.7, D4.1, D4.5 | accepted |
| U5 | Secret split, ServiceAccounts, node boot warning | WS-B §4.0 stage one | accepted |
| U6 | Model-child lockdown, one outbound-fetch policy | WS-D D5.2, D5.3 | accepted |

### Stage 2 — features (release-candidate class)

| Unit | Content | Spec | Status |
|---|---|---|---|
| U7 | Per-request Slack client | WS-D D1.2, D1.4 | accepted |
| U8a | Secrets module: reference parser, resolver seam, env and Vault backends | WS-A §4–§6 | accepted |
| U8b | Provider credentials: persona field, bundle, node delivery, fatal typed failure, mono refusal | WS-A §5, §7–§11 | accepted |
| U9 | Node credential, `authenticateNode`, route table, gate, endpoint hardening | WS-B §4.1–§4.4 | accepted |
| U10 | `runs_on`, label queues, dispatch, worker, reaper, unserved labels, typed relabel | WS-B §4.5–§4.8 | accepted (U10a, U10b) |
| U11 | Node-local stdio manifest, plugin allow-list, strict MCP config | WS-B §4.10 | accepted |
| U12 | MCP bridge | WS-C §4.2 | accepted |
| U13 | KB scope, scoped list tools, skills provenance, memory-provider check | WS-C §4.1, §4.3 | accepted |
| U14 | Panel persona API and screens | WS-C §4.4 | in progress |

### Stage 3 — cluster setup for the operator's mock test, docs, closeout

| Unit | Content | Spec | Status |
|---|---|---|---|
| U15 | `k8s-local` for the full topology (split Secrets, labelled node deployments, dev Vault, bridge upstream, runbooks), docs, field notes, release-note drafts | WS-D, WS-E §8 | todo |
| U16 | Whole-branch verification and cross-unit review | all | todo |

## Open issues and follow-ups found by review

- **Master-key rotation is NOT supported in v0.45.0 (deferred in U17, pre-stable follow-up).** No tool re-encrypts stored credentials under a new `SLAUDE_MASTER_KEY`; a managed gateway fails at boot after a key change. Supported in this release: the exposed-secrets rotation of `SLAUDE_JOB_SECRET`. For the master key the documented procedure is "discard the stored credentials and re-enter them (re-run onboarding and connect)", or keep the key and record the exposure. Stated in WS-E §5, the v0.45.0 notes and multi-node.md. Building the re-encryption command is a follow-up before the stable release.
- **The gateway reads `.env` and `.mcp.json` from the shared, node-writable home.** Gateways load `/data/.env` at boot (`src/config/env.ts`, `home.ts`), so a node turn can set variables for after a restart; and `.mcp.json` `${VAR}` placeholders expand against the gateway's env, refusing only gateway-only names (other gateway env, such as embedding or provider keys, can still be expanded into a server config). Not closed by the Secret split; the gateway should not read either file from the shared volume.
- **Node-side direct database reads.** The Secret split removed the Postgres URL from nodes, which exposed that the node agent read the `/1on1` lock from the database directly. U5 now signs the lock into the job token (and into the session-config fingerprint, minted on every dispatch, so a warm node session reboots when the lock changes) and makes a node fail loudly instead of opening an embedded database. Remaining node reads, failing loudly until served by the gateway:
  1. **Episodic memory on nodes (BLOCKS promoting the RC to stable).** `<memory-context>` and memory writes no longer run on node turns in the scaled topology; before the split they ran against the brain's Postgres through the shared URL. Needs memory served through the gateway over `/v1`.
  2. **Runtime soul overrides on nodes**, read only when the runtime bundle carries no structured soul; refused, so overrides are not applied in that case. Ship them in the bundle.
- **`SLAUDE_OUTBOUND_INTERNAL_HOSTS`** (U6) must be set for in-cluster HTTP identity providers and MCP servers, including the local mock MCP; set it in the `k8s-local` overlay (U15) and state it in the release notes.
- **Release notes must mention:** the child-env scrub now removes Slack tokens and database URLs from the agent child in `mono`, and the outbound policy refuses private and http hosts by default.
- **Release notes must mention (U11):** nodes mount NO plugin MCP unless declared in the manifest. A node without `SLAUDE_NODE_MANIFEST` (default `/etc/slaude/node.json`) runs no stdio or plugin MCP server for any persona, and every node agent child runs with `strictMcpConfig`. `mono` is unchanged.
- U6 found and fixed a real prompt-injection path: the `kb_think` synthesis child could run Bash from page content.
- **RELEASE-BLOCKING (blocks promoting the RC to stable): episodic memory on nodes.** The Secret split removes the node's direct database access, so `<memory-context>` and memory writes no longer work on node turns in the scaled topology (they fail loudly; turns still run). Memory must be served through the gateway over `/v1` (planned inside U13, together with the H31 check).
- Runtime soul overrides on nodes fail loudly when the bundle has no structured soul (ship overrides in the bundle).
- `.mcp.json` `${VAR}` expansion is a blocklist against the gateway-only list; the gateway should not read `.mcp.json` or `.env` from the node-writable shared volume (same follow-up class).
- The `lock` claim in the job token can be stale for a job that was waiting while the lock flipped (documented next to `runAs`).
- Rollout rule: the node image must be at this release before the new node Secret is applied, and queued turns must drain first.
- **mono episodic memory leak (found by U13):** in `mono` the in-process memory provider uses the process-wide agent id, so named personas' turns (1:1s included) land in the default persona's slice. Node memory is now scoped through the gateway; mono needs the same scoped provider. Track before stable.
- Gateway-served memory: public and DM threads get no `<memory-context>` on nodes by design; a persistent memory failure is logged once.
- The MCP bridge keeps the node-side MCP credential seeding in place until the bridge is proven; a later cleanup removes it.
- Cross-replica de-duplication of failure messages is per process (U2); a Redis-backed guard is a possible later step.
- **Cleanup after the MCP bridge is proven in a cluster (U12, WS-C §4.2.11):** remove the node-side MCP credential seeding (`src/node/credentials.ts`, its wiring in `src/node/worker.ts`), the `needs-auth` recovery, and the `GET /v1/tenants/:t/mcp-credentials` and `…/refresh` endpoints. Left in place by U12 on purpose. The bridge's connect-card rate limit is also per process (one card per session and server per 10 minutes per replica).
- **Follow-ups from the U10–U13 reviews (not blocking the RC unless noted):**
  - U13: a manager speaking in someone else's locked thread, and a cron created inside a 1:1 (runs as the user), write episodic memory into the persona's shared slice (`memoryScopeFor` ignores `runAs`); the gateway memory handler bounds only the provider call, not `ready()`/lock lookup; with the brain disabled the baseline prompt still names `kb_memoize`/`kb_search`; node mounts `kb_*` shims even then.
  - U11: refuse runtime-control keys (`BUN_OPTIONS`, `NODE_OPTIONS`, `BUN_CONFIG_*`, `LD_PRELOAD`, `DYLD_*`) as manifest `env` keys; the manifest wrapper's `--config=/dev/null` assumes Linux; a Bun-based stdio server run from a workspace holding a `.env` loads it itself (operator's server).
  - U10b: node paused on a refused credential stays healthy but not ready (alert on `slaude_node_auth_paused`); the re-dispatching follower is the dispatching gateway only; two ordering races remain and are documented.
  - Flaky tests seen under load: `tests/node/worker-e2e` lock-resolver (fixed in U11 for its own waits), `tests/gateway/sim/tui/app-interactions` help overlay, `tests/deploy/e2e-ha-collect` free_port.
