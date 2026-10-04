---
title: Alerts runbook
description: The alerts for provider credentials, node credentials, node labels and the Secret split, with the metric each reads, an example rule, what it means and what to do.
---

# Alerts runbook

One section per alert for the gateway and node topology's credential and
routing paths. Each section names the signal exactly as slaude exports it, gives
an example Prometheus rule, says what it means, and says what to do. Queue,
node-health and claim-latency alerts are in [Scale operations](scale-operations.md#what-to-alert-on).

Two rules for reading the gauges below:

- gauges marked **leader only** are exported by the gateway replica that holds
  the reaper lock. A replica that loses the lock drops (or keeps) its series, so
  aggregate with `max()` across gateway pods, never `sum()`;
- gateway metrics are on `:8080/metrics`, node metrics on `:8081/metrics`. Set
  `SLAUDE_METRICS_LABELS=role=gateway` (or `role=node`) per Deployment so the
  series are separable.

| Alert | Signal | Exported by |
|---|---|---|
| [Vault unreachable](#vault-unreachable) | `slaude_provider_cred_resolve_total{scheme="vault",outcome="error"}`, `slaude_provider_cred_stale_served_total` | gateway |
| [A label with no live node](#a-label-with-no-live-node) | `slaude_label_unserved{label}` | gateway, leader only |
| [A node credential close to expiry](#a-node-credential-close-to-expiry) | `slaude_node_credential_expiry_seconds{id}` | gateway |
| [A rising rate of 403 from the gate](#a-rising-rate-of-403-from-the-gate) | the `[v1] gate denied:` log line (no metric) | gateway log |
| [The legacy door in use](#the-legacy-door-in-use-while-a-node-key-is-set) | `slaude_node_legacy_auth_total` | gateway |
| [A node holding gateway-only variables](#a-node-pod-holding-gateway-only-variables) | `slaude_node_gateway_secrets_present` | node |
| [A node paused on a refused credential](#a-node-paused-on-a-refused-credential) | `slaude_node_auth_paused` | node |

```yaml
groups:
  - name: slaude-credentials-and-routing
    rules:
      - alert: SlaudeVaultUnreachable
        expr: sum(rate(slaude_provider_cred_resolve_total{scheme="vault",outcome="error"}[5m])) > 0
        for: 5m
      - alert: SlaudeVaultServingStale
        expr: sum(increase(slaude_provider_cred_stale_served_total[10m])) > 0
      - alert: SlaudeLabelUnserved
        expr: max by (label) (slaude_label_unserved) == 1
        for: 5m
      - alert: SlaudeNodeCredentialExpiring
        expr: min by (id) (slaude_node_credential_expiry_seconds) < 14 * 86400
        for: 1h
      - alert: SlaudeNodeLegacyTokenInUse
        expr: sum(increase(slaude_node_legacy_auth_total[1h])) > 0
      - alert: SlaudeNodeHoldsGatewaySecrets
        expr: max(slaude_node_gateway_secrets_present) > 0
      - alert: SlaudeNodeAuthPaused
        expr: max by (instance) (slaude_node_auth_paused) == 1
        for: 5m
```

Every alert here must be **exercised** once before a release is promoted: make it
fire on a test cluster, follow the section, and see it clear. The local cluster
can produce each one; see `deploy/k8s-local/README.md` in the repository.

## Vault unreachable

**Signal.** `slaude_provider_cred_resolve_total{scheme="vault",outcome="error"}`
counts resolutions that failed for a reason other than a definitive refusal:
Vault unreachable, a timeout, a 5xx, a failed login. `outcome="denied"` is a
definitive answer (missing secret or field, policy denial, a reference outside
`SLAUDE_VAULT_ALLOWED_PREFIXES`) and is a configuration error, not an outage.
`slaude_provider_cred_stale_served_total` rises while the gateway is serving a
cached value past its TTL because Vault could not answer.

**What it means.** Warm sessions keep running. New threads, respawns after the
idle TTL and reloads need a bundle: while a cached value exists they get it for
up to `SLAUDE_VAULT_STALE_MAX` (default 600 s), then they fail with
`PROVIDER_CREDENTIALS_UNAVAILABLE` and Slack shows one fixed message per failed
job. A gateway restarted while Vault is down has no cache at all.

**What to do.**

1. Read the gateway log: each failure is an error-level
   `[provider.cred.resolve] persona=… scheme=vault outcome=error` line with an
   internal reason. It never names the path, field or value.
2. Check Vault's health and the gateway's network path to `SLAUDE_VAULT_ADDR`.
3. With Kubernetes auth, check the login: the projected token file at
   `SLAUDE_VAULT_K8S_TOKEN_PATH` exists on the gateway pod, its audience is the
   role's, and the role is bound to the `slaude-gateway` ServiceAccount.
4. Do not restart gateways while Vault is down: a restart throws away the
   cache that keeps new sessions working.

For `outcome="denied"`, fix the reference or the policy; see
[Provider credentials](provider-credentials.md#failure-behaviour).

## A label with no live node

**Signal.** `slaude_label_unserved{label}` (leader only) is 1 when the label is
in use (a live persona's `runsOn`, or an existing `turns.label.<label>` queue),
jobs are waiting on its queue, and no live node has carried the label for
longer than `SLAUDE_LABEL_UNSERVED_SECS` (default 60). `GET /panel/api/labels`
reports the same, with live-node and waiting counts.

**What it means.** That label's turns wait. Nothing is posted to Slack.

**What to do.**

1. Find the node Deployment whose credential carries the label, and look at its
   pods: crash-looping, scaled to zero, or paused on a refused credential (see
   [below](#a-node-paused-on-a-refused-credential)).
2. If no Deployment carries the label, the persona's `runsOn` names a label
   nobody runs (the sync warned about it). Add a node Deployment for it, or fix
   `runsOn` in the persona repository and sync.
3. Keep at least two replicas per label, so one pod's restart does not trip
   this alert.

## A node credential close to expiry

**Signal.** `slaude_node_credential_expiry_seconds{id}`: seconds until a signed
credential this gateway replica has seen expires. The gauge is set when a node
authenticates, at most 64 ids per replica. A node also logs a warning at boot
when fewer than 14 days remain.

**What it means.** At expiry the node gets `401`, pauses its claim loops and
stops serving its labels. A credential that is no longer used keeps its last
value until the gateway restarts, so a retired id can keep the alert firing:
check that the id is still in use before acting.

**What to do.** Mint a new credential on a gateway and roll the node
Deployment that uses it:

```sh
bun run node-token mint --label finance --id finance-2026-q4 --ttl 90d
# put the printed token into that Deployment's credential Secret
# (slaude-scale-node-cred-<label>) as SLAUDE_NODE_TOKEN, without the newline,
# then roll the Deployment; finally revoke the old id:
bun run node-token revoke finance-2026-q3
```

The token is printed once on stdout; never put it in a command line or a log.
See [Node credentials](multi-node.md#node-credentials).

## A rising rate of 403 from the gate

**Signal.** There is no metric for gate refusals. Each refusal is an
error-level gateway log line:

```
[v1] gate denied: node=<credential id> tenant=<t> persona=<p> label=<label> route=<route>
```

Alert on its rate in your log system, for example with Loki:

```
sum by (node) (count_over_time({app="slaude", component="gateway"} |= "[v1] gate denied:" [10m])) > 5
```

Related metrics that move with it: `slaude_v1_job_events_total{event="fail"}`
(jobs failed with `LABEL_MISMATCH`) and `slaude_node_turns_total{result="moved"}`
on nodes.

**What it means.** A node asked for a persona's bundle, tools or token for a
label its credential does not carry. A few refusals right after a relabel are
expected: the in-flight turn fails with `LABEL_MISMATCH` and is re-dispatched
once. A steady rate means a misconfiguration (a Deployment minted with the
wrong label, a warm session on a node that lost the label) or a node trying to
use credentials it should not have.

**What to do.** Group the lines by `node=`. If one credential id dominates,
inspect it on a gateway (`bun run node-token inspect -`, token on stdin) and
compare its labels with the personas named in the lines. If the labels are
wrong, re-mint and roll that Deployment. If the node should not be asking at
all, revoke its id (`bun run node-token revoke <id>`) and investigate the pod.

## The legacy door in use while a node key is set

**Signal.** `slaude_node_legacy_auth_total` counts `/v1` requests authenticated
with the shared legacy token (`SLAUDE_NODE_LEGACY_TOKEN`) while
`SLAUDE_NODE_KEY` is set. The gateway also logs one warning per process.

**What it means.** At least one node still uses the shared static token. While
the door is open, every persona on `default` is reachable with that one secret.

**What to do.** Find the node (its pods have no signed `SLAUDE_NODE_TOKEN`;
their `whoami` reports `legacy: true`), mint a credential for it, roll it, and
once the counter stays flat set `SLAUDE_NODE_LEGACY=off` on the gateways and
remove `SLAUDE_NODE_LEGACY_TOKEN` from their Secret.

## A node pod holding gateway-only variables

**Signal.** `slaude_node_gateway_secrets_present` on a node: the number of
gateway-only variables found in its environment at boot (0 when the Secret
split is done). The node also logs one line naming them, never their values.

**What it means.** The node, and every agent turn on it, can read secrets that
let it act as the gateway: mint job tokens, decrypt stored credentials, read
every tenant's rows. With `SLAUDE_NODE_BOOT_CHECK=warn` (the default) the node
boots anyway; with `refuse` it would not have started.

**What to do.** Load only the node Secret on node pods
([the Secret split](multi-node.md#the-secret-split)), roll the nodes, and then
treat the exposed values as compromised: rotate `SLAUDE_JOB_SECRET` and read
the warning about `SLAUDE_MASTER_KEY` in
[What nodes were exposed to](multi-node.md#what-nodes-were-exposed-to).

## A node paused on a refused credential

**Signal.** `slaude_node_auth_paused` on a node is 1 while it has paused its
claim loops because the gateway answered `401 NODE_UNAUTHORIZED` for its own
credential (expired, revoked, or minted under a key the gateways no longer
accept).

**What it means.** The node takes no new turns and sends no heartbeat, but
`/healthz` stays 200 on purpose (a restart cannot fix a credential and would
crash-loop on the boot-time 401); `/readyz` is 503. Its labels may become
unserved.

**What to do.** Inspect the credential on a gateway, mint a new one for the
Deployment, and roll it. The node resumes by itself once `GET /v1/node/whoami`
succeeds again, retrying every 5 s doubling to 60 s.
