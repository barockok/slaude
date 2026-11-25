---
title: "Boxes on a real cluster: a privileged pod on GKE found that a sandbox's memory was outside the pod"
date: 2026-11-25
---

# Boxes on a real cluster (the plan's host 3)

**Date:** 2026-11-25. **Status:** K1 and K6 now measured on a cluster; K2c, the OAuth form and the release workflows still open.
Earlier results: [the Phase 0 spikes](2026-11-24-box-spikes.md) (a development VM). Nothing here changes a default: boxes ship dark.

## The cluster

A temporary GKE Standard cluster, zonal, two `n2-standard-4` nodes (amd64, 4 vCPU, 16 GB), Ubuntu 24.04 node image
(kernel 6.8.0-1064-gke, containerd 2.2.7), cgroup v2, `pd-balanced` 50 GB boot disks, nested virtualisation on
(`/dev/kvm` present in the pod). Pod: `scripts/spike/box/host3-pod.yaml`, privileged, 3 CPU and 8 GiB, no namespace
labels needed (a default GKE Standard namespace admits a privileged pod, server-side dry run and real). runsc
release-20261116.0, the systrap platform. The cluster was deleted after the run; the project had a budget alert and
hard regional quotas (12 vCPU, 250 GB disk) set first.

Autopilot and Fargate-style nodes do not allow a privileged pod, so K1 cannot pass there by design; the bwrap tier
needs unprivileged user namespaces instead.

## K1: runsc runs nested in a privileged pod

Spike 1 (`scripts/spike/box/01-run.sh`) passed on the cluster: run and exec, bind mounts both ways, the root overlay
with a size limit (`ENOSPC` at 256 MB), isolation between two sandboxes, a 100 MB stdio stream intact, loopback with
`--network none`, memory, pids and cpu limits, `--host-uds=open` reaching a host socket. Start time (20 runs): `run
--detach` median 37 ms (p95 45), run plus first exec median 49 ms (p95 60). Density: an idle sandbox is about 41 MB
PSS over its two processes, ten idle sandboxes 104 MB in total. The script prints one `FAIL` row, `host-uds-none`:
that is its negative control (the socket is refused without `--host-uds=open`), the expected result.

## Finding: in a pod the cgroup namespace is the host's, and boxd put sandboxes at the node's root

The Phase 0 and smoke runs used containers with a private cgroup namespace, where `/sys/fs/cgroup` is the container's
own cgroup. A Kubernetes privileged container does not get one: `/proc/self/cgroup` is
`/kubepods.slice/kubepods-pod<uid>.slice/cri-containerd-<id>.scope`, and `/sys/fs/cgroup` is the **node's** root
(106 processes in it, the cgroup namespace id of the initial namespace). boxd made its sandboxes' cgroups, and told
runsc to, at that root. Measured on the cluster before the fix: a 400 MB allocation inside a sandbox moved the pod's
own `memory.current` by 2 MB, and the sandbox's cgroup sat outside the pod. K6 (the sandbox's memory is charged to
the supervisor's container, so the pod limit, the kubelet and the autoscaling signal see it) failed, and so did the
sizing model that rests on it. It would also have written into the node's cgroup tree from a pod.

Fix (`src/box/boxd/server.ts`, `src/box/boxd/spec.ts`): boxd reads its own cgroup from `/proc/self/cgroup`
(`ownCgroupPath`, `defaultCgroupRoot`), moves what runs in it to an `init` child, enables the controllers for that
cgroup's children, makes every sandbox's cgroup a child of it, and passes the parent as the OCI `cgroupsPath`
(`cgroupParent`). With a private cgroup namespace the own path is `/` and nothing changes (the golden spec test is
untouched). The boxd `probe` now also reads `memory.max` and `memory.current` of its own cgroup, which is the pod's
limit, not the node's.

Measured after the fix, same pod: the sandbox cgroup is `.../cri-containerd-<id>.scope/slaude-box-a`, `memory.max`
536870912 and `pids.max` apply, and the same 400 MB allocation moves the pod's `memory.current` by 306 MB (sandbox
cgroup 305 MB). The cpu limit holds at 1.03 cores. K6 passes. The change is covered by unit tests of the path
parsing and the spec; the live proof on the cluster is `scripts/spike/box/probe-cgroup-own.sh` and its result file.

Two things the fix needed that the cluster probe did not show, both found by re-running the gated suites in the
development VM (`scripts/smoke/box-smoke.sh`, 33 pass, 1 skip, 0 fail on each tier after the second fix):

- The cgroup path must be read **before** boxd moves itself into its `init` child. The first version read it again
  later, named `.../init`, made sandbox cgroups under a cgroup that still held processes, and runsc failed with
  `device or resource busy` on all 28 tests of each tier. It is read once now, and an `init` suffix left by an earlier run
  in the same cgroup (a restarted supervisor) is stripped.
- On a plain host the supervisor's cgroup must be delegated. A login session's scope is not, and boxd moves every process
  in its cgroup into the child, so it must never run there. A systemd unit needs `Delegate=yes` (the plain-host guide
  said the opposite and is corrected), and the smoke script starts itself in a fresh `systemd-run --scope -p
  Delegate=yes`. Containers (a pod, a Docker container) already have a cgroup of their own.

The nested stage of the smoke (a privileged Docker container, private cgroup namespace, the path is `/`) is the case
that must not change; it is re-run separately, see below.

## K2 on real nodes (the mini benchmark, 3 runs, medians in ms)

`scripts/spike/box/02-mini.sh`: a small repository and a many-small-files tree on the pod's disk. `plain` is runc.
This is smaller than the plan's Spike 2 (no `bun install`, no agent turn), so it supports the ratios and not the
kill criteria as written.

| Work | plain | C1 (the design) | C2 (exclusive mounts) | C5 (directfs off) |
|---|---|---|---|---|
| clone | 1359 | 4308 (3.2x) | 3771 (2.8x) | 13495 (9.9x) |
| git status | 246 | 1363 (5.5x) | 1167 (4.7x) | 3936 (16x) |
| git checkout | 499 | 2762 (5.5x) | 2238 (4.5x) | 9454 (19x) |
| 20,000 small files created | 685 | 2496 (3.6x) | 2366 (3.5x) | 5238 (7.6x) |
| find over them | 27 | 65 (2.4x) | 66 (2.4x) | 70 (2.6x) |
| delete them | 252 | 508 (2.0x) | 422 (1.7x) | 1752 (7x) |

The ratios match the VM (C1 clone 3.0x, git status 2.6x there, 5.5x here), so the VM was not flattering gVisor on
git. By the letter of K2b (more than 5 times and more than 2 s) `git status` is 5.5x but +1.1 s, so it does not
trip. The KVM platform ran (`/dev/kvm` is present) and was not faster on file work (clone 9.2 s against 4.3 s under
systrap; I trust the script's `PLATFORM` variable for that and did not confirm the platform from inside), as expected
for work bound by the gofer.

## Still open

- K2c: a real-model turn on runc and on gVisor, three runs each. Needs a model credential; none was used.
- The OAuth-token form behind the provider proxy against a real token.
- The release workflows and the tier-gated CI job have not run on a runner.
- The gated suites on the cluster itself (they need Docker for Redis, the mock model and the image build), and amd64 beyond Spike 1 (the runsc amd64 download matched its published
  checksum and ran here; the box image, box-init and the seccomp table on amd64 are still table-tested only).
