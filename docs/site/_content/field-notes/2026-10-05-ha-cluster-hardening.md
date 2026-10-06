---
title: "HA cluster hardening: defects only two apps, two replicas or a real CLI could show"
date: 2026-10-05
---

The fake-Slack suite and the local cluster turned up defects in HTTP-mode Slack,
approvals, the portal and the local harness itself. This workstream fixed them,
made the `/deploy` payload versioned, locked down the gateway's own model
children, and put every configured or server-supplied URL behind one outbound
policy. This note records the mechanisms.

## Slack in HTTP mode

- **The bot token was read from the environment per message.** HTTP mode resolves
  apps from the encrypted registry, but the attachment path still read
  `SLACK_BOT_TOKEN` and dropped the turn when it was unset. It now takes the
  token from the event's own app, and only when the message has files.
- **The lazy client lacked methods.** It forwarded a hand-written list of
  methods. `chat.postEphemeral` had already been added once after the portal link
  was never delivered, and `files.uploadV2` (attachment replies), `chat.delete`,
  pins, topic and purpose, and canvases were still missing. It now forwards any
  method through a recursive proxy, with a plain object root so serializers
  probing it do not break. A hand-written list had failed twice.
- **Every outbound call went out as the oldest registered app.** Surfaces,
  reactions, status, gates, error posts, slash replies, cron runs and the `/v1`
  tool plane took their client at construction from the transport's app-level
  client. They now resolve it per call from the session's app, carried on the
  route context, persisted on cron jobs and signed into the job token. With two
  apps in one channel, Slack delivers each message to both; self-echo filtering
  now uses every registered app's bot ids, so two apps never answer each other.
- **`users.profile:write` was emitted as a bot scope**, which Slack rejects; it is
  a user scope.
- **Raw error text reached Slack.** Typed failure codes now post fixed text, the
  raw error goes to the log, once per job.

## Approvals and the portal

- **A second click on an approval erased the decision record.** The first click
  rewrites the card to "Approved by ..."; a second click found the row no longer
  pending and replaced the card with "already decided". The database row was
  intact, but the Slack message, the only visible record, was gone. The tests
  never checked `replace_original`, which is why it passed. It now answers ephemerally and leaves the decided card; an
  expired or cancelled gate says so instead of "already decided".
- The portal gained an unlink button, and `/mcp` and Connect cards resolve per
  persona, sharing the portal's list.

## The payload, the model children, outbound fetches

- **`/deploy` payloads carry a `version`.** Unknown fields are reported in
  `ignoredFields` (and refused with `SLAUDE_DEPLOY_STRICT=1`); a version newer
  than the gateway supports is always refused. `render` writes the highest version
  any field needs, so a new field reaches an older gateway as a refusal, not as a
  silent drop.
- **The gateway's model children had a shell.** See the
  [persona config note](2026-10-05-persona-config-on-nodes.md#prompt-injection-found-on-the-way):
  an empty `allowedTools` list is dropped by the SDK, and a prompt-injected KB
  page ran Bash in the `kb_think` synthesis child.
- **One outbound policy.** MCP OAuth discovery, registration, exchange and
  refresh used the plain `fetch`: private ranges were reachable, redirects were
  followed with the request body, and there was no timeout. Every such request
  now checks every resolved address, connects to the checked address, follows no
  redirect and has a timeout and a size cap. In-cluster identity providers and
  MCP servers must be listed in `SLAUDE_OUTBOUND_INTERNAL_HOSTS`. Review found two
  more holes: IPv4-translated and local-use NAT64 IPv6 forms reached loopback,
  and connect and TLS errors carried the pinned private address into the Slack
  thread. Both are fixed.
- **The agent child scrub** now removes every gateway-only variable, the Redis
  URL and, in `mono`, Slack tokens and database URLs. `.mcp.json` placeholders
  never expand a gateway-only variable.

## The local harness

- **`up.sh` raced Postgres's temporary init server.** On first start the image
  runs a socket-only server for its init scripts, then restarts. `pg_isready`
  without `-h` succeeded against it, and the following `CREATE DATABASE` raced
  the init script. It now waits over TCP and treats "already exists" as success.
- **`verify-turns.sh` could not tell "could not measure" from "measured zero".**
  A failed `kubectl exec` arrived at an assertion as an empty string and was
  reported as a product failure. Probes now print nothing and return non-zero on
  failure, and an empty value is reported as COULD NOT MEASURE with the reason.
- **The node HPA scaled to three nodes** under turn load and held for ten minutes,
  so checks that assumed two failed. The scripts pin it for the run and restore it
  from an annotation even after a killed run.
- **A bare `kubectl port-forward` goes quiet** when its pod is replaced.
  `forward.sh` forwards to one named pod, checks it, and rebinds.
- **Sizing.** A node pod holds bun plus one CLI child per warm session (about
  150 to 200 MB each), so node limits were raised and the rest trimmed; one file
  (`sizing.env`) holds the numbers and a test fails when the manifests disagree.
  The floor is provisional until a host that small passes the verify scripts twice
  in a row.

## What the takeover costs

A killed node never releases its session lock, so a re-delivered turn waits for
the lock's TTL (10 minutes by default) and BullMQ's stall detection (about 30 s)
before another node runs it. Nothing is lost or duplicated; it is a latency
bound, documented as such. The local overlay uses a 45 s TTL to keep the check
quick.

## Still open

Cross-replica de-duplication of failure messages is per process. The gateway
still reads `.env` and `.mcp.json` from the shared volume nodes can write. The
cluster proof for personas as code, the real-Slack smoke runbook and the
configured-then-rolled-back rehearsal have not been run; the release gate
requires them.
