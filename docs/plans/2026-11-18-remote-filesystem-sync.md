# Remote filesystem sync: implementation plan

Spec: `docs/superpowers/specs/2026-11-18-remote-filesystem-sync.md` (read it first).
Ships as `v0.46.0-rc.34` behind `SLAUDE_STORAGE=s3`. The default (`fs`) changes
nothing, so the single-box mono deployment is unaffected by the RC.

## Rules for every task

- TDD: failing test first, then the code. Run `bun test <file>` per task and the
  full `bun test` plus `bun run typecheck` before the PR.
- Public repo: no real names, org names or secrets. Leak scan before every commit
  (see CLAUDE.md). No emoji, no em-dashes. No AI co-author trailer.
- One logical change per commit. Integration tests that need MinIO or Redis gate
  on `SLAUDE_S3_TEST_ENDPOINT` / `SLAUDE_REDIS_TEST_URL` and skip without them.
- `SLAUDE_STORAGE` unset or `fs` must keep today's behavior byte for byte.

## Task 1: storage interface, backends, config, self-check

Files (new): `src/storage/object-store.ts`, `local.ts`, `s3.ts`, `config.ts`,
`selfcheck.ts`, `index.ts`; `tests/storage/contract.ts` (shared suite),
`tests/storage/local.test.ts`, `tests/storage/s3.test.ts`;
`docker-compose.s3-test.yaml` (MinIO + bucket init).

- `ObjectStore` exactly as in the spec. `LocalObjectStore(dir)` maps keys to files
  (atomic write via temp + rename). `S3ObjectStore` uses `Bun.S3Client` with
  endpoint, region, bucket, path-style toggle, key prefix.
- `config.ts`: `storageMode()` (`fs`|`s3`), `s3Config()` from `SLAUDE_S3_*`,
  `syncFlush()` (`turn`|`idle`). Reject bad values at boot with a clear message.
- `selfcheck.ts`: put, head, get, list, delete a probe under `_probe/<id>`; throws
  an error naming the failing operation.
- Contract suite runs against both backends: put/get roundtrip, range get, head,
  missing get is null, list with prefix and `after`, delete many, overwrite,
  empty object, binary bytes.
- Register the storage metrics (spec table) in `src/metrics.ts` so later tasks
  only call them.

## Task 2: manifest and tree sync engine

Files (new): `src/storage/manifest.ts`, `tree-sync.ts`, `ignore.ts`, `gc.ts`;
tests `tests/storage/manifest.test.ts`, `tree-sync.test.ts`, `gc.test.ts`.

- `manifest.ts`: schema (`version`, `epoch`, `seq`, `createdAt`, `files:
  {path -> {hash, size, mode, mtimeMs}}`), key helpers
  `sessions/<id>/manifest/<epoch>-<seq>.json`, `latestManifest(store, id)`
  (highest epoch, then seq; zero-padded keys so list order is numeric).
- `tree-sync.ts`: `flushTree(store, id, roots, {epoch, isCurrent})`: scan roots,
  skip ignored paths, hash, upload missing blobs (multipart is the backend's job),
  then re-check `isCurrent()` and write the manifest last. `hydrateTree(store, id,
  roots, {localManifestId})`: no-op when the local marker equals the remote
  manifest id; otherwise write missing or changed files, delete files absent from
  the manifest, restore modes. Local marker file `.slaude-sync` per root.
- `roots`: the workspace dir (`ws/`) and the transcript dir
  `<configHome>/projects/<encoded-cwd>/` (`tx/`), encoded as the SDK does
  (verify against a real `~/.claude/projects` entry in a test fixture).
- `ignore.ts`: default list `node_modules`, `.cache`, `__pycache__`, overridable
  with `SLAUDE_SYNC_IGNORE`.
- `gc.ts`: keep the newest N manifests per session (default 5), delete blobs no
  retained manifest references, remove closed sessions after a grace period.
- Tests: idempotent flush (second flush uploads nothing), epoch ordering (stale
  manifest ignored), crash before manifest leaves no visible state, hydrate on a
  fresh dir reproduces the tree including empty dirs and modes, ignore rules,
  large file (>64 MB generated sparse) streams without buffering whole.

## Task 3: node integration

Files: new `src/node/fs-sync.ts`; edits `src/node/worker.ts`,
`src/queue/keys.ts` (epoch key, needs-flush key), `src/config/env.ts`.

- Epoch: `INCR` a per-session Redis key inside the lock callback, before hydrate.
- Before the turn runs: hydrate workspace (`working_dir`, same absolute path on
  every node) and transcript dir. After: flush per `SLAUDE_SYNC_FLUSH`. The
  transcript flushes every turn whatever the cadence. Drain flushes everything
  warm. Idle eviction (warm TTL close) flushes then deletes the local copy.
- Flush failure: set `needs-flush:<id> {node, epoch, since}`, release the lock,
  keep the local copy, retry with capped backoff; clear on success. The next
  turn for that session routes to the same node through the existing warm
  routing. If the owner heartbeat is gone, the claimer proceeds from the last
  manifest and increments `slaude_storage_unflushed_loss_total`.
- Everything is a no-op unless `storageMode() === "s3"`.
- Tests (Redis-gated, StubAgent): turn on node A flushes, turn on node B
  hydrates and sees the file; kill A mid-turn, B resumes from the last manifest;
  zombie flush from a lower epoch is ignored; flush failure sets `needs-flush`
  and the metric; transcript flushes under `idle` cadence.

## Task 4: skills overlay and invalidation

Files: `src/skills/overlay.ts` (new), `src/skills/loader.ts`,
`src/skills/mcp-tools.ts`, a gateway endpoint under `src/gateway/api/` plus its
client method in `src/node/client.ts`, `src/queue/pubsub.ts`.

- Overlay dir `$SLAUDE_HOME/skills-runtime/<scope>/<slug>/` (pod-local, rebuilt
  from the store). The loader reads base then overlay; overlay shadows base.
- In S3 mode `write_skill` / `delete_skill` on a node call the gateway endpoint.
  The gateway validates (reuse `skillOps`), writes immutable
  `shared/skills/<scope>/<slug>/<version>/...`, flips `HEAD`, records the
  `skill_versions` row, and publishes `skills:changed`.
- Nodes subscribe, refetch the changed skill into a temp dir and rename it in
  place. At turn start a node compares its cached versions to the `INDEX`
  object. Record `slaude_skills_invalidation_lag_seconds`.
- Tests: write on node A visible to node B within one pub/sub round trip; missed
  message repaired at the next turn start; base skill edit becomes an overlay and
  the base file is untouched; delete re-exposes the base.

## Task 5: gateway reads, docs, deploy overlay, alerts

- Gateway panel transcript reads through `ObjectStore` in S3 mode.
- `deploy/k8s-scale/overlays/s3/`: kustomize overlay removing the PVC, adding
  `emptyDir` for `/data` on nodes and gateways, and the S3 env and Secret keys.
- Docs: `docs/site/_content/deploy/remote-storage.md` (config table, MinIO and
  other S3 endpoints, scoped credential policy, the flag and rollout),
  `alerts.md` entries, a field note, and the RC release notes
  `docs/site/_content/releases/v0.46.0.md` section for rc.34.

## Task 6: ship and deploy

1. Leak scan, `bun run typecheck`, full `bun test`, MinIO and Redis gated suites.
2. Independent code review (`superpowers:code-reviewer`), fix findings.
3. PR, wait for CI green, squash-merge (standing preference), pull main.
4. Version PR to `0.46.0-rc.34`, tag `v0.46.0-rc.34`, confirm the release workflow.
5. Deploy the box through `~/Code/vps-hardening`: `sudo /usr/local/sbin/slaude-backup`
   on the box, bump `SLAUDE_VERSION`, `apply.sh sumopod 81-slaude`, `verify` at
   0 FAIL, Slack smoke. The box is mono and the flag stays `fs`, so the deploy
   proves the RC causes no regression; the S3 path is proven by the MinIO suites.
