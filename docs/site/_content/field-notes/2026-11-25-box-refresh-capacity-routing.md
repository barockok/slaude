---
title: "Boxes, phases 4, 6, 7 and 8 without a sandbox: refresh, stdio servers, images and routing, capacity"
date: 2026-11-25
---

# Boxes, phases 4, 6, 7 and 8 without a sandbox

**Date:** 2026-11-25
**Status:** on the branch, not released, all of it dark (`SLAUDE_BOX=off`, `SLAUDE_BOX_TIER=none`). No session runs in a box: the sandbox driver, the supervisor (`boxd`), the two proxies and `box-init` (plan, Phase 2) do not exist here. Everything below that needs a driver was built against the existing `SandboxDriver` interface and tested with a fake.
**Plan:** `docs/superpowers/plans/2026-11-24-box-implementation.md`. **Spec:** `docs/superpowers/specs/2026-11-24-box-design.md`.

## A finding first: a sandbox tier with no driver ran sessions unboxed

Before this work, a node started with `SLAUDE_BOX_TIER=gvisor` advertised `box/1` and its tier, the gateway (with `SLAUDE_BOX=on`) sent it boxed sessions, and the agent manager, which had no sandbox resolver installed, spawned the CLI on the node itself. That is the one thing the design says must never happen: a failure to start a box becoming an unboxed run. Nobody could reach it by accident with the defaults, but the variable was documented.

The worker now refuses to start on a sandbox tier that has no driver, before it announces itself or claims anything. This build ships no driver, so the only tier that starts is `none`. With a driver, the worker installs a resolver that answers null for an unboxed session and, for a boxed one, either the sandbox it started or a boot failure.

## What exists now

**Owed from the review of phase 3.**

- The signed box set has a high-water mark, kept outside the database in the store the guardrail mark uses, under a key of its own. A whole signed set replaced by an older signed set (a restored backup, a rollback) now fails closed on every read and write. A committed sync raises the mark; a dry run does not. After a deliberate restore an operator clears the mark by hand: there is no repair command yet.
- `personas export --format agent-yaml` carries the `box` key. The files format has no key for it and refuses such a persona, because exporting without it would turn a boxed agent into an unboxed one at the next deploy.
- A stand-in digest (`personas render --no-push`) is marked: it starts with 24 zero hex digits. A real sync refuses it with a 422 and stores nothing, a dry run still prints the diff with a warning, and a node refuses to boot a session on one. Refusing on the gateway was chosen over only marking: the gateway is the last place that sees every payload.
- A persona that names a box and cannot be boxed (a provider credential form no box can use) is refused where the deployment says so. See "Decisions".

**Refresh (phase 7).** `refresh` moves a session's pin by compare-and-set, ends the warm session through the reload route and writes one `box.refreshed` audit row. It never runs during a turn: a queued or running turn defers it. A forced box version makes older pins stale, and the next dispatch refreshes before the job exists and tells the sender privately. `/box status` and `/box refresh` exist where `SLAUDE_BOX` is on and turns go to nodes; elsewhere `/box` is text, as before. The first turn after a refresh carries a `<box-refreshed>` note once.

**Stdio MCP servers (phase 8).** The name and key patterns and the `${` rules live in one module that the node manifest and a box's `mcp.stdio` both use. On a sandbox-tier node a boxed session gets exactly its box's servers, checked again on the node, with no exec wrapper; a manifest entry is ignored for it. `slaude box from-manifest` classifies a manifest's servers into the three cases, and `slaude box preflight` is the opt-in checklist. Both report and change nothing.

**Images, inventory, routing (phase 4).** An image cache behind a two-method runner interface; `GET /v1/node/boxes`; a prewarm loop; the node's digests and occupancy on its heartbeat; a cold boxed session routed to a node that holds its image and reported a free slot; `BOX_IMAGE_UNAVAILABLE`; the console's boxes route says which nodes hold each version (data only, no page).

**Capacity (phase 6).** Sizing, admission, pressure and the claim gate as pure functions with table tests; a node runtime that applies them; hand-back of a claimed job; two independent pause reasons; drain; the parked hint and the routing preference for the parked node; the storage sweeper removing a closed session's home; the autoscaling half of `deploy/k8s-scale-box`.

## Decisions taken while building it

**Where a persona that cannot be boxed runs.** The spec says such a persona runs unboxed "if the operator left that available" and is refused otherwise, and names no switch. Every node can run an unboxed session, so availability cannot be read from the fleet. There is now a gateway variable, `SLAUDE_BOX_UNBOXED` (`allow` by default, or `refuse`). With `refuse`, dispatch does not run the turn (its own notice, `BOX_NOT_BOXABLE`), a node is refused the bundle, and a sync that would deploy such a persona fails, dry run included. It all hangs on the one constant that still lists all three credential forms, so today it has nothing to act on. **This is a new variable the owner has not seen.**

**The refresh note waits in Redis, not in a session column.** The plan lists no migration for phase 7. Boxes only exist where turns go through the queue, so Redis is always there. The mark (`box-refresh-note:<session>`, 30 days) is taken with GETDEL by the dispatch that queues the turn, and put back if that turn is not queued. A lost mark loses a hint to the model, never the refresh.

**"A turn is running" is the session lock.** A node holds `lock:session:<id>` for exactly the length of a turn, so that key answers the same on every gateway replica. The coalesce index was tried first and dropped: its 10 minute lifetime is shorter than a long turn.

**`/box status` is for anyone in the thread; `/box refresh` for the manager and the channel's approvers.** The plan says both are for "whoever may `/new` the thread". Status only reads, answers privately, and shows a short digest.

**`GET /v1/node/boxes` has no label gate in the route table.** There is no job token at node start, so the gate is applied in the handler, on the caller's own verified labels. The route's entry says so, and the audited list in the route table test gained one line. **A security decision for review.**

**The image checks compare like with like only if the tool keeps the manifest.** A registry digest names a manifest. A tool that converts the manifest while copying produces another digest. The runner passes `--preserve-digests` to skopeo, and the cache then verifies the layout's digest itself: the index names it, and the manifest blob hashes to it. An image that is not already in OCI form may therefore be refused. Not tested against a real registry.

**Admission runs under the session lock, after hydrate.** The spec calls it claim step 2. The worker binds a job's token and tenant inside the lock, and which box a session runs in is read with that token, so the check sits there, after the files are in place and before the session can boot.

**Handing a job back has two forms.** From the node's own queue it is the existing atomic move to the label queue. From the label queue the same move is a no-op that would complete the job without running it, so the job is put back on its queue with a one second delay while the node's label workers pause.

**A full node's "room" includes an idle session it may park.** With room defined as a free slot only, a node whose every session sat idle stayed paused until their idle timeout, with work waiting on the queue. The integration test found it.

**The default park budget is not always half the volume.** The spec's worked example (an 80 Gi volume: images 15, live 30, parked 30) and its default (half the volume, 40) do not fit together: 15 + 30 + 40 is 85. The default is now half the volume or what is left after images and live sessions, whichever is smaller, so the default cannot fail the boot check it is part of.

**Two pause reasons.** Capacity pauses the label-queue workers only, a refused credential pauses every worker, and a worker resumes when its last reason goes.

## Not done, and why

- **Everything that needs the sandbox.** No session was started in a sandbox. The proxy assertions of the design's non-goal (the egress proxy adds no header; the provider proxy adds one only for its one upstream) are written as a test and skipped by name until `src/box/egress/` exists.
- **`skopeo` and `umoci` were not run.** Their argv is asserted through a fake process runner. Pull, unpack and the digest check were tested with a fake runner, a local OCI layout fixture and a layout served over HTTP.
- **The node does not read `boxd`'s cgroup limit or volume size.** The sizing check takes them through an interface (`limits`) that the driver will supply; with none given both are unknown, and the check then refuses to start unless `SLAUDE_BOX_MEMORY_BUDGET_MB` is set. The pressure rule likewise needs a memory reading it does not have yet.
- **Home and workspace-extras sync on a node** is wired only where a packer is passed in. The supervisor is to serve it.
- **A parked session's image can be evicted.** The image cache protects images of running sessions and of what the gateway lists; a parked session's digest is not tracked on the node.
- **`/box status` shows limits, not disk use.** Use is known to the node at flush, and nothing carries it to the gateway.
- **`SLAUDE_BOX_DEV_IMAGE` was not removed**: it was never added, since phase 2 has not run.
- **A warning for a persona that is both boxed and in the node manifest comes at its first session, not at boot.** A node learns which personas are boxed from their bundles.
- **No React page.** The boxes route returns the node rows; nothing renders them.
- **The box overlay is incomplete on purpose.** It has triggers, the grace period and the fallback HPA, and not the `boxd` container. Its header says not to apply it.
- **No repair command for the box set's high-water mark.**

## Tests

All of it runs in the default suite except what is named here. The sync, bundle and store tests need the persona tables (`SLAUDE_DB=pg`, PGLite locally). `tests/integration/box-capacity.test.ts` needs Redis: it was run against a throwaway `redis:7-alpine` container, two workers in one process with the fake driver, and passed. The rendered overlay test needs `kubectl`. Nothing here needs Linux, root or a sandbox runtime, because nothing here starts one.
