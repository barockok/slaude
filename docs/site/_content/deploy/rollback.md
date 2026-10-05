---
title: Rollback runbook
description: Upgrade order for the gateway and node topology, what older code does with each new setting after a rollback, and the configured-then-rolled-back procedure.
---

# Rollback runbook

The provider references, node labels, node credentials and KB scope added in
v0.45.0 are each inert **until configured**. That makes a release candidate safe
to install. It does **not** make a configured cluster safe to roll back: older
code ignores the new settings, and ignoring them changes behaviour. This page
says what changes, and how to roll back without being surprised by it.

## Upgrade order

**Gateways first, then nodes**, for every release in the series and for every
step inside one.

| Combination | Behaviour |
|---|---|
| new gateway, old nodes | old nodes use the static token, are label `default` and consume `turns`; personas without `runsOn` are `default`; nothing changes |
| new nodes, old gateway | a node with the static token behaves as before; a node with a signed credential is rejected with 401 at boot, with a clear message |
| a runtime bundle with `mcpServers` or provider references, old node | the old node ignores the fields it does not know |
| a `/deploy` payload with a newer field, older gateway | from v0.44.1 the gateway reports the unknown field in `ignoredFields` (a 422 only with `SLAUDE_DEPLOY_STRICT=1`) and refuses a payload `version` newer than it supports; a gateway before v0.44.1 silently drops it |
| a node pod that still loads the gateway Secret | the node logs a warning and sets `slaude_node_gateway_secrets_present`; with `SLAUDE_NODE_BOOT_CHECK=refuse` it does not boot unless `SLAUDE_NODE_ALLOW_GATEWAY_SECRETS=1` |
| `SLAUDE_PROVIDER_ENV_FALLBACK` | defaults to `1` (today's behaviour); the default is not changed in this series |
| `SLAUDE_NODE_KEY` unset | signed node credentials are not accepted; the legacy token is the only door |

Two rollout rules from the Secret split also apply on the way up: the node
image must already be at the new release when the new node Secret is applied
(set the image in the same apply), and queued and running turns must drain
first. See [Upgrading a cluster that used one Secret](multi-node.md#upgrading-a-cluster-that-used-one-secret).

An older gateway's queue follower does not know the `job-moved` marker or
`LABEL_MISMATCH`: mid-rollout it can close a moved turn early, and it posts the
fixed failure message instead of re-dispatching. Keep the window short.

## What older code does after a rollback

Once a setting is configured, rolling back to code that predates it gives this:

| What was configured | What older code does |
|---|---|
| `provider` references (persona field, `personas.provider_json`) | ignores the column; managed personas fall back to `provider_creds` rows and to **node-environment credentials** |
| `runsOn` (`personas.runs_on`) | ignores it; every persona runs on `default`, on any node |
| `kbSources` (`personas.kb_sources`) | ignores it; every persona regains **all** knowledge sources |
| signed node credentials | an older gateway rejects them with 401; nodes must go back to the static token |
| node revocations (`node_revocations`) | the table is unused; nothing is revoked |

The schema changes are additive (`ADD COLUMN IF NOT EXISTS`, one new table), so
older code starts on the newer schema. Nothing has to be migrated down.

A `/deploy` that reaches an older replica mid-rollout records the revision and
drops the fields that replica does not know (before v0.44.1, silently). Do not
sync personas while gateways of two versions are serving.

## Configured-then-rolled-back procedure

Decide first which of the two is acceptable:

- **Accept the table above.** Roll back as is, knowing that personas lose their
  label, their KB scope and their own provider for the duration.
- **Undo the configuration first**, so the older code sees nothing it would
  misread. This is the safe default when personas must not see each other's
  knowledge or keys.

To undo the configuration first, in this order:

1. **Stop new configuration.** Pause the persona pipeline.
2. **Remove the settings through a sync.** In the persona repository, delete
   `runsOn`, `kbSources` and `provider` from every persona and sync. Removing
   `provider` warns, naming each persona: from then on it uses the
   `provider_creds` rows and, with `SLAUDE_PROVIDER_ENV_FALLBACK=1`, the node's
   own credentials. Give those personas stored credentials, or put a provider
   key back into the node Secret, **before** the sync, or their turns fail.
3. **Undo provider references:** unset `SLAUDE_VAULT_ADDR` (and the other
   `SLAUDE_VAULT_*` variables) on the gateways, and set
   `SLAUDE_PROVIDER_ENV_FALLBACK=1` on nodes.
4. **Undo node credentials:** put the shared static token back as each node's
   `SLAUDE_NODE_TOKEN`, make sure `SLAUDE_NODE_LEGACY_TOKEN` holds it on the
   gateways and `SLAUDE_NODE_LEGACY` is not `off`, and roll the nodes. Collapse
   the per-label node Deployments into one `default` Deployment (or keep them;
   with no `runsOn` every turn is `default` anyway) and remove the per-label
   ScaledObjects.
5. **Drain.** Wait until `slaude_queue_depth` is 0 for every label and no turn
   is running. A job on a `turns.label.<label>` queue is invisible to older
   nodes, which consume `turns` only.
6. **Roll back gateways, then nodes**, to the older image.
7. **Check:** a mention of each persona gets a reply, and the nodes log no 401
   at boot.

To roll forward again, reverse the order: new gateways, new nodes, then
re-apply the configuration through a sync.

## The rehearsal

Before promoting v0.45.0, run this once on a test cluster with every feature
configured: at least one persona with a `vault://` provider reference, one with
a non-default `runsOn` served by its own labelled node Deployment, one with
`kbSources`, and signed node credentials with the legacy door closed. Then:

1. run the procedure above;
2. confirm the older release serves a turn for each of those personas, and that
   the table above describes what you see;
3. roll forward again and confirm each persona is back on its label, scope and
   provider.

Record the result (what was run, on which versions, what differed from this
page) with the release's soak notes. The local cluster can host the rehearsal;
its runbook is `deploy/k8s-local/README.md` in the repository.
