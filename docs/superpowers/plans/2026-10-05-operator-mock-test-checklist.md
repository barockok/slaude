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
| 0.5 | `kubectl config use-context slaude-local` (after 1.1) | | `up.sh` no longer changes your current context; the plain `kubectl` commands below assume it (or add `--context slaude-local`) |
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
credentials, so roll back with `SLAUDE_LOCAL_NODE_AUTH=legacy`, pass the older
`up.sh` `SLAUDE_LOCAL_CPUS=4 SLAUDE_LOCAL_MEMORY=4864`, and delete the
`slaude-node-finance`, `vault` and `mock-mcp` Deployments it leaves. Record what
differed from the runbook's table.

## 8. Capacity numbers for the release notes (gate item 8)

While 2.2 runs: `kubectl top pods -n slaude-scale`, Redis
`INFO clients` (`kubectl -n slaude-scale exec deploy/dev-redis -- redis-cli info clients`;
one connection per worker per node: each node runs one worker per label plus
its own queue), and the gateway's CPU during the bridge step. Record them in a
copy of the [capacity check template](2026-10-05-capacity-check-template.md),
which lists the steps (idle, load, scale step, load without the bridge) and the
table to fill, and link the copy from the v0.45.0 notes; the numbers are not
assumed anywhere.

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
- `SLAUDE_NODE_BOOT_CHECK` defaults to `refuse` in code since U17, matching the
  manifests and the release plan; `SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1` (or
  `SLAUDE_NODE_BOOT_CHECK=warn`) is the documented escape.
- `/deploy` stage two is the default since U17: an unknown field is a 422;
  `SLAUDE_DEPLOY_STRICT=0` turns it off. An unknown value of any security switch
  refuses the boot, naming the variable.
- `slaude_node_credential_expiry_seconds` keeps a retired id's last value until
  the gateway restarts.
- No metric for gate 403s: the alert reads the `[v1] gate denied:` log line.

## Not verified offline

Offline, the implementer ran: `kubectl kustomize` of the base, the local overlay
and the e2e overlay (with fake generated files) under the tests in
`tests/deploy/topology.test.ts`, `secret-split.test.ts` and
`local-sizing.test.ts`; shellcheck over every tracked `*.sh`; the scripts'
stubbed-kubectl tests (`local-scripts.test.ts`, `verify-turns.test.ts`,
`up-context.test.ts`); the helper tests (`local-topology-lib.test.ts`, which
mints and inspects a credential with the real CLI); the mock MCP server driven
by the MCP SDK client (`mock-mcp.test.ts`).

Each item below is **UNVERIFIED**. Check it off when it has run on the cluster.

- [ ] UNVERIFIED: the dev Vault CLI forms `vault.sh` uses, inside the vault pod:
  - `vault kv put secret/slaude/personas/<p> -` (JSON data on stdin; `seed_one`);
  - `vault kv patch secret/slaude/personas/<p> -` (JSON data on stdin; `rotate`);
  - `vault kv metadata put -custom-metadata=seed=<hash> secret/slaude/personas/<p>`;
  - `vault write -format=json auth/token/lookup -` (`{"token": ...}` on stdin);
  - `vault write auth/token/create-orphan -` with `id`, `policies`, `period`,
    `display_name` on stdin (a root token may set `id`);
  - `vault policy write slaude-personas -`; the `hashicorp/vault:1.17` image in
    dev mode with `SKIP_SETCAP=1`.
- [ ] UNVERIFIED: the in-pod probes: `probe/personas.ts` (soul cache seed plus
  `/deploy` post), `probe/node.ts` (`whoami`, `runtime`, `mcpx`), and the new
  `probe/turns.ts` commands (`--label live`, `token`, `legacy-whoami`,
  `unserved`). They were only built with `bun build`, never run against `/app/src`.
- [ ] UNVERIFIED: `bun run node-token revoke <id>` against the cluster's Postgres,
  and the node pausing on the following 401.
- [ ] UNVERIFIED: the unserved-gauge timing: `slaude_label_unserved` reaching 1
  within `UNSERVED_TIMEOUT` (150 s) with `SLAUDE_LABEL_UNSERVED_SECS=20` and the
  30 s reaper pass; and the other waits (soul-hash log lines, the rotation within
  the 10 s Vault cache TTL).
- [ ] UNVERIFIED: the e2e nightly suite on the larger topology: the runner fitting
  a 4 CPU / 4864 MB minikube node; `e2e/up.sh` with Vault, the finance node and
  the mock MCP server; `e2e/ha/driver.ts` restarting `slaude-node-finance` with the
  others; `scripts/e2e-ha.sh` waiting for `slaude-node-finance`, `vault` and
  `mock-mcp`; the sanity stage's `verify-ha.sh` sync with Vault references.
- [ ] UNVERIFIED: any pod of the new topology at all: the projected Vault token
  volume, the finance deployment, the 4864 MB sizing, `up.sh`'s context guard on
  a real kubeconfig.
- [ ] UNVERIFIED: the real-Slack runbook (nine steps).
- [ ] UNVERIFIED: every alert in the alerts table, fired and cleared.
- [ ] UNVERIFIED: the rollback rehearsal (the older tag's `up.sh` with
  `SLAUDE_LOCAL_CPUS=4 SLAUDE_LOCAL_MEMORY=4864`, deleting the
  `slaude-node-finance`, `vault` and `mock-mcp` Deployments it leaves behind,
  legacy-token default nodes, and the roll forward recreating them).
