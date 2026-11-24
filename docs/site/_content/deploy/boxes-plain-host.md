---
title: Boxes on a plain host
description: Run the box supervisor and a node worker as systemd services on one Linux machine, without Kubernetes. What to install, the two units, the capacity settings, and what has not been run.
---

# Boxes on a plain host

> **Status: written, not run.** The units on this page have not been installed
> on any machine. What has run is the same supervisor and node worker started
> by hand as root processes on a development VM (Ubuntu 24.04, aarch64), by
> `scripts/smoke/box-smoke.sh`: see the
> [2026-11-25 box smoke note](../field-notes/2026-11-25-box-smoke.md). Treat
> this page as a starting point to check line by line, not as a tested recipe.
> Boxes themselves are in development and off by default: read
> [Boxes](boxes.md) first.

A node pod on Kubernetes has two containers: the node worker, and the box
supervisor (`boxd`), which is privileged and holds no secret. On a plain host
they are two systemd services on the same machine. Everything else is the
same: the same control socket, the same box directory, the same capacity
settings.

This page covers the node side only. The gateway, Postgres and Redis are set
up as in [Multi-node scale-out](multi-node.md); boxes exist only where turns
go to node workers through the queue.

## What the host needs

- Linux with cgroup v2 mounted at `/sys/fs/cgroup`. The development VM ran
  kernel 6.8; no older kernel was tried.
- Root, for the supervisor.
- Bun, and a checkout or release of slaude (below: `/opt/slaude`).
- `runsc` for the `gvisor` tier, or `bubblewrap` for the `bwrap` tier.
- `skopeo` and `umoci` (the node worker pulls and unpacks box images with
  them), `zstd`, and `tini`.

```sh
sudo apt-get update
sudo apt-get install -y bubblewrap skopeo umoci zstd tini curl gnupg
```

### runsc from the gVisor apt repository

```sh
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update
sudo apt-get install -y runsc
runsc --version
```

The package installs `runsc` together with the helper programs it needs
beside it. The release the smoke test ran is `release-20261116.0`, which is
also the one the container image pins; the apt repository's `release` channel
serves the newest one, so note the version you get. A newer release has not
been run here.

### box-init

The first process of every box is a small program, compiled once and kept
alone in its own directory (the supervisor mounts the directory, not the
file):

```sh
sudo mkdir -p /usr/local/lib/slaude-box
cd /opt/slaude
sudo bun build --compile src/box/init/main.ts --outfile /usr/local/lib/slaude-box/box-init
```

### Directories

| Path | What | Who writes it |
|---|---|---|
| `/var/lib/slaude-box` (`SLAUDE_BOX_DIR`) | Unpacked images, each session's home and root overlay, scratch directories, parked sessions, the pack spool | the supervisor and the node worker |
| `/run/slaude-box/boxd.sock` (`SLAUDE_BOXD_SOCKET`) | The supervisor's control socket, mode 0600 | the supervisor |
| `$SLAUDE_HOME` | Workspaces (bind mounted into boxes at the same path) | the node worker |
| The node's config root (`SLAUDE_NODE_CONFIG_ROOT`, default `/config-home`) | Each session's config directory | the node worker |

```sh
sudo mkdir -p /var/lib/slaude-box /config-home
```

Put `/var/lib/slaude-box` on a disk with room for the image budget, the live
sessions and the parked ones (the sizing rule in
[Scale operations](scale-operations.md) gives the arithmetic). A node refuses
to start a sandbox with under 1 GB free there.

## Who runs as whom

- **The supervisor runs as root.** It creates cgroups and sandboxes. It
  refuses to start without root.
- **The node worker runs as root too**, or, on the `gvisor` tier only, as uid
  10001 (the uid a box's agent runs as). The reason: the sandbox's user must
  own what it writes, and the node worker reads and writes the same workspace,
  config directory and scratch directory. A worker under any other uid is not
  supported. On the `bwrap` tier a box's files are root's on the host's disk,
  so the worker must be root.
- When the worker is not root, tell the supervisor its uid with
  `SLAUDE_BOXD_CLIENT_UID`, so the control socket is handed to it. **A node
  worker that is not root has not been run at all**; the units below run both
  as root, which is the arrangement that was exercised.

Running the node worker as root means every UNBOXED session on this machine
runs its tools as root. If this host also serves personas that are not boxed,
weigh that, or keep unboxed personas on another node label.

## The supervisor unit

`/etc/systemd/system/slaude-boxd.service`:

```ini
[Unit]
Description=slaude box supervisor (boxd)
After=local-fs.target

[Service]
User=root
WorkingDirectory=/opt/slaude
# A clean environment, stated here and nowhere else. NO EnvironmentFile: the
# supervisor is privileged and must hold no credential. It refuses to start
# when its environment carries a provider key, the node token, the Redis URL
# or an object store setting, and names the variable (never the value).
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=SLAUDE_BOX_TIER=gvisor
Environment=SLAUDE_BOX_DIR=/var/lib/slaude-box
Environment=SLAUDE_BOXD_SOCKET=/run/slaude-box/boxd.sock
RuntimeDirectory=slaude-box
RuntimeDirectoryMode=0700
# tini -s: a subreaper in front of the supervisor. Ended sandbox processes are
# left for an init to reap, and the supervisor is not one. --no-env-file: bun
# reads no dotenv file. The mount roots are the directories a box may be given
# read-write; the read-only root is the slaude checkout (the CLI and the
# built-in plugins).
ExecStart=/usr/bin/tini -s -- /usr/local/bin/bun --no-env-file src/box/boxd/main.ts \
  --mount-root /var/lib/slaude --mount-root /config-home --ro-root /opt/slaude
KillMode=mixed
TimeoutStopSec=60
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `/var/lib/slaude` with your `$SLAUDE_HOME`, and the paths to `tini`
and `bun` with where they are on your host.

Why `tini -s` here when the container command is plain `tini --`: in a
container tini is pid 1 and reaps by position. Under systemd it is not pid 1,
so it has to register as a subreaper to do the same job. On the `bwrap` tier a
supervisor with no init in front of it was measured to keep one zombie per
process a box ran. This `-s` arrangement under systemd is the part of this
page least covered by what was run.

Things that differ from a pod, by how the supervisor works:

- **Sandbox cgroups are created at the top of the host's cgroup tree**
  (`/sys/fs/cgroup/slaude-box-*`), not inside the unit's own cgroup. A
  `MemoryMax=` on this unit therefore does not bound the boxes. Each box still
  has its own memory, CPU and process limits.
- **The supervisor has no memory limit to read**, because the top of the tree
  has none. So the node cannot derive its memory budget: set
  `SLAUDE_BOX_MEMORY_BUDGET_MB` on the node worker (below). The node says so at
  start, and the pressure rule (park idle sessions above 90 percent of the
  limit) does not run on a plain host. Size the budget for the machine
  yourself, leaving room for everything else it runs.

## The node worker unit

`/etc/systemd/system/slaude-node.service`:

```ini
[Unit]
Description=slaude node worker
After=network-online.target slaude-boxd.service
Requires=slaude-boxd.service

[Service]
User=root
WorkingDirectory=/opt/slaude
# The node's own settings and credentials (SLAUDE_NODE_TOKEN, SLAUDE_REDIS_URL,
# SLAUDE_GATEWAY_URL, the object store settings). Mode 0600, root's. Never the
# gateway's file: a node refuses to boot holding a gateway-only variable.
EnvironmentFile=/etc/slaude/node.env
Environment=SLAUDE_ROLE=node
Environment=SLAUDE_HOME=/var/lib/slaude
Environment=SLAUDE_NODE_CONFIG_ROOT=/config-home
Environment=SLAUDE_BOX_TIER=gvisor
Environment=SLAUDE_BOX_DIR=/var/lib/slaude-box
Environment=SLAUDE_BOXD_SOCKET=/run/slaude-box/boxd.sock
# Capacity. See "Capacity settings" below.
Environment=SLAUDE_NODE_MAX_BOXES=4
Environment=SLAUDE_BOX_MEMORY_BUDGET_MB=5120
ExecStart=/usr/local/bin/bun --no-env-file src/node/main.ts
# The drain: the worker finishes its turns, then flushes and stops every warm
# box. Longer than SLAUDE_NODE_DRAIN_SEC (default 120) plus the flushes.
TimeoutStopSec=300
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The node entry is executed directly (`bun --no-env-file src/node/main.ts`),
never through `bun run`: a parent process would hold the node token.

`SLAUDE_BOX_TIER`, `SLAUDE_BOX_DIR` and `SLAUDE_BOXD_SOCKET` must be the same
in both units. A node on a sandbox tier whose supervisor does not answer
refuses to start; it never runs a boxed session on the host itself.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now slaude-boxd slaude-node
journalctl -u slaude-boxd -n 20    # "[boxd] listening on /run/slaude-box/boxd.sock (tier gvisor, ...)"
journalctl -u slaude-node -n 40    # "[node] boxes: tier gvisor, at most 4 at once, ..."
```

On the gateway, `SLAUDE_BOX=on` makes it read boxes; a persona runs in one
once it names a box (see [Boxes](boxes.md), "The opt-in checklist").

## Capacity settings

All on the node worker. The node checks them once at start and refuses to
start when the machine cannot hold what it is configured for, naming the
numbers.

| Variable | Default | On a plain host |
|---|---|---|
| `SLAUDE_NODE_MAX_BOXES` | 8 | The most sandboxes at once. Each needs its reserve (a third of the box's memory ceiling, 1024 MB for the default box) plus the overhead |
| `SLAUDE_BOX_MEMORY_BUDGET_MB` | derived from the supervisor's memory limit | **Set it**: there is no limit to derive it from. At least `MAX_BOXES x (reserve + overhead)`: 4 boxes need 4 x (1024 + 150) = 4696 MB |
| `SLAUDE_BOX_SANDBOX_OVERHEAD_MB` | 150 | Added to each box's reserve for the sandbox's own processes |
| `SLAUDE_BOX_IMAGE_BUDGET_MB` | 15360 | Disk for unpacked box images |
| `SLAUDE_BOX_PARK_BUDGET_MB` | half the box volume, or what is left after images and live sessions | Disk for the local copies of idle sessions |
| `SLAUDE_BOX_PRESSURE_IDLE_SEC` | 60 | Has no effect without a memory limit to read |

Memory is overcommitted on purpose: a box may use up to its ceiling (3072 MB
for the default box) while only its reserve is set aside. With no pressure
rule on a plain host, nothing parks idle sessions when the machine runs short;
the kernel's out-of-memory killer is what is left. Choose the budget with that
in mind.

## The bwrap tier

Set `SLAUDE_BOX_TIER=bwrap` in both units. What differs, measured on the
development VM:

- The kernel is shared with the host. A short system call deny list is loaded;
  it is not an allow list.
- Ubuntu 24.04 refuses unprivileged user namespaces, so the supervisor runs
  bwrap as root with a mapped user namespace. A box's files are root's on the
  host's disk, and the node worker must be root.
- The root overlay has no size limit of its own.

## What has not been run

- These units, on any host. The supervisor and the node worker were started by
  a test as root processes, never by systemd.
- `tini -s` in front of the supervisor under systemd.
- A node worker that is not root.
- runsc installed from the apt repository (the smoke test used the release
  archive, the same binaries by another route), and any release newer than
  `release-20261116.0`.
- amd64. Everything ran on aarch64.
- A real model and a real provider credential: the smoke test used a mock
  model.
- A home that follows its session to another machine (`SLAUDE_STORAGE=s3`)
  from a plain host.
