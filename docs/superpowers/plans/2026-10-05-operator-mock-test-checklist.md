# Operator checklist: the mock HA test on the local cluster

**Date:** 2026-10-05
**Branch:** `ha/dev` with U15 merged (U1 to U14)
**Runbook:** `deploy/k8s-local/README.md` (topology, operating commands, real-Slack runbook, alerts)
**Gate this feeds:** `docs/superpowers/specs/2026-10-03-ha-release-plan-design.md` §6

Ordered steps. Each says what to run, what you should see, and what it proves.
Run from the repository root. Nothing here was run by the implementer: every
manifest, script and test was validated offline only (see the last section).

## 0. Before you start

| Step | Command | Expected | Proves |
|---|---|---|---|
| 0.1 | `docker info --format '{{.NCPU}} {{.MemTotal}}'` | at least 5 CPUs and about 7.5 GB | the VM can host the 4 CPU / 4864 MB node (provisional floor, `sizing.env`) |
| 0.2 | `command -v minikube kubectl openssl python3 bun` | all found | `up.sh` prerequisites (bun mints the node credentials) |
| 0.3 | an existing `slaude-local` profile at the old 3 CPU / 3500 MB size: `deploy/k8s-local/down.sh` | profile deleted (secrets kept) | `up.sh` refuses a profile of another size |
| 0.4 | optional: `export SLAUDE_LOCAL_ENV_FILE=./.env` (real provider key), `SLAUDE_LOCAL_MODEL=...` | | real model turns for the Slack runbook; without them the verify scripts still pass |

## 1. Bring-up, signed credentials, legacy door open

| Step | Command | Expected | Proves |
|---|---|---|---|
| 1.1 | `deploy/k8s-local/up.sh` | ends with `ready`; pods: 2 gateway, 2 `slaude-node`, 1 `slaude-node-finance`, vault, mock-mcp, postgres, redis, all Ready | the overlay applies; split Secrets; nodes boot with `SLAUDE_NODE_BOOT_CHECK=refuse`; signed credentials accepted |
| 1.2 | in the `up.sh` output | `minted the default/finance node credential`, `vault: ... written` x4, a persona sync JSON line with `"status": 200` | node-token CLI mint; Vault seed; the persona set (default, alpha, beta) synced with Vault references, `runsOn`, `kbSources`, a bridged server |
| 1.3 | `kubectl -n slaude-scale logs deploy/slaude-node-finance \| grep -i whoami` or the boot lines | no `refusing to boot`, no gateway-only variable warning | the finance node holds only its Secret |
| 1.4 | `deploy/k8s-local/vault.sh status` | four `version N` lines | Vault seeded |

## 2. Verify, signed nodes (twice in a row)

| Step | Command | Expected | Proves |
|---|---|---|---|
| 2.1 | `deploy/k8s-local/verify-ha.sh` | `N passed, 0 failed`; no `COULD NOT MEASURE` | failover, leader election, heartbeats for every node of both labels, credential placement, each node's credential carries exactly its label, legacy door open (legacy token gets 200 `legacy`), a node handed `SLAUDE_JOB_SECRET` refuses to boot naming it, personas as code (soul from the bundle; the node token cannot sync) |
| 2.2 | `deploy/k8s-local/verify-turns.sh` | `N passed, 0 failed`; the log file named on the first line | delivery through a node kill; cron once; beta's turns boot only on finance nodes; the label gate (403 for a default node with beta's token); a rotated Vault key in the next new thread; the bridge lists and calls `echo`, alpha gets 404; with finance scaled to 0 a beta turn waits, `slaude_label_unserved{label="finance"}` is 1, the turn runs when the node is back; relabel moves beta's next turn to default |
| 2.3 | run 2.1 and 2.2 again | same | the gate wants two passes in a row |

## 3. Legacy-token nodes

| Step | Command | Expected | Proves |
|---|---|---|---|
| 3.1 | `SLAUDE_LOCAL_NODE_AUTH=legacy deploy/k8s-local/up.sh` | `node auth: default=legacy, finance=signed` | |
| 3.2 | `verify-ha.sh`, `verify-turns.sh` (twice) | pass; verify-ha notes the default nodes' credential as `legacy token` | a legacy-token `default` node keeps working beside signed ones (WS-B §4.11) |
| 3.3 | gateway `/metrics`: `slaude_node_legacy_auth_total` | rising | the legacy-door alert fires (exercise it here) |

## 4. Legacy door closed

| Step | Command | Expected | Proves |
|---|---|---|---|
| 4.1 | `SLAUDE_LOCAL_LEGACY_DOOR=closed deploy/k8s-local/up.sh` | `legacy door closed` | |
| 4.2 | `verify-ha.sh`, `verify-turns.sh` | pass; verify-ha: `the legacy token is refused (401)`, every node `signed` | the gate's "once with the legacy door closed" |
| 4.3 | `deploy/k8s-local/up.sh` | back to the default (door open, signed) | |

## 5. Real-Slack smoke (on the RC)

Follow "Real-Slack smoke runbook" in `deploy/k8s-local/README.md`: a tunnel to
`forward.sh gateway`, one Slack app per persona registered with
`bun run slack-app add --persona alpha|beta`, `SLAUDE_LOCAL_ALPHA_SLACK_USER`,
`SLAUDE_LOCAL_BETA_SLACK_USER`, `SLAUDE_LOCAL_MANAGER` exported and
`personas.sh sync` re-run. Nine steps, each must pass. Step 7 (an in-flight
turn re-dispatched once after a relabel) is covered only here.

## 6. Alerts

Exercise each alert from the table "Alerts to exercise" in the README, using the
rules in `docs/site/_content/deploy/alerts.md`. Record for each: fired (time),
followed the runbook section, cleared.

## 7. Rollback rehearsal

"Rollback rehearsal" in the README, with the procedure in
`docs/site/_content/deploy/rollback.md`. Older gateways reject signed node
credentials, so roll back with `SLAUDE_LOCAL_NODE_AUTH=legacy`. Record what
differed from the runbook's table.

## 8. Capacity numbers for the release notes (gate item 8)

While 2.2 runs: `kubectl top pods -n slaude-scale`, Redis
`INFO clients` (`kubectl -n slaude-scale exec deploy/dev-redis -- redis-cli info clients`;
one connection per worker per node: each node runs one worker per label plus
its own queue), and the gateway's CPU during the bridge step. Put the numbers in
the v0.45.0 notes; they are not assumed anywhere.

## Known limitations (from the tracker's follow-ups)

- **Episodic memory on nodes** is served through the gateway (U13), but the
  mono memory leak and the `runAs`-blind scope are open; the release plan marks
  stable promotion blocked until tracked items close.
- **The re-encrypt tool for `SLAUDE_MASTER_KEY` does not exist.** Do not rotate
  the master key on a cluster whose stored credentials you keep; a managed
  gateway fails at boot after a key change.
- The gateway still reads `.env` and `.mcp.json` from the shared, node-writable
  volume.
- The re-dispatching follower is the dispatching gateway only; two ordering
  races remain (U10b).
- The bridge's connect-card rate limit and failure-message de-duplication are
  per process.
- Node-side MCP credential seeding and its endpoints stay until the bridge is
  proven on a cluster (this test is that proof; the cleanup is a follow-up).
- The code's default for `SLAUDE_NODE_BOOT_CHECK` is still `warn`; the manifests
  set `refuse`. The release plan says v0.45.0 refuses by default: decide before
  the RC.
- `/deploy` stage two (refusing unknown fields by default) is not implemented;
  `SLAUDE_DEPLOY_STRICT=1` enables it.
- `slaude_node_credential_expiry_seconds` keeps a retired id's last value until
  the gateway restarts.
- No metric for gate 403s: the alert reads the `[v1] gate denied:` log line.

## Not verified offline

Everything above. Offline, the implementer ran: `kubectl kustomize` of the base,
the local overlay and the e2e overlay (with fake generated files) under the
tests in `tests/deploy/topology.test.ts`, `secret-split.test.ts` and
`local-sizing.test.ts`; shellcheck over every tracked `*.sh`; the scripts'
stubbed-kubectl tests (`local-scripts.test.ts`, `verify-turns.test.ts`); the
helper tests (`local-topology-lib.test.ts`, which mints and inspects a credential
with the real CLI); the mock MCP server driven by the MCP SDK client
(`mock-mcp.test.ts`). Specifically never run:

- any pod of the new topology: the dev Vault image and its `vault` CLI calls
  (`kv put/patch` with `-` on stdin, `kv metadata put -custom-metadata`,
  `auth/token/create-orphan` with an `id`), the projected-token volume, the
  finance deployment, the 4864 MB sizing;
- the in-pod scripts `probe/personas.ts`, `probe/node.ts` and the new
  `probe/turns.ts` commands (built with `bun build`, never run against
  `/app/src`);
- the soul-hash, unserved-gauge and log-line timings the verify scripts wait on;
- whether the e2e nightly suite (which now also brings up Vault, the finance
  node and the mock MCP server) still fits its runner and passes;
- the real-Slack runbook, the alerts and the rollback rehearsal.
