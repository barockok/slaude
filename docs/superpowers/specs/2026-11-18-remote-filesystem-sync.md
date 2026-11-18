# Remote filesystem sync (S3-compatible storage)

Status: draft, for review. No implementation yet.

## Goal

Remove the shared-volume dependency from gateway and node mode. Every file a
session depends on lives in S3-compatible object storage. A node hydrates a
session's files onto pod-local disk when it claims the session, works on the
local copy while the session is hot, and flushes back. When the session goes
idle it can resume on any node, which hydrates what the previous node wrote.

No PersistentVolume, no ReadWriteMany storage class, anywhere in the cluster
topology.

## Today

`$SLAUDE_HOME` is one ReadWriteMany PVC (`deploy/k8s-scale/30-pvc.yaml`)
mounted at `/data` by every gateway and node. It holds:

| Path | What | Writers |
|---|---|---|
| `workspaces/<team>-<channel>-<thread>[...]` | Per-thread working directory (`manager.ts`) | The node running the session |
| `workspaces/agent-<id>/proactive[/channels/<id>]` | Proactive and channel-session folders (`workspace-claim.ts`) | The node running the session |
| `.claude/projects`, `personas/<name>/.claude/projects` | SDK transcripts, reached through the `projects/` symlink in each pod-local config home | The node running the session |
| `skills/`, `personas/<name>/skills/` | Bundled, installed (`slaude.lock`) and agent-written skills; `write_skill` writes here | Image seed, any node, the gateway |
| `personas/<name>/.claude`, `.claude` | Persona config home base: settings, plugin symlink, credential seed, transcripts | The node running the session |
| `.claude/plugins` | Installed plugin code | Image build, operator |
| `personas/<name>/agent.yaml`, `SOUL.md`, `.mcp.json`, `slaude.json` | Filesystem persona definitions and operator files | Operator; read by the gateway and mono |
| `knowledge/` | Installed knowledge bases | `install-deps` from `slaude.json`, baked into the image and seeded into `/data` |

Already off the volume, and not a node concern:

- Per-session `CLAUDE_CONFIG_DIR` homes (pod-local `emptyDir`,
  `config-root.ts`), MCP credentials, session rows.
- **Persona definitions.** A node receives a bundle from the gateway and has
  no persona directory. Filesystem personas (`agent.yaml`, `SOUL.md`) are read
  by the gateway and mono only; managed personas come from Postgres.
- **Knowledge.** `kb_search`, `kb_think` and the KB listing go through the
  gateway's REST tool plane, so a node never reads `knowledge/` to answer them.
  The `/ingest` flow (`src/knowledge/ingest.ts`) is deprecated; KBs are
  installed from the `slaude.json` manifest at image build time.

What a node still reads from `$SLAUDE_HOME` is therefore: skills, the persona
config home base, installed plugins, and the legacy `.mcp.json` files (only a
managed persona's MCP config is bridged by default). The one edge case is a
deployment with the brain disabled, where the prompt tells the agent to read
`knowledge/<label>/` directly.

Costs of the volume: it forces an RWX storage class, which is slow on many
small files and has rename and locking quirks. Correctness leans on filesystem
semantics plus the Redis session lock and `WorkspaceClaims`.

## Decisions

| Topic | Decision |
|---|---|
| Interface | The S3 API only. Endpoint, region, bucket, credentials and a path-style toggle are configuration. No provider-specific feature in the code. |
| MinIO | A container in the integration-test compose file and a documented self-host option. No code references it. |
| Scope | Every file a node-side session depends on: workspaces, transcripts, skills, the persona config home base. Per-session credential homes stay pod-local. Persona definitions and knowledge are not node filesystem state (see Today). |
| Two classes | Session-owned state (single writer) and shared state (skills, persona config base; many readers, gateway-authoritative). |
| Personas in S3 mode | Must be managed (Postgres). Filesystem personas and the operator files (`agent.yaml`, `SOUL.md`, `.mcp.json`, `slaude.json`) stay mono-only, because gateway replicas cannot share them without a volume. |
| Knowledge | Image-baked from `slaude.json`; not synced. With the brain disabled in S3 mode, the node reads the baked copy in its image. |
| Plugins | Image-owned (the existing read-only plugin root), not synced. |
| Flush cadence | Configurable: `turn` (flush at the end of every turn) or `idle` (flush when the session is evicted). A flush on drain always happens. |
| Large files | No size limit. Multipart upload; hydrate lazily where possible. |
| Encryption | Bucket-level server-side encryption. No application-level encryption. |
| Skill scope | Runtime-evolved skills only (written by `write_skill`), as an overlay on the image-baked base. Plugin, bundled and installed skills are not synced. |
| Skill freshness | Apply immediately (soft real time) through pub/sub invalidation, with a version check at turn start as the floor. |
| Rollout | Behind a flag. The RWX path stays until the S3 path is proven; the cutover is a later change. |
| Mono | Unchanged. The local filesystem is the default backend; S3 is optional there. |

## Storage interface

```ts
interface ObjectStore {
  get(key: string, opts?: { range?: [number, number] }): Promise<ReadableStream | null>;
  put(key: string, body: ReadableStream | Uint8Array, opts?: { contentType?: string }): Promise<{ etag: string }>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  list(prefix: string, opts?: { after?: string; limit?: number }): AsyncIterable<{ key: string; size: number; etag: string }>;
  delete(keys: string[]): Promise<void>;
}
```

Two implementations: `S3ObjectStore` (Bun's built-in S3 client, so no AWS SDK
dependency) and `LocalObjectStore` (a directory, for mono and unit tests).

**Conditional writes are not assumed.** `If-Match` / `If-None-Match` support
varies across S3-compatible providers, so fencing never depends on them (see
Fencing). Multipart upload is assumed; it is part of the baseline S3 API.

**Startup self-check.** On boot, each process puts, gets, lists and deletes a
probe object under `_probe/<node-id>`. A provider that is only half compatible
fails loudly at boot, not mid-turn.

### Configuration

| Variable | Meaning |
|---|---|
| `SLAUDE_STORAGE` | `fs` (default, today's behavior) or `s3` |
| `SLAUDE_S3_ENDPOINT` | Endpoint URL; empty means the AWS default |
| `SLAUDE_S3_REGION` | Region |
| `SLAUDE_S3_BUCKET` | Bucket |
| `SLAUDE_S3_PREFIX` | Optional key prefix, so one bucket can serve several clusters |
| `SLAUDE_S3_PATH_STYLE` | `1` for providers that need path-style addressing |
| `SLAUDE_S3_ACCESS_KEY_ID`, `SLAUDE_S3_SECRET_ACCESS_KEY` | Credentials |
| `SLAUDE_SYNC_FLUSH` | `turn` or `idle` |

Credentials follow the existing Secret split: nodes need storage credentials,
and they are held in the node Secret, not the gateway-only one. Scoped
credentials (a node may read and write only `sessions/` and read `shared/`)
are recommended and documented, but not enforced by code.

## Key layout

```
<prefix>/
  sessions/<session-id>/
    manifest/<epoch>-<seq>.json     # one object per committed flush
    blobs/<sha256>                  # file content, content-addressed
  shared/
    skills/<scope>/<slug>/<version>/...    # immutable skill versions
    skills/<scope>/<slug>/HEAD             # pointer: current version
    personas/..., knowledge/...
  _probe/
```

Content-addressed blobs make flushes incremental (unchanged files upload
nothing) and make a re-delivered flush idempotent. A manifest lists every path
in the session's tree with its blob hash, mode, size and mtime.

## Session-owned state

Covers the thread, proactive and channel workspaces and the SDK transcript.
The existing Redis session lock already gives one writer at a time.

### Local path must be deterministic

The SDK keys a transcript by the encoded working-directory path. A session
resumed on another node must therefore see its workspace at the same absolute
path. Every node hydrates a session to the same pod-local location (a fixed
`SLAUDE_NODE_WORK_ROOT`, default `/work`, plus the session's relative path).
This is simpler and safer than rewriting transcript paths on hydrate. The
workspace row's `working_dir` stays the single source of that path.

### Lifecycle

1. **Claim.** The node takes the session lock and gets its epoch.
2. **Hydrate.** It reads the newest manifest. If a local copy exists and its
   manifest id equals the remote one (the warm, same-node case), it skips the
   download. Otherwise it writes the missing files from blobs. Large files
   stream; the manifest lets the node create the tree first and fill content
   lazily where the agent does not need it up front.
3. **Run the turn** against local disk. Nothing remote is touched.
4. **Flush** (`turn`: end of every turn; `idle`: on eviction; both: on drain).
   It scans the tree, uploads blobs not already present, then writes
   `manifest/<epoch>-<seq>.json`. The manifest is written last, so a crashed
   flush leaves orphan blobs and no visible state.
5. **Idle eviction.** After the final flush the node may delete the local copy.

A node that dies mid-turn loses that turn's unflushed edits. BullMQ replays
the turn after the session lock expires, so the work is redone from the last
committed manifest.

### Fencing

A zombie node (partitioned, lock expired, still running) must not overwrite a
newer node's state. Without conditional writes:

- Each lock acquisition increments a per-session epoch in Redis.
- A manifest is named `<epoch>-<seq>.json`. Readers take the highest epoch,
  then the highest seq within it.
- Before writing a manifest, the node re-checks in Redis that its epoch is
  still current. If not, it discards the flush and aborts the turn.

The check-then-write window is small but not zero, so a late stale manifest can
land. It carries a lower epoch than the current holder's, so readers ignore it.
Blobs are content-addressed and never mutated, so a stale writer cannot corrupt
them.

### Flush failure

A failed flush never holds the session lock. The turn's reply is already
posted, and a stalled lock would block the session for as long as storage is
down.

1. The node records `needs-flush:<session-id> = {node, epoch, since}` in
   Redis and releases the lock as usual.
2. It keeps the local copy (eviction is deferred until a flush succeeds) and
   retries in the background with capped exponential backoff.
3. The next turn for that session routes back to the same node through the
   existing warm-session routing, so it continues from the local copy and
   flushes under a fresh epoch. Nothing is lost.
4. If that node is gone (its heartbeat expired), the next claimer runs from
   the last committed manifest. The edits since that manifest are lost, and
   the loss is counted (`slaude_storage_unflushed_loss_total`). The dead node's
   late flush, if it ever happens, carries a lower epoch and is ignored.

Transcripts are the exception to "lost": they flush every turn on a separate,
single-file path, so a conversation's history is the last thing at risk.

### Metrics and alerts

Everything above must be visible without reading logs. Names follow the
existing `/metrics` conventions on gateway and node.

| Metric | Type | Meaning |
|---|---|---|
| `slaude_storage_flush_total{result}` | counter | Flushes by `ok`, `error`, `fenced` |
| `slaude_storage_flush_duration_seconds` | histogram | Time to commit a manifest |
| `slaude_storage_flush_bytes_total` | counter | Blob bytes uploaded |
| `slaude_storage_flush_pending` | gauge | Sessions in `needs-flush` |
| `slaude_storage_flush_pending_age_seconds` | gauge | Age of the oldest `needs-flush` |
| `slaude_storage_unflushed_loss_total` | counter | Claims that ran from an older manifest because the owner node was gone |
| `slaude_storage_hydrate_total{result,mode}` | counter | Hydrates by result and `warm` or `cold` |
| `slaude_storage_hydrate_duration_seconds` | histogram | Hydrate time |
| `slaude_storage_hydrate_bytes_total` | counter | Bytes downloaded |
| `slaude_storage_request_errors_total{op}` | counter | S3 request failures by operation |
| `slaude_storage_selfcheck_ok` | gauge | Last startup self-check, 1 or 0 |
| `slaude_skills_invalidation_lag_seconds` | histogram | Time from `write_skill` commit to a node's refreshed cache |

Alerts, documented in the alerts runbook: pending age above a threshold,
any `slaude_storage_unflushed_loss_total` increase, a flush error rate above
a threshold, and a failing self-check. The runbook also names the first
checks: endpoint reachability, credentials, and bucket policy.

### Garbage collection

A background pass in the reaper leader deletes manifests older than the newest
N per session and blobs no retained manifest references. Retention and the
sweep interval are configurable. Closed sessions are removed after a grace
period.

### Ignore rules

Default excludes are `node_modules`, `.cache` and `__pycache__`, set by a
configurable ignore list. Everything else, including `.git`, is workspace state
and syncs. With no size limit, the ignore list is the only brake on a runaway
workspace, so the default list is conservative and documented.

## Shared state: skills, personas, knowledge

Many readers, occasional writers. The gateway is authoritative.

### Skills

**Scope: runtime-evolved skills only.** The sync covers skills that
`write_skill` creates or edits while the agent runs. It does not cover:

- skills from plugin definitions (image-owned, read from the plugin root);
- bundled skills (the release's `skills/` dir, seeded on boot);
- installed skills (`slaude.lock`, put there by `install-deps` or
  `sync_manifest`, baked into the image).

Those three are the **base**: identical on every pod because they ship in the
image. Runtime-written skills are an **overlay** keyed by `(scope, slug)` that
shadows a base skill of the same slug, which is how the loader already treats a
persona skill over a global one. `write_skill` editing a bundled or installed
skill therefore writes an overlay, and the base is untouched. Provenance
(`provenance.ts`) is unchanged: the lock and bundled list still win for
retirement decisions.

The skill version log in Postgres (`skill_versions`, migration 0034) records
each change today, while the files stay the runtime authority. In this design
the roles split:

- **Write path.** `write_skill` on a node calls a gateway endpoint instead of
  writing a local file. The gateway validates, writes the immutable version
  under `shared/skills/...`, flips `HEAD`, records the `skill_versions` row, and
  publishes `skills:changed {scope, slug, version}` on Redis pub/sub.
- **Read path.** Each node keeps a local cache of the skills it has loaded. On
  a `skills:changed` message it refetches that skill and swaps it atomically
  (write to a temp dir, rename). The skill is visible to the next tool call,
  not just the next turn. At the start of every turn the node also compares
  its cached versions to a cheap manifest (a single `shared/skills/INDEX`
  object, or a Redis hash), so a missed pub/sub message is repaired within one
  turn.
- **Conflicts.** Two simultaneous writers serialize at the gateway. The
  version log already rejects a stale base ("the caller re-reads the latest
  row and decides again").

This keeps skills out of the per-session sync: they are small, shared, and
want push semantics, not hydrate-on-claim.

### Persona config home base

A node seeds each session's pod-local config home from `personas/<name>/.claude`
(or `.claude` for the default persona): settings, the plugin symlink and the
credential seed. In S3 mode that base is built from the image (settings and
plugins) plus the gateway bundle, not a shared directory. Transcripts are the
exception and belong to the session-owned class, not this one.

### Personas and knowledge

No sync. Persona definitions arrive through the gateway bundle, and knowledge
is image-baked and served through the gateway's brain. Filesystem personas and
the operator files stay mono-only (see Decisions).

## Gateway reads

Anything the gateway reads from the volume today (panel transcript view,
skills view) goes through `ObjectStore`. The panel's durable transcript reads
the latest session manifest's transcript blob, not a mounted path. Personas
come from Postgres, so the gateway reads no persona files in S3 mode.

## Flag and rollout

`SLAUDE_STORAGE=fs` keeps today's behavior byte for byte. `s3` switches
every path above. The RWX PVC stays in the manifests, off by default in the new
overlay, until the S3 path soaks. This touches the agent loop and session
lifecycle, so it ships as release candidates (`vX.Y.Z-rc.N`) per the repo's
release rules. Cutover (removing the PVC and the `fs` path from the scale
overlay) is a separate, later change.

## Testing

- **Unit:** `LocalObjectStore` against the store contract suite; manifest and
  epoch ordering; the ignore list; flush idempotency.
- **Contract suite:** one suite that runs against any `ObjectStore`, so
  `LocalObjectStore` and `S3ObjectStore` are held to the same behavior.
- **Integration:** a MinIO container in the compose file, gated like the Redis
  tests (skipped without `SLAUDE_S3_TEST_ENDPOINT`). Scenarios: hydrate on a
  second node, resume after a node kill mid-turn, a zombie flush ignored by
  epoch, skill edit visible on another node within one pub/sub round trip,
  startup self-check failure on a bad endpoint.
- **Multi-node sim:** the existing `bun sim run --nodes 2` suite must pass
  unchanged with `SLAUDE_STORAGE=s3`.

## Failure modes

| Failure | Behavior |
|---|---|
| Storage unreachable at hydrate | The turn fails and retries through BullMQ; the session is not run on empty state. |
| Storage unreachable at flush | The lock is not held. The session is marked `needs-flush` and the node keeps its local copy and retries with backoff. See Flush failure. |
| Node killed mid-turn | Last committed manifest wins; the turn replays. |
| Zombie flush | Lower epoch; ignored by readers. |
| Provider half-compatible | Caught by the startup self-check. |
| Hydrate of a very large tree | Slower first turn on a cold node; warm-routing keeps repeat turns on the node that holds the copy. |

## Resolved questions

1. **Persona config home base** is image-owned. Settings and plugins come from
   the image and the gateway bundle, so nobody hand-edits `.claude` on a
   running pod. This is unrelated to skills.
2. **Flush failure** does not hold the session lock (see Flush failure).
3. **Eviction** deletes the local copy on idle, after a successful final
   flush. A bounded cache is a later optimisation if hydrate time hurts.
4. **Transcript** is flushed at the end of every turn regardless of
   `SLAUDE_SYNC_FLUSH`. It is one file, so it is cheap, and a crash never
   loses conversation history, only workspace edits made since the last
   workspace flush when the cadence is `idle`.
5. **Edits to base skills** become an overlay. `write_skill` is fully
   supported in S3 mode for every slug. An edit of a bundled or installed skill
   is saved as a runtime skill that shadows the base on every node; the base in
   the image is untouched. Agent-written skills sync the same way.

## Out of scope

Application-level encryption, cross-region replication, and the cutover that
removes the `fs` path.

## As built (rc.34)

Where the implementation differs from the draft above, the code is right and the
draft is superseded:

- **Sync units are directories, not sessions.** Two units per session, `ws-<hash
  of the working directory>` and `tx-<hash of the transcript directory>`, each
  with its own manifest series and epoch, stored under `sessions/<unit>/`. A
  proactive or channel folder is shared by several sessions; keying by session
  would make them overwrite each other.
- **Skills are store-authoritative and mirrored by every process.** There is no
  gateway write endpoint. The tool hook uploads the skill (files first, then a
  head object under `shared/skills-head/`), announces it on the `skills-changed`
  channel, and every node and gateway replica refetches and swaps it in. The
  gateway replica also records the arrival in the skill version log. Two writers
  racing on one slug resolve to the head written last. A delete that exposes a
  bundled skill restores it at once; an installed (`slaude.lock`) skill returns on
  the next pod start.
- **The panel's durable transcript read** is still a TODO in the code, so there
  was no gateway read to move.
- **A shared base needs no PVC mount.** The overlay mounts an `emptyDir` at
  `/data`, which behaves like a fresh volume each pod start; the image's seeding
  runs every boot.
- **Garbage collection** (`gcSession`, `removeSession`) is implemented and tested
  but not yet scheduled by the reaper.
- **Flush retry** is per node and in memory, with a Redis mark for other nodes; a
  node that restarts forgets its pending set, and the mark expires after seven
  days.
- **Not built:** a bounded local cache of recent sessions (eviction deletes on
  idle), and application-level encryption (out of scope by decision).
