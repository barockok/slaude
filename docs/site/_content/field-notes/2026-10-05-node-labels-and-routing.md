---
title: "Node labels and routing: the label is a signed claim, and every move is a race"
date: 2026-10-05
---

**The limits first.** Nodes reach Redis directly, so queue names are routing,
not access control: a node can read another label's queue and its job payloads.
What a label enforces is the credential path. Files on the shared volume are
shared until sandboxing exists, and every agent turn on a node runs as the
node's user, so labels separate nodes, never personas that share a node.

Before this work any node could serve any persona, and every node held the one
shared token plus, in the stock manifests, every gateway secret. Now the
Secrets are split, a node proves its identity and labels with a signed
credential, a persona runs on the label in its `runsOn`, each label has its own
queue, and every persona-scoped `/v1` route checks the label signed into the
job token against the node's. The operator procedure is in
[Multi-node deployment](../deploy/multi-node.md) and
[Node MCP manifest](../deploy/node-manifest.md).

## Decisions

**Split the Secrets first, warn before refusing.** A node needs its credential,
Redis, the gateway URL and (while the fallback exists) a provider key. A node
holding `SLAUDE_JOB_SECRET` can mint a job token for any persona; one holding
`SLAUDE_MASTER_KEY` decrypts every stored credential. One list
(`src/config/gateway-only-env.ts`) drives three things: the node boot check, the
agent child scrub, and a manifest test that renders the built Deployments and
fails if a node can see a gateway-only name. The boot check warns by default and
refuses with `SLAUDE_NODE_BOOT_CHECK=refuse`, so an unsplit cluster sees the
problem before it is stopped.

**The label goes into the job token, not a registry lookup.** The gate compares
`claims.label` with the node's verified labels on every call, so there is no
window in which a replica that has not seen a relabel tells a node it may
proceed. The live `runsOn` is re-checked at token refresh and reissue, and a
mismatch answers `409 LABEL_MISMATCH`.

**HMAC credentials with their own key.** `SLAUDE_NODE_KEY` must differ from the
job secret, or whoever can mint a job token could mint a node. Because HMAC
means "whoever can verify can mint", the key lives in the gateway Secret only;
asymmetric credentials are deferred. A credential has an expiry, a gauge, an id
revocable through `node_revocations`, and a previous key accepted during
rotation.

**`turns` stays the `default` queue.** Old and new nodes keep consuming it, so a
rolling upgrade works. Other labels get `turns.label.<label>`; a node id starting
with `label.` is refused at mint and at boot so it can never collide.

**No node-level semaphore.** One worker per label plus the node's own queue,
each with `SLAUDE_NODE_CONCURRENCY`. Holding claimed jobs active while they wait
for a node-wide slot would starve idle nodes and hide the backlog from the
autoscaler, which reads the wait list.

**A label mismatch is failed and re-dispatched once by the gateway**, not
retried by BullMQ on the same queue (the 500 ms hot loop an early draft had).

**The node-local stdio manifest** declares the stdio servers a node may run and
which personas get each, keyed on the persona from the verified job claims. A
plugin's MCP server is mounted only when the manifest declares it, and every
node child runs with `strictMcpConfig`.

## What went wrong

Most defects were in moving jobs between queues, and most were found in review
by reasoning about the gap between two Redis calls.

- **A signed credential authenticated as the legacy identity.** The gateway read
  `SLAUDE_NODE_TOKEN` as its legacy value, and the stock manifests fed it from
  the node Secret: a revoked, expired signed credential placed there matched the
  legacy check before the verifier ran. The gateway now reads
  `SLAUDE_NODE_LEGACY_TOKEN`, and refuses a legacy value shaped like a signed
  credential. The first version of that refusal rejected any value with two
  dots, which closed the door on an operator's ordinary token; it now checks the
  decoded payload.
- **Reissue reset the token-life cap.** It accepted any original token and
  restarted `iat0`, so a holder could keep a job token alive indefinitely. Reissue
  now answers 409 while a refresh is still possible and never extends a token
  past the job's own age cap.
- **A move was add-then-remove.** A worker claiming the original between the two
  steps left a second claimable copy, and messages ran twice. Every move now adds
  the copy held (delayed), takes the original in one Lua step that refuses a
  locked or finished job, and only then releases the copy.
- **A dead node's claimed warm turn stayed active forever.** No surviving worker
  consumes a node's own queue, so BullMQ's stall recovery never ran there. The
  reaper now moves active jobs whose lock has expired, checking `turn-done` in the
  same atomic step so a finished turn is dropped instead of run again.
- **Merge order.** Moved and re-dispatched messages were put first
  unconditionally; with the coalesce index expired, a newer job could go ahead of
  an older one. A merge now orders by the Slack timestamp of each job's earliest
  message, and the reaper moves active jobs before waiting ones.
- **A message coalesced into a job whose turn had already run was lost**: a node
  that wrote `turn-done` and died before the ack leaves the job to stall recovery.
  Such a job is now treated as claimed.
- **The labels key expired before the sessions it described.** With a long
  heartbeat a warm session sat on a node whose `nodelabels:` key had expired, so
  routing read it as `{default}` and another node cold-resumed beside a live
  session.
- **A paused node was restarted by its liveness probe.** Pausing claims on a
  refused credential made `/healthz` fail, and the restart crash-looped on the
  boot-time 401. `/healthz` now stays 200 and `slaude_node_auth_paused` is the
  signal.
- **The CLI expands `${...}` a second time** in a stdio server's command, args and
  env, against the agent child's environment, including the `${VAR:-default}`
  form. A manifest could hand a stdio server the persona's provider key. The node
  now refuses any `${` the CLI would expand. Its exec wrapper also ignores
  `bunfig.toml` and `.env` in the session workspace, which Bun would otherwise
  load from the cwd.

## What was measured, and what was not

Integration tests drive label routing through the real gateway, the gate and two
labelled nodes, a relabel end to end (a pending message moved, the in-flight turn
failed and re-dispatched once, nothing posted), and a node killed during a
warm-routed turn. Two ordering races remain and are documented (a newer job
already running; an expired coalesce index with two stranded jobs). Not measured
yet: any of this on a cluster, the capacity of several label queues (Redis
connections grow by one per worker per node), and a cluster with the legacy door
closed. The release gate requires all three.
