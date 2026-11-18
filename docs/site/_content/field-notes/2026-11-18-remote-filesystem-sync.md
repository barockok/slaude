---
title: "Remote filesystem sync: why a session's files go to a bucket and what makes that safe"
date: 2026-11-18
---

# Remote filesystem sync (rc.34)

**Date:** 2026-11-18. **Status:** shipped behind `SLAUDE_STORAGE=s3`, off by default.
Spec: `docs/superpowers/specs/2026-11-18-remote-filesystem-sync.md`.
Guide: [Remote storage](../deploy/remote-storage.md).

## The problem

The scale topology mounted one ReadWriteMany volume on every gateway and node.
That forced an RWX storage class, which is slow for many small files and has
rename and locking quirks (the credentials file had already been moved off it for
exactly that reason). It also made correctness depend on filesystem semantics
across processes, on top of the Redis session lock.

Looking at what a node still read from the volume cut the problem down. Persona
definitions arrive through the gateway bundle, knowledge goes through the
gateway's brain, and credentials were already pod-local. What was left was a
session's working directory, its transcript, and the skills the agent writes while
running.

## Decisions worth remembering

- **Only the S3 API.** No MinIO, AWS or provider-specific call anywhere, so the
  bucket is configuration. The official MinIO images stopped being pullable
  during this work, which would have been a CI break had the code or the test
  setup named them; the tests start whichever S3 server is available.
- **Fence with an epoch, not a conditional write.** `If-Match` support differs
  across S3-compatible servers. Instead each lock acquisition increments a Redis
  counter; a manifest is named by `<epoch>-<seq>`; readers take the highest; a
  flush re-checks that its epoch is still current just before the one write that
  makes it visible. A late write from a node that lost the lock has a lower epoch
  and is never the latest. Blobs are content-addressed and never mutated, so a
  stale writer cannot corrupt them.
- **Key by directory, not session.** A proactive or channel folder is shared by
  several sessions. Keying the stored state by session made two sessions
  overwrite each other's copy of one folder (a hydrate removes files the
  manifest does not hold); keying by the directory, which is already what the
  workspace lock serializes, avoids it. Caught while reading how the folder lock
  is taken, before the node integration was written; a test now keeps a folder
  alive while a second session in it is still warm.
- **A failed flush must not hold the lock.** The first draft held the session lock
  until the flush succeeded; that stalls a session for as long as the store is
  down. The shipped design marks the directory `needs-flush` and keeps the local
  copy, and makes the same node flush before it reads anything on its next turn,
  so a newer local copy is never replaced by an older stored one.
- **The transcript flushes every turn.** Even with `idle` cadence, conversation
  history is one small directory and the last thing to risk.
- **Skills are store-authoritative, mirrored everywhere.** The design first put a
  gateway endpoint in front of skill writes. The node already holds the bucket
  credentials, and the existing skill-version log scans the gateway's local copy,
  so each process mirroring the bucket into its own skills directory reuses
  everything that already reads that directory (the loader, the agent SDK, the
  version log). Two writers racing on one slug resolve to the head written last.
  Plugin, bundled and installed skills stay in the image, and a runtime edit of
  one is an overlay.
- **The skills mirror has no switch (rc.36).** rc.35 added `SLAUDE_SKILLS_MIRROR=0`
  for one machine where the gateway and the worker share a read-only skills
  directory, and the first deployment used it. That left `s3` mode on with the
  one piece of state a second node needs (skills the agent wrote) not syncing,
  which contradicts what the mode promises. The flag is gone: the mirror starts
  with the storage mode. Two things make the shared directory work instead. A
  pull that cannot write the directory (read-only to the worker, owned and
  written by the gateway) or cannot move an existing copy aside is a no-op when
  the bytes already match the stored version, and a failure, retried next turn,
  when they do not. And the gateway publishes the
  agent-written skills it already has (the `authored_by: agent` stamp, which
  provenance already trusts over nothing else) to any scope the store has no head
  for, so a deployment that switched on `s3` after months of runtime skills loses
  none of them. A skill the store already holds is never overwritten by that seed.

## Things that went wrong on the way

- `Bun.write(path, new Response(stream))` hangs when the stream came from a Node
  stream. Downloads use a plain stream pipeline.
- An overlay directory cannot live inside the base it extends: kustomize detects
  the cycle. It is a sibling directory.
- A test that kept each node's keys under its own prefix could not see the other
  node's epoch and fence marks, and passed for the wrong reason until the key
  space was shared, as it is in a cluster.

## Not done

- The panel's durable transcript read is still a TODO in the code; it never read
  from the volume, so nothing there needed to move.
- The loss window with `idle` cadence is real: a node that dies loses every
  unflushed turn of a warm session. It is documented, not hidden.
- Garbage collection exists (`gcSession`, `removeSession`) but nothing schedules
  it yet. Stored manifests and blobs grow until it is wired into the reaper.
