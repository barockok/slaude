---
title: Remote storage (S3)
description: Run the gateway and node topology with no shared volume. Session files, transcripts and runtime skills live in an S3-compatible bucket, and a session can continue on any node.
---

# Remote storage (S3)

The scale topology normally mounts one ReadWriteMany volume as `$SLAUDE_HOME` on
every gateway and node. With `SLAUDE_STORAGE=s3` that volume is gone: every pod's
`$SLAUDE_HOME` is pod-local scratch, and the files a session depends on live in
an S3-compatible bucket. A node loads a session's files when it claims the
session, works on its own disk, and writes them back. When the session is idle it
can continue on any other node, which loads what the first one wrote.

`SLAUDE_STORAGE` unset (or `fs`) keeps today's behavior exactly. The single-process
deployment is unchanged and needs no bucket. Design:
`docs/superpowers/specs/2026-11-18-remote-filesystem-sync.md` in the repository.

## What syncs

| State | Where it lives in S3 mode |
|---|---|
| A session's working directory (`workspaces/...`, including a proactive or channel folder) | The bucket, per directory, under `sessions/ws-<id>/` |
| The agent's own transcript directory for that working directory (the SDK's `projects/<cwd>/`) | The bucket, under `sessions/tx-<id>/` |
| Skills the agent writes, edits, retires or deletes while running | The bucket, under `shared/skills/`, mirrored into every process's local skills directory |
| Plugin skills, bundled skills, skills installed from `slaude.lock` | The image. Identical on every pod, never synced. A runtime edit of one is an overlay that shadows it on every node |
| Persona definitions | Postgres, through the gateway bundle (managed personas). Filesystem personas (`agent.yaml`, `SOUL.md`) are single-process only |
| Knowledge bases | The image, served through the gateway's brain |
| Files the gateway saves for a session (Slack attachments) | Staged in the bucket's `inbox/` by the gateway; the node that runs the turn writes them into the working directory after it loads it, so they join the stored tree at the next flush |
| Per-session credentials | Pod-local, as before. Never in the bucket |

A workspace is keyed by its directory, not its session, because several sessions
can share one folder (the agent's proactive folder). The two units of a session
each have their own manifest series and their own fencing epoch.

## Configuration

| Variable | Meaning |
|---|---|
| `SLAUDE_STORAGE` | `fs` (default) or `s3` |
| `SLAUDE_S3_ENDPOINT` | The endpoint URL. Empty means the AWS endpoint for the region |
| `SLAUDE_S3_REGION` | Region, default `us-east-1` |
| `SLAUDE_S3_BUCKET` | Bucket (required) |
| `SLAUDE_S3_PREFIX` | Key prefix, so several clusters can share a bucket |
| `SLAUDE_S3_PATH_STYLE` | `1` for path-style addressing. Defaults on when an endpoint is set |
| `SLAUDE_S3_ACCESS_KEY_ID`, `SLAUDE_S3_SECRET_ACCESS_KEY` | Credentials (required) |
| `SLAUDE_SYNC_FLUSH` | `turn` (default) or `idle`, see below |
| `SLAUDE_SYNC_IGNORE` | Comma-separated directory or file names that never sync. Default `node_modules,.cache,__pycache__,.venv` (a virtualenv is rebuilt from its requirements, not synced; `.git` is deliberately not ignored) |
| `SLAUDE_SYNC_STATE_DIR` | Absolute path where a node keeps its sync markers and the skills sync state. Default `$SLAUDE_HOME/.sync-state`. Set it when the worker cannot write `$SLAUDE_HOME`, to a directory that survives a restart. See [One machine, a non-root worker](#one-machine-a-non-root-worker) |

Only the S3 API is assumed (get, put, head, list, delete, multipart upload), so
any compatible endpoint works: AWS S3, Cloudflare R2, or a server you host
yourself such as MinIO, RustFS, SeaweedFS or Garage. Nothing in slaude is specific
to one of them. A process checks the bucket at boot (put, get, list, delete one
probe object) and refuses to start, naming the operation, if the endpoint fails
any of them.

Give the credentials only the access they need: read and write on
`<prefix>/sessions/*` and `<prefix>/shared/*`, and list on the prefix. This is the
same trust a shared volume gave a node, not more: whoever can run a prompt on a
node can reach what that key reaches. Use bucket-level server-side encryption for
data at rest; slaude adds no encryption of its own.

## Flush cadence

`SLAUDE_SYNC_FLUSH=turn` writes the workspace back after every turn, so while the
bucket is reachable losing a node loses at most the turn in flight (the queue
replays it). If the bucket is failing, see [When a flush fails](#when-a-flush-fails).
`idle` writes it
back when the session goes idle or the node drains, which uploads less when a
session makes many small turns, and loses every unflushed turn of a warm session
if the node dies.

Either way the transcript is written back after every turn, so a crash never
loses conversation history.

## When a flush fails

A failed flush never holds the session lock, because a stalled lock would block
the session for as long as the store is down. Instead the node:

1. marks the directory `needs-flush` in Redis and keeps its local copy;
2. retries with capped backoff;
3. flushes before it reads anything on its next turn for that directory, so a
   newer local copy is never overwritten by an older stored one. While the
   session is warm on that node, the existing warm-session routing sends the next
   turn there.

Another node that finds the mark waits (the job is requeued) while the owner is
alive, for up to two minutes. If the owner is gone, or the wait runs out, it
continues from the last stored state and counts the loss in
`slaude_storage_unflushed_loss_total`: those workspace edits are lost.

A flush from a node that no longer owns a session (its lock expired and another
node took over) is refused rather than merged; see
[Alerts](alerts.md#remote-storage) for what to watch.

## Skills

A `write_skill`, delete, retire or restore on any process updates its local copy,
uploads the skill, and announces it on the `skills-changed` Redis channel. Every
other process refetches that one skill and swaps it in with a rename, so the new
text is visible to the next tool call. Each turn also reconciles with the bucket,
which repairs a missed announcement. A write the bucket did not accept is kept
and retried before every reconcile, and a pull never replaces an edit that has
not been published yet. Deleting a runtime skill that overlaid a bundled one
brings the bundled skill back. A skill installed from `slaude.lock` that was
overlaid returns on the next pod start.

A retired skill's old copy stays on the machine that retired it (and goes with
that pod); every other process sees the skill removed. Restoring it works only
there. Old versions of a skill stay in the bucket under `shared/skills/`; they
are small, and nothing sweeps them yet.

## Deploying

`deploy/k8s-scale-s3` is a kustomize overlay on `deploy/k8s-scale` that removes
the PVC, mounts an `emptyDir` at `/data` on the gateway and every node
deployment, sets the storage settings, and adds the credentials Secret:

```sh
# fill in the REPLACE_ values here and in deploy/k8s-scale first
kubectl apply -k deploy/k8s-scale-s3
```

An `emptyDir` behaves like a fresh volume at every pod start, so the image's
seeding of bundled and installed skills runs each boot. Size `sizeLimit` for the
largest set of warm sessions one pod serves, not for history.

To try it on one machine, `docker-compose.s3-test.yaml` starts a local S3 server
and the storage tests run against it:

```sh
docker compose -f docker-compose.s3-test.yaml up -d --wait
SLAUDE_S3_TEST_ENDPOINT=http://localhost:9100 bun test tests/storage tests/skills tests/node
```

## One machine, a non-root worker

The Kubernetes overlay gives every pod a writable `$SLAUDE_HOME`. A compose deployment is often different: the
gateway runs as root, the worker as an unprivileged user, and both mount one data directory that is root-owned except
for the worker's own `workspaces/` and `.claude/projects/`. Four things follow, and from v0.46.0-rc.35 slaude handles
each of them in `s3` mode:

- **Sync state.** The worker cannot create `$SLAUDE_HOME/.sync-state`. Set `SLAUDE_SYNC_STATE_DIR` to a directory the
  worker owns that survives a restart (a host directory mounted into the worker). Without the markers in it, the next
  hydrate after a restart is a full pass.
- **Skills.** Runtime skills always go through the bucket in `s3` mode; there is no switch. The gateway and the
  worker may still share one skills directory, and it can stay root-owned and read-only to the worker: the gateway
  writes it, and a worker that cannot write it leaves a skill alone when it already holds exactly the stored version
  (right after a change, until the gateway has pulled it, the worker fails and retries on its next turn). On the first start the
  gateway publishes the agent-written skills it already has (stamped `authored_by: agent`) to the bucket, for every
  scope that has none stored; skills installed from a lock, bundled with the release or placed by the operator stay in
  the image or the operator's config and are never published.
- **Working directories.** A gateway in `s3` mode no longer creates a session's directory. The node creates it when it
  loads the session's files, so it is owned by the worker. **Directories that already exist are another matter.**
  Every session started before the mode was turned on has a directory (and an `attachments/` in it) that the gateway
  made as root, which the worker cannot write: its first turn after the switch would fail on the first file it must
  place. Give the worker ownership once, before the switch: `chown -R <worker uid> workspaces/` in the data directory.
  What a root process leaves behind later is read and uploaded as usual, and if the worker cannot delete something in
  it when the session goes idle, that is logged, the local copy and its marker are kept, and the next turn goes on.
- **State directory check.** A node that has `SLAUDE_SYNC_STATE_DIR` set creates it and writes a probe file at boot,
  and refuses to start, naming the directory, if it cannot.
- **Attachments.** The gateway downloads a Slack file into a private temp directory, puts it in the bucket's `inbox/`
  and tells the agent the path it will have in the working directory. The node places it there before the turn. A file
  the node cannot place stays in the inbox for the next turn and is logged, and one bad file does not hold up the rest.
  Nothing clears an inbox object that no node ever collects.

Because both processes still share the data directory, the local copy stays where it is until a session goes idle:
the bucket then holds a replica, not the only copy, until eviction removes the local one. Back up the bucket's storage
before relying on that.

## Rolling back

Set `SLAUDE_STORAGE=fs` (or remove it) and restore the PVC. State written to the
bucket is not copied back: the volume still holds whatever it held when you left
it. Keep the volume until the S3 path has soaked.

## Limits

- A directory is stored as separate files; there is no size limit, so keep large
  generated trees out with `SLAUDE_SYNC_IGNORE`.
- Two nodes cannot work in one directory at once. The existing session and folder
  locks still serialize them; the bucket does not replace those locks.
- A file that changes while it uploads is retried a few times and then fails the
  flush, which retries as described above.
- Timestamps are kept to the millisecond. A tool that depends on sub-millisecond
  mtimes sees them rounded.
