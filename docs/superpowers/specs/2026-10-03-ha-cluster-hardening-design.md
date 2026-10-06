# HA and cluster hardening

**Date:** 2026-10-03
**Umbrella:** `2026-10-03-centralized-persona-runtime-design.md` — this is WS-D, the
backlog H1–H20 and the findings added since
**Revised:** 2026-10-04 (after design review)
**Evidence:** every item below was re-checked against `main` at `79dec1a` (the merge of the HA
review branch); "present" means reproduced in the current code, not recalled from a note

## 1. Intent

Stand the two-gateway, two-node topology up on a fresh machine, run the checks, and
use it against a real Slack workspace, and have each step work the first time and
fail with a clear message when it cannot. This spec lists what stopped that from
being true, why, the smallest fix, and how it is covered, so the release gate in the
umbrella can be met with evidence.

The items group into four batches by the code they touch, so each batch is one
reviewable change.

## 2. Scope

**In:** fixes to the HTTP-mode Slack transport and its gates (D1); approval, portal
and `/mcp` behaviour (D2); the local-cluster scripts, manifests and verify harness
(D3); and the verification tasks that need a real environment (D4).

**Out:** the features in WS-A, WS-B and WS-C (but their *foundations* are batch D5); a redesign
of the Slack transport; Slack scopes beyond what the code already calls (§D1.5 says what is
unverified).

## 3. Batch D1 — Slack HTTP-mode correctness

### D1.1 H1 — the bot token is read from the environment per message

- **Where.** `src/gateway/core/gateway.ts:2246` builds the attachment download with
  `botToken: env.slack.botToken()` on **every** inbound message, even when `files` is
  empty. `env.slack.botToken()` is `req("SLACK_BOT_TOKEN")` (`src/config/env.ts:107`)
  and throws `missing env SLACK_BOT_TOKEN`. In HTTP mode the token lives encrypted in
  `slack_apps` and is decrypted at `http-transport.ts:116`; nothing passes it on.
- **Why the simulator hid it.** `src/gateway/sim/engine.ts:68` seeds a dummy
  `SLACK_BOT_TOKEN` to avoid this throw.
- **Fix.** Read a token only when `files.length > 0`, and take it from the app the
  event belongs to: add it to the context `dispatchEvent` builds
  (`http-transport.ts:149-153`) or look it up by `(api_app_id, team_id)`. Fall back to
  the environment in Socket Mode only.
- **Test.** An HTTP-transport test with a message and no files and no
  `SLACK_BOT_TOKEN` in the environment; one with files that downloads using the app's
  own token. Remove the simulator's dummy token so the suite can fail on this again.

### D1.2 H2 — calls go out as the oldest registered app

- **Where.** `primary` is the first `slack_apps` row by `created_at`
  (`http-transport.ts:99, 122`); the lazy client always delegates to
  `primary.client` (`:360-387`). In HTTP mode `outClient` is the lazy client unless a
  user token is set (`gateway.ts:459-463`), and surfaces, `ApprovalGate`,
  `PermissionGate`, `Presence`, `Status`, the reaction fallback, the error post
  (`gateway.ts:1308`) and cron all use it. Only the event handler's own client
  (`http-transport.ts:155`) is correct. The two boot-time `auth.test` calls
  (`gateway.ts:615, 2457`) also go through it, so identity logs describe only the
  primary app.
- **Fix.** Make the client per request: carry the event's `entry.client` through the
  route context (`ctx.client` is already set from `outClientForPersona`), and let the
  gates and surfaces resolve a client from `(api_app_id, team_id)` instead of holding
  one at construction. A single-app deployment behaves as before.
- **Release.** This threads a client through the gates, surfaces, presence, status and cron: a
  refactor across the whole outbound path, not a one-line fix. It ships in the **release-candidate
  series**, not in the direct patch release (WS-E); the other D1 items do not depend on it.
- **Test.** Two registered apps; an event for the second posts, reacts and requests
  approval as the second, not the first. Today's test (`http-transport.test.ts:608`)
  only asserts the lazy client reaches the primary.

### D1.3 H3 — the lazy client lacks methods the code calls

`postEphemeral` was added in `16f3d56`. Still not proxied, with the calling code:

| Method | Call site |
|---|---|
| `files.uploadV2` | `slack/surface.ts:112`, `slack/mcp-tools.ts:175` — breaks attachment replies |
| `files.info` | `mcp-tools.ts:432` |
| `chat.delete` | `mcp-tools.ts:342` |
| `pins.add`, `pins.remove` | `mcp-tools.ts:368, 379` |
| `conversations.setTopic`, `.setPurpose` | `mcp-tools.ts:388, 397` |
| `conversations.canvases.create`, `canvases.edit` | `mcp-tools.ts:409, 462` |

- **Fix.** Replace the hand-listed proxy with a recursive `Proxy` that forwards any
  `a.b.c(...)` to the resolved client after `started`. A hand-written list has already
  failed twice; a new Slack method must not need a code change here.
- **Test.** A table-driven test that calls every method in the list through the lazy
  client and asserts it reaches the underlying client with the same arguments; a test
  that an unknown namespace throws the same error a real client would.

### D1.4 (with D1.2) per-request identity at boot

The two `auth.test` boot calls report the primary app only. With the per-request
client they are made per registered app, and the logs name each.

### D1.5 H5 — the manifest emits `users.profile:write` as a bot scope

- **Where.** `src/cli/manifest.ts:38` (inside `BOT_SCOPES`, used at `:72`), and
  `src/gateway/slack/oauth.ts:224`, which builds the authorize URL from the same list.
- **Fix.** Remove it from `BOT_SCOPES`; emit it under `oauth_config.scopes.user`; pass
  user scopes as `user_scope` in the authorize URL. Presence needs a user token anyway.
- **Test.** The manifest test asserts the user scope is in the user list and absent from
  the bot list; `tests/gateway/slack/oauth.test.ts:111, 430`, which compare against
  `BOT_SCOPES`, follow the change.
- **Unverified.** The bot scope list also looks short for calls the code makes
  (`pins.*`, `canvases.*`, `conversations.setTopic/setPurpose`, and `search.messages`,
  which needs a user token). This was not checked against Slack's documentation. It is
  a task in this batch to check and either fix the list or record why it is right.

### D1.6 Raw error text is posted into Slack

- **Where.** Turn errors post `e.error` verbatim (`gateway.ts:~1308`), and a failed job posts a message built
  from the failure reason (`dispatch.ts:197-199`). That text can be a provider or CLI message ("Invalid API key
  · Please run /login") or a stack fragment, and it goes to a channel other people can read. A connect-flow
  leak of exactly this kind was fixed before; this is the same class on the main path.
- **Fix.** Failures carry a **typed code** on the event stream and in the job failure; the gateway maps codes to
  fixed text and logs the detail server-side. Unknown codes map to one generic message. A single message per
  failed turn, de-duplicated on the job id (today a client retry, a BullMQ attempt and a replica can each post).
  The codes WS-A and WS-B add (`PROVIDER_CREDENTIALS_UNAVAILABLE`, `LABEL_MISMATCH`) use the same mapping.
- **Test.** A turn that fails with a provider error posts the fixed text and not the error; a job that fails
  twice posts once; an unknown code posts the generic text.

## 4. Batch D2 — approvals, portal, `/mcp`

### D2.1 H4 — a second approval click erases the decision record

- **Where.** `src/gateway/slack/approval-gate.ts:106-114` (`stale()` replies with
  `replace_original: true, blocks: []`, call sites `:140, :149, :162, :206`) and the
  same in `permission-gate.ts:233-243`. The first click rewrites the card to
  "Approved by @x"; a second click finds the row no longer pending and overwrites it
  with ":lock: approval already decided". The database row is intact; the Slack message,
  the only visible record, is lost.
- **Fix.** In the "already decided" branches, answer ephemerally with
  `replace_original: false` and leave the card alone.
- **Test.** `tests/approval-gate.test.ts:242-255` and `tests/permission-gate.test.ts:221`
  assert the old text and would need updating; they also never check `replace_original`,
  which is why this passed. They are changed to assert it is `false` and that no
  `chat.update` happens.

### D2.2 H7 — the portal page has no unlink button

- **Where.** `src/gateway/portal/web/app/App.tsx:118-122` and `web/app/api.ts:45-52`.
  `Me.slackIdentities` is fetched but only used for the "no account connected" text.
  The server route exists (`DELETE /portal/api/link`, `portal/api.ts:208-220`, covered
  by `tests/gateway/portal/api.test.ts:184-204`).
- **Fix.** `api.unlink(teamId, slackUserId)` as a `DELETE` with a JSON body and the CSRF
  header (the `call()` helper adds it); render each identity with an Unlink button; then
  reload.
- **Test.** A component test for the button and the call, plus the server tests that
  exist.

### D2.3 H8 — Slack `/mcp` and the portal can disagree

- **Where.** `gateway.ts:678` loads the global MCP file once at boot; `:857`
  (`httpExternalServers`) feeds `/mcp connect`, `/mcp disconnect` and the "Connect" cards
  from it. The status list is per session, so a persona-only server can be listed and
  then rejected as "unknown" on connect. The portal uses `portalServers()` (the union
  over personas, read per request, `integrations.ts:82-90`).
- **Fix.** Resolve per persona with `sessionExternalMcp(personaId, externalMcp)`, as
  `gateway.ts:761` already does when mounting; better, reuse `portalServers()` so the
  two cannot drift.
- **Test.** A persona-only server can be connected from Slack; `/mcp` and the portal list
  the same servers for the same persona. Nearest suites:
  `tests/gateway/slack/commands-mcp` (parser only today), `tests/connect-mcp`,
  `tests/gateway/core/session-external-mcp`.

## 5. Batch D3 — local cluster and the verify harness

### D3.1 H6 — `up.sh` races Postgres's temporary init server

- **Mechanism.** The Postgres image's entrypoint runs a temporary server during first
  initialisation that listens on the unix socket only, then runs
  `/docker-entrypoint-initdb.d/10-brain-database.sql`, then restarts. The Deployment has
  no readiness probe, so `rollout status` (`up.sh:181`) returns once the container is
  running; `pg_isready -U slaude` with no `-h` (`:190`) connects over the socket and
  succeeds against the temporary server; the retry loop (`:189-192`) falls through
  silently if it never succeeds; `CREATE DATABASE slaude_brain` (`:195`) then races the
  init script's own, and the loser fails (aborting `up.sh`, or crash-looping the
  container).
- **Fix.** Probe over TCP (`pg_isready -h 127.0.0.1`), which the temporary server does
  not serve; add a `readinessProbe` to the Postgres container (and Redis, which has the
  same gap, `90-dev-datastores.yaml`); make the creation retry and treat "already
  exists" as success; make the readiness loop fail loudly after its last attempt.
- **Test.** A script-level test (a shell test against a stubbed `kubectl`) for the loop's
  failure path; the real proof is a cold `up.sh` on a clean profile.

### D3.2 H12 — `verify-turns.sh` cannot say why it could not measure

Three separate problems:

- **The diagnostics go to stderr.** `!!` lines are printed only by `probe()`
  (`verify-turns.sh:62, 68`), to stderr. A log captured with `> file` or `| tee` has
  only stdout, so "see the !! lines above" points at lines that are not there. Three
  calls discard them outright (`:157`, `:216`, the trap's cleanup at `:135`), and a probe
  whose exec succeeded but whose last line is not JSON fails silently in `field` and
  `queue_sum` (exit 3, no message). **Fix:** print diagnostics to stdout and to a log
  file the script names at the start; make the silent exit 3 print which probe and what
  it received.
- **The probes are too short for a loaded node.** Neither base manifest sets
  `timeoutSeconds` or `failureThreshold`, so Kubernetes' defaults apply (1 s, 3
  failures). Gateway: liveness `/healthz` every 30 s, readiness `/readyz` every 10 s
  (`40-gateway.yaml:54-68`); node: the same (`50-node.yaml:53-68`). `/readyz` queries
  Postgres on the same event loop that runs the turns. **Fix:** `timeoutSeconds: 5`,
  `failureThreshold: 5` on both probes, and a `startupProbe` so a slow boot is not
  killed by liveness.
- **The local resource limits oversubscribe the node.** Requests are small but limits
  sum above three CPUs (gateway 1, node 1.5, two of each, three nodes at the HPA
  maximum). **Fix:** set requests and limits to a combination that fits the documented
  minimum (D3.5), not the other way round.
- **Test.** `verify-turns.sh` run on the documented minimum host twice in a row, with no
  *could not measure*.

### D3.3 H13 — the node deployment ends up at three replicas

- **Cause (found; no interrupt bug).** The script never changes replicas. The local
  overlay keeps the node HPA `slaude-node-cpu-fallback` with `minReplicas: 2,
  maxReplicas: 3` (`kustomization.yaml:165-175`) targeting 60 % of a 250 m CPU
  request, so ordinary turn load scales it to three, and the base
  `scaleDown.stabilizationWindowSeconds: 600` (`70-autoscale.yaml:85-89`) holds it
  there for at least ten minutes. The script anticipates this at `:144-145`. Its only
  trap (`:138`) removes probe files and restores no replica count.
- **Fix.** The verify scripts record the HPA's `maxReplicas` and set it equal to
  `minReplicas` for the run, restoring it in the trap; or assert "at least two nodes"
  instead of exactly two. This is a test-harness change, not a product one.
- **Test.** The script's own preconditions section.

### D3.4 H19 — `up.sh` cannot set the model

- **Where.** `up.sh:35` lists four provider variables; `SLAUDE_MODEL` is never read or
  passed. The base ConfigMap sets `SLAUDE_MODEL: "claude-sonnet-4-6"`
  (`20-config.yaml:16`), which is wrong for any non-Anthropic gateway, and **the obvious
  fix does not work**: nodes and gateways load `envFrom` with the Secret first and the
  ConfigMap second (`50-node.yaml:33-37`), and the later source wins, so a value in
  `provider.env` would be overridden.
- **Fix.** An optional `SLAUDE_LOCAL_MODEL` (and `SLAUDE_LOCAL_ENV_FILE` lookup, as for
  the provider keys), written to a gitignored `deploy/k8s-local/model.env` that always
  exists (empty is fine), consumed by a `configMapGenerator` entry with
  `behavior: merge` for `slaude-scale-config`. Document it in the README beside the
  provider variables.
- **Interaction with WS-A.** Once a persona carries its own `model`, this is only the
  cluster default.

### D3.5 H11, H20 — port-forward fragility and hard-coded ports

- **H11.** `kubectl port-forward svc/…` pins one pod; any rollout or crash silently
  breaks whatever was using the forward (a Slack tunnel went down this way). The scripts
  print the command and leave the user to run it. **Fix:** a `deploy/k8s-local/forward.sh`
  that runs the forward in a loop **with a health check**: it probes the forwarded
  endpoint every few seconds and recycles the forward when the probe fails or the target
  pod changes; one script for the gateway and one for Keycloak, with ports from
  variables.
- **H20.** Ports are hard-coded in the printed commands (8080 in `up.sh` and `panel.sh`,
  8180 for Keycloak, 9000 for the mock MCP); nothing checks a port is free, so a plain
  forward against a taken port can quietly bind a second loopback address and the real
  listener answers. `scripts/e2e-ha.sh` picks a random port with `RANDOM` and no
  collision check, silences `kubectl`, and its 10-second wait ends without error.
  **Fix:** `SLAUDE_LOCAL_PORT` and siblings; a `nc -z`/`lsof` check that fails loudly
  before starting; `e2e-ha.sh`'s loop exits non-zero on timeout. (`e2e/harness/kube.ts`
  already does this correctly and is the model.)
- **Test.** The forward script against a port that is taken; against a pod that is
  killed.

### D3.6 Sizing floor

Document the measured minimum: the cluster ran with a 3 CPU / 3.5 GB minikube node
inside a 4 CPU / 6 GB Docker VM, and under verification load the VM had roughly 100 MB
free. The floor to publish is whatever passes D3.2 twice in a row, **measured in this
batch, not assumed**; the README states it, and `up.sh` warns when the VM is smaller.

### D3.7 Smaller defects found while checking

- `verify-turns.sh:226-228`: `expect_value` is passed a fifth argument that is ignored.
- `verify-turns.sh:136`: cleanup runs `k exec "$(gateway)"`; with no running gateway the
  argument is empty and the cleanup silently does nothing.
- `verify-turns.sh:234`: `probe cron >/dev/null` ignores its failure.
- `up.sh:189-192`: the readiness retry loop does not fail after its last try.
- `up.sh:181` and the Redis rollout (`:199-201`): rollout success is taken as readiness;
  neither Deployment has a readiness probe (fixed with D3.1).

## 6. Batch D4 — verification tasks and documentation

### D4.1 H14 — the lock-takeover documentation

Not a code defect. The defaults are TTL 600 000 ms and extend 60 000 ms
(`env.ts:285-286`, `locks.ts:75, 90`), with TTL at least three times the extend
interval; the local overlay sets 45 000 and 5 000 (`kustomization.yaml:70-71`). A killed
node never releases its lock; a re-delivered job is re-queued every 500 ms until the key
expires (`worker.ts:529-535`), so the wait is the remaining TTL, and BullMQ's stall
detection must also fire (a floor of around 30 s). `multi-node.md:117` and the field
note do not contradict: **45 s is the local overlay, 10 minutes is the default.** The
task is to qualify "45 s" wherever it appears and state the stall-detection floor once.

### D4.2 H9 — does a person see the `/link` private reply

A manual check in a test workspace with a second, non-admin Slack user: send `/link` and
confirm the ephemeral message is visible to that user and to no one else. Record the
result in the field note. Automate it only if the fake-Slack harness can render
ephemeral visibility, which it cannot today.

### D4.3 H10 — an agent in a 1:1 using a connected credential

Against a real OAuth-protected MCP server (not the throwaway mock): connect through the
portal, start a 1:1, and have the agent call one of its tools; confirm the call carried
the seeded access token and that a rotation reaches the next turn. The mock MCP stays for
CI; this is a one-off proof recorded in the field note.

### D4.4 H17 — the cluster proof for personas as code

The compare-and-set race and the multi-replica sync were never exercised on real
infrastructure. Define the proof as a runbook plus script that runs against **any**
kube context, not only minikube: two concurrent syncs of different revisions to two
gateway replicas, asserting exactly one wins and the loser is told; a sync during a
gateway rollout; a runtime override wiped by the next sync. The nightly HA workflow
(`e2e-ha.yml`) is the place to run it; a real managed cluster is a one-time run before
the release candidate, recorded in the release notes.

### D4.5 H18 — the local-tunnel runbook

Write down what was learned: which process owns the forward, that a second `cloudflared`
connector for the same tunnel can run unnoticed on a machine (so the first thing to do
is list connectors), that a Slack Request URL silently flips to "didn't respond" when the
path is down and needs a manual Retry, and that the forward must be recycled after any
rollout. Lives in the `k8s-local` README, with generic hostnames.

## 6a. Batch D5 — foundations and security fixes

These are small, independent of the new features, and **must land before** the features that depend on them.

### D5.1 A strict, versioned `/deploy` payload

- **Where.** The persona payload schema is permissive (`z.object` with Zod's default of stripping unknown keys,
  `payload.ts:24-31`), and the sync upsert writes a fixed column list (`db/personas.ts:151-160`). A gateway running
  older code that receives a payload carrying a newer field (`runsOn`, `provider`, `kbSources`) **records the
  revision and silently drops the field**; the persona then runs on node credentials, on `default`, with all
  knowledge sources.
- **Fix.** The payload gains a `version` (absent means 1); a payload whose `version` is newer than the gateway
  understands is refused. Unknown fields are handled in two stages so no existing pipeline breaks in a patch release:
  **first release** — they are accepted, ignored, and **reported** in the response (`ignoredFields`) and the gateway log;
  **next release** — they are a 422 naming the field. This is what makes rolling the code back, or deploying to a
  gateway that has not been upgraded, fail loudly instead of silently dropping `runsOn`, `provider` or `kbSources`.
- **Test.** An unknown field is reported (stage one) and refused (stage two); an older payload still syncs; a newer
  `version` is refused; the export and `render --check` emit the version.

### D5.2 The gateway's own model children must not have tools

- **Where.** `kb_think` synthesis runs an SDK child with `allowedTools: []` and
  `permissionMode: "bypassPermissions"` (`src/knowledge/brain-think.ts:49-50`) over untrusted page content. A review
  found that an empty `allowedTools` does not disable tools in this SDK version (it passes `--allowedTools` only for
  a non-empty list), so the result may be a prompt-injection path to Bash on the gateway pod — the pod that will
  hold Vault access and the master key. **This claim is unverified.**
- **Task (first).** Reproduce: run the synthesis child over a page that tells the model to run a command, and see
  whether a tool executes. If it does, fix by passing the SDK's explicit empty tool set (`tools: []`) and a
  non-bypass permission mode, and apply the same to any other gateway-side model child (soul extraction, ingest).
- **Test.** A synthesis child with a malicious page executes no tool.

### D5.3 One outbound-fetch policy

The MCP bridge (WS-C §4.2.7) needs an SSRF policy, and the OAuth discovery, registration and token-exchange fetches
have the same gap today (no host or scheme validation, no private-range denial, redirects followed, no timeout).
Build the policy **once**, in one module, and use it in both places: scheme check, address check after DNS
resolution, no redirects with credentials, a timeout, and an optional host allowlist.

- **Test.** Private, loopback, link-local and metadata addresses refused; a rebinding hostname refused; redirects
  not followed; discovery and exchange go through the same module.

### D5.4 Deployment manifests

Not the Secret split (WS-B phase 0), but the manifests it needs: a dedicated ServiceAccount for the gateway, node pods
with `automountServiceAccountToken: false`, and an optional NetworkPolicy keeping nodes away from Postgres and Vault.
These ship with the manifests and the local overlay.

## 7. Ordering

D5 first where a feature depends on it (D5.1 before any new payload field; D5.3 before the MCP bridge;
D5.2 is a security task to reproduce early). Then D1 (product defects that make HTTP mode wrong; **D1.2 goes
through a release candidate**), D2 with it or right after, D3.1 and D3.4 early because they unblock a clean
rebuild, D3.2/D3.3/D3.5/D3.6 together as the harness batch, D4 last because it needs the others in place. D1
(except D1.2), D2 and the harness fixes carry no schema change and need no release candidate on their own
(WS-E decides).

## 8. Testing summary

Each item names its test above. New coverage that does not exist today: the HTTP
transport with no environment token; multi-app client selection; the full lazy-client
method table; the gates' `replace_original`; the portal unlink button; `/mcp` for a
persona-only server; the forward script; the harness's own failure paths. The existing
suites named above are updated rather than duplicated.

## 9. Open decisions

0. **D5.2 is unverified** and a security question; reproduce it before scheduling the fix.
1. **Probe values** (D3.2): `timeoutSeconds: 5`, `failureThreshold: 5` proposed; production
   values may differ from the local overlay's, and the base manifests are shared.
2. **Slack scope audit** (D1.5): how far to go checking the bot scope list against Slack's
   documentation, and who owns it.
3. **The documented sizing floor** (D3.6): decided by measurement.
4. **A real managed cluster for D4.4:** which one, and whether the nightly workflow may
   target it.
