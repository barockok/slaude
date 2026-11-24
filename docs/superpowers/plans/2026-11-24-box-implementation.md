# Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan phase by phase. Steps use checkbox (`- [ ]`) syntax for tracking. Phase 0 is a gate: do not start Phase 2 or later until its results are written down and the owner has read them. Phases 2 onward are specified at file level, not step level, on purpose: their details depend on what Phase 0 measures, and each gets its own task breakdown when it starts.

**Goal:** A node becomes a generic host, and each agent session runs in its own sandbox (a box) inside the node pod, built from a reviewed OCI image, with no secret of any kind, a refuse-by-default network, and a durable home and workspace.

**Architecture:** The Agent SDK's `spawnClaudeCodeProcess` hook starts the CLI inside a sandbox behind a `SessionSandbox` interface (tiers `none`, `bwrap`, `gvisor`). A privileged, credential-free supervisor container (boxd) in the node pod runs gVisor on a read-only image with a throwaway root overlay, and bind mounts the session's home, workspace, config and scratch directories. The node worker keeps every credential, runs a per-session egress proxy and a provider proxy on Unix sockets, admits boxes against a per-pod capacity, and syncs two new packed units (`hm`, `wx`) through the existing `FsSync` fencing. Boxes are defined in the deploy repo, built by CI, stored and signed by the gateway, pinned per session by digest.

**Tech Stack:** Bun 1.3, TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.173, ioredis and BullMQ, the `ObjectStore` seam (`src/storage/object-store.ts`), bun:test; on nodes: runsc (gVisor), GNU tar and zstd, skopeo and umoci (replaceable); KEDA or the HPA for scaling.

**Spec:** `docs/superpowers/specs/2026-11-24-box-design.md`

## Owner decisions this plan implements

1. Boxes run inside the node pod through a privileged boxd sidecar. No pod per session. Scaling follows the node pod.
2. Durable: home, workspace, transcript, workspace extras. The root filesystem is thrown away; a runtime `apt install` is not durable.
3. Up to about 20 s on the first turn after idle is acceptable. Local copies stay on node disk after idle (parking). No pre-started sandbox pool.
4. No secret in a box, in any form. The provider proxy must cover every credential form; a form it cannot cover makes the persona not boxable.
5. Egress is refuse by default and changes only through the deploy repo. No runtime approval.
6. Opt in per persona. Tier `none` stays supported. No forced migration.
7. No secret-backed access from a box to a named host. Private code goes through a gateway-side MCP server for the code host, or the persona stays unboxed. The provider proxy is the only credential-adding route.
8. Memory overcommit: a box reserves about a third of its memory ceiling by default (`memoryReserveMb`), with the pressure rule as the safety.

## Global Constraints

- Public repo: no deployment names, people, channel ids or registry names of a real organisation in code, tests, docs or commit messages. Use `ghcr.io/example/...` and generic fixtures.
- No `Co-Authored-By` trailer; one logical change per commit; `git config core.hooksPath .githooks` once per clone.
- Before every `git add`: scratch scan, then the leak scan from CLAUDE.md over `git diff --cached -U0`.
- No emoji and no em-dashes in any written output.
- **The environment feature is out of scope.** Do not edit `src/remote/`, `src/gateway/core/env-command.ts`, `src/gateway/core/env-form.ts`, `src/gateway/api/remote-env.ts`, `src/gateway/api/remote-key.ts`, the `environment` key in `src/persona/agent-schema.ts`, or `SHARED_ENV_CAPABILITY`. A guard test (Phase 1) fails if `src/box/` imports from `src/remote/` or the reverse.
- **No secret in a box.** No code path may place a credential in a box's environment, its config directory, its home or its arguments. There is no escape hatch flag. A test in every phase that builds a box environment asserts it.
- **A failure to start a box never becomes an unboxed run.**
- Every phase ships dark: `SLAUDE_BOX=off` on the gateway and `SLAUDE_BOX_TIER=none` on nodes are the defaults through the last phase. With both at their defaults the full existing suite (`bun test`, `bun run test:pg`, the sim, `scripts/e2e-ha.sh`) must pass unchanged at the end of every phase.
- The agent loop and the DB schema are touched: releases that carry Phases 1, 3 and 5 go out as release candidates (CLAUDE.md, "Release candidates").
- Gates after every task: `bun run typecheck` and the task's tests. Redis-gated suites use `SLAUDE_REDIS_TEST_URL` against a throwaway `redis:7-alpine`.
- Tests that need Linux, root or runsc are gated on `SLAUDE_BOX_TEST_TIER=gvisor|bwrap` and skipped otherwise, like the Redis-gated suites. They run in a dedicated CI job.
- Never report a spike or benchmark result that was not run. A script that has not been executed is labelled "not run" where it is written down.

## Review Focus

- A boxed spawn's environment, built from a node environment that holds every name in `PROVIDER_ENV_KEYS`, every gateway-only name, `SLAUDE_NODE_TOKEN`, `SLAUDE_REDIS_URL` and `SLAUDE_S3_*`, contains none of their values: only placeholders for the provider form.
- A boxed session's config directory never contains `.credentials.json`; the sandbox start refuses one.
- The provider proxy never returns the real credential in a response, an error or a redirect, and forwards to one host only.
- boxd refuses any path outside `SLAUDE_BOX_DIR` and the declared mount roots, and refuses to start with a credential in its environment.
- Pack apply with hostile archives: `..`, absolute paths, a symlink in layer 1 used as a directory in layer 2, device nodes, set-uid files, a path changing type between layers.
- A fenced `hm` or `wx` flush stops the sandbox and discards the local copy; it never commits.
- A session pinned to digest A never runs on digest B without a refresh row in the audit trail.
- The transcript unit id of a session is the same boxed and unboxed (identical paths).
- A full node never fails a job: it hands it back to the label queue. A warm session's turn is never refused for capacity.
- `/env use` works in a boxed session with an egress list that does not mention the remote host.
- Sync with `SLAUDE_BOX=off` accepts a payload with `boxes` and changes no session behaviour.
- `${` anywhere in a `box.yaml`, or a value shaped like a credential, fails the sync and the message names the field, never the value.

## File Structure

- Create `src/box/`: `sandbox.ts`, `resolver.ts`, `env.ts`, `policy.ts`, `definition.ts`, `image.ts`, `capacity.ts`, `capability.ts`, `drivers/none.ts`, `drivers/gvisor.ts`, `drivers/bwrap.ts`, `boxd/main.ts`, `boxd/server.ts`, `boxd/client.ts`, `boxd/protocol.ts`, `boxd/pack.ts`, `egress/proxy.ts`, `egress/policy.ts`, `egress/llm.ts`, `init/main.ts`.
- Create `src/storage/pack-sync.ts` (flush and hydrate of a pack unit against the store), `src/storage/pack-manifest.ts`.
- Create `src/gateway/core/box-registry.ts`, `src/gateway/core/box-refresh.ts`, `src/gateway/api/node-boxes.ts`, `src/gateway/core/box-command.ts`, `src/db/migrations/0055_boxes.sql` onward, `src/db/boxes.ts` (beside `src/db/guardrails.ts` and `src/db/environments.ts`).
- Create `boxes/default/box.yaml`, `boxes/default/Dockerfile` (the default box), `deploy/k8s-scale-box/kustomization.yaml`, `scripts/spike/box/*` (Phase 0 only).
- Modify `src/agent/manager.ts`, `src/node/worker.ts`, `src/node/main.ts`, `src/node/fs-sync.ts`, `src/node/manifest.ts`, `src/storage/manifest.ts`, `src/storage/gc.ts`, `src/storage/units.ts`, `src/storage/index.ts`, `src/queue/keys.ts`, `src/queue/registry.ts`, `src/gateway/core/dispatch.ts`, `src/gateway/core/failure-codes.ts`, `src/gateway/slack/commands.ts`, `src/persona/sync/payload.ts`, `src/persona/sync/run.ts`, `src/persona/agent-schema.ts`, `src/persona/agent-def.ts`, `src/cli/personas.ts`, `src/config/env.ts`, `src/metrics.ts`, `Dockerfile`, `docker-compose.scale.yaml`, `.github/workflows/ci.yml`, `.github/workflows/docker.yml`, `.github/workflows/release.yml`.
- Docs: `docs/site/_content/deploy/boxes.md` (new), edits to `deploy/node-manifest.md`, `deploy/multi-node.md`, `deploy/remote-storage.md`, `deploy/scale-operations.md`, `deploy/alerts.md`, `reference/configuration.md`; one field note per shipped phase that found something; one findings line in `CLAUDE.md` each.
- Tests: `tests/box/*.test.ts` (unit), `tests/box/gvisor-*.test.ts` and `tests/box/bwrap-*.test.ts` (gated), `tests/storage/pack-sync.test.ts`, `tests/node/fs-sync.test.ts` (extend), `tests/node/worker-box-real.test.ts` (Redis-gated), `tests/persona/box-definition.test.ts`, `tests/gateway/box-dispatch.test.ts`, `tests/deploy/topology.test.ts`, `tests/deploy/secret-split.test.ts` and `tests/deploy/node-entry.test.ts` (extend), `tests/integration/box-resume.test.ts`, `tests/integration/box-capacity.test.ts`.

## Rollout order and sizes

| Phase | What ships | Flag that hides it | Size | Why that size |
|---|---|---|---|---|
| 0 | Spike results and a go or no-go | nothing ships | M | Four experiments on real Linux hosts; no product code |
| 1 | The seam: `SessionSandbox`, the `none` driver, the spawn hook, the environment builder | resolver returns null | S | One interface, one manager option, tests |
| 2 | boxd, the gVisor driver, both proxies, box-init; boxes from an imported image with a node-local home | `SLAUDE_BOX_TIER` | L | A new privileged process, a protocol, two proxies, a gated CI job |
| 3 | Box definitions end to end: schema, sync, tables, signed set, bundle, pinning, capability | `SLAUDE_BOX` | L | Touches sync, DB, bundle, dispatch, console |
| 4 | Pull, prewarm, inventory, digest-aware routing | `SLAUDE_BOX` | M | New code beside existing patterns |
| 5 | Durability: `hm` and `wx` pack units, parking | boxed sessions only | M | A simple archive format (one owner, no special files) on existing fencing; the care is in `FsSync` edge cases |
| 6 | Capacity, admission, autoscale signals, drain | boxed nodes only | M | Worker logic plus manifests; needs Phase 0's memory numbers |
| 7 | Refresh: `/box`, forced refresh | `SLAUDE_BOX` | S | A digest change and a command |
| 8 | Stdio MCP in boxes, the manifest helper, the opt-in checklist | boxed sessions only | S | One extracted validator, one CLI helper, docs |
| 9 | Kubernetes and compose manifests, default box image, quotas, metrics, alerts, docs | overlay is opt-in | M | Manifests, CI, documentation |
| 10 | `bwrap` tier (Linux, then macOS Seatbelt) | `SLAUDE_BOX_TIER=bwrap` | M | A second driver on the same base |
| Later | Home reset, hard disk quota, sandbox pool, native registry client, microVM, mandatory boxes | n/a | n/a | Each on a measured need or a new decision |

Phases 1 and 3 do not depend on Phase 0's outcome and may start while it runs. Phases 2, 5 and 6 do. Phase 6 must ship before any production persona opts in: a node without admission can be pushed past its pod's memory.

---

## Phase 0: Spikes (gate)

Nothing here was run when this plan was written. The scripts below are artifacts to write and run; the machine this plan was written on is macOS with no runsc. Commit the scripts under `scripts/spike/box/` and the results as a field note (`docs/site/_content/field-notes/<date>-box-spikes.md`) with the raw numbers, the host (kernel, CPU, disk, instance type), the runsc version and the platform.

**Hosts:** (1) a plain Linux VM (kernel 5.15 or newer, 4 vCPU, SSD); (2) the same workload inside a privileged container in a pod on `deploy/k8s-local`; (3) a privileged pod on the kind of cluster the owner runs in production. Host 3 is the one that decides, because the design is "boxes inside the node pod".

### Spike 1: runsc nested in the node pod

- [ ] Install runsc from the gVisor apt repository on host 1. Record the version.
- [ ] `scripts/spike/box/01-run.sh` (not run): build an OCI bundle from `debian:bookworm-slim` exported with `umoci`, then
  ```sh
  runsc --root /tmp/rs --platform systrap --network none \
        --overlay2 "root:dir=/tmp/ov/spike1,size=2g" --host-uds open \
        run --detach --bundle "$BUNDLE" spike1
  runsc --root /tmp/rs exec spike1 /bin/sh -c 'id; df -h /; ip addr || true'
  ```
  with `/home/agent` and a workspace directory bind mounted read-write in the bundle's `config.json`.
- [ ] Root overlay: write 1 GB under `/usr/local`; confirm it lands in the backing file under `/tmp/ov/spike1`, that a write past the size limit fails with "no space", and that two sandboxes on the same read-only root with different `dir=` values do not see each other's writes. If `dir=` misbehaves, record what `root:self` does with a shared root directory.
- [ ] Exec with piped stdio: `printf 'hello\n' | runsc exec spike1 cat` round-trips; a 100 MB stream through `cat` has no truncation; closing stdin ends the process; `runsc kill` ends a hung one within 2 s.
- [ ] Host Unix socket: a listener on the host at `$RUN/egress.sock`, bind mounted at `/run/slaude`; from inside, a client connects and exchanges bytes. If refused, record which flag value makes it work, from `runsc flags` on the installed version.
- [ ] Loopback inside with `--network none`: a listener on `127.0.0.1:3128` accepts a local connection.
- [ ] Limits: `linux.resources` memory 512 MB, pids 64, cpu quota 1 core in the spec; an allocation loop is killed; a fork loop is refused; a busy loop is held to one core. Record whether it needs cgroup v2 delegation inside the pod, and whether the sandbox's memory is charged to the boxd container's cgroup (it must be, for the capacity model and the autoscale signal).
- [ ] Repeat all of the above on host 2 and host 3. Record every extra capability, mount or flag needed.
- [ ] Sandbox start time: 20 runs of `run --detach` plus first `exec` returning; median and p95.
- [ ] **Density:** resident memory of sentry plus gofer for an idle sandbox; then with an idle `claude` CLI inside; then ten at once in one container. This number sets `SLAUDE_BOX_SANDBOX_OVERHEAD_MB` and the default `SLAUDE_NODE_MAX_BOXES`.

### Spike 2: bind-mount I/O (the main performance risk)

`scripts/spike/box/02-bench.sh` (not run). The agent's file work happens in the workspace and in home, both bind mounts served by the gofer. The root filesystem matters only for reading the toolchain. Configurations:

| Id | Runtime | Root | Bind mounts (home, workspace) |
|---|---|---|---|
| C0 | runc (baseline) | host overlayfs | plain |
| C1 | runsc systrap | image directory + `root:dir=` overlay (**the design**) | shared mode (default) |
| C2 | C1 | same | `--file-access-mounts=exclusive` |
| C3 | runsc systrap | EROFS image + overlay | shared mode |
| C4 | C1 with `--platform kvm` | same | shared; only where `/dev/kvm` exists |
| C5 | C1 with `--directfs=false` | same | shared; to see how much directfs gives |

Workloads, each 5 runs, cold and warm page cache noted:

- [ ] `git clone` of a mid-size public repository (about 20,000 files) from a local mirror into the workspace, then `git status`, `git log -100 --stat`, `git checkout` of another branch.
- [ ] `bun install` of a fixed lockfile with about 1,000 packages into the workspace: cold cache, then warm cache (`~/.bun` in home populated).
- [ ] `npm ci` of the same project (cache in `~/.npm`).
- [ ] `uv sync` or `pip install` into a workspace `.venv` with one compiled wheel.
- [ ] `go build` of a mid-size module with the module and build caches in home.
- [ ] `rg` over the cloned repository; a test run of a small project.
- [ ] Toolchain reads from the root: `python -c 'import ...'` of a large package installed in the image, `ruby -e` with many requires, a `node` start: C1 against C3.
- [ ] `apt-get install -y ffmpeg` from a local mirror (root overlay only; expected fast, and not durable).
- [ ] CLI boot: time from spawning the bundled `claude` binary to its `init` message, against the fake Messages API in `tests/spike/fake-messages-api.ts`.
- [ ] A scripted agent turn against the mock model (the aimock setup of the mock-llm suite): ten tool calls (read, edit, bash `bun test` on a tiny project). Wall time per configuration.
- [ ] One real agent turn against a real model on C0 and C1 ("clone this repo, install, run the tests"), three runs each, to see whether the file overhead is visible next to model latency.
- [ ] For C2: write a file into the workspace from the host while the sandbox runs (what `drainInbox` does) and record whether the sandbox sees it. This decides whether exclusive mode is usable at all.

### Spike 3: the provider proxy for every credential form (blocking)

The no-secrets rule makes this a requirement, not an optimisation. `scripts/spike/box/03-provider.ts` (not run):

- [ ] A reverse proxy on a Unix socket that forwards to the real provider, replaces the credential header, strips the inbound one, streams. Inside the sandbox, `box-init`'s relay on `127.0.0.1:3129`, `ANTHROPIC_BASE_URL` pointing at it, and a **placeholder** in the credential variable.
- [ ] Form A, API key: a full turn with streaming, a tool loop, extended thinking, a subagent, a compaction, a resume.
- [ ] Form B, auth token: the same.
- [ ] Form C, OAuth token (`CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`): the same. Capture, on the proxy, every request the CLI makes (method, host, path, header names): record any request that does not go to the base URL, any header that carries or derives from the token, and any local validation the CLI does on the token's shape that a placeholder fails.
- [ ] With the egress allowlist empty: confirm the CLI makes no provider-related request that bypasses port 3129 (it would show as a refused CONNECT in the egress proxy's log).
- [ ] Token rotation: change the real credential in the proxy mid-session; the box is not restarted.

**Kill criterion K3 (per form):** the form passes only if every case above completes with a placeholder in the box and the real credential never present in the box's environment, files, arguments or any response body.

**If form C fails:** the rule is kept. OAuth-token personas are not boxable: the sync warns, dispatch runs them unboxed where tier `none` is available and refuses otherwise. Record it in the field note and tell the owner in the gate summary, in those words, so that boxing them with the token inside is a decision the owner makes knowingly and not a default. If form A or B fails, stop: the architecture does not hold.

### Spike 4: the agent inside

`scripts/spike/box/04-agent.ts` (not run), reusing `tests/spike/sdk-run.ts` and `tests/spike/sdk-cases.ts`:

- [ ] A `spawnClaudeCodeProcess` that returns a `SpawnedProcess` backed by `runsc exec` with piped stdio. Run the existing SDK spike cases through it: a tool loop, a `PreToolUse` hook that denies, `canUseTool`, an in-process MCP server created with the SDK, an abort mid-turn, a resume from the transcript directory (bind mounted at the same path).
- [ ] `HTTPS_PROXY=http://127.0.0.1:3128` relayed to a host CONNECT proxy over the Unix socket; a `curl`, a `git clone` over HTTPS, an `npm view`, a `pip download`, a `go mod download` all appear in the proxy's log; a host not on the list gets the 403 and the tool prints something an agent can understand.
- [ ] A credential-free stdio MCP server declared in the options starts inside the sandbox and answers.
- [ ] Plugin skills listed from a read-only bind mount of the built-in plugin directory; a plugin hook script runs inside.
- [ ] A pack round trip of a home with 50,000 files (plain `tar --zstd`): time to create, size, time to extract on another host. This replaces the spec's estimates early.

### Kill criteria for the gVisor path

Decide on host 3's numbers (host 1 as the reference), the best safe configuration among C1 to C5 against C0:

| # | Criterion | Kill when |
|---|---|---|
| K1 | Runs nested in a privileged container on the owner's cluster | Spike 1 cannot pass on host 3 |
| K2a | Warm-cache `bun install` into the workspace | More than 3 times C0 and more than 20 s slower |
| K2b | `git status` on 20,000 files | More than 5 times C0 and more than 2 s |
| K2c | Scripted agent turn | More than 25 percent slower wall time |
| K2d | CLI boot | More than 3 s slower |
| K3 | Provider proxy | Form A or B fails (stop). Form C fails (narrow, see above) |
| K4 | Agent over `exec` stdio | Any SDK case fails for a reason the relay fallback (a long-lived process in the box) does not fix |
| K5 | Density | Idle sandbox plus idle CLI above 400 MB, so that a 16 GB boxd container holds fewer than about 25 idle sessions |
| K6 | Sandbox memory is charged to the boxd container and limits apply | Cannot be made true nested |

**Fallback ladder**, in order:

1. **Tune within gVisor.** If C1 fails K2 but C2, C3 or C4 passes, adopt that configuration. C2 (exclusive mode) is adoptable only if the host-write test passed, or if staged files are moved to arrive between sandbox stops. C4 needs KVM on the cluster's machines.
2. **`bwrap` as the production tier** if no gVisor configuration passes K2, or K1, K5 or K6 fails. Phase 10 moves ahead of Phase 2's gVisor driver. Everything else is unchanged: the same image, home, packs, proxies, capacity model and definitions. The kernel is shared, and the docs say so. gVisor stays available as a tier a box can require on hosts where it passes.
3. **K3 form C** narrows who can be boxed; it never changes the tier.
4. **K3 form A or B, or K4 beyond the relay**: stop and redesign.
5. A microVM tier is evaluated only if the owner rejects a shared kernel and gVisor fails on performance.

- [ ] Write the field note with a table per spike, the decision per criterion, the configuration chosen, the measured overhead and density numbers that become defaults, and the rung. Update the spec's "The gVisor configuration", "Capacity", "Open risks" and "Recommendations" sections to match what was measured. Get the owner's read before Phase 2.

---

## Phase 1: The seam (S)

Ships with no behaviour change: the resolver is never installed outside tests.

**Files:** Create `src/box/sandbox.ts`, `src/box/drivers/none.ts`, `src/box/env.ts`, `tests/box/sandbox-seam.test.ts`, `tests/box/env.test.ts`, `tests/box/scope-guard.test.ts`. Modify `src/agent/manager.ts`.

**Interfaces:** as in the spec: `BoxTier`, `BoxMount`, `BoxSpec`, `SessionSandbox`, `SandboxDriver`. Manager: `setSandboxResolver(fn: (sessionId: string) => Promise<SessionSandbox | null>): void`. `buildBoxEnv(input: { sdkEnv, imageEnv, policy, scratchDir, configDir, providerForm }): Record<string, string>` in `src/box/env.ts`.

- [ ] Test: with a resolver that returns a fake sandbox, the options built by the manager's boot carry a `spawnClaudeCodeProcess` that calls `sandbox.spawn` with the SDK's `command`, `args`, `cwd`, `env`, `signal`; with a null resolver the option is absent (compare with a snapshot of today's option keys). Use the manager's existing test doubles (see `tests/agent/`).
- [ ] Test: a resolver that throws fails the boot with a `BootFailure` and never spawns unboxed.
- [ ] Implement in `src/agent/manager.ts` beside the other resolvers; add the option where `options` is assembled (near the `env: scrubChildEnv(...)` line).
- [ ] Test `buildBoxEnv`: given an SDK environment holding real values for every name in `PROVIDER_ENV_KEYS`, every gateway-only name (`src/config/gateway-only-env.ts`), `SLAUDE_NODE_TOKEN`, `SLAUDE_REDIS_URL` and `SLAUDE_S3_*`, no real value appears anywhere in the result; the credential variable of the given form holds the placeholder and the other two are absent; the proxy variables and `ANTHROPIC_BASE_URL` are set; `CLAUDE_*` names the SDK set are kept. A property test feeds random secret-looking values and greps the output.
- [ ] Scope guard test: no file under `src/box/` imports `src/remote/` and no file under `src/remote/` imports `src/box/`.
- [ ] `drivers/none.ts`: `probe` is always ok; `create` is never called (the resolver returns null for tier `none`). It exists so the tier table is complete.
- [ ] Commit per item. Typecheck, `bun test tests/box tests/agent`.

## Phase 2: Boxes under gVisor (L)

Depends on Phase 0. A node with `SLAUDE_BOX_TIER=gvisor` and `SLAUDE_BOX_DEV_IMAGE=<digest>` (a development-only variable, removed in Phase 4) runs every session in a sandbox from a locally imported image, with both proxies and a home directory that lives on the node only. No gateway change.

**boxd** (`src/box/boxd/`)

- `protocol.ts`: newline-delimited JSON requests over `SLAUDE_BOXD_SOCKET`: `probe` (tier, cgroup memory limit, disk), `image.import`, `image.list`, `image.remove`, `sandbox.create`, `sandbox.exec` (returns a second socket path carrying the process's stdio), `sandbox.kill`, `sandbox.stats`, `sandbox.stop`, `sandbox.list`. Every path argument is checked against `SLAUDE_BOX_DIR` and the mount roots given at boxd start (`--mount-root /data --mount-root /config-home`), after `realpath`.
- `main.ts`: refuses to start if its environment holds any name matching `isChildScrubbedEnv` (`src/agent/child-env.ts`), `PROVIDER_ENV_KEYS` or `SLAUDE_S3_*`; socket created 0600.
- `server.ts`: sandbox table, owner connection tracking (a dropped owner's sandboxes are killed after 30 s), `runsc` argv with the configuration Phase 0 chose, OCI `config.json` generation from a `BoxSpec` (limits, mounts, user, no capabilities), root overlay directory per session created and deleted with the sandbox, first-start seeding of an empty home from the image's `/home/agent`.
- `client.ts`: the worker's side; `exec` returns an object satisfying the SDK's `SpawnedProcess`.

**Driver, proxies, init**

- `src/box/drivers/gvisor.ts`: `probe` asks boxd; `create` returns a sandbox whose `start` creates the session directories and asks boxd to run, and whose `spawn` maps the SDK's `command` to the bind-mounted CLI path. `start` refuses a config directory containing `.credentials.json`.
- `src/box/egress/policy.ts`: pure matcher (host, port, wildcard, deny wins, refuse by default). `proxy.ts`: HTTP proxy on a Unix socket per session, CONNECT and plain HTTP, resolve once, check with `src/net/outbound-policy.ts`, fixed refusals for the gateway URL, the Redis host and the S3 endpoint host; rules read per connection from a supplier function; `closeDisallowed()` ends tunnels a new rule set refuses; the 403 body is one plain sentence.
- `src/box/egress/llm.ts`: the provider proxy for the forms Phase 0 passed; one upstream; strips inbound credential headers; never follows a redirect to another host; never logs a header value.
- `src/box/init/main.ts`: PID 1; two TCP listeners on loopback relayed to the two sockets; reaps children; built with `bun build --compile` in the `Dockerfile` and bind mounted read-only.
- `src/box/resolver.ts`: builds the `BoxSpec` (mounts: home, working directory, the session's config directory from `src/agent/config-root.ts`, the scratch directory from `ScratchDirs`, the built-in plugin directory, the home plugin directory, `SLAUDE_PLUGIN_ROOT`, the CLI binary), starts the proxies, returns the sandbox.
- `src/node/worker.ts`: install the resolver when the tier is not `none`; skip node-side MCP credential seeding for a boxed session (find the callers of `src/node/credentials.ts` and gate them); stop the sandbox and proxies at the three places `scratch.remove(sessionId)` is called and in `stop()`; `/readyz` requires a live boxd.
- `src/agent/manager.ts`: the one prompt line for a boxed session (what persists and what does not), added where the runtime blocks of the system prompt are assembled.
- `src/node/main.ts`: probe at boot, refuse on failure.
- `Dockerfile`: add runsc (pinned version and checksum, like tailcat) and the compiled `box-init`.

**Tests**

- Unit (`tests/box/`): policy matcher table; proxy against a local TCP echo and a local TLS server (allowed, refused by default, private address refused, rebinding attempt, rule change closes a tunnel); provider proxy header swap per form against `tests/spike/fake-messages-api.ts`, including "the real credential appears in no response"; protocol path validation (traversal, symlink out of a mount root); boxd environment refusal; `config.json` golden file; the credentials-file refusal.
- Gated (`SLAUDE_BOX_TEST_TIER=gvisor`, `tests/box/gvisor-*.test.ts`): start, exec, kill, stats; no network except the proxy; a second sandbox cannot see the first's home or workspace; OOM, pid and overlay-size limits; a system-level write is gone after stop and start, a home write is not.
- Gated end to end: `tests/node/worker-box-real.test.ts` runs the existing worker e2e pattern (`tests/node/worker-e2e.test.ts`) with a boxed session against the mock model: a turn with a Bash tool call, a denied hook, a reply through the shims, a bridged MCP call, an upload from the scratch directory; a dump of the sandbox's environment and `/proc/*/environ` contains no credential.
- CI: a new job in `.github/workflows/ci.yml` on a Linux runner that installs runsc and runs the gated suites. If the hosted runner cannot run runsc (Phase 0 shows), the gVisor suite moves to the cluster job in `e2e-ha.yml` and the hosted job runs the `bwrap` subset once Phase 10 exists.

## Phase 3: Box definitions (L)

Independent of Phase 0. With `SLAUDE_BOX=off` the gateway validates and stores, and nothing reads the result.

- `src/box/definition.ts`: the Zod schema for `box.yaml` (no `secrets` key, no placeholders; `memoryReserveMb` defaults to a third of `memoryMb`), strict keys, messages in the agent.yaml style; refuses `${` anywhere; checks `env` values and `mcp.stdio` arguments against the secret shapes in `src/redact/`. `scripts/gen-agent-schema.ts` extended (or a sibling script) to emit `docs/site/schemas/box.schema.json` with a drift test.
- `src/persona/sync/payload.ts`: `BOX_PAYLOAD_VERSION = 8`, `SUPPORTED_PAYLOAD_VERSION = 8`, `boxes` in the payload schema, `payloadVersionFor` raises the version only when boxes are present. `src/persona/sync/run.ts`: upsert boxes in the sync transaction; a new version row when digest or policy differs; refuse deleting a box a persona names; refuse a persona naming an unknown box (422, dry run included); warn or refuse a boxed persona whose provider form Phase 0 found unsupported; the dry run prints a per-box diff summary; an audit row per changed box.
- `src/persona/agent-schema.ts` and `agent-def.ts`: the optional `box` key (a box name), carried in `definition`.
- `src/cli/personas.ts`: read `boxes/`, resolve `image.build` through the context hash and a registry lookup, build and push with `docker buildx` when missing (the only place a build runs; CI), send digests. `slaude box check <dir>` runs the schema and the image requirement checks.
- Migrations `0055_boxes.sql`, `0056_box_versions.sql`, `0057_boxes_manifest.sql`, `0058_session_box.sql` (two nullable columns, a 2 s lock timeout, no index, following `0050_boundary_sessions.sql`), in both dialects as the migration runner requires.
- `src/gateway/core/box-registry.ts`: read path with the signed-set check, modelled on `src/guardrails/integrity.ts` (manifest row first, then rows, fail closed).
- Runtime bundle: a `box` field (name, pinned digest, policy), the box set version as an ETag input. The tenant reload announcement already invalidates node bundle caches; confirm it is published by the sync and add it if a box-only sync does not trigger it.
- `src/box/capability.ts`: `BOX_CAPABILITY = "box/1"`, `boxTierCapability(tier)`. `src/node/worker.ts`: add them to `NODE_CAPS` when the tier is not `none`. `src/gateway/core/dispatch.ts`: when `SLAUDE_BOX=on` and the persona has a box, add both to `requiredCaps` (the existing capability wait and refusal path, with its message extended), and pin `box_name` and `box_digest` with a compare-and-set at first dispatch.
- Node: the resolver reads the box from the bundle and the pinned digest from the session view instead of `SLAUDE_BOX_DEV_IMAGE`; the egress proxy's rule supplier reads the cached bundle, and the reload handler calls `closeDisallowed()`.
- Console: a read-only Boxes page beside Guardrails (list, versions, digest, policy built field by field, never a dump).

**Tests:** schema table tests (`tests/persona/box-definition.test.ts`), including `${` refused and a token-shaped `env` value refused without echoing it; payload version tests beside the existing ones; sync tests for create, new version, policy-only change, refused delete, unknown box, dry-run diff; integrity tests (deleted row, replayed row); dispatch tests (`tests/gateway/box-dispatch.test.ts`): pinned once, not re-pinned by a new version, refused without a capable node, untouched when `SLAUDE_BOX=off`; bundle ETag changes with the box set; an allowlist change reaches a running session's proxy at its next connection with no sandbox restart (a worker-level test with a fake bundle source).

## Phase 4: Pull, prewarm, inventory, routing (M)

- `src/box/image.ts`: `pull(image, digest)` (worker: `skopeo copy docker://<repo>@<digest> oci:<spool>`), `unpack` (boxd: `umoci unpack`, the EROFS build if Phase 0 chose it, then the requirement checks), `list`, `evict` (least recently used above `SLAUDE_BOX_IMAGE_BUDGET_MB`, never a digest in use). `slaude box import <dir>` for offline use.
- `src/gateway/api/node-boxes.ts`: `GET /v1/node/boxes`, node credential, label gated, returns current and pinned digests for the node's labels.
- `src/node/worker.ts`: a prewarm loop at start and on the tenant reload announcement; readiness waits for the current digests up to a timeout; the heartbeat writes the cached digests.
- `src/queue/keys.ts`: `nodeBoxes(nodeId)`. `src/queue/registry.ts`: write with the node TTL beside `nodeCaps`; `liveNodesWithBox(label, caps, digest)`.
- `src/gateway/core/dispatch.ts`: for a cold boxed session, target a live node that has the digest (random among them); else the label queue. On the node, a claim without the digest pulls under a deadline and emits a status event.
- Failure code `BOX_IMAGE_UNAVAILABLE` in `src/gateway/core/failure-codes.ts`.
- Console: which nodes hold which digest (a derived snapshot refreshed like `src/gateway/core/plugin-inventory.ts`).
- Remove `SLAUDE_BOX_DEV_IMAGE`.

**Tests:** registry unit tests with a mem Redis; dispatch routing table (warm node wins; digest-warm node next; label queue last; a dead node's key expired); a fake registry (a local OCI layout served by a tiny static server) for pull and digest mismatch; eviction order; gated: pull, unpack and start from the fake registry.

## Phase 5: Durability and parking (M)

Depends on Phase 0 only for numbers. The archive is a plain tar: one owner, no whiteouts, no extended attributes, no device nodes.

- `src/storage/pack-manifest.ts`: the version 2 manifest (`kind: "pack"`, `layers`). `src/storage/manifest.ts`: `latestManifest` returns either kind; `src/storage/gc.ts`: liveness reads `layers[].hash` for a pack manifest.
- `src/storage/units.ts`: `hmUnitId(sessionId)`, `wxUnitId(workingDir, digest)`.
- `src/box/boxd/pack.ts`: `scan(root, filter)` to an index; `diff(prev, next)`; `create(root, entries, removed)` to an archive in the spool; `apply(archive, root)` confined, writing every entry as the sandbox user and stripping set-uid bits; `validateListing`. `wx` uses a filter that selects exactly what `isIgnored` (`src/storage/ignore.ts`) skips, so `ws` and `wx` partition the workspace with no overlap and no gap (a property test). `hm` honours the box's `durable.exclude`.
- `src/storage/pack-sync.ts`: `flushPack(store, unit, { epoch, isCurrent, pack })` and `hydratePack(store, unit, { markerPath, apply })`, with the same fence check position, the same idempotence (no change, no write) and the same marker rules as `flushTree` and `hydrateTree`; the compaction rule.
- `src/node/fs-sync.ts`: a unit gains a `kind` (`tree` or `pack`); `Tracked` gains optional `wx` and `hm`; `#prepare`, `#flushNow`, `evict`, `drain`, `#dropLocal` branch on kind; a session's box facts (digest, home directory) come through a new dependency `boxOf(sessionId)`. Prepare and flush order `tx`, `ws`, `wx`, `hm`. `drain` flushes several sessions at a time.
- **Parking** in `src/node/fs-sync.ts`: for a boxed session `evict` flushes and keeps the local directories and markers; a `park` table (session, units, bytes, last used) with a pruner that drops least recently used above `SLAUDE_BOX_PARK_BUDGET_MB` or when free disk is short; the existing marker comparison is what makes a parked resume a no-op hydrate and a stale parked copy a full one. `src/queue/keys.ts`: `parked(sessionId)`; `src/node/worker.ts` sets and clears it; `src/gateway/core/dispatch.ts` prefers the parked node after a warm one.
- `src/node/worker.ts`: on a fenced flush or a lost lock, stop the sandbox and discard the local copies; the sandbox starts after `beforeTurn` returns `ok`.
- Soft quotas for home and workspace extras at flush; notices through the existing session event path.
- Gateway: session close and `/new` remove the session's `hm` unit in the storage sweeper tick (`src/gateway/core/storage-sweeper.ts`).
- Without `SLAUDE_STORAGE=s3`: the two units are not created; one log line per node; documented.

**Tests**

- `tests/storage/pack-sync.test.ts` against the local object store used by `tests/storage/contract.ts`, with a fake packer: idempotent flush, delta then compaction, fenced flush writes nothing, hydrate warm and cold, missing blob, gc keeps live layers.
- `tests/box/pack.test.ts` (Linux): index diff table; archive round trip of modes, symlinks, hard links, empty directories, removed paths; every hostile archive from Review Focus.
- `tests/node/fs-sync.test.ts` extended: four units, needs-flush on `hm`, the dead-owner loss path, a recreated process on the same disk recovering a home, two sessions sharing a folder and a `wx` unit, two sessions on different digests in one folder getting different `wx` units; parked resume downloads nothing; a parked copy that another node superseded is replaced; the pruner drops the least recently used and never an unflushed one.
- `tests/integration/box-resume.test.ts` (Redis and gVisor gated, two workers, one store): install a tool into home and a workspace `node_modules` on node A, evict, resume on node B, both are present and a system-level install is not; kill node A before a flush, resume on B from the last flush with the loss counter incremented.
- A load script under `scripts/load/` measuring flush and cold hydrate for 50,000 files against a real S3-compatible server, reported against the 20 s first-turn budget; its numbers replace the spec's estimates.

## Phase 6: Capacity, admission, autoscale, drain (M)

Depends on Phase 0's density and cgroup results.

- `src/box/capacity.ts` (pure): `checkSizing({ maxBoxes, memoryBudgetMb, overheadMb, smallestReserveMb, diskMb, imageBudgetMb, parkBudgetMb })` for the boot check; `admit(state, box)` returning `admit`, `make-room` (with the session to park) or `full`; `pressure(memoryUsed, memoryLimit)` with the 90 and 80 percent thresholds and the hysteresis.
- `src/config/env.ts`: `SLAUDE_NODE_MAX_BOXES`, `SLAUDE_BOX_MEMORY_BUDGET_MB`, `SLAUDE_BOX_SANDBOX_OVERHEAD_MB`, `SLAUDE_BOX_PRESSURE_IDLE_SEC`.
- `src/node/main.ts`: read boxd's cgroup memory limit and disk from `probe`; run the sizing check; refuse to start on a violation, naming the numbers; warn when `MAX_BOXES` is below the node's turn concurrency.
- `src/node/worker.ts`: an admission step before the sandbox starts (claim step 2 in the spec); early parking of the longest-idle warm session; pause and resume of the label-queue workers through the same pause mechanism the credential-refusal path uses (a second, independent reason, so one does not resume the other); handing a claimed job back to the label queue with the existing atomic move; a pressure tick reading `sandbox.stats` and boxd's memory; free slots on the heartbeat.
- `src/gateway/core/dispatch.ts`: route a cold or parked session to a node's own queue only when that node reported a free slot.
- `src/metrics.ts`: `slaude_node_boxes_running`, `_capacity`, `_full`, `_parked`, `slaude_box_memory_reserved_bytes`, `slaude_box_admission_total{result}`, `slaude_box_pressure_evictions_total`.
- Drain (`stop()` in `src/node/worker.ts`): after in-flight turns, flush and stop every warm box in parallel, release registry entries, delete parked hints.
- Manifests (in `deploy/k8s-scale-box/`, created here and completed in Phase 9): the ScaledObject patches adding KEDA `memory` and `cpu` triggers with `containerName: boxd` and a commented Prometheus occupancy trigger; a patched copy of `optional/node-cpu-fallback-hpa.yaml` with `ContainerResource` metrics for boxd memory and CPU and an updated header; `terminationGracePeriodSeconds: 300`.
- Docs: `deploy/scale-operations.md` gains the sizing model, the worked example, the admission rule and the drain arithmetic; `deploy/alerts.md` gains "every node of a label is full" and "cold resume p95 above 20 s".

**Tests:** `tests/box/capacity.test.ts` (tables for sizing, admission and pressure); `tests/integration/box-capacity.test.ts` (Redis-gated, a fake driver with scripted memory): a node at capacity parks an idle session to admit a new one; with none idle it pauses its label workers and the job is claimed by a second node; a job routed to a full node's own queue comes back to the label queue and runs once; a warm session's turn runs on a full node; pressure parks idle sessions and stops admitting; the credential-refusal pause and the capacity pause do not release each other; drain flushes every warm box before exit. `tests/deploy/topology.test.ts`: the rendered overlay's ScaledObjects carry the triggers and the grace period exceeds the drain window.

## Phase 7: Refresh (S)

- `src/gateway/core/box-refresh.ts`: `refresh(sessionId, { by })`: end the warm session through `routeReload` (`src/gateway/core/reload-route.ts`), set the digest, write the audit row. `isStale(session)`: a forced version newer than the pinned digest exists.
- `src/gateway/core/dispatch.ts`: before enqueue, a stale session is refreshed and gets a private notice with the box's note.
- `src/gateway/core/box-command.ts` and the command table in `src/gateway/slack/commands.ts`: `/box status`, `/box refresh`; allowed for whoever may `/new` the thread.
- The first turn after a refresh carries a `<box-refreshed>` note (assembled where the thread-head and runtime notes are, in the manager's turn envelope), stripped from the episodic record like `<thread-head>`.
- Nothing to do on the node: the new digest gives a new `wx` unit id by construction; home is untouched.

**Tests:** refresh state table (user, forced, nothing newer, session mid-turn deferred); a forced version never refreshes a session during a turn; audit rows; the command's permission rule; the note appears once; after a refresh the session's home is intact and its workspace extras are empty.

## Phase 8: Stdio MCP in boxes and the opt-in checklist (S)

- Extract from `src/node/manifest.ts` a shared `validateStdioServer(name, config)` (name and key patterns, the `${` rules); the node manifest keeps its behaviour through it; `src/box/definition.ts` uses the stricter box form (no `${` at all); the node re-checks what it receives.
- `src/node/worker.ts`: the local MCP resolver returns the box's `mcp.stdio` for a boxed session (no exec wrapper), the node manifest's for an unboxed one. One boot warning per persona that is both boxed and allowed in the manifest.
- `slaude box from-manifest <node.json> <persona>`: per server, an `mcp.stdio` block (credential-free), or "needs a gateway-side server" with the env names that carry a node secret, or "needs both a token and the workspace".
- `slaude box preflight <persona>`: the opt-in checklist as a command: provider form supported, no node-side credential seeding in use, no manifest server with a secret, the box's tier offered by a live node of the persona's label, and private code access: the command asks whether the persona needs private repositories or registries (a `--private-code` flag, or a prompt), and if so requires a code-host MCP server in the persona's `mcp`, otherwise it reports "stays unboxed" with the reason. It reports only and edits nothing.
- Docs: `deploy/node-manifest.md` (the tier-conditional trust statement, the three cases), `deploy/multi-node.md` (what labels are for now), `deploy/boxes.md` (the consequences of "no secrets": private repositories and registries are reached through a gateway-side code-host MCP server declared in the persona's `mcp`, with a worked example of declaring one; a persona without one stays unboxed).
- **Explicit non-goal:** no credential-adding proxy route from a box to a code host or registry, and slaude ships no code-host MCP server of its own; the operator deploys one. A test asserts that the egress proxy adds no header and that the provider proxy adds one only for the provider upstream.

**Tests:** the existing manifest tests pass unchanged through the extracted function; a boxed session lists exactly the box's servers plus the gateway-resolved ones; a manifest entry is ignored for a boxed persona; `from-manifest` classifies a fixture manifest with one server of each case; `preflight` on fixtures.

## Phase 9: Deployment, default box, operations (M)

- `boxes/default/`: a Dockerfile reproducing today's runtime tools (debian, git, curl, ca-certificates, bun, uv), the `agent` user, package managers pointed at home (a user-level npm prefix, `PIP_USER`, `GOPATH`); a `box.yaml` whose egress list is the common package registries and code hosts. `docker.yml` and `release.yml` build and publish it with each release; its digest is written to a file in the slaude image so `SLAUDE_BOX_DEFAULT=default` and `box: default` resolve with no deploy repo entry.
- `deploy/k8s-scale-box/kustomization.yaml` completed: the boxd container, the two volumes, the tier and capacity variables, the resource split, for every node Deployment; composable with `deploy/k8s-scale-s3`. `deploy/k8s-local` gains a switch to apply it. The NetworkPolicy file's comments are updated; its rules are not.
- `docker-compose.scale.yaml`: an optional `boxd` service under a compose profile; defaults unchanged.
- `Dockerfile`: an optional `node-box` target without the unboxed-only tools; the default target keeps them, because tier `none` stays supported.
- `tests/deploy/topology.test.ts`, `secret-split.test.ts`, `node-entry.test.ts`: the rendered overlay has a boxd container with no `envFrom`, no Secret volume, `privileged: true` only there; the node container still execs `src/node/main.ts` directly; boxd's memory limit satisfies the sizing rule for the manifest's `SLAUDE_NODE_MAX_BOXES`.
- The remaining metrics and alerts from the spec; audit kinds.
- `slaude box digests --in-use`.
- `scripts/e2e-ha.sh` and `deploy/k8s-local/verify-turns.sh`: a boxed variant (a turn; a failover with a cold resume that keeps a tool installed in home; a scale-up under a burst of sessions).
- Docs: `deploy/boxes.md` complete, opening with what persists and what does not, then concepts, the format, the GitOps flow, tiers, egress and its limits, "no secrets" and what it means for tools, refresh, sizing, operations, the security section; `reference/configuration.md`; a plain-host guide (systemd units). Release notes under the stable name.

## Phase 10: The bwrap tier (M)

Moves ahead of Phase 2's driver if Phase 0 ends on rung 2.

- `src/box/drivers/bwrap.ts` on Linux: boxd runs `bwrap` on the image directory read-only with a tmpfs or overlay for system writes, new user, pid, ipc, uts and network namespaces, no capabilities, a seccomp filter, the same bind mounts and sockets, `box-init` as PID 1, the same cgroup limits. Everything above the driver is shared.
- macOS: the driver wraps the spawn with Anthropic's sandbox-runtime (Seatbelt), write access to the workspace, config and scratch directories, its domain proxy fed from the box's egress list; no image, no packs. Marked development only in `probe`'s reason text and in the docs.
- Tests: the gated suites of Phase 2 run with `SLAUDE_BOX_TEST_TIER=bwrap` (the driver contract is one test file parameterised by tier); a macOS-gated smoke test.

## Later (each needs a number or a decision first)

- A command that empties a session's home.
- A hard disk quota (a filesystem image per home).
- A pool of started sandboxes.
- A native registry client replacing skopeo and umoci.
- Client-side encryption of packs.
- A microVM tier.
- Making boxes mandatory on nodes.

## Test strategy summary

| Layer | Runs where | Covers |
|---|---|---|
| Unit, bun:test, no privileges | every developer machine and CI shard (`scripts/ci-test-shards.sh`) | schema, policy matcher, environment builder, protocol validation, capacity tables, pack manifest and sync against the local store, dispatch and refresh tables, sync payload |
| Redis-gated (`SLAUDE_REDIS_TEST_URL`) | CI, as today | registry keys, routing, fs-sync with four units, fencing, parking, admission and hand-back |
| Tier-gated (`SLAUDE_BOX_TEST_TIER`) | a Linux CI job with root | driver contract, isolation assertions, no credential in the sandbox, pack round trip, hostile archives |
| Worker e2e with the mock model | tier-gated CI | a real CLI in a box: tools, hooks, shims, bridge, upload, the provider proxy |
| Fake-Slack HA suite (`scripts/e2e-ha.sh`, `e2e-ha.yml`) | the cluster job | a boxed persona end to end, failover with a cold resume, scale-up when nodes fill |
| Sim (`bun sim run`, `--nodes 2`) | unchanged | proves the default-off path is untouched |
| Load (`scripts/load/`) | on demand | flush and hydrate against the 20 s budget, sandbox density |

Every phase ends with the full default-off suite green, which is the reversibility proof: with the flags at their defaults the product is the one that exists today.

## Self-review

- Spec coverage: definitions and the GitOps flow, Phase 3; tiers, Phases 1, 2, 10; the gVisor configuration, Phases 0, 2; durability and parking, Phase 5; build and prewarm, Phases 3, 4; refresh, Phase 7; credentials, the provider proxy and egress, Phases 0, 2, 3; stdio MCP and the manifest, Phase 8; capacity, admission, autoscale and drain, Phase 6; Kubernetes, Phases 6, 9; migration (opt in), Phases 8, 9; observability, quotas and garbage collection, Phases 5, 6, 9.
- Nothing refers to a synced root layer, a host overlay mount, layer generations, box secrets or placeholders, a runtime approval of hosts, a pod per session, or a forced migration.
- The environment feature: no file of it appears in any phase's file list; the scope guard test and the Review Focus item keep it that way.
- Unverified items are confined to Phase 0 and named there; nothing later claims a measured result.
- Defaults that are guesses until Phase 0 (`SLAUDE_BOX_SANDBOX_OVERHEAD_MB`, `SLAUDE_NODE_MAX_BOXES`, the pod sizes in the overlay) are marked as such where they appear.
