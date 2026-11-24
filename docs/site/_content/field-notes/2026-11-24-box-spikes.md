---
title: "Boxes, phase 0 spikes: what a dev VM shows about gVisor, the provider proxy and the agent inside, and what only the real cluster can"
date: 2026-11-24
---

# Boxes, phase 0 spikes: what a dev VM shows about gVisor, the provider proxy and the agent inside, and what only the real cluster can

**Date:** 2026-11-24
**Status:** Spikes 1 to 4 written and run on **a development VM on a Mac (host 1)**, plus Spike 1 and a small Spike 2 subset in a privileged container on the same VM (a host 2 stand-in). **Host 3, the owner's real cluster, was not run.** K1 is therefore **not proven**. No real model credential exists in this work: everything that talks to a model talks to a scripted fake.
**Plan:** `docs/superpowers/plans/2026-11-24-box-implementation.md`, Phase 0. **Spec:** `docs/superpowers/specs/2026-11-24-box-design.md`.
**Scripts and raw output:** `scripts/spike/box/` and `scripts/spike/box/results/`. Everything below is copied from those files; a number that is not in them is not here.

## Read this first

- This is a development host. A Mac VM is not the production cluster, and a verdict here is a verdict about this VM. The kill criteria say to decide on host 3's numbers; there are none yet.
- Spike 3 (the provider proxy) ran against a **fake provider**. It proves the plumbing and that the CLI accepts a placeholder credential in all three forms. It cannot prove how the real provider treats an OAuth-token request, or what extra requests the CLI makes with a real account.
- **K2c as written is exceeded** by the design configuration on this VM (see Spike 2). I did not turn that into a kill, because the scripted turn has a model with zero latency. That is a judgement for the owner, and the commands that decide it are at the end.
- The first benchmark run was thrown away: the synthetic mirror's `HEAD` pointed at a branch that did not exist, so `git clone` produced an empty tree and the clone, `git status` and `git log` rows measured nothing. The mirror, the scripts (each git step now asserts a real result) and every number below are from the rerun.

## The host

| Item | Value |
|---|---|
| Machine | Apple silicon Mac, macOS, Colima 0.9.1 (Lima), `vz` virtualisation, `virtiofs` host mounts (not used for any benchmark path) |
| VM | 4 vCPU (Apple), 7.9 GB RAM, Ubuntu 24.04.2 aarch64, kernel 6.8.0-64-generic, cgroup v2 (`cgroup2fs`) |
| Disk | virtio block device, ext4 root, 19 GB (benchmark data on the VM's own disk, never on a host mount) |
| KVM | **absent** (`/dev/kvm` does not exist); the only runsc platform tried is `systrap` |
| Container runtime | Docker 28.4.0 with runc 1.2.5, inside the VM |
| runsc | `release-20261116.0`, aarch64. Release tarball `gvisor.tar.zstd` sha256 `399835d261b2b08fa82fef9c907f44e9563a5bfec8a692a1704085b041bdc06d` (also verified against the published sha512); installed `runsc` binary sha256 `5234a347ba40766077cc65aa3883b88a3b1d589043447661acb9d713074aa04b`. This release also needs its `gvisor-bin/` directory next to the binary (`gvisor_sentry` and others); an install that copies only `runsc` fails with `sidecar "gvisor_sentry" not usable` |
| Tools in the VM | skopeo, umoci, bubblewrap, zstd, ripgrep, Go 1.22, Node 18, Bun 1.4.5 (VM), Claude Code CLI 2.1.173 (the native binary from the pinned SDK 0.3.173) |
| Toolchain image | Ubuntu 24.04 plus git, Node, npm, Go, Python, ripgrep, Bun, the CLI; 1.7 GB exported rootfs |

`scripts/spike/box/00-setup.sh` installs the above; `02-setup-bench.sh` builds the image and the offline fixtures.

## Spike 1: runsc nested in a privileged container

`01-run.sh` (raw: `results/01-run.vm-colima.txt` on the VM directly, `results/01-run.docker-privileged-2g.txt` in a privileged container with `--memory=2g` and a private cgroup namespace, the closest thing here to a node pod's boxd container). `probe-cgroup.sh`, `probe-load.sh`, `probe-erofs.sh` are the follow-ups. Flags used: `--platform systrap --network none --host-uds open --overlay2 root:dir=<dir>,size=<n>`.

| Check | VM directly | Privileged container | Notes |
|---|---|---|---|
| `run --detach` and `exec` | pass | pass | `id`, `df`, `mount` as expected; the root shows as a 9p mount |
| Bind mounts read-write, host sees writes and the reverse | pass | pass | the mount directories must be owned by the agent uid, because every capability is dropped (a root process without `CAP_DAC_OVERRIDE` cannot write a uid 1000 directory) |
| Root overlay, 1 GB written under `/usr/local` | host disk +1024 MB | +1024 MB | lands on the host disk under the `dir=` directory; the image directory is untouched |
| Overlay size limit (`size=256m`, write 400 MB) | `no space left on device` at 256 MB | same | |
| Two sandboxes, one image directory, two `dir=` values | isolated | isolated | writes in one are not visible in the other, and not in the image directory |
| After stop, the overlay directory | empty (1 MB) | empty | the backing file is created unlinked, nothing to clean up |
| `exec` stdio: `printf hello | cat` | pass | pass | 100 MB through `cat`: sha256 equal, 445 ms (VM), 257 ms (container) |
| Closing stdin ends `cat` | 20 ms | 10 ms | |
| Host Unix socket, `--host-uds=none` | **refused** | refused | `connection refused` |
| Host Unix socket, `--host-uds=open` | **pass** | pass | a listener on the host, bind mounted at `/run/slaude`, round trips bytes. The flag is `--host-uds` with values `none`, `open`, `create`, `all` (default `none`); read from `runsc flags`, not guessed. `open` is enough for connecting to an existing socket |
| Loopback with `--network none` | pass | pass | a listener on `127.0.0.1:3128` accepts a local connection; a dial to a public address fails with `network is unreachable` |
| Memory limit 512 MB, allocate 900 MB | killed at about 400 MB | same | **the whole sandbox stops** (state `stopped`), not one process in it |
| `pids` limit 64, fork loop | 17 forks, then `cannot allocate memory` | 17 forks | the limit counts **host threads of the sandbox**: an idle sandbox already holds 25 to 30 of them, so a nominal 64 left room for 17 processes (about 2 threads each) |
| CPU quota 1 core, 4 busy threads for 6 s | **1.01 to 1.03 cores** measured on the sandbox cgroup | 1.01 | the in-sandbox view reports `GOMAXPROCS=2` and 1.2 cores of CPU time, so measure on the host cgroup. The unlimited control used 3.6 cores |
| Start time, 20 runs, `run --detach` | median 28.5 ms, p95 44 ms | median 24.0 ms, p95 41 ms | |
| Start time, `run --detach` plus first `exec` returning | median **36.5 ms**, p95 59 ms | median 31.5 ms, p95 53 ms | sandbox start is not what the 20 s first-turn budget is spent on |

**cgroup placement and the container charge (K6).** runsc creates the sandbox's cgroup as `/<id>` under the root of the cgroup namespace it sees.

- On the VM directly (a systemd session), that is `/sys/fs/cgroup/<id>`, a **sibling** of the shell's scope. A 400 MB allocation in the sandbox moved the surrounding scope's `memory.current` by 2 MB and the sandbox's own cgroup by 303 MB. Nothing is charged to the caller.
- In a privileged container with a private cgroup namespace it is a **child of the container's cgroup**. The same allocation moved the container's `memory.current` by 406 MB. The sandbox's memory is charged to the boxd container, which is what the capacity model and the autoscale signal need.
- **It needs cgroup v2 delegation inside the container.** Without it, runsc fails at start with `cannot set up cgroup for root: ... write /sys/fs/cgroup/cgroup.subtree_control: device or resource busy` (cgroup v2 forbids enabling controllers for children while the container's own cgroup holds processes). The fix, in `lib.sh` as `cg_delegate`: move the container's processes into a child cgroup (`/init`) and write `+cpu +memory +pids +cpuset +io` to `cgroup.subtree_control`. A boxd entrypoint must do this before its first sandbox. With it, memory (512 MB), pids (64) and cpu (`100000 100000`) limits from the OCI spec land on the sandbox cgroup (`memory.max`, `pids.max`, `cpu.max` read back).

**Two spec findings that change the design text.**

1. `root.readonly: true` in the OCI config makes the root read-only **even with a root overlay**; every write failed with `read-only file system`. The bundle must say `readonly: false`; the image directory is protected by the overlay (verified: no leak into the image directory), not by the flag.
2. Killing the `runsc exec` client does **not** end the process inside. The client forwards `SIGTERM` into the sandbox, and the CLI took 54 s to exit with a 60 s tool call running. See Spike 4 for what works.

**Density (R6, K5).**

| Measurement | Value |
|---|---|
| Idle sandbox, sentry plus gofer, PSS summed | 38 MB for the first, about 10 MB each for ten (`01-run`) |
| Idle sandbox, cgroup `memory.current` | 8 to 10 MB (33 MB once on a cold page cache) |
| Sandbox plus the CLI started, no message yet | 140 MB cgroup, sentry plus gofer RSS 53 MB (`04-agent` density) |
| Sandbox plus the CLI idle after one turn | **151 MB** cgroup. The very first run, with the 248 MB CLI binary not yet in the page cache, charged 372 MB to its cgroup |
| Ten sandboxes at once, each with an idle CLI | 1505 MB summed by cgroup, **151 MB each**; the VM's used memory rose 1508 MB |
| During a clone, a warm `bun install` and an `npm ci` in one sandbox (`probe-load.sh`) | sentry plus gofer RSS peak **568 MB** (this includes the workload's own memory, which lives in the sentry's mapping, so it is not pure overhead); cgroup `memory.current` peak 2050 MB with the guest file cache; 1353 MB still charged once the work stopped |
| The same work under a 1024 MB memory limit | **completes**, `memory.current` capped at 1024 MB, 380 MB left afterwards: the file cache is reclaimed, not an OOM risk at that ceiling |

**Not run in Spike 1:** the platform `kvm` (no `/dev/kvm`); host 3 (the owner's cluster); a real node pod on `deploy/k8s-local` (no Kubernetes here). A privileged docker container is a stand-in, not the same thing: a pod's cgroup layout, its storage class and its node image differ. See "What the owner must still run".

## Spike 2: bind-mount I/O

`02-bench.sh` runs the workloads inside one long-lived sandbox (or container) per configuration with `exec`; timings are wall clock around each `exec`, so a command that is itself tiny carries about 20 ms (runsc) or 40 ms (docker exec) of exec overhead. Home and workspace are bind mounts of directories on the VM's ext4 disk. Fixtures: a synthetic 20,000-file git repository (22,973 files at `main`, 120 commits, two branches, generated by the script, not a public repository), a Bun and npm project of about 660 and 690 packages (a smaller tree than the plan's 1,000), numpy wheels, Go module cache, `golang.org/x/tools` v0.21.0. **Runs: 3 per workload (2 for `go build`), not 5.** The first run of each follows a host page-cache drop; the later runs are warm. Median in ms, the runs in brackets. C0 is runc through Docker with the same bind mounts and `--network none`. Raw: `results/02-bench.<cfg>.tsv`; the table is `python3 scripts/spike/box/02-summary.py`.

| Workload | C0 runc | C1 runsc (the design) | C2 exclusive file access | C5 `--directfs=false` |
|---|---|---|---|---|
| `git clone` (local mirror, 22,973 files) | 1042 (1042/1194/842) | 3135 (3570/3135/2885) | 2094 (1938/2094/3455) | 17289 (17277/17289/18447) |
| `git status` | 286 (187/286/402) | 737 (737/780/690) | 401 (401/347/487) | 5738 (7251/5108/5738) |
| `git log -100 --stat` | 116 | 169 | 126 | 1087 |
| `git checkout` (two switches) | 319 | 1282 | 1031 | 13025 |
| `rg` over the tree | 163 | 1322 | 768 | 10220 |
| `bun install` warm cache | 688 (1861/688/644) | 2933 (5028/2202/2933) | 2410 (3378/1763/2410) | 18171 (18171/13389/28116) |
| `npm ci` warm cache, offline | 10738 | 15245 | 11952 | 24851 |
| `pip install numpy` into a venv, offline | 4197 | 6575 | 5322 | 9813 |
| `bun test`, 5 tiny files | 58 | 25 | 23 | 72 |
| create 20,000 small files | 422 | 1307 | 1173 | 5098 |
| `find` and `du` over them | 105 | 246 | 224 | 4563 |
| delete them | 201 | 288 | 276 | 3330 |
| Python stdlib import set (root reads) | 121 | 135 | 128 | 191 |
| Node builtin modules (root reads) | 188 | 180 | 176 | 206 |
| `claude --version` (a 248 MB binary from the root) | 164 | 189 | 210 | 395 |
| CLI boot, one plain turn against the fake API | 505 (708/475/505) | 574 (661/574/550) | 593 (853/593/553) | 645 |
| Scripted agent turn, 10 tool calls (Bash, Read, Write, Edit, `bun test`) | 672 (707/571/672) | 1631 (1631/2158/1438) | 1162 (1726/1129/1162) | 1064 (1064/1015/1303) |
| `go build ./...` of x/tools, empty build cache, 2 runs | 9010 (14517/3504) | 26645 (29894/23396) | 30328 | 33454 |

| Configuration | Result |
|---|---|
| C3 EROFS root | **not run.** The image mounts only if built uncompressed (a `-zlz4hc` image is refused: `unsupported incompatible features detected: 0x1`; that first attempt's output was not kept). Mounted, **every `exec` of a file on it fails** with `failed to load <path>: bad address` on this runsc build and arch, whatever the overlay medium (`results/02b-erofs.txt`). Also `dev.gvisor.spec.rootfs.overlay` takes only the medium (`dir=...`), not `root:dir=...`, and a default `--overlay2 root:self` panics if the annotation is `dir=` and the flag is absent |
| C4 KVM platform | **not run**, no `/dev/kvm` |
| Cold-cache `bun install` | **not run**: a sandbox has no network by design, and the offline caches exist only warm |
| `uv sync` | **not run** (`pip` stood in) |
| `apt-get install ffmpeg` from a local mirror | **not run** (no local apt mirror was built) |
| One real agent turn against a real model, C0 and C1, three runs | **not run**: no credential exists |

**Host writes into a live workspace (the C2 question).** `02c-coherence.txt`: with the default shared mode the sandbox sees a new file, a removed file, a size change and an in-place rewrite made on the host at once and after 5 s. With `--file-access-mounts=exclusive` it sees **none**: the new file stays invisible, the removed file stays present, the size stays stale, and five seconds later nothing has healed. `drainInbox` writes into a live workspace, so **C2 is not usable** unless those writes move to times the sandbox is stopped. (A weaker first check of one small file did not show this; the adversarial one did.)

**What the numbers say.**

- The slowdown is real and concentrated in metadata and small-file work through the gofer: `rg` 8x, `git clone` 3x, creating 20,000 files 3.1x, `bun install` 4.3x. Absolute deltas are modest on this fixture (a warm `bun install` costs 2.2 s more; a `git status` on 23,000 files 0.45 s more). Reads of the toolchain from the root are at parity (`python` imports, `node` start), so the EROFS idea would not have bought much even if it ran.
- `directfs` is worth a lot: switching it off (C5) is 5x to 60x worse on file work. Keep the default.
- C2 is 1.2x to 1.8x faster than C1 on the heavy file rows and is not usable (above).
- The scripted turn is 2.4x slower on C1 (+959 ms over ten tool calls, roughly 100 ms per tool call, mostly process creation inside the sandbox) and 1.7x on C2. The model in that turn has **zero latency**.

## Host 2 stand-in: the same checks and a small comparison, nested in a privileged container

`host3-bootstrap.sh` (the script the owner runs on host 3) was run in a fresh `ubuntu:24.04` container on the dev VM: `--privileged --cgroupns=private --memory=8g`, runsc installed by the script from the pinned release with a checksum check, a Debian image from the registry for Spike 1 and `node:22-bookworm` for the comparison. Label `host2-docker`; raw: `results/01-run.host2-docker.txt`, `01b-cgroup.host2-docker.txt`, `02-mini.host2-docker.tsv`. It shows that the script works end to end, not that a pod works.

- Spike 1: every check passes except `host-uds-none` (the expected refusal). Start time median 21.5 ms, 29.0 ms with the first `exec` (p95 40 ms). A 400 MB allocation moved the container's `memory.current` by 405 MB.
- `02-mini.sh`, median ms of 3 runs, the 22,973-file synthetic repository on the same volume. "plain" is the same command run directly in the container, the only baseline a pod has (there is no runc inside a pod).

| Workload | plain | C1 | C2 | C5 |
|---|---|---|---|---|
| `git clone` | 836 | 2334 | 2157 | 24065 |
| `git status` | 186 | 835 | 597 | 5307 |
| `git log -100 --stat` | 62 | 150 | 142 | 1086 |
| `git checkout` (two switches) | 323 | 1123 | 900 | 13404 |
| create 20,000 small files | 288 | 1018 | 995 | 5203 |
| `find` over them | 15 | 38 | 37 | 39 |
| delete them | 143 | 295 | 268 | 3404 |

C1 is 2.8x to 4.5x the plain run on the git and file-creation rows, in line with the C1 and C0 numbers above (this run is a different VM load and baseline). `git status` at 4.5x, +649 ms, is under the K2b kill line (5x and 2 s).

## Spike 3: the provider proxy

`03-provider.ts` (raw: `results/03-provider.vm-colima.json`, and `...-nonessential.json`; `lib/servers.ts` has the fake upstream, the proxy and an egress proxy). A fake provider that accepts **only** the real credential for the form under test; a reverse proxy on a Unix socket that strips `x-api-key` and `authorization`, adds the real credential, streams, refuses redirects; `box-probe init` as PID 1 of the sandbox relays `127.0.0.1:3129` and `:3128` to the sockets; `ANTHROPIC_BASE_URL=http://127.0.0.1:3129`; the real `claude` binary inside with a **placeholder** in the credential variable. gVisor `--network none`, empty egress allowlist.

| Case | Form A (`ANTHROPIC_API_KEY`) | Form B (`ANTHROPIC_AUTH_TOKEN`) | Form C (`CLAUDE_CODE_OAUTH_TOKEN`) |
|---|---|---|---|
| Streaming turn (7 stream events) | pass, 3060 ms | pass, 1377 ms | pass, 1647 ms |
| Tool loop (three Bash calls) | pass | pass | pass |
| Extended thinking block | pass | pass | pass |
| Subagent (Task tool) | pass | pass | pass |
| Resume from the bind-mounted transcript | pass, same session | pass | pass |
| Compaction (`/compact`) | pass (`compact_boundary` written to the transcript) | pass | pass |
| Token rotation without restarting the sandbox | pass | pass | pass |
| The real credential absent from the box: process environment and arguments, home, workspace, run directory, the overlay file, every CLI output | pass | pass | pass |
| The placeholder never reaches the upstream (17 requests each) | pass | pass | pass |
| Header carrying the inbound credential | `x-api-key` | `authorization` | `authorization` |
| Every request the CLI made to the base URL | `POST /v1/messages` only | same | same |

- **No local validation of the credential's shape**: a `sk-ant-oat01-` placeholder and a free-form placeholder were both accepted by the CLI.
- **Requests that bypass the base URL.** With the egress proxy's allowlist empty, the CLI made `CONNECT api.anthropic.com:443` attempts: 36 over the whole form A run, 14 form B, 21 form C. They are refused and the turn does not fail. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the count is **0** for forms A and C. That setting also removed five small side requests per run that went through `/v1/messages` (a short text request the CLI makes besides the turn; I did not identify them further). Recommendation: set it in the box environment.
- **What this does not show.** The upstream was a script. The real provider's treatment of an OAuth-token request (server-side validation, the headers it expects, refresh behaviour, any account lookup) is untested. A form C persona is not safe to call boxable on this evidence alone; it needs one run with a real token behind the proxy, which only the owner can supply.

## Spike 4: the agent inside

`04-agent.ts` drives the Agent SDK 0.3.173 with a `spawnClaudeCodeProcess` that runs `runsc exec` with piped stdio. Home and workspace are bind mounted at the **same path** inside and outside; the plugin directory is a read-only bind mount. Raw: `results/04-agent.vm-colima.json` and the two follow-up files.

| Case | Result |
|---|---|
| Tool loop | pass, 703 ms |
| `PreToolUse` hook that denies | pass: hook called once, the command did not run |
| `canUseTool` allow / deny | pass / pass: asked once each, the command ran only on allow |
| In-process MCP server created with the SDK | pass: handler called once, result returned |
| Credential-free **stdio** MCP server declared in the options | pass: starts inside the sandbox, status `connected`, the tool result is in the transcript |
| Plugin skill from a read-only mount | pass: `spike:spike-skill` is in the init message; a write to the mount fails with `Permission denied` |
| Plugin command hook script | pass: ran as uid 1000 inside |
| Resume with the transcript at the identical path | pass: one model request, history loaded, transcript at `<home>/.claude/projects/<cwd encoded>/<session>.jsonl` on both sides |
| Abort mid-turn, **killing only the `exec` client** | **fail**: the query ended 55 s after the abort (when the 60 s tool call finished) |
| Abort, plus `runsc kill --pid <internal pid>` | **fail**: the CLI exits in 2.2 s, but the tool's child (`sleep`) is left running in the sandbox |
| Abort with `exec --new-pidns` plus `runsc kill --pid <internal pid>` (`--internal-pid-file`) | **pass**: the query ends 2.2 s after the abort (the SDK's own grace window) and nothing is left in the sandbox |
| Proxy relay and tools, allowlist empty | `curl` and `git clone` fail with `CONNECT tunnel failed, response 403`; `npm view` with `403 on a server you do not have access to`; `go mod download` with `Forbidden`; **`pip download` with `Could not find a version that satisfies the requirement six (from versions: none)`**, which an agent would misread as a missing package. Every attempt appears in the proxy log (example.com, github.com, registry.npmjs.org, pypi.org, proxy.golang.org) |
| Proxy relay, allowlist with the code host and registries | pass: `curl` 200, `git clone`, `npm view`, `pip download`, `go mod download` all complete; the log shows `CONNECT` for each host including `files.pythonhosted.org` and `sum.golang.org` |
| The 403 body | **no tool shows it**: the explanatory text the proxy sends in the 403 body (`not on this persona's allowlist`) never reaches the agent, because clients drop the body of a failed `CONNECT`. The explanation has to come from elsewhere (the system prompt, or an environment variable and a note), not from the proxy's response |
| Pack round trip, a home of 50,020 files (417 MB, about 100 MB incompressible) with `tar` plus `zstd -T0`, extracted after a cache drop on the same VM and disk | level 1: create 1.4 s, 166.5 MB, extract 2.2 s; level 3: create 5.2 s, 163.6 MB, extract 1.4 s; a hash sample of the tree identical. This is system `tar`; the production packer is the TypeScript one, whose own numbers are in the pack-units note |

The "naive" abort row says PASS in `04-agent.vm-colima.json` because that run only counted leftover processes; the criterion was then tightened (the query must also end within 10 s) and `04-agent.vm-colima-abort-density.json` has the corrected FAIL.

**Not run in Spike 4:** the spike cases of `tests/spike/sdk-cases.ts` as such (the SDK behaviours they pin were re-created against the sandbox in `04-agent.ts`: hook deny, `canUseTool`, abort, resume, in-process MCP); a real model; the pack round trip "on another host".

## Decisions per kill criterion

All on the dev VM; **K1 and anything that depends on the cluster is not proven.**

| # | Verdict on this VM | Evidence, and what is missing |
|---|---|---|
| K1 | **Not proven.** Pass in a privileged container on the dev VM (needs the cgroup delegation step) | Spike 1 passes every check in a privileged docker container. Host 3 not run; no k8s here |
| K2a warm `bun install` | pass for C1 (4.26x, +2.2 s, below the 20 s clause); C2 3.5x; C5 26x, +17.5 s (still passes the letter) | |
| K2b `git status` on 20,000 files | pass for C1 (2.58x, +451 ms) and C2; **kill for C5** (20x, +5.5 s) | |
| K2c scripted agent turn | **exceeded by the letter**: C1 2.43x (+959 ms), C2 1.73x, C5 1.58x | the turn has a zero-latency model. The plan's own companion check, a real turn against a real model, is not run. Overhead per tool call is about 100 ms; against ten model round trips of several seconds each that is a few percent of a turn (an estimate, not a measurement) |
| K2d CLI boot | pass: +69 ms (C1), +88 ms (C2) | |
| K3 forms A, B | pass against a fake provider | real provider not exercised |
| K3 form C | pass against a fake provider, **not established** against a real one | needs one run with a real OAuth token behind the proxy |
| K4 agent over `exec` stdio | pass for every case, with a required spawn design: `--new-pidns` plus an explicit `runsc kill --pid` | the relay fallback is not needed |
| K5 density | pass: idle sandbox 10 MB, with an idle CLI 151 MB warm, 372 MB when the image's binaries are cold, both under 400 MB | 90 idle sessions would fit a 16 GB container by this number; that is arithmetic, not a measurement |
| K6 memory charged and limits | pass in a privileged container **with cgroup v2 delegation**; not true without it, and not proven nested in a pod | |

## Configuration chosen, defaults, and the rung

- **Configuration:** C1, as designed: runsc `systrap`, image directory with `root:dir=<session>/overlay,size=<n>` overlay, bind mounts in shared mode, directfs on, `--network none`, `--host-uds=open`, `root.readonly=false` in the bundle, every capability dropped, agent uid owning the mounts. C2 is unusable (incoherent with host writes), C3 does not run on this build, C4 needs KVM, C5 is far worse.
- **`SLAUDE_BOX_SANDBOX_OVERHEAD_MB`: keep 150.** Idle sentry plus gofer is 10 to 40 MB, but the same processes peaked at 568 MB RSS during file-heavy work and part of that is the workload's own memory, which I could not separate. A number below 150 would be a guess; the idle CLI (about 150 MB) is the box's own, covered by `memoryReserveMb`.
- **`SLAUDE_NODE_MAX_BOXES`: keep 8.** Memory is not the limit: at 1174 MB reserved per default box, a 16 GiB container holds 11 by memory. CPU saturation with many active sandboxes was not measured (4 vCPU here).
- Other numbers the spec can use: sandbox start 30 to 60 ms, so a pre-started pool buys nothing; the `pids` limit counts host threads: budget about 2 per process plus 30 for the sandbox itself; a 100 MB-class pack extracts in about 2 s.
- **Fallback ladder.** By the letter, rung 1 (tune within gVisor) finds no configuration that passes all of K2 and rung 2 (`bwrap` as production) would follow, because K2c fails everywhere. **I do not recommend moving the architecture on that number.** K2c's zero-latency turn overstates the cost, the real-model turn that the plan pairs it with has not been run, and the dev VM is not the cluster. Recommended: stay on gVisor C1 as the working assumption, treat `bwrap` (Phase 10) as the live contingency, and decide on host 3 plus one real-model turn. If the owner reads K2c strictly, Phases 1, 3 and 5 are unaffected and Phase 10 moves ahead of Phase 2's gVisor driver.

## What changes in the design

- boxd's entrypoint must do the cgroup v2 delegation (`/init`, `+memory +pids +cpu`) before it starts a sandbox, or runsc will not start; `boxd` refuses to start when `cgroup.subtree_control` cannot be written.
- The OCI bundle sets `root.readonly: false`; the image is protected by the overlay.
- The mount directories belong to the agent uid; the sandbox PID 1 is `box-init` and runs both relays.
- The CLI is spawned with `runsc exec --new-pidns --internal-pid-file` and ended with `runsc kill --pid`; never by killing the `exec` client.
- The box environment sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- The proxy's 403 text is invisible to tools; the egress explanation goes in the system prompt, and `pip`'s message in particular is misleading.
- The per-box `pids` limit counts host threads of the sandbox.

## What the owner must still run

Host 3 is a privileged pod on the kind of cluster production uses, with the node Deployment's node pool, memory limit and volume type. A pod spec and a bootstrap script exist and were exercised end to end in a privileged docker container on the dev VM (label `host2-docker`, results below); they have **not** been run on a cluster.

```sh
# 1. a privileged pod (edit nodeSelector, tolerations, resources and the volume to match the node Deployment)
kubectl apply -f scripts/spike/box/host3-pod.yaml
kubectl wait --for=condition=Ready pod/box-spike --timeout=120s
# 2. copy the spike directory in and run it: runsc install (pinned, checksum checked), Spike 1, the cgroup follow-up,
#    and the small Spike 2 comparison (plain pod vs runsc C1, C2, C5 on the same volume); about 15 minutes
kubectl cp scripts/spike/box box-spike:/spike
kubectl exec box-spike -- env LABEL=host3 bash /spike/host3-bootstrap.sh
# 3. bring the results back and paste them next to the dev-VM ones
kubectl cp box-spike:/spike/results scripts/spike/box/results-host3
```

K1 passes on host 3 when `01-run.host3.txt` shows no FAIL other than `host-uds-none` (which is expected to fail) and `01b-cgroup.host3.txt` shows the surrounding cgroup's `memory.current` rising by about the allocation. If runsc cannot start there, record the exact error: that is rung 2.

Two things need a credential or hardware this work did not have, and only the owner can run them:

1. **One real turn per credential form behind the provider proxy** (form C first): point `03-provider.ts`'s proxy at the real provider with a real token held on the host side and run the same cases. This decides whether OAuth-token personas are boxable (the plan's gate summary must say so in those words).
2. **The real-model turn that K2c is paired with**: "clone this repo, install, run the tests", three runs each, on C0 and C1 (`02-bench.sh` shows how to set up both). If C1 is within 25 percent of C0 there, K2c is met in the sense the plan meant.

If the cluster's machines have `/dev/kvm`, run `02-bench.sh C4` there; it is the only configuration left that could beat C1.
