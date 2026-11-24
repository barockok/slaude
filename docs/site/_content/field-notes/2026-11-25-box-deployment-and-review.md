---
title: "Boxes, phase 9 and the resume test: deployment, the default box, a session that moves between nodes, and a review of the whole branch"
date: 2026-11-25
---

# Boxes, phase 9 and the resume test

**Date:** 2026-11-25
**Status:** on the branch, dark (`SLAUDE_BOX=off`, `SLAUDE_BOX_TIER=none` are still the defaults), not released. Every phase of the plan now has code. **Nothing has run on a cluster, against a real model, or with a real provider credential.**
**Plan:** `docs/superpowers/plans/2026-11-24-box-implementation.md`, Phase 9 and the last test of Phase 5. **Spec:** `docs/superpowers/specs/2026-11-24-box-design.md`.

## What exists now

- **`tests/integration/box-resume.test.ts`**, run by `scripts/smoke/box-smoke.sh` with the two other gated suites.
- **The default box** (`boxes/default/`), the workflow steps that publish it, and a built-in `default` box the gateway reads from its own image.
- **`deploy/k8s-scale-box` complete** (a kustomize Component with the supervisor container), `with-s3`, a `boxes` compose profile, `SLAUDE_LOCAL_BOX` for the local cluster, a `node-box` image target, a plain-host guide.
- **The remaining node metrics**, `slaude box digests --in-use`, boxed variants of the HA scripts.
- **The documentation**: `deploy/boxes.md` in full.

## The resume test, and what it showed

Three nodes in turn, one object store (the directory store behind `SLAUDE_STORAGE=s3`), a real supervisor, the real CLI in a real sandbox, the mock model.

| Asked | Shown |
|---|---|
| A tool installed into home and a dependency in the workspace's `node_modules` on node A are there on node B | Node B starts on an empty disk. Its first turn runs the tool (the execute bit survived the pack) and reads the dependency, the plain workspace file and the image's seed file. The transcript on node B holds the first turn's tool call |
| A system-level install is not | The file written outside home and workspace reads `No such file or directory` on node B |
| Kill a node before a flush; the next node resumes from the last flush and the loss is counted | Node B's store stops accepting writes during a turn; its four flushes fail and leave their marks; node B is killed. Node C has everything up to node B's last good flush, none of the edits after it, and `slaude_storage_unflushed_loss_total` rose (once per unit, four here) |

It passed on both tiers the first time it ran, which is the pack units and the fencing of phase 5 doing what their unit tests said. **No product defect surfaced.** One line of product code changed: a killed worker (`kill()`, a test seam) now stops its sync timers, as a dead process would.

What the test models and does not prove:

- The three nodes run one after another in one process. A node's disk is modelled by moving every node-local directory aside before the next node starts. Two live nodes on separate machines contending for one session were not run here (the unit tests of the fence cover that with a fake store).
- "A tool" is an executable written into `~/.local/bin` and "a dependency" a file under `node_modules`. No package manager ran, because no registry is allowlisted in that suite.
- The store is a directory. **Nothing was flushed to or hydrated from a real S3-compatible server through a real supervisor.**
- The loss counter only moves when a flush failed and left its mark. With `SLAUDE_SYNC_FLUSH=idle`, a node that dies between flushes loses its edits with no mark and so no count. That is how the per-file units already behaved; it is now true of a home too.

The first full run had one failure in the nested bwrap stage: the test read the node's warm set a moment before the worker's own `finally` filled it. The test now waits on the registry. The run after that:

| Stage | Tier | Pass | Skip | Fail |
|---|---|---|---|---|
| On the VM | gvisor | 33 | 1 | 0 |
| On the VM | bwrap | 33 | 1 | 0 |
| Nested in a privileged container | gvisor | 33 | 1 | 0 |
| The same container | bwrap | 33 | 1 | 0 |

33 is 16 of the contract suite, 11 of the worker suite and 6 of the resume suite. The host is the VM of the smoke note.

## Decisions taken in phase 9

**The built-in default box is trusted as the code is.** The image carries `boxes/default/box.yaml` and `boxes/default/image.ref`; the gateway adds a `default` box to a tenant's verified snapshot only when the stored set has none of that name, and only after the stored set verified. A stored set that fails its check still fails closed. A session pinned to an older built-in digest keeps that digest from the same repository and moves only by a refresh.

**Per-architecture digests, not an index digest.** The node's image cache verifies that the layout holds one manifest whose blob hashes to the pinned digest, and a multi-platform index does not satisfy that. `image.ref` has one line per architecture and the gateway serves its own. A deployment whose nodes and gateway differ in architecture must define its own `default`.

**Composition is a Component, not two overlays.** kustomize refuses the same base listed twice, so "list both overlays" does not work. The box overlay is a Component, and `deploy/k8s-scale-box/with-s3` lays it over the S3 overlay.

**An `emptyDir` size limit is not visible inside a pod** (the file system reports the host's disk), so the overlay sets the image and park budgets explicitly.

**On a plain host the supervisor's cgroup is the root**, which has no memory limit to read: `SLAUDE_BOX_MEMORY_BUDGET_MB` must be set and the pressure rule does not run there.

**One compose default changed.** Each node's `/config-home` is a named volume now, so an optional supervisor can reach it.

**Three audit kinds of the spec are log lines and metrics, not audit rows**: a refused connection, a quota exceeded, an image a node could not fetch. A node has no route that writes the gateway's audit trail, and adding one is a new surface that was not designed.

**Two metrics of the spec are not emitted**: a count of sandboxes ended for memory (nothing on the node sees it; the failure code `BOX_OOM` does not exist either) and the `cli` phase of a start.

## Review of the branch against the plan's Review Focus

| Item | Test | Note |
|---|---|---|
| 1. A boxed spawn's environment | `tests/box/env.test.ts`, `review-focus-env-proxy`, and both gated suites with real processes | Reads clean |
| 2. No `.credentials.json` | `tests/box/supervised-driver.test.ts`; removal and no seeding only in the gated worker suite | Only that one file name is listed, checked at start |
| 3. The provider proxy | `tests/box/provider-proxy.test.ts`, `review-focus-env-proxy` | See "open" below: the retry |
| 4. Supervisor paths and environment | `tests/box/boxd.test.ts` | The environment check refuses known names, not every name that could hold a token |
| 5. Hostile archives | `tests/box/pack.test.ts` (19 cases) | Reads clean |
| 6. A fenced home or extras flush | `tests/node/fs-sync.test.ts`, `tests/storage/pack-sync.test.ts`, `review-focus-sync` | **Gap:** the worker's own reaction (abort, stop the sandbox) has no test |
| 7. A pin never moves without a refresh row | `tests/gateway/box-refresh.test.ts`, `box-dispatch`, `tests/box/builtin-box.test.ts`, `review-focus-policy` | See "open": the audit write |
| 8. The transcript unit is the same boxed and unboxed | `review-focus-sync` (new) | See "open": a symlinked path |
| 9. A full node never fails a job | `tests/node/box-runtime.test.ts`; hand-back in `tests/integration/box-capacity.test.ts` (Redis) | A start that fails after admission is a failed turn |
| 10. `/env use` in a boxed session | `review-focus-policy` (new, structural) | **No end to end proof exists** |
| 11. Sync with `SLAUDE_BOX=off` | `box-dispatch`, `run-sync-boxes`, `runtime-box` (the last two need `SLAUDE_DB=pg`) | Reads clean |
| 12. `${` or a credential shape in `box.yaml` | `tests/persona/box-definition.test.ts`, `payload-boxes`, `review-focus-policy` | Fixed here: see below |

**Fixed in this pass.** A credential-shaped value in a box's `description`, `refresh.note` or `durable.exclude` was accepted; only `env` and the stdio fields were checked. The note is shown in Slack and the description in the console. All free text is checked now.

**Open, found by reading and not fixed:**

1. **The refresh audit row is not in the transaction that moves the pin.** The digest moves by compare-and-set, then the audit write is sent without waiting and its failure is swallowed. A failed insert, or a gateway that dies between the two, leaves a session on a new digest with no row. The Review Focus item holds only when the audit write succeeds.
2. **The provider proxy's retry replays a request on any connection error**, not only on a kept connection that was already closed. A reset after the provider accepted a request sends it twice: for a model call, a second charge. No credential is at risk.
3. **A working directory that crosses a symbolic link.** The box is given the path as stored and the transcript folder named after the resolved path. If the CLI inside names its folder from the path it sees, the transcript would go to the throwaway overlay. Read from the code; not reproduced with a real CLI. Every run here used a path with no link in it.
4. A deployment that later defines its own `default` box makes sessions pinned to a built-in digest unservable until `/box refresh` (refused, never moved).
5. The supervisor checks a path and then uses it; no current request names a component a box controls.

## Test counts, as run

- `bun run typecheck`: clean.
- `bun test`, once, the whole suite: 12471 pass, 523 skip, 5 fail, 12999 tests in 822 files. Two of the five are the known load-sensitive guards (`no-misused-promises`, `no-string-authority`), which pass alone. Three were tests of the fix above, written before it and running against the old code; they pass now. **The whole suite was not run again after that fix**; the persona, box and CLI directories were (2415 pass, one unrelated CLI test failing under load and passing alone).
- `SLAUDE_DB=pg` on PGLite, `tests/box tests/persona tests/gateway tests/db`: 5176 pass, 52 skip, 0 fail.
- `bun sim run`: 26 of 26 transcripts.
- `tests/deploy` (needs `kubectl`): 287 pass, 0 fail.
- The box smoke, both tiers, on the VM and nested: the table above.

## Not verified

Everything in the smoke note's list still stands, except the resume test, which now exists. In addition:

- **No workflow ran.** The steps that build and publish the default box, hand its digests to the image build, and the `node-box` target were checked against a fake `docker` only.
- **No image was built**: not `boxes/default/Dockerfile`, not the restructured main `Dockerfile` as a whole. The box layers of the main `Dockerfile` were built and used by the nested smoke stage.
- **The default box was never unpacked or started by a node**, and no image was pulled from a real registry with skopeo.
- **No manifest was applied.** The Kubernetes overlay and the local switch render; the compose file validates; the systemd units were never started. `tini -s` in the plain-host guide is untested.
- **The boxed HA variants did not run** (`E2E_BOX`, `VERIFY_BOX`). Nothing syncs a boxed persona or loads a box image into the local cluster, and there is no scale-up assertion (the local overlay has no KEDA).
- **`PIP_USER=1` in the default box** refuses an install inside a virtualenv. It is what the plan asked for; the box's Dockerfile says to use `uv pip`.

## What the owner must do before any production use

1. Decide K1 on a real cluster (the phase 0 note's host 3 steps), then run the smoke test in a privileged pod of the node Deployment's shape.
2. One real turn per provider credential form behind the provider proxy, and the real-model turn K2c needs.
3. Run the workflows once on a branch or a candidate tag and check that the default box image is published, that `image.ref` is in the slaude image, and that a node unpacks and starts that image.
4. Apply `deploy/k8s-scale-box/with-s3` to a test cluster with a real S3-compatible bucket, opt one persona in, and run the boxed HA variant.
5. Read the five open items above and decide on the first two before a persona that matters is boxed.
6. Replace the pod sizes in the overlay with measured ones.
