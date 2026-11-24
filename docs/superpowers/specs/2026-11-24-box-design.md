# Box: one sandbox per session, built from a reviewed image

Status: draft, for review, with the owner's six decisions applied (see
"Decisions" at the end). No implementation yet. Nothing in this document has
been run: every gVisor behaviour is taken from the gVisor documentation or
marked as unverified, and Phase 0 of the plan
(`docs/superpowers/plans/2026-11-24-box-implementation.md`) exists to prove or
kill the parts that are assumptions.

## Goal

Make a node a plain generic host. Every agent session runs inside its own
sandbox, a **box**, started inside the node pod from a reviewed OCI image. The
box holds the toolchain; the node holds none. The agent and everything it
starts (Bash, stdio MCP servers, plugin hooks) run inside the box with **no
secret of any kind** and no network except a per-box proxy on the node. The
session's home directory, workspace and transcript survive a cold resume on
another node.

## Today

Facts read from the code at `bb79e606`, not assumed.

| Area | Today | Where |
|---|---|---|
| Trust | A node is one trust domain. Every agent child and every stdio MCP server runs as the node's user. One child can read another's environment and arguments. | `docs/site/_content/deploy/node-manifest.md`, `src/node/scratch.ts` header |
| Node process | Made non-dumpable so a same-uid tool cannot read `SLAUDE_NODE_TOKEN` from `/proc`. Best effort, Linux only. | `src/node/harden.ts`, `src/node/first-import.ts` |
| Agent child | Started by the Agent SDK from `AgentManager`, with `env: scrubChildEnv(...)`, `cwd: row.working_dir`. The child holds the persona's provider credentials. | `src/agent/manager.ts:2142`, `src/agent/child-env.ts`, `src/node/worker.ts` (`nodeChildEnv`) |
| Spawn seam | The SDK (0.3.173) has `spawnClaudeCodeProcess(options) => SpawnedProcess`, documented for containers and VMs. slaude does not use it yet. | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` |
| In-process tools | Reply tools, shims, the MCP bridge, `slaude_session`, hooks and `canUseTool` live in the node worker and talk to the child over its stdio. | `src/node/bridge.ts`, `src/node/shims`, `src/agent/manager.ts` |
| Stdio MCP | Declared in a node-local manifest, allowed per persona, started through an exec wrapper with a minimal environment. Tokens come from the node's environment. | `src/node/manifest.ts`, `src/node/mcp-exec.ts` |
| Remote MCP | A persona's `mcp` is HTTP only and goes through the gateway-side bridge. No URL or credential on the node. | `src/persona/mcp-http-only.ts`, `src/node/bridge.ts`, `src/gateway/core/mcp-bridge.ts` |
| Toolchain | Baked into the one image: `git`, `curl`, `uv`, a prefetched `mcp-grafana`, `tailcat`. | `Dockerfile` |
| Files | With `SLAUDE_STORAGE=s3`: two sync units per session, `ws-<hash of working dir>` and `tx-<hash of transcript dir>`, keyed by directory. One JSON manifest per flush named `<epoch>-<seq>`, one blob per file. | `src/node/fs-sync.ts`, `src/storage/tree-sync.ts`, `src/storage/manifest.ts` |
| Ignore list | `node_modules`, `.cache`, `__pycache__`, `.venv` never sync, in any unit. | `src/storage/ignore.ts` |
| Routing | Warm session goes to its node's own queue, anything else to the label queue. Capabilities (`guardrails/1` and others) gate dispatch. | `src/gateway/core/dispatch.ts`, `src/queue/registry.ts`, `src/guardrails/capability.ts` |
| Autoscale | KEDA on the label's BullMQ wait list; an optional CPU HPA for clusters without KEDA. | `deploy/k8s-scale/70-autoscale.yaml`, `deploy/k8s-scale/optional/node-cpu-fallback-hpa.yaml` |
| Egress | Optional pod-level NetworkPolicy, port based, 443 open to anywhere. | `deploy/k8s-scale/optional/node-egress-networkpolicy.yaml` |

Three facts that shaped the design:

1. **Blobs do not dedupe across sessions.** A blob key is
   `sessions/<unit>/blobs/<hash>` (`blobKey` in `src/storage/manifest.ts`):
   content addressing is per unit. This design does not rely on cross-session
   dedup.
2. **Workspace installs are not durable today.** `DEFAULT_IGNORE` skips
   `node_modules` and `.venv` inside the workspace. A cold resume on another
   node finds the workspace without them. This design adds a unit for them
   (`wx`, below).
3. **Per-file sync does not fit an install tree or a cache directory.**
   `hydrateTree` downloads one object per file with a concurrency of 4, and
   every flush rewrites one JSON manifest that lists every file. Estimates for
   a 50,000 file, 500 MB tree: a 7 MB manifest per flush, and a cold hydrate
   of roughly 50 s against an in-cluster store (4 ms per GET) to 4 min against
   a regional one (20 ms per GET). The new units use a packed format instead.
   These are estimates, not measurements.

## Goals

- A session's processes cannot read another session's files, environment or
  credentials, on the same node, whatever their persona.
- **No secret is ever inside a box**: no provider credential in any form, no
  node credential, no job token, no Redis URL, no object-store credential, no
  MCP token, no tool token. Anything that needs a secret is a gateway-side MCP
  server reached through the existing bridge.
- Outbound network from a box is refused by default and allowed per box by a
  list reviewed in git, enforced outside the box.
- A box image is reviewed in git, built by CI, pulled by digest. A node never
  builds an image.
- Durable across nodes: the workspace, the transcript, the session's home
  directory (tool caches included), and the installs inside the workspace.
- A session stays on the image it started with until someone asks to move it.
- Boxes run inside the node pod. A node pod has a stated capacity, refuses
  work beyond it, and the cluster scales node pods on that pressure.
- Today's behaviour stays available as a tier (`none`), per persona, with no
  forced migration.

## Non-goals

- **The existing environment feature is out of scope, entirely.** Remote
  environments (`/env use`, `environments/<name>.yaml`, the tailcat ssh
  transport, `src/remote/`, `src/gateway/core/env-command.ts`,
  `src/gateway/api/remote-env.ts`, the `environment:` key of agent.yaml, the
  `shared-env/1` capability) are not changed, renamed or redesigned. See
  "Boundary with remote environments".
- **System-level changes are not durable.** A runtime `apt install`, a write
  to `/usr` or `/etc`, anything outside the home directory and the workspace
  is lost when the sandbox stops. System packages belong in the box image.
  This is accepted and documented, not a gap to close.
- No pod per session, and no call from a node to the Kubernetes API.
- No secret in a box, by any route: no per-box secret environment, no TLS
  inspection, no certificate authority inside the box.
- No secret-backed access from a box to a named host (a code host, a package
  registry) through a credential-adding proxy on the node. The provider proxy
  is the only such route. Private code goes through a gateway-side MCP server
  or the persona stays unboxed. slaude does not ship a code-host MCP server;
  the operator deploys one.
- No runtime approval of network destinations. The allowlist changes through
  git only.
- No pool of pre-started sandboxes in v1.
- No microVM tier. The interface leaves room for one.
- No image builds on nodes, no buildkit, no registry push from a node.
- No change to the gateway's trust model, the job token, labels as signed
  claims, or the MCP bridge.
- No sandbox for the gateway's own model children (decision gate, background
  passes) or for the voice child (`src/agent/voice-mcp.ts`).
- No forced move of existing personas into boxes.
- No cross-session blob dedup. No lazy hydration.

## Terminology

| Term | Meaning |
|---|---|
| **box** | A reviewed definition: one OCI image (by digest) plus a policy (egress, limits, stdio MCP servers, non-secret environment). Named, versioned. |
| **box image** | The OCI image of a box, identified by its digest. Immutable. |
| **box policy** | Everything in a box that is not the image. Applied when a sandbox starts or enforced live at the proxy. Changing it is not an image change. |
| **sandbox** | One running instance of a box for one session, on one node. Lives as long as the session is warm there. |
| **tier** | The isolation technology a node offers: `none`, `bwrap`, `gvisor`. |
| **base** | The unpacked box image on a node. Read-only, shared by every sandbox of that digest. |
| **home** | The session's `/home/agent`: a plain directory on the node, bind mounted into the sandbox. Durable. |
| **workspace extras** | The trees inside the workspace that the sync ignore list skips (`node_modules`, `.venv`, `__pycache__`, `.cache`). Durable, per image. |
| **root overlay** | The sandbox's throwaway writable layer over the base. Never synced. |
| **boxd** | A small privileged supervisor container in the node pod that runs sandboxes and packs directories. Holds no credential and makes no network call. |
| **node worker** | Today's `src/node/worker.ts` process. Holds the node credential, Redis, the object store and each session's proxies. |
| **pack unit** | A sync unit stored as a few packed archives instead of one object per file. |
| **parked** | A session that is no longer warm but whose local copies are still on the node's disk. |

## Design decisions

1. The name is **box**, in prose and identifiers (`box.yaml`, `src/box/`,
   `SLAUDE_BOX_*`, `box/1`).
2. Nodes become generic hosts. Toolchains move to box images. `tailcat` stays
   in the node image, because remote environments run from the node worker
   and are out of scope.
3. One sandbox per session, inside the node pod, started by the node worker
   through a `SessionSandbox` interface. Tiers: `none`, `bwrap`, `gvisor`.
   gVisor first.
4. **The agent process itself runs inside the box**, not only its tools. The
   SDK's `spawnClaudeCodeProcess` hook starts the CLI in the sandbox, and its
   stdio is the only channel to the node worker. Hooks, permission prompts
   and in-process MCP servers keep running in the node worker.
5. **Durable state is four directories**: transcript (`tx`), workspace (`ws`),
   workspace extras (`wx`), home (`hm`). The root filesystem is the image
   plus a throwaway overlay, in gVisor's fastest configuration. There is no
   synced root layer, no host overlayfs, no `--overlay2=none`.
6. **`hm` and `wx` are pack units.** The fencing, the manifest series named by
   epoch, the needs-flush mark and the unit lifecycle in `FsSync` are reused
   as they are. The per-file format is not, because of its cost per file.
7. **No secret in a box.** The provider credential stays in a proxy in the
   node worker, for every credential form. A persona whose credential form
   cannot work that way cannot be boxed.
8. **Paths are identical inside and outside the box** for the workspace, the
   session's config directory and the scratch directory. The SDK names the
   transcript directory after the real working directory, so a different path
   inside the box would change the `tx` unit and break resume across tiers.
9. Box images are built by CI and pulled by digest. The digest reaches a node
   inside the runtime bundle the gateway already signs for, so no separate
   image signature is needed. Registry only in v1; `slaude box import` loads
   an image from a local OCI layout for tests and offline nodes. No rootfs
   baked into the node image.
10. A session keeps its digest until a user asks or the box owner forces it.
    A refresh changes the digest and nothing else: home, workspace and
    transcript stay; workspace extras start empty because their unit is keyed
    by the digest.
11. Policy is not image. Egress rules apply to open sessions at the next
    connection; limits and MCP servers at the next sandbox start.
12. A node pod has a fixed capacity in boxes. A full node stops claiming new
    sessions; the queue backlog and resource pressure scale the Deployment.

## Architecture

```
                         gateway (unchanged role)
   deploy repo           +---------------------------------------------+
   boxes/<name>/         |  /deploy  payload v8: boxes[]               |
     box.yaml       -->  |  boxes, box_versions tables, signed set     |
     Dockerfile  CI      |  runtime bundle: box {name, digest, policy} |
        |      build     |  sessions.box_digest (pinned)               |
        v                |  dispatch: warm > parked > digest > label   |
   registry (by digest)  |  MCP bridge: every tool that needs a secret |
        |                +----------+----------------------+-----------+
        | pull by digest            | /v1 (job token)      | Redis
        v                           v                      v
 +------------------------------------------------------------------------+
 | node pod (capacity: N boxes)                                           |
 |                                                                        |
 |  node worker container                      boxd container (privileged)|
 |  src/node/worker.ts                         src/box/boxd/              |
 |  - node token, Redis, S3 creds              - no credential            |
 |  - AgentManager, hooks, shims,              - no network call          |
 |    MCP bridge, canUseTool                   - unpack images            |
 |  - FsSync: tx, ws, wx, hm                   - run / exec / kill runsc  |
 |  - admission and capacity                   - pack / apply directories |
 |  - per session:                             - cgroup limits per box    |
 |      egress proxy    (unix socket)                 |                   |
 |      provider proxy  (unix socket)                 |                   |
 |        ^      ^        control socket + stdio      |                   |
 |        |      +------------------------------------+                   |
 |  ======|=========================================================      |
 |        |  bind mounts only        sandbox (gVisor, network none)       |
 |  +-----|------------------------------------------------------------+  |
 |  |  /run/slaude/egress.sock, llm.sock                               |  |
 |  |  box-init (PID 1): 127.0.0.1:3128 -> egress.sock                 |  |
 |  |                    127.0.0.1:3129 -> llm.sock                    |  |
 |  |  claude CLI  <-- stdio --> node worker                           |  |
 |  |    Bash, stdio MCP servers (no credentials), plugin hooks        |  |
 |  |  /             base (read-only) + root overlay (thrown away)     |  |
 |  |  /home/agent   bind: the session's home                (durable) |  |
 |  |  <workspace>   bind, same path                         (durable) |  |
 |  |  <config dir>  bind, same path          (transcript:   durable)  |  |
 |  |  <scratch>     bind, same path     plugins, CLI: bind, read-only |  |
 |  +------------------------------------------------------------------+  |
 |                                                                        |
 |  $SLAUDE_BOX_DIR/images/<digest>/        shared, read-only             |
 |  $SLAUDE_BOX_DIR/sessions/<sid>/{home,overlay,run}                     |
 +------------------------------------------------------------------------+
        |
        v  object store (existing): sessions/tx-*, ws-*, wx-*, hm-*
```

Three processes, three privilege levels:

- **The sandbox** runs untrusted work. It has files and two sockets.
- **The node worker** is trusted. It holds credentials and decides policy. It
  never runs anything from a box image, a home or a workspace.
- **boxd** is privileged and holds nothing. It does only what needs
  privilege: sandbox processes, cgroups, reading and writing files owned by
  the sandbox's user.

## Box definition format

A box lives in the deploy repo beside personas, guardrails and environments:

```
boxes/
  ruby-dev/
    box.yaml
    Dockerfile        # optional, when image.build is used
```

```yaml
# yaml-language-server: $schema=https://<docs site>/schemas/box.schema.json
version: 1
name: ruby-dev                      # must equal the directory name
description: Ruby 3.3 and Node 22 for the storefront repositories

image:
  # Exactly one of build or ref.
  build:
    dockerfile: Dockerfile
    context: .
  # ref: ghcr.io/example/boxes/ruby-dev@sha256:...   (a digest; a tag is refused)

tier: gvisor                        # the weakest tier this box may run on

resources:
  cpu: 2                            # cores, a ceiling
  memoryMb: 3072                    # a ceiling; the sandbox is killed above it
  memoryReserveMb: 1024             # what a node sets aside to admit this box
  pids: 512
  homeMb: 4096                      # the durable home
  workspaceExtrasMb: 4096           # node_modules, .venv and the like
  rootOverlayMb: 2048               # throwaway system-level writes

egress:
  allow:                            # everything else is refused
    - registry.npmjs.org
    - rubygems.org
    - github.com                    # port 443 unless stated
    - "*.githubusercontent.com"
  deny: []                          # wins over allow

env:                                # not secret; a value that looks like a credential fails the sync
  BUNDLE_JOBS: "4"

mcp:
  stdio:                            # programs in the image; no credentials
    ruby-lsp:
      command: /usr/local/bin/ruby-lsp-mcp
      args: ["--stdio"]

durable:
  exclude: []                       # home paths never packed, for example ".cache/huggingface"

refresh:
  force: false                      # true: sessions on an older image move at their next turn
  note: ""                          # shown to users when force is true
```

There is no `secrets` key and no placeholder syntax. `${` anywhere in the file
fails the sync: nothing is expanded, so nothing can be smuggled through an
expansion. `env` values and `mcp.stdio` arguments are checked against the
repository's secret shapes (the masks in `src/redact/`) and a match fails the
sync, naming the field and never the value.

Rules, following the agent.yaml conventions (`src/persona/agent-schema.ts`):
one Zod schema, a generated JSON schema with a drift test, unknown and
duplicate keys fail the sync, error messages name the field.

**Image requirements**, checked by `slaude box check` in CI and again by the
node when it unpacks:

- linux, an architecture the nodes run, glibc (the CLI binary the SDK ships
  for Linux is bind mounted into the box; a musl image is not supported in
  v1);
- a user `agent` with a fixed uid and gid (10001) and home `/home/agent`;
- `git` and `ca-certificates` present;
- no `ENTRYPOINT` is used: the node starts `box-init`, then the CLI.

What the image puts in `/home/agent` (dotfiles, a preconfigured tool) seeds a
new session's home once, at its first start. After that the session's own
home shadows it.

**How it compiles.** `slaude personas sync` (`src/cli/personas.ts`) gains a
box step:

1. Parse and validate every `boxes/*/box.yaml`.
2. For `image.build`: hash the build context (the Dockerfile and every file
   under `context`, sorted). If the registry already holds
   `<repo>/<name>:ctx-<hash>`, reuse its digest. Otherwise build, push that
   tag, and read the digest. A rebuild therefore happens only when a reviewed
   file changed. The build runs in CI with CI's registry credentials; the
   gateway and the nodes never build.
3. For `image.ref`: use the digest as written.
4. Send `boxes: [{ name, description, image: "<repo>@sha256:...", tier,
   resources, egress, env, mcp, durable, refresh }]` in the deploy payload
   (version 8; `SUPPORTED_PAYLOAD_VERSION` in `src/persona/sync/payload.ts`).

The gateway stores a box as a row per version and signs the set the same way
guardrails are signed (`src/guardrails/integrity.ts`): an HMAC per row and one
manifest row over the sorted list, so a deleted or replayed row does not
verify.

**How a persona names a box.** One key in agent.yaml:

```yaml
box: ruby-dev
```

A persona without the key runs unboxed (tier `none`). An operator may set a
deployment default (`SLAUDE_BOX_DEFAULT=<name>`) for personas without the
key; unset, nothing moves. The key is a plain name, like a guardrail slug.

**Versioning.** The gateway numbers versions per box (1, 2, 3). A new version
is recorded when the digest or the policy changes. A version stores `digest`,
`policy`, `forced`. Sessions pin a digest, never a version number, so a
policy-only version changes nothing about which image a session runs.

### The GitOps flow, end to end

The people who deploy slaude own the boxes. Every change, the egress
allowlist included, is a reviewed change in the deploy repository. There is
no runtime approval, no Slack card, no console edit.

1. **Edit.** Someone opens a pull request on the deploy repo changing
   `boxes/<name>/box.yaml` (a new allowed host, a limit) or its Dockerfile.
2. **Check.** CI on the pull request runs the sync in dry-run mode
   (`?dryRun=1&strict=1`, the existing mode): the schema, the secret-shape
   check, unknown boxes named by personas, and for an image change a build
   without a push. The dry run prints the diff the gateway would record
   ("egress: +pypi.org", "image: new digest").
3. **Review.** A reviewer approves. For `image.build` the reviewed thing is
   the Dockerfile; the context hash ties the built image to it. Teams that
   want the digest itself in git use `image.ref`.
4. **Merge and compile.** CI on the main branch runs the sync: build and push
   if the context changed, then one `/deploy` request carrying personas,
   guardrails, environments and boxes.
5. **Store and sign.** In the sync transaction the gateway writes a new
   `box_versions` row when the digest or the policy differs, re-signs the set,
   and bumps the set version, which is an input of the runtime bundle's ETag.
6. **Announce.** The gateway publishes the existing tenant reload
   announcement on Redis (`makeTenantReloadHandler` in `src/node/worker.ts`
   is the node's subscriber).
7. **Nodes react.** Each node drops its cached bundles for the tenant. Its
   prewarm loop fetches the box list and pulls any new digest.
8. **Open sessions pick up a policy change with no refresh.** The egress
   proxy asks the bundle cache for the session's rules at every new
   connection, so the first connection after the announcement is judged by
   the new list. When a change removes a host, the proxy also closes that
   session's open tunnels to hosts the new list refuses. Limits, environment
   and stdio servers apply the next time the sandbox starts. An image change
   reaches a session only through a refresh.
9. **Audit.** The sync writes an audit row per changed box (who synced, the
   version, a diff summary), like guardrail changes.

Worst-case delay for an allowlist change to reach a running session: the
announcement's delivery (sub-second) or, if a node missed it, the bundle
cache's revalidation at the next turn.

## Sandbox tiers and the SessionSandbox interface

```ts
// src/box/sandbox.ts
export type BoxTier = "none" | "bwrap" | "gvisor";

export interface BoxMount {
  source: string;
  target: string;          // equal to source for workspace, config and scratch
  mode: "ro" | "rw";
}

export interface BoxSpec {
  sessionId: string;
  tenantId: string;
  persona: string;
  digest: string;                      // pinned image
  policy: BoxPolicy;                   // limits, env, stdio servers
  mounts: BoxMount[];                  // home, workspace, config dir, scratch, plugins, CLI
  cwd: string;
}

export interface SessionSandbox {
  readonly tier: BoxTier;
  /** Start the sandbox. Idempotent. */
  start(): Promise<void>;
  /** The Agent SDK's spawnClaudeCodeProcess: run the CLI inside, stdio piped. */
  spawn(o: SpawnOptions): SpawnedProcess;
  /** Memory, process count and disk, for limits, admission and metrics. */
  stats(): Promise<{ memoryBytes: number; pids: number; homeBytes: number; overlayBytes: number }>;
  /** Kill every process and remove the root overlay. Home and workspace stay for the sync. */
  stop(reason: "idle" | "pressure" | "evict" | "fenced" | "refresh" | "drain" | "error"): Promise<void>;
}

export interface SandboxDriver {
  readonly tier: BoxTier;
  /** Whether this node can run the tier, and why not. Checked once at boot. */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  create(spec: BoxSpec): SessionSandbox;
}
```

`AgentManager` gets one seam, `setSandboxResolver((sessionId) =>
Promise<SessionSandbox | null>)`, in the style of its existing resolvers. In
the boot path (`src/agent/manager.ts`, where `options` is built) a non-null
sandbox adds `spawnClaudeCodeProcess: (o) => sandbox.spawn(o)`. Nothing else
in the manager changes: hooks, `canUseTool` and in-process MCP servers already
cross the child's stdio.

| Tier | Isolation | Image | Where |
|---|---|---|---|
| `none` | Today's behaviour. The resolver returns null. | Not used. The node's own toolchain. | mono, dev, macOS, any persona that has not opted in |
| `bwrap` | Namespaces, seccomp, no capabilities, shared kernel. | Same base, home, packs and proxies as `gvisor` on Linux. On macOS: Seatbelt through sandbox-runtime, host filesystem, no image. | The fallback tier; macOS dev |
| `gvisor` | A user-space kernel (runsc) between the agent and the host kernel. | Base plus a throwaway overlay. | Production |
| `microvm` | Not built. | | Later |

**Ordering.** `none < bwrap < gvisor`. A box states the weakest tier it
accepts. A node advertises the strongest it offers as a capability
(`box/1`, `box-tier/gvisor`). Dispatch refuses a persona to a node below its
box's tier with the existing capability gate.

**What spawn does to the environment.** The SDK hands `spawn` the child's
environment, which today contains provider credentials. The sandbox builds
the box's environment from nothing instead of filtering:

- from the image config: `PATH`;
- fixed: `HOME=/home/agent`, `LANG`, `TMPDIR` and `SLAUDE_SCRATCH` (the
  session's scratch directory), `CLAUDE_CONFIG_DIR` (unchanged path);
- proxy: `HTTP_PROXY`, `HTTPS_PROXY`, their lower-case forms, all
  `http://127.0.0.1:3128`; `NODE_USE_ENV_PROXY=1`;
  `NO_PROXY=127.0.0.1,localhost`;
- provider: `ANTHROPIC_BASE_URL=http://127.0.0.1:3129` and a **placeholder**
  in the variable of the persona's credential form (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`), so the CLI behaves as
  it would with the real one; the non-secret provider variables (model names)
  pass;
- from the SDK's environment: names starting with `CLAUDE_` or `ANTHROPIC_`
  that are not in `PROVIDER_ENV_KEYS` (`src/agent/provider-env.ts`), plus
  `SLAUDE_AGENT_ID`;
- from the box: `env`.

Nothing else from the node's environment enters a box.

**The session's config directory holds no credential in a box.** Today a node
can write MCP access tokens into the session's `.credentials.json`
(`src/node/credentials.ts`, already marked for retirement in favour of the
bridge). A boxed session never gets that file: the node skips the seeding,
and the sandbox start refuses a config directory that contains one. A persona
that still depends on node-side seeding is not boxable until it uses the
bridge.

### The gVisor configuration

Chosen from the gVisor filesystem and networking guides for the case where
only bind mounts must be visible from the host:

- **Root filesystem: the unpacked image, read through the gofer, with
  gVisor's own overlay on top** (`--overlay2=root:dir=<session>/overlay` with
  a size limit). The overlay's data lives in one file per session on the
  node's disk, so system-level writes cost disk, not memory, and vanish with
  the sandbox. The docs' other media: `memory` (charged to the sandbox's
  memory, which would eat the per-box budget) and `self` (a hidden file in
  the root directory, which here is shared between sandboxes; behaviour with
  a shared root is unverified, so it is avoided).
- **Candidate improvement: an EROFS image as the base.** The docs describe an
  EROFS root as memory-mapped into the sentry with no gofer round trips for
  reads, usable as the lower layer of the root overlay. It would make reads of
  the toolchain (interpreters, compilers, libraries) the fastest available.
  It costs one `mkfs.erofs` per digest at unpack. Phase 0 measures it; it is
  adopted if it wins and works nested.
- **Home, workspace, config and scratch: bind mounts through the gofer**, in
  the default shared mode. gVisor's exclusive mode for bind mounts caches
  harder but is documented as unsafe when anything outside the sandbox
  changes the files, and the node does write into a live workspace (files the
  gateway staged, `drainInbox` in `src/storage/inbox.ts`). Exclusive mode is
  measured in Phase 0 and adopted only if the gain justifies moving those
  writes.
- `--network=none` (the docs: the sandbox "will still contain a loopback
  provided by netstack"), `--platform=systrap`, directfs on (the default).
- Every capability dropped, `noNewPrivileges`, the `agent` user, limits from
  the box's `resources`.
- The sandbox runs detached with `box-init` as PID 1; the CLI runs with
  `runsc exec` and piped stdio. A child reboot (a lock flip, a reload) is
  another `exec` in the same sandbox.

**Where the performance risk now is.** The agent's heavy file work (git,
installs into the workspace, caches in home) happens on bind mounts, and bind
mounts go through the gofer. The root filesystem is no longer the concern.
Phase 0's benchmark is built around that.

Unverified and in Phase 0: that a bind-mounted host Unix socket is
connectable from the sandbox (the flag is believed to be `--host-uds`); that
cgroup limits apply when runsc runs nested in a privileged container; that
`exec` stdio carries the SDK's control protocol without buffering problems;
the systrap platform inside a pod on common managed node images; the
`dir=` overlay medium with one directory per sandbox.

**Phase 0 results (dev VM, 2026-11-24).** Measured on a Mac VM (Ubuntu 24.04
aarch64, kernel 6.8, 4 vCPU, no KVM, runsc release 20261116.0, systrap), alone
and in a privileged docker container; **not** on the owner's cluster, so
nothing here retires R1. Detail and raw numbers: `docs/site/_content/field-notes/2026-11-24-box-spikes.md`.

- Confirmed: a host Unix socket bind mounted into the sandbox is connectable
  with `--host-uds=open` (the values are `none`, `open`, `create`, `all`;
  the default `none` refuses); loopback works with `--network none`; the
  `root:dir=<dir>,size=<n>` overlay takes the writes (1 GB landed in the
  directory, the image directory stayed untouched), refuses writes past its
  size with "no space left on device", and two sandboxes on one image
  directory with different `dir=` values do not see each other; `exec` stdio
  round trips 100 MB intact; memory, pids and cpu limits from the OCI spec
  take effect (a memory kill stops the **whole sandbox**).
- Corrections: the bundle must set `root.readonly: false`. With `true` the root
  is read-only even under the overlay and every write fails. The `pids` limit
  counts host threads of the sandbox (an idle sandbox holds 25 to 30; about
  2 per process). Killing the `runsc exec` client does not end the process
  inside; the CLI must be run with `runsc exec --new-pidns --internal-pid-file`
  and ended with `runsc kill --pid`.
- Needed: inside a container with its own cgroup namespace, runsc fails to
  start unless the container's processes are first moved to a child cgroup
  and the controllers enabled in `cgroup.subtree_control`. With that done the
  sandbox's memory is charged to the boxd container's cgroup.
- Bind mounts and exclusive mode: with `--file-access-mounts=exclusive` the
  sandbox does not see a host-side new file, removal or size change (still
  stale after 5 s), so exclusive mode is **not usable** while the node writes
  into a live workspace. `--directfs=false` is 5x to 60x slower on file work;
  keep directfs on.
- EROFS base (C3): not usable on this runsc build. Only an uncompressed image
  mounts, and every `exec` from it fails with `bad address`. Left as not run.
- Measured cost of C1 against runc on this VM (3 runs): `git clone` 3.0x, `git
  status` 2.6x (+0.45 s), `bun install` warm 4.3x (+2.2 s), `rg` 8.1x; reads of
  the toolchain from the root at parity. The scripted ten tool call turn is
  2.4x (+0.96 s) with a zero-latency model, which exceeds K2c as written; the
  real-model turn that K2c is paired with has not been run.
- Sandbox start: median 31 to 37 ms for `run --detach` plus the first `exec`.

Node layout:

```
$SLAUDE_BOX_DIR (default /var/lib/slaude-box)
  images/<digest>/rootfs/          unpacked base, read-only, root-owned
  images/<digest>/config.json      image config (PATH, user)
  sessions/<sid>/home/             the session's home (durable through hm)
  sessions/<sid>/overlay/          the root overlay's backing file (thrown away)
  sessions/<sid>/run/              egress.sock, llm.sock (bind mounted at /run/slaude)
  spool/                           packs in transit between boxd and the worker
```

Nothing on the node ever executes a file from `images/` or `sessions/`.

## Durability and sync

A session's durable state:

| Unit | Holds | Keyed by | Format | Status |
|---|---|---|---|---|
| `tx-<hash>` | SDK transcript directory | directory | per file | exists |
| `ws-<hash>` | workspace, minus the ignore list | directory | per file | exists |
| `wx-<hash>-<digest12>` | the workspace trees the ignore list skips | directory and box image | pack | new |
| `hm-<session>` | `/home/agent` | session | pack | new |
| (pinned) | box name and digest | session row | database | new |

**What home covers.** Everything a tool writes under `$HOME`: global package
installs (`npm -g` with a home prefix, `pip install --user`, `cargo install`,
`go install`), tool caches (`~/.npm`, `~/.bun`, `~/.cache/uv`,
`~/go/pkg/mod`, `~/.cargo/registry`), shell history, tool configuration. The
default box image points package managers at home (a user-level npm prefix,
`PIP_USER`, `GOPATH`) so an ordinary "install this tool" lands somewhere
durable. A box may exclude paths (`durable.exclude`) to keep a very large
cache out of the packs; an excluded path lives on the node until the session
leaves it.

**What is not durable, stated to the agent and the user.** The root overlay:
`apt install`, `/usr/local`, `/etc`, `/opt`, `/var`. The system prompt of a
boxed session carries one line saying so ("system packages installed at
runtime do not persist; ask for them to be added to the box image; your home
directory and the workspace persist"), and `docs/site/_content/deploy/boxes.md`
says it in its first section.

Why `wx` is keyed by the image too: native modules are compiled against the
box's libraries. A directory can be shared by sessions pinned to different
images (a channel folder, one session refreshed and one not). Keying by
directory and image gives each image its own installs and makes a refresh
start clean with no deletion.

Why `hm` is keyed by session, unlike `ws`: a home belongs to one sandbox. Two
sessions never share one, so session close decides its fate.

### What is reused, unchanged

- The `Unit` lifecycle in `src/node/fs-sync.ts`: `beforeTurn` prepares each
  unit under the session lock, `afterTurn` flushes, `evict` flushes, `drain`
  flushes at shutdown.
- Fencing: an epoch per unit from Redis (`fsEpoch`), raised above the stored
  maximum, checked once just before the manifest is written.
- Manifest naming (`<epoch>-<seq>`), "highest wins", `latestManifest`.
- needs-flush marks, the disk id, "the same node flushes before it reads",
  wait for a live owner, count a loss for a dead one.
- The in-use mark and the unit sweeper (`src/storage/sweep.ts`), which lists
  `sessions/` and so covers the new units with no change.
- The `SLAUDE_SYNC_FLUSH` cadence: the new units flush when `ws` flushes.

### The pack format

A pack unit's manifest (version 2 of `Manifest`, a new `kind`):

```json
{
  "version": 2, "kind": "pack", "sessionId": "hm-<session>",
  "epoch": 7, "seq": 3, "createdAt": 0,
  "layers": [
    { "hash": "<sha256 of the archive>", "bytes": 181000000, "entries": 51234,
      "removed": [] },
    { "hash": "...", "bytes": 240000, "entries": 12, "removed": [".cache/x"] }
  ]
}
```

- A **layer** is one zstd-compressed tar of the entries that changed since
  the previous layer: regular files, directories, symlinks, hard links,
  modes, mtimes. `removed` lists paths that were deleted. Everything in a
  home or a workspace belongs to the one sandbox user, so owners are not
  stored: apply writes every entry as `agent`.
- **Flush**: boxd walks the directory and compares it with a local index
  (path to type, size, mtime, ctime, inode, mode) kept beside the marker. No
  change: nothing is written (same as `flushTree`). Otherwise boxd writes the
  delta archive to the spool, the node worker uploads it as a blob
  (`sessions/<unit>/blobs/<hash>`, the existing key) and writes a manifest
  with the layer appended, after the fence check.
- **Compaction**: when a unit has more than 8 layers, or its layers hold more
  than 1.5 times the live bytes, the next flush writes one full layer
  instead. `gcSession` then drops the old manifests and the blobs only they
  referenced (its liveness set reads `layers[].hash` for a pack manifest).
- **Hydrate**: download the layers in order into the spool, boxd applies each
  into an empty directory, then writes the marker and rebuilds the index. A
  node whose marker names the latest manifest does nothing.

**Apply is confined.** An archive comes from a directory the agent
controlled. boxd validates the listing first (relative paths only, no `..`,
regular files, directories, symlinks and hard links only) and extracts with
every path resolved inside the target directory (a chroot or an equivalent),
so a symlink planted in one layer cannot redirect a later layer's write.
Set-uid and set-gid bits are stripped.

**Who does what.** boxd reads and writes the directories (the files belong to
the sandbox's user, and the tar work is CPU that should be charged where the
boxes are). The node worker moves bytes to and from the object store because
it holds the credentials. boxd never has a credential; the worker never opens
a file inside a home.

Why a pack and not the existing per-file format: a
home with package caches and a `node_modules` tree are both tens of thousands
of small files, which is exactly where the per-file format costs minutes. The
format is simple, because one user owns everything: no owners, no extended
attributes, no device nodes.

### Cost estimates (not measured)

For a 500 MB, 50,000 file tree (a `node_modules`, or a home with caches):

| Step | Per file (today's format) | Pack |
|---|---|---|
| Stored objects | 50,000 blobs and a 7 MB manifest | 1 archive of about 150 MB, a 1 KB manifest |
| First flush | 50,000 HEAD and PUT requests, 100 s or more | compress about 2 to 4 s, upload about 2 to 5 s |
| Later flush, 10 files changed | scan and a 7 MB manifest rewrite | scan about 0.5 s, a small archive |
| Cold hydrate | 50 s to 4 min | download 2 to 5 s, extract 5 to 15 s |

A cold resume of a heavy session (a large home and a large `wx`) should land
at 10 to 20 s, inside the accepted first-turn delay of about 20 s; a light
session well under a second. The Phase 5 load test replaces these numbers
with measured ones, and its result is checked against the 20 s budget.

### Parking: local copies stay after idle

When a session goes idle the node flushes its four units and stops the
sandbox, but **keeps the local directories and their markers**: home,
workspace, workspace extras, transcript. The session is parked. A resume on
the same node finds every marker current, hydrates nothing, and pays only the
sandbox start.

- Parked copies are bounded by a disk budget (`SLAUDE_BOX_PARK_BUDGET_MB`,
  on by default at half of the box data volume). When the budget or free disk
  runs short, the least recently used parked session is dropped (it is
  already flushed, so dropping is a delete).
- A parked session holds disk only: no sandbox, no memory, no capacity slot.
- The node records `parked:<session> -> node` in Redis with a TTL; dispatch
  prefers that node while it is alive and has a free slot.
- A parked copy is only trusted through its marker, as today: if another node
  ran the session since, the stored manifest is newer and the hydrate
  replaces the local copy.
- This changes `FsSync.evict` for boxed sessions (flush, then keep) and adds
  a pruner. Unboxed sessions keep today's behaviour.

There is no pool of pre-started sandboxes in v1.

### Without S3

With `SLAUDE_STORAGE` unset (the shared volume), `tx` and `ws` live on the
volume as today, and `hm` and `wx` stay on the node's own disk. A cold resume
on another node then starts with an empty home and no workspace extras. The
node logs this once at boot, and the box documentation says that durability
of home and installs needs `SLAUDE_STORAGE=s3`.

### What a pack can contain

With no secret in a box, a pack should hold nothing sensitive that slaude
put there. An agent can still write what a user pasted into the thread. The
rules:

- The object store path is per unit, a home unit is per session, and session
  ids are not guessable. A node of another label holds the same bucket
  credentials today; per-label prefixes with separate credentials
  (`SLAUDE_S3_PREFIX` per label) are what this design recommends for labels
  that separate trust.
- Encryption at rest is the bucket's. Client-side encryption is not planned
  for v1.
- **The node never executes, sources or parses for behaviour anything from a
  home, a workspace or a workspace-extras tree.** The only operations are
  archive create and confined archive apply.

## Image build, pull and prewarm

- **What a node pulls.** `GET /v1/node/boxes` (new, node credential, label
  gated like the persona routes) returns the boxes of personas that run on the
  node's labels: `{ name, image, digest }` for the current version and for
  every digest a live or parked session is pinned to.
- **How.** boxd cannot reach the network, so the node worker downloads by
  digest into the spool as an OCI layout (v1: `skopeo copy` with the digest
  in the reference, which verifies content; an optional registry pull
  credential is a node secret, `SLAUDE_BOX_REGISTRY_AUTH`, never passed to
  boxd or a box). boxd unpacks it to `images/<digest>/rootfs` (v1:
  `umoci unpack`) and runs the image checks. Both tools are replaceable
  behind `src/box/image.ts`.
- **Report.** The heartbeat carries the cached digests and the node's free
  capacity (a Redis key per node with the node TTL, like `nodeCaps` in
  `src/queue/registry.ts`). The console shows which nodes hold which digest,
  read-only, like the plugin inventory.
- **Cost of a new session on a warm digest.** One sandbox start. No download.
- **A node that lacks the digest** and claims the job anyway pulls first,
  under a deadline, with a status line ("preparing the box"). A pull that
  fails fails the turn with a clear failure code, never an unboxed run.
- **Eviction.** A node keeps digests that are current or pinned by a session
  warm or parked on it, and evicts the rest least recently used above a disk
  budget (`SLAUDE_BOX_IMAGE_BUDGET_MB`).
- **Offline.** `slaude box import <oci layout dir>` loads an image into a
  node's cache from disk.

## Refresh semantics

- **Pin.** At the first dispatch of a session whose persona has a box, the
  gateway writes `sessions.box_name` and `sessions.box_digest`
  (compare-and-set from null). The node reads them from the session view; it
  never chooses a digest.
- **A session never moves on its own.** A new box version changes new
  sessions only.
- **A refresh is a new digest and nothing else.** Home, workspace and
  transcript are kept. Workspace extras start empty, because the `wx` unit id
  contains the digest; the old unit ages out.
- **User refresh.** `/box refresh` in the thread: the gateway ends the warm
  session through the existing reload route and sets `box_digest` to the
  current one. The next turn boots on the new image. It gets a short
  `<box-refreshed>` note: the toolchain changed, reinstall the project's
  dependencies, and compiled caches in home may need clearing.
- **Forced.** A version with `refresh.force: true` marks every older digest
  of that box stale. At the next dispatch of a session pinned to a stale
  digest the gateway does the same refresh (never during a turn) and posts a
  private notice with the box's `note`.
- **`/box status`** shows the box, the pinned digest (short), whether a newer
  version exists, the tier, and disk use against the limits.
- **Home after a refresh.** Home is kept on purpose, so caches of compiled
  artefacts (a Go build cache, wheels built for the old Python) can be stale
  against the new image. Tools mostly detect this; where they do not, the
  agent clears the cache. A command that empties a session's home is listed
  under "Later", not built.
- **Policy** needs no refresh (see the GitOps flow).
- **A digest that is gone** (deleted from the registry and from every node):
  the boot fails with `BOX_IMAGE_UNAVAILABLE` and the notice offers
  `/box refresh`.

## Credential and egress model

**Rule: nothing in a box is a secret.** What each party holds:

| | Gateway | Node worker | boxd | Box |
|---|---|---|---|---|
| Master key, job secret, database | yes | no | no | no |
| Node credential, Redis, object store | n/a | yes | no | no |
| Job token | mints | holds per session | no | no |
| Provider credential (API key, auth token, OAuth token) | stores | holds per session, in the provider proxy | no | **no, in every form** |
| MCP credentials | holds (bridge) | no | no | no |
| Tool tokens (git hosts, package registries, cloud CLIs) | holds, behind MCP servers | no | no | no |
| Registry pull credential | no | optional | no | no |

**The box has no network.** The only ways out are two Unix sockets in a
per-session directory that the node worker owns and boxd bind mounts at
`/run/slaude`:

- `egress.sock`: an HTTP proxy (CONNECT and plain HTTP) run by the node
  worker (`src/box/egress/proxy.ts`), one listener per session so every
  request is attributed without trusting anything the box says.
- `llm.sock`: the provider proxy (`src/box/egress/llm.ts`), a reverse proxy
  to the persona's provider base URL from the bundle.

`HTTP_PROXY` cannot name a Unix socket, so `box-init`, PID 1 in every box,
relays `127.0.0.1:3128` and `:3129` to the two sockets. It is a small program
from this repository, bind mounted read-only, and it also reaps orphans. It
makes no decision: a compromised `box-init` gains nothing the agent did not
already have.

### The provider proxy is a hard requirement

Because no credential may enter a box, the CLI must run with a placeholder
and the provider proxy must supply the real credential for **all three**
forms slaude supports:

| Form | In the box | The proxy does |
|---|---|---|
| API key (`ANTHROPIC_API_KEY`) | placeholder | replaces `x-api-key` |
| Auth token (`ANTHROPIC_AUTH_TOKEN`) | placeholder | replaces `Authorization: Bearer` |
| OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) | placeholder | replaces `Authorization: Bearer`, passes the CLI's own headers through untouched |

The proxy forwards to exactly one upstream (the persona's base URL), streams
responses, strips whatever credential header the box sent before adding the
real one, and never echoes the real one back. It reads the credential from
the session's bundle, so a rotation reaches it without touching the box.

The first two forms are ordinary header replacement. **The OAuth form is the
uncertain one**: with an OAuth credential the CLI chooses different request
headers and may make requests other than the Messages call (unverified).
Whether a placeholder plus header replacement is enough is a **blocking
Phase 0 spike** with a kill criterion (plan, spike 3).

**If the OAuth form cannot be made to work behind the proxy:** the rule is
kept and the feature is narrowed. A persona whose provider credential is an
OAuth token is **not boxable**: the sync warns, dispatch runs it unboxed on
tier `none` if the operator left that available, and refuses it otherwise
with a clear notice. The token is never put into a box to make it work. The
owner should know the cost: those personas stay in today's one-trust-domain
mode until they are given an API key or auth token. If the owner would
rather box them with the token inside, that is a deliberate exception to the
no-secrets rule and a new decision, not something this design does quietly.

### Egress policy

Evaluated in the node worker (`src/box/egress/policy.ts`):

- **refuse by default**; allow and deny entries are host names with an
  optional port and an optional leading `*.`; deny wins;
- the proxy resolves the name itself, refuses private, loopback, link-local
  and metadata addresses with the existing `src/net/outbound-policy.ts`, and
  connects to the address it checked (no second resolution);
- the gateway's address, Redis and the object store endpoint are always
  refused, whatever the list says;
- a refusal is counted, logged with the session and the host (not the path),
  rate limited into the audit trail, and returned to the client as a 403
  whose one line the agent can read: the host is not on this box's allowlist,
  and the allowlist is changed by the people who deploy slaude.

**The default box** (`boxes/default/` in this repository) allows the common
package registries and code hosts: the npm, PyPI, RubyGems, crates.io and Go
module registries and their file hosts, the Debian package mirrors (so a
non-durable `apt install` still works inside a session), and the main public
code hosts over HTTPS. The exact list is in the box file and is the thing an
operator reviews and edits.

Honest limits: with no TLS inspection the proxy sees the CONNECT host only.
An allowed CDN can front for another site on the same provider, and an
allowed host that accepts uploads is an exfiltration path. The allowlist
narrows where data can go; it does not prove what was sent. Tools that
ignore proxy variables fail closed (there is no route), which is the right
failure.

### What "no secrets" means for tools

Anything that authenticates is a gateway-side MCP server (a persona's `mcp`
in agent.yaml, HTTP, credentials as `${PERSONA_*}` or connected through the
portal), reached through the bridge. From inside a box:

- public package installs and public clones work, through the allowlist;
- **a private repository cannot be cloned or pushed with git, and a private
  package registry cannot be read**, because that needs a token in the box.
  Private code reaches a session through a gateway-side MCP server for the
  code host, or not at all in v1;
- cloud CLIs, database clients and the like have no credentials to use.

This is the direct consequence of the rule and the largest behaviour change
for an agent that today inherits a token from its node. The supported path for private code is a gateway-side MCP server for the
code host; a persona that cannot work that way stays unboxed. Giving a box
secret-backed access to a named host was considered and rejected (see
"Decisions").

### Relation to what exists

- The MCP bridge and the reply shims are in-process servers in the node
  worker and are not touched. A bridged tool call never passes through the
  box's proxy.
- Job tokens stay in the node worker (`bindToken`, `tokenFor`).
- `src/agent/child-env.ts` (`scrubChildEnv`) stays for the `none` tier and
  for mono. A boxed spawn does not use it.
- `src/node/harden.ts` stays. On the `none` tier it is still the only thing
  between a tool and the node token. On a sandbox tier it is defence in
  depth.
- The upload tool (`src/node/upload.ts`) reads the workspace and the scratch
  directory from the node side, as today. Both are plain bind mounts at
  unchanged paths, so its realpath confinement is unchanged.

## Stdio MCP servers and the node manifest

A stdio MCP server is a program, so it belongs with the toolchain: in the box
image, declared in `box.yaml` under `mcp.stdio`. In a box it can have **no
credential**.

- For a boxed session the node's local MCP resolver returns the box's
  `mcp.stdio` (from the bundle) instead of the node manifest's. The servers
  start inside the sandbox as children of the CLI, with the box's
  environment.
- `${` is refused anywhere in a box's stdio config, at compile on the gateway
  and again on the node, so the CLI's second expansion (the reason for the
  rules in `src/node/manifest.ts`) has nothing to act on. The checks for
  names and keys are shared with the node manifest through one extracted
  function.
- The exec wrapper (`src/node/mcp-exec.ts`) is not used in a box: there is no
  provider key in the CLI's environment to keep away from a server.
- `strictMcpConfig` stays on.

**Impact on today's node manifest servers.** Each server in a node manifest
falls into one of three cases:

| Server today | In a box |
|---|---|
| No `env`, or only literal non-secret values (a linter, a language server, a local search tool) | Moves to `mcp.stdio` unchanged; the image must contain the command. |
| `env` references a node secret (`"TF_TOKEN": "${NODE_TF_TOKEN}"`, a code-host token) | **Cannot move into a box.** It must become a gateway-side server: run it as an HTTP MCP service the gateway can reach (the server's own HTTP transport, or a stdio-to-HTTP wrapper deployed beside the gateway), declare it in the persona's `mcp` with its credential as a `${PERSONA_*}` placeholder, and it reaches the agent through the bridge. |
| A server that needs both a token and the session's files (it reads the workspace and calls an API) | Does not fit: a gateway-side server cannot see the workspace, and a boxed one cannot hold the token. The persona stays unboxed, or the server is split. |

`slaude box from-manifest <node.json> <persona>` prints, per server, which
case it is: an `mcp.stdio` block for the first, and for the others the reason
and what to deploy instead.

**Migration of `SLAUDE_NODE_MANIFEST`:**

1. Unchanged for unboxed sessions. A node reads it exactly as today.
2. A boxed session ignores it. If the manifest allows a persona that is
   boxed, the node logs one warning at boot naming the persona.
3. The manifest and `mcp-exec.ts` stay in the product as long as tier `none`
   does, which is indefinitely.

**Labels.** A label stays what it is technically: a signed claim on the node
credential and the job token that gates the credential path. What an operator
needs it for changes:

| Purpose | Before | With boxes on a sandbox tier |
|---|---|---|
| Keep two personas' secrets apart | Required: different labels | Not required: there are no secrets in a box, and the sandbox separates files |
| Toolchain ("this persona needs Ruby") | A label and a custom node image | Gone: the box image |
| Capability and capacity routing (size, region, tier) | Label | Label |
| Separation that must survive a sandbox escape | Label | Label, still recommended |
| Redis and bucket reach | Not separated by labels | Unchanged |

The documents that say "a node is one trust domain" become tier-conditional:
true on `none`, replaced by the security section below on a sandbox tier.

## Capacity, admission and autoscaling

Boxes run inside the node pod, so a node pod is the unit of capacity and the
Deployment's replica count is the only thing that scales.

### What a pod must hold

Two containers:

| Container | Runs | Sized for |
|---|---|---|
| `node` | the worker: SDK clients, hooks, proxies, sync uploads | small and roughly constant per session: about 0.5 CPU and 512 MB, plus about 20 MB per warm session (to be measured) |
| `boxd` | every sandbox (sentry, gofer, the CLI, the agent's processes), packing | the sum of the boxes |

Per box, from `box.yaml`:

| Limit | Enforced by | Kind |
|---|---|---|
| `memoryMb` | the sandbox's cgroup | hard ceiling; the sandbox is killed above it |
| `memoryReserveMb` | the node's admission | what is set aside; default a third of `memoryMb` |
| `cpu` | the sandbox's cgroup quota | ceiling; CPU is overcommitted |
| `pids` | cgroup | hard; counts host threads of the sandbox (about 30 at idle, about 2 per process), so set it well above the process count wanted |
| `homeMb`, `workspaceExtrasMb` | measured at flush | soft (below) |
| `rootOverlayMb` | the overlay's size option | hard; writes fail with "no space" |

Node settings:

| Variable | Meaning | Default |
|---|---|---|
| `SLAUDE_NODE_MAX_BOXES` | Most sandboxes running at once on this pod | 8 |
| `SLAUDE_BOX_MEMORY_BUDGET_MB` | Memory the boxes may reserve in total | 85 percent of boxd's cgroup memory limit, read at boot |
| `SLAUDE_BOX_SANDBOX_OVERHEAD_MB` | Added to each reserve for the sentry and gofer | 150 (kept after Phase 0: idle sentry plus gofer measured 10 to 40 MB, peak 568 MB RSS during file-heavy work with the workload's own memory included; see below) |
| `SLAUDE_BOX_DIR` volume size | Disk for images, live sessions and parked sessions | from the manifest |

The rule a pod must satisfy, checked at node boot (a violation stops the
node, naming the numbers):

```
boxd memory limit  >=  MAX_BOXES x (smallest memoryReserveMb it will serve + overhead) / 0.85
box data volume    >=  image budget + MAX_BOXES x typical live disk + park budget
MAX_BOXES          >=  1
```

and, per admission, at run time:

```
admit a new sandbox only if
  running < MAX_BOXES
  and  sum(reserve + overhead of running boxes) + (new reserve + overhead) <= memory budget
  and  free disk >= the new box's homeMb share (a floor, 1 GB)
```

A worked example, for the manifest's defaults:

```
boxd:  limits cpu 8, memory 16Gi          node: limits cpu 1, memory 1Gi
SLAUDE_NODE_MAX_BOXES = 10
default box: memoryMb 3072, memoryReserveMb 1024, cpu 2
  reserve per box 1024 + 150 = 1174 MB;  10 boxes = 11.7 GB  <=  13.6 GB budget
  worst case if every box hit its ceiling: 30 GB > 16 GB, so memory is
  overcommitted 2.2 times; the pressure rule below is what keeps that safe
box data volume 80 Gi: images 15, live 10 x 3 = 30, parked 30, slack 5
```

**Phase 0 measurements (dev VM, 4 vCPU; detail in `docs/site/_content/field-notes/2026-11-24-box-spikes.md`).** An
idle sandbox is 8 to 10 MB of cgroup memory (33 MB on a cold page cache), with
the CLI started and idle 140 to 151 MB, and ten sandboxes each with an idle CLI
took 151 MB each (the first one, with the CLI binary cold in the page cache,
was charged 372 MB). During a clone, a warm `bun install` and an `npm ci` the
sandbox's sentry and gofer reached 568 MB RSS (which includes the workload's
own memory) and its cgroup 2 GB with the guest file cache; under a 1 GiB
limit the same work completed with the cache reclaimed. This leaves
`SLAUDE_BOX_SANDBOX_OVERHEAD_MB` at 150 and `SLAUDE_NODE_MAX_BOXES` at 8 (a
16 GiB boxd container holds 11 default boxes by memory); CPU saturation with
many busy sandboxes was not measured.

`SLAUDE_NODE_CONCURRENCY` (turns running at once, per BullMQ worker) is
unchanged and is a different number: a warm session between turns holds a
sandbox but no turn. `MAX_BOXES` should be at least the node's total turn
concurrency; the node warns at boot when it is lower.

### Admission when a node is full

A warm session's next turn is always served: it already has its sandbox.
Admission applies to starting a sandbox (a new session, or a cold or parked
resume).

1. **Make room first.** If a slot or memory is missing and the node holds a
   warm session with no running turn that has been idle for at least
   `SLAUDE_BOX_PRESSURE_IDLE_SEC` (default 60), it flushes and parks the
   longest-idle one early and takes its slot.
2. **Otherwise stop claiming.** The node pauses its label-queue workers (the
   mechanism the worker already uses when its credential is refused,
   `w.pause(true)` in `src/node/worker.ts`) and reports
   `slaude_node_boxes_full 1`. Its own queue keeps running, so warm sessions
   continue. New work stays on the label's wait list, where other nodes claim
   it and where the autoscaler sees it.
3. **A job already claimed** when the check fails (a race, or a job routed to
   this node's own queue for a parked session) is moved back to the label
   queue with the existing atomic move, not failed and not run unboxed.
4. **Resume claiming** when a slot and memory are free again (hysteresis: one
   free slot held for 5 s).
5. **Memory pressure.** If boxd's memory use passes 90 percent of its limit,
   the node stops admitting, parks idle sessions longest-idle first until it
   is under 80 percent, and counts `slaude_box_pressure_evictions_total`. A
   sandbox over its own ceiling is killed by its cgroup alone; the pod's
   limit is the backstop that this rule exists to keep away from.
6. `/readyz` stays 200 on a full node (it is healthy; marking it unready
   would not help a queue consumer). `slaude_node_boxes_full` is the signal.

Dispatch helps but is not trusted to be exact: a node's free slots are in its
heartbeat, and the gateway only routes a cold or parked session to a node's
own queue when that node reported a free slot. The node's own check is the
authority.

### The autoscale signal

Three signals, combined so that any one of them scales up:

| Signal | Why | Where |
|---|---|---|
| **The label's wait list** (existing) | The ground truth that work exists and no node took it. With the admission rule, a full fleet shows up here within seconds. | KEDA `redis` trigger, unchanged |
| **Box occupancy**: `sum(slaude_node_boxes_running) / sum(slaude_node_boxes_capacity)` per label, target 0.7 | Scales before a backlog forms, and holds replicas while sessions are warm though the queue is empty. This is the "active sessions per node" signal. | KEDA `prometheus` trigger (new, optional where Prometheus exists) |
| **Memory and CPU of the `boxd` container**, targets 75 and 70 percent of requests | Heavy boxes fill a pod before the slot count does. | KEDA `memory` and `cpu` triggers with `containerName: boxd` |

Changes to the manifests (in the box overlay, so the base is untouched):

- `70-autoscale.yaml`'s ScaledObjects gain the memory and CPU triggers and,
  commented as optional, the Prometheus occupancy trigger. KEDA scales to the
  largest replica count any trigger asks for.
- `optional/node-cpu-fallback-hpa.yaml` (clusters without KEDA) gains
  `ContainerResource` metrics for `boxd` memory and CPU. Its header today
  says CPU is a poor proxy because turns wait on the model; with boxes,
  memory held by warm sandboxes is a much better one, and the file's comment
  is updated to say so.
- `cooldownPeriod` stays 300 s and the HPA's scale-down stabilisation stays
  600 s: a removed pod's sessions cold-resume elsewhere, which is cheap but
  not free.

Scale-up latency is a new pod's start plus its image pulls. A fresh pod has
no box image cached, so its first sessions wait for the prewarm (the pull of
the current digests starts at boot, before the node claims). The node does
not report ready until the digests of its labels' current boxes are present,
bounded by a timeout after which it goes ready and pulls on demand.

### Scale-down and drain

Kubernetes picks the pod; the node does not choose. On SIGTERM (unchanged
entry, `SLAUDE_NODE_DRAIN_SEC`, default 120):

1. Stop claiming from every queue; `/readyz` goes 503 (existing).
2. Let running turns finish within the drain window (existing).
3. For every warm session: stop the CLI, flush `tx`, `ws`, `wx`, `hm`
   (`FsSync.drain`, extended to the new units, several sessions at a time),
   stop the sandbox, release the registry entry so the next turn routes
   elsewhere.
4. Parked sessions are already flushed: delete their registry hints.
5. Exit. The pod's disk goes with it.

A turn still running at the end of the window is aborted and its session
flushed as it stands, as today. `terminationGracePeriodSeconds` must cover
the drain window plus the flush of the warm sessions: the overlay sets 300
for the default 120 s drain, and the documentation gives the rule (drain
seconds, plus about 15 s per warm box at the size limits, divided by the
flush parallelism). A pod killed before its flushes finish loses the turns
since each session's last flush, the same window the storage design
documents.

The next turn of a drained session lands on another node as a cold resume:
within the 20 s budget for a heavy session.

## Node and gateway changes

**Node**

- `src/box/`: `sandbox.ts` (interface), `drivers/none.ts`, `drivers/gvisor.ts`,
  `drivers/bwrap.ts`, `boxd/` (the supervisor and its client), `image.ts`,
  `egress/`, `init/` (box-init), `policy.ts`, `definition.ts` (schema),
  `capacity.ts` (admission), `resolver.ts`, `env.ts`.
- `src/node/main.ts`: probe the configured tier at boot, check the sizing
  rule, refuse to start if either fails, start the prewarm loop.
- `src/node/worker.ts`: install the sandbox resolver; add `box/1` and
  `box-tier/<tier>` to `NODE_CAPS`; start the session's proxies before the
  sandbox and stop them after it; stop the sandbox where the scratch
  directory is removed today (idle, eviction, lost lock, drain); admission
  and pausing; report digests and free slots on the heartbeat.
- `src/node/fs-sync.ts`: two more units per tracked session when it is boxed;
  prepare order `tx`, `ws`, `wx`, `hm`; pack flush and hydrate through boxd;
  park instead of drop.
- `src/agent/manager.ts`: `setSandboxResolver`, `spawnClaudeCodeProcess`, the
  one prompt line for boxed sessions.

**Gateway**

- Migrations (next free number, 0054 onward, one table per migration as the
  recent ones do): `boxes`, `box_versions`, a `boxes_manifest` row for the
  signed set, two nullable columns on `sessions` (`box_name`, `box_digest`).
- `src/persona/sync/payload.ts`, `run.ts`: payload version 8 with `boxes`;
  `src/persona/agent-schema.ts`: the `box` key; a persona naming an unknown
  box fails the sync; a boxed persona with an OAuth-token provider is refused
  or warned according to Phase 0's result.
- The runtime bundle gains `box` (name, the session's pinned digest, policy),
  with the box set's version as an ETag input, as guardrails did.
- `src/gateway/core/dispatch.ts`: pin at first dispatch; add the box
  capabilities to `requiredCaps`; route warm, then parked, then a node with
  the digest and a free slot, then the label queue; the forced-refresh check.
- `src/gateway/api/`: `GET /v1/node/boxes`; the session view returns the two
  columns.
- A `/box` command (`status`, `refresh`) in `src/gateway/slack/commands.ts`.
- Console: a read-only Boxes page (versions, digests, policy, which nodes
  hold them).
- Session close and `/new` enqueue removal of the session's `hm` unit.

**Flags**

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `SLAUDE_BOX` | gateway | `off` | `on`: boxes are stored, pinned and required for personas that name one. `off`: the `box` key is validated and ignored. |
| `SLAUDE_BOX_TIER` | node | `none` | The tier this node offers. |
| `SLAUDE_BOX_DIR` | node, boxd | `/var/lib/slaude-box` | Images, sessions, spool. |
| `SLAUDE_BOXD_SOCKET` | node, boxd | `/run/slaude-box/boxd.sock` | Control socket. |
| `SLAUDE_BOX_DEFAULT` | gateway | unset | Box for personas without a `box` key. Unset means such personas stay unboxed. |
| `SLAUDE_NODE_MAX_BOXES`, `SLAUDE_BOX_MEMORY_BUDGET_MB`, `SLAUDE_BOX_SANDBOX_OVERHEAD_MB`, `SLAUDE_BOX_PRESSURE_IDLE_SEC` | node | see the capacity section | Sizing and admission. |
| `SLAUDE_BOX_IMAGE_BUDGET_MB`, `SLAUDE_BOX_PARK_BUDGET_MB` | node | 15000; half the volume | Disk budgets. |

## Kubernetes deployment

**Boxes run inside the node pod, through a privileged boxd container.**
runsc runs nested in that container. This works on any cluster that allows a
privileged pod, with nothing installed on the Kubernetes hosts. The
privileged container holds no secret and makes no network call. It is not
allowed on clusters that forbid privileged pods (Pod Security `restricted`,
some managed autopilot modes); on those, slaude runs unboxed or on the
`bwrap` tier if its requirements are met, and that limit is documented.

Other shapes were considered and are not built: a pod per session with a
gVisor RuntimeClass (nodes would call the Kubernetes API, and scaling would
no longer follow the node pod), a host-level daemon (same privilege, more
parts), and rootless runsc (the gVisor rootless guide lists `runsc create`,
its network stack and cgroups as unsupported there).

A new overlay `deploy/k8s-scale-box/` (like `deploy/k8s-scale-s3/`, and
composable with it) patches every node Deployment, so the base keeps working
unboxed:

```yaml
# added to each node Deployment's pod spec
terminationGracePeriodSeconds: 300
containers:
  - name: node
    env:
      - { name: SLAUDE_BOX_TIER, value: gvisor }
      - { name: SLAUDE_NODE_MAX_BOXES, value: "10" }
    resources:
      requests: { cpu: 500m, memory: 768Mi }
      limits:   { cpu: "1",  memory: 1Gi }
    volumeMounts:
      - { name: box-run,  mountPath: /run/slaude-box }
      - { name: box-data, mountPath: /var/lib/slaude-box }
  - name: boxd
    image: ghcr.io/REPLACE/slaude:latest        # same image, runsc included
    command: ["bun", "--no-env-file", "src/box/boxd/main.ts"]
    securityContext: { privileged: true }
    # No envFrom, no Secret: boxd refuses to start with any credential in its environment.
    resources:
      requests: { cpu: "2", memory: 12Gi }      # the boxes are charged here
      limits:   { cpu: "8", memory: 16Gi }
    volumeMounts:
      - { name: box-run,     mountPath: /run/slaude-box }
      - { name: box-data,    mountPath: /var/lib/slaude-box }
      - { name: slaude-home, mountPath: /data }          # workspaces, bind mounted into boxes
      - { name: config-home, mountPath: /config-home }   # session config dirs
volumes:
  - { name: box-run,  emptyDir: { medium: Memory, sizeLimit: 16Mi } }
  - { name: box-data, emptyDir: { sizeLimit: 80Gi } }
```

Also in the overlay: the autoscale changes above, and the PodDisruptionBudget
unchanged. Elsewhere:

- The node image gains `runsc`, `skopeo`, `umoci` and the compiled
  `box-init`. `tailcat` stays. The tools unboxed personas use (`uv`, the
  prefetched MCP server) stay too, because tier `none` stays supported; a
  slimmer image for box-only deployments is an optional build target.
- A default box image (`boxes/default/`, published with each release)
  carries what the node image carries today, so a persona that opts in sees
  the same tools.
- **NetworkPolicy**: the pod-level policy keeps its shape, because box
  traffic leaves through the node worker's proxy and so has the pod's
  address. Its comment changes: port 443 to anywhere is now narrowed per box
  at the proxy, and the registry is one more HTTPS destination.
- The node-entry test (`tests/deploy/node-entry.test.ts`) and the secret
  split test (`tests/deploy/secret-split.test.ts`) gain the rule that boxd
  mounts no Secret and has no `envFrom`.

**A plain host** (a VM, the single-box deployment): install runsc from the
gVisor apt repository; run boxd as a root systemd unit and the node worker as
its own user; same socket, same directories, the same capacity settings.
`docker-compose.scale.yaml` gets an optional `boxd` service under a compose
profile with `privileged: true`; its default stays tier `none`, so
`docker compose up` on a laptop is unchanged.

## Session lifecycle

```
dispatch (gateway)
  pin digest if unset; forced refresh if stale
  route: warm node > parked node with a slot > node with digest and a slot > label queue
claim (node), under the session lock
  1. bundle: box policy, pinned digest
  2. admission: slot and memory, or make room, or hand the job back
  3. image present? else pull (deadline)
  4. FsSync.beforeTurn: tx, ws (existing), wx, hm     -> "wait" if a live node owes a flush
  5. start proxies; boxd: start sandbox                         (first turn only)
  6. AgentManager boots the CLI inside (spawn)                  (first turn only)
  7. run the turn
  8. FsSync.afterTurn: tx always; ws, wx, hm per SLAUDE_SYNC_FLUSH, only when dirty
release the lock; the sandbox stays (warm)
...
idle limit (SLAUDE_IDLE_MINUTES), pressure, drain
  stop the CLI; flush all four; stop sandbox (root overlay deleted); stop proxies
  park: keep the local directories under the disk budget     (drain: nothing kept)
```

- **The sandbox lives exactly as long as the session is warm on the node.**
  It starts in the session's boot and stops wherever the worker today removes
  the scratch directory and evicts the bundle (`src/node/worker.ts`).
- **Every sandbox stop loses the root overlay.** That is the cold start a
  user sees after idle: home and workspace intact, system-level changes gone.
- **The Redis session lock** is unchanged.
- **A lost lock or a fenced flush** means another node owns the session: stop
  the sandbox at once and discard the local copies, as the workspace copy is
  discarded today.
- **Packing while processes run.** Between turns a background process may
  write. The pack re-reads a file that changed while it was archived (as
  `flushTree` does) and accepts a tree that is consistent per file, not as a
  whole.
- **Node crash.** Unflushed changes to `hm`, `wx` and `ws` are lost for the
  turns since the last flush, the same window the S3 design documents. With a
  pod-local `emptyDir` a container restart keeps the directories; the
  needs-flush mark and the disk id then recover them as they do for `ws`.
- **Worker restart with boxd alive.** boxd kills sandboxes whose owning
  connection has been gone for a grace period; the directories stay for the
  recovery above. **boxd restart** kills every sandbox (they are its
  children); the worker sees each CLI exit and treats the session as crashed,
  the existing path for a dead child.
- **Warm resume**: nothing to do. **Parked resume** (same node): start the
  sandbox. **Cold resume** (another node): hydrate, then start. Budget: about
  20 s for a heavy session.

## Dev and macOS

- **mono** (`SLAUDE_ROLE=mono`) never boxes in v1. Nothing changes.
- **Dev node on macOS or Linux**: tier `none` by default. Same code path as
  today.
- **`bwrap` on Linux**: for a dev machine with user namespaces. Uses the real
  base, home, packs and proxies, so the box logic is testable without gVisor.
- **`bwrap` on macOS** means Seatbelt through Anthropic's sandbox-runtime:
  write confinement to the workspace and a domain proxy, the host's own
  toolchain, no image. It exists so a macOS developer can exercise the egress
  policy; it is not a production tier and is the last phase.
- `docker-compose.yaml` (mono) and `docker-compose.scale.yaml` are unchanged
  by default. The sim (`bun sim run`) uses a stub agent and never boxes.

## Boundary with remote environments

Box does not touch the environment feature. Verified in the code:

- A remote session's tools are an in-process MCP server
  (`createRemoteMcp` in `src/agent/manager.ts`) whose `exec` opens the ssh
  connection from the node worker process (`src/remote/helper-client.ts`,
  `src/remote/tailcat.ts`). The connection does not originate in the agent
  child, and its key never enters a box.
- So in a boxed session `/env use` works with no rule in the box's egress
  list and no change to the remote code. The pod-level NetworkPolicy still
  needs the tailnet rule it needs today.
- In a remote session the local file and shell tools are denied by the
  existing hook; the box still runs the CLI, mostly idle. No special case.
- `tailcat` stays in the node image for this reason.
- The words do not collide: agent.yaml keeps `environment:` for shared
  remote machines and gains `box:`. An environment is someone's existing
  machine the thread's tools run on; a box is the sandbox the session itself
  runs in.

Not done, on purpose: no "run the box on the remote machine", no merging of
`/env` and `/box`, no change to `shared-env/1`.

## Observability, quotas, garbage collection

**Metrics** (Prometheus, the existing `src/metrics.ts` registry):
`slaude_node_boxes_running`, `slaude_node_boxes_capacity`,
`slaude_node_boxes_full`, `slaude_node_boxes_parked`,
`slaude_box_memory_reserved_bytes`, `slaude_box_pressure_evictions_total`,
`slaude_box_admission_total{result}` (admitted, made_room, handed_back),
`slaude_box_start_seconds{tier,phase,result}` (phases: pull, hydrate, start,
cli), `slaude_box_resume_seconds{kind}` (warm, parked, cold; the 20 s budget
is an alert on the cold p95), `slaude_box_pack_seconds{unit,op}`,
`slaude_box_pack_bytes_total`, `slaude_box_home_bytes` (histogram at flush),
`slaude_box_egress_total{decision}`, `slaude_box_image_pull_seconds{result}`,
`slaude_box_images_cached`, `slaude_box_oom_total`,
`slaude_box_quota_exceeded_total{kind}`. The existing storage metrics count
the new units too. No session, persona or host label on any of them.

**Audit**: box pinned, refreshed (who, from, to), forced refresh applied, box
version recorded at sync (diff summary), egress refused (rate limited per
session and host), quota exceeded, image unavailable.

**Quotas**

- CPU, memory, pids, root overlay: hard, as in the capacity section. An
  out-of-memory kill ends the CLI; the session reports it as a child crash
  with `BOX_OOM`.
- Home and workspace extras: soft in v1. boxd measures each at every flush;
  over the limit the agent is told at the next turn and the flush still
  happens; over twice the limit the pack is refused, the session keeps
  working, and the user is told that home (or the installs) will not survive
  a move to another node until space is freed. A hard limit (a filesystem
  image per home) is a later step.
- Scratch (`TMPDIR`): on the node's disk as today, never synced.

**Garbage collection**

- Home units: removed when the session is closed or archived (`removeUnit` in
  `src/storage/gc.ts`, run by the gateway's storage sweeper tick). The
  age-based sweeper is the backstop.
- Workspace-extras units: by age only (they are shared by directory, and a
  refresh leaves the old image's unit behind to age out).
- Within a unit: `gcSession` after compaction.
- Parked copies on a node: least recently used above the budget.
- Images on a node: least recently used above the budget, never one in use.
- Images in the registry: outside slaude. `slaude box digests --in-use`
  prints every digest a box version or a live session references, for a
  registry retention job.
- Session directories on a node after a crash: boxd sweeps directories with
  no sandbox, no parked record and no needs-flush mark older than a day.

## Migration path

Opt in per persona. Unboxed stays supported; nothing here forces a move, and
making boxes mandatory is a separate decision for later.

1. **Upgrade with everything off.** `SLAUDE_BOX=off`, nodes on tier `none`.
   No behaviour change. The `box` key and `boxes/` are validated at sync.
2. **Add boxed capacity.** Apply the box overlay to a node Deployment (an
   existing label or a new one), `SLAUDE_BOX=on` on the gateway. Nodes with
   the overlay serve boxed and unboxed personas of their label alike.
3. **Opt a persona in.** Check it first: its provider credential form is
   supported (Phase 0's result), it does not rely on a node-manifest server
   with a token (run `slaude box from-manifest`), and it does not need git or
   package-manager access to a private repository or registry from its shell
   (the supported path is a gateway-side MCP server for the code host in the
   persona's `mcp`; without one the persona stays unboxed).
   `slaude box preflight <persona>` runs these checks. Then
   add `box: default` (or its own box). New sessions are boxed. Open sessions
   finish as they are: a session without a pinned digest stays unboxed until
   it ends.
4. **Repeat, or stop.** Personas that do not fit stay unboxed for as long as
   the operator wants.

Rollback: remove the `box` key (or set `SLAUDE_BOX=off`). A session with a
pinned digest on a deployment where boxes are off boots unboxed, with a log
line; its workspace and transcript are unaffected because their paths never
changed, and its home is simply not mounted.

## Security analysis

**What the boundary guarantees on the `gvisor` tier, if gVisor holds:**

- A session cannot read or write another session's workspace, home, config
  directory, scratch directory, environment, arguments or memory.
- There is no credential in the box to steal: not the provider's, not the
  node's, not a job token, not an MCP token, not a tool token.
- A session cannot open a connection except through its own proxy, which
  refuses everything not on its box's reviewed allowlist, and always refuses
  private addresses, the gateway, Redis and the object store.
- A session cannot change its own policy, image or limits: they come from the
  signed bundle and are applied outside the box.
- A session cannot take more than its limits, and a node cannot be pushed
  past its capacity by its sessions.

**What it does not guarantee:**

- **A gVisor escape.** It lands in boxd's container, which is privileged.
  From there the node's disk and the worker's files are reachable. gVisor
  narrows the kernel attack surface a great deal; it is not a second machine.
  Labels remain the answer for tenants that must not share a host.
- **Exfiltration through allowed destinations.** See the egress limits.
- **Use of the provider through the proxy.** A box can make model calls with
  the persona's credential without holding it. That is the agent's normal
  work; a prompt-injected turn can spend tokens, bounded by the existing
  budgets.
- **What the user puts in the thread.** A token pasted into a message is in
  the transcript and can end up in a file.
- **The workspace's content.** A shared channel folder is shared by the
  sessions that use it, by design.
- **Redis and the bucket.** Nodes still reach Redis directly and hold bucket
  credentials; a compromised node worker reads other labels' queues and
  units, as today. Boxes make the worker much harder to compromise (the agent
  no longer shares its uid), not Redis safer.
- **The `none` and `bwrap` tiers.** `none` is today. `bwrap` shares the host
  kernel: a kernel bug is an escape.
- **Persistence inside a session.** An agent can plant something in its own
  home that runs in a later turn of the same session. It cannot cross to
  another session.

**New attack surface, and what covers it:**

| Surface | Risk | Cover |
|---|---|---|
| boxd control socket | Whoever can write to it runs privileged work | Socket mode 0600 in a volume only the two containers mount; never bind mounted into a box; a fixed set of verbs with validated paths under `SLAUDE_BOX_DIR` and the declared mount roots |
| Pack apply | Path traversal, symlink redirection | Listing validated, confined extraction, set-uid stripped, tests with hostile archives |
| Image unpack | A malicious image | Images come by digest from the signed bundle; unpack is confined the same way; nothing from an image is executed outside a sandbox |
| Proxies | SSRF, request smuggling, DNS rebinding | Resolve once and connect to the checked address; fixed refusals; CONNECT only to an allowed host and port; the provider proxy forwards to one fixed upstream and strips inbound credential headers |
| Provider proxy | The box learning the real credential | Never returned in a response or an error; redirects from the upstream are not followed to another host |
| CLI stdio | A hostile child sends crafted SDK messages to the worker | Already the case today; unchanged |
| Bind mounts | A symlink in the workspace pointing outside | The sandbox resolves paths inside its own mount view; the node-side upload tool keeps its realpath check |

## Failure modes

| Failure | Behaviour |
|---|---|
| boxd not running, the tier's probe fails, or the sizing rule fails at boot | The node refuses to start. |
| boxd dies while sessions are warm | Sandboxes die; each session's child exit is handled as a crash; the next turn cold-starts from local copies. `/readyz` fails until boxd is back. |
| The node is full | Make room, else stop claiming; work waits on the label queue; the autoscaler adds pods. |
| Every node of a label is full and the Deployment is at its maximum | Turns wait. The existing unserved-label notice path tells the user after its timeout; `slaude_node_boxes_full` on every node is the alert. |
| Image pull fails or times out | The turn fails with `BOX_IMAGE_UNAVAILABLE`; retried once on a node that has the digest, if any. Never an unboxed run. |
| No node on the label offers the box's tier | The existing "no capable node" path: wait, then refuse with a notice and an audit row. |
| Hydrate of `hm` or `wx` fails | The boot fails (a half-applied home must not run); the marker is cleared so the next attempt is a full one. |
| A pack flush fails | needs-flush mark, local copy kept, retry with backoff; the lock is not held. Same as today. |
| A layer blob is missing from the store | The boot fails with a specific code; an operator removes the unit, and the session starts with an empty home. |
| Home or extras over quota | The soft limit behaviour above. |
| Sandbox out of memory | CLI killed; `BOX_OOM`; the sandbox restarts at the next turn with the same home. |
| Pod memory pressure | Stop admitting, park idle sessions. |
| The agent expects a system package it installed earlier | It is gone after any sandbox stop. The prompt line says so; the fix is the box image. |
| A tool needs a token | It fails in the box. The fix is a gateway-side MCP server. |
| Provider proxy cannot reach the provider | The CLI sees the HTTP error and retries as it does today. |
| A box is deleted from the deploy repo while a persona names it | The sync is refused. A box no persona names is retired: its versions stay readable for pinned sessions until those close. |
| Redis loses the unit epoch | Existing rule: start above the stored maximum. |

## Open risks and the experiment that retires each

| # | Risk | Experiment (plan, Phase 0) | If it fails |
|---|---|---|---|
| R1 | runsc cannot run nested in a privileged container on the owner's clusters (systrap, cgroups) | Spike 1 | The `bwrap` tier as production |
| R2 | **Bind-mount I/O through the gofer** is too slow for git and installs in the workspace and caches in home | Spike 2: the benchmark, built around workspace and home | Tune (exclusive mode, EROFS base, KVM platform where available); then `bwrap` as production |
| R3 | **The provider proxy does not work for the OAuth form** | Spike 3, blocking | OAuth-token personas are not boxable; the no-secrets rule is kept |
| R4 | The CLI inside a sandbox does not work over `runsc exec` stdio (hooks, in-process MCP, permission prompts, resume) | Spike 4 | A long-lived stdio relay process in the box instead of `exec` |
| R5 | A bind-mounted host Unix socket is not connectable from gVisor | Spike 1 | gVisor's sandbox network with a host-side link to the proxy only |
| R6 | Idle sandbox memory makes the density per pod too low to be worth the pod | Spike 1 measures sentry, gofer and idle CLI | A shorter idle limit for boxed sessions (parking makes that cheap) |
| R7 | Cold resume of a large home is slower than the 20 s budget | Phase 5 load test with a real store | A larger park budget; a lower default `homeMb`; exclude big caches by default |
| R8 | Plugin hooks and skills need a runtime the box image lacks | Phase 2 e2e with the built-in plugin | The default box image carries bun; `slaude box check` warns |
| R9 | Agents hit the allowlist constantly | Soak on one persona with refusals counted and listed | A wider default list, through git |
| R10 | "No secrets" removes something a persona needs daily (private repositories) | The migration checklist per persona, before opting in | A gateway-side code-host MCP server, or the persona stays unboxed |

**Phase 0 results (dev VM, 2026-11-24), per risk.** Run on a Mac VM and a
privileged container on it, not on the owner's cluster; detail in
`docs/site/_content/field-notes/2026-11-24-box-spikes.md`.

- R1: not retired. runsc runs nested in a privileged container on the dev VM
  once cgroup v2 delegation is done; host 3 not run.
- R2: measured on the dev VM. C1 is 1.4x to 8x slower than runc on git, `rg`,
  installs and small-file work, by 0.05 to 4.5 s on the fixtures (17.6 s on a
  Go build of x/tools); exclusive mode is
  incoherent with host writes (unusable); EROFS does not run on this runsc;
  KVM absent. K2c (scripted turn, 2.4x) is exceeded with a zero-latency model;
  the real-model turn is not run. Not enough to change the tier.
- R3: the three credential forms pass against a **fake** provider with a
  placeholder in the box; the real OAuth-token path is untested.
- R4: retired on the dev VM. Every SDK case passes over `runsc exec`; abort
  needs `--new-pidns` and an explicit `runsc kill --pid`.
- R5: retired on the dev VM: `--host-uds=open` makes a bind-mounted host
  socket connectable.
- R6: an idle sandbox with an idle CLI is about 150 MB; K5 (400 MB) is not
  tripped.

## Recommendations and confidence

| Recommendation | Confidence |
|---|---|
| Run the CLI itself inside the box through `spawnClaudeCodeProcess`; keep hooks, shims and the bridge in the worker | High (the seam is documented for this use; untested here) |
| Identical paths inside and outside | High |
| A separate privileged boxd with no credential | High |
| No network in the box; two Unix sockets; policy in the worker | High (R5 retired on the dev VM with `--host-uds=open`) |
| Provider proxy for the API key and auth token forms | High |
| Provider proxy for the OAuth form | Low-medium: passes against a fake provider with a placeholder; a real-token run is still needed |
| Durable home and workspace, throwaway root overlay | High |
| Pack units for `hm` and `wx` | High |
| Root overlay backed by a per-session file on disk | High on the dev VM (EROFS base: not usable on the tested runsc build, dropped for now) |
| Parking on by default | High |
| Capacity by reserved memory and a slot count; pause claiming when full | Medium-high (dev VM numbers kept the defaults; host 3 and a loaded run still to do) |
| Wait list plus occupancy plus boxd memory as the scale signal | Medium-high |
| Registry only, no baked core box in v1 | Medium-high |
| `bwrap` as the fallback production tier | Medium; the live contingency while K2c is unresolved |
| Soft disk quota for home in v1 | Medium |

## Out of scope and later

Out of scope: listed under Non-goals. Also not here: a UI to edit boxes in the
console, per-user boxes, a shared cache volume between boxes, GPU boxes.

Later, each on a measured need or a new decision:

- A command that empties a session's home.
- A hard disk quota (a filesystem image per home).
- A pool of pre-started sandboxes.
- A native registry client replacing skopeo and umoci.
- Client-side encryption of packs.
- A microVM tier.
- Making boxes mandatory on nodes.

## Decisions

The owner's answers to the six questions this spec ended with, and what each
changed.

1. **Where boxes run: a privileged boxd sidecar in the node pod.** Boxes run
   inside the node pod; there is no pod per session. Scaling follows the node
   pod's resource use. Consequences in this document: the capacity model,
   the admission rule, the autoscale signals and the drain behaviour
   ("Capacity, admission and autoscaling"); the pod-per-session shape is
   removed from the tiers and the roadmap.
2. **Durability: home and workspace only.** System packages belong in the
   image; a runtime `apt install` is not durable, and that is accepted.
   Consequences: no synced root layer, no host overlayfs, no
   `--overlay2=none`, no layer generations; the root filesystem uses
   gVisor's own overlay; durable state is `tx`, `ws`, `wx` and the new `hm`;
   the main gVisor risk moved from the root filesystem to bind-mount I/O; a
   refresh is a new digest and nothing else; the prompt and the docs state
   what is lost.
3. **First-turn delay after idle: up to about 20 s is acceptable.** Local
   copies of home and workspace stay on node disk after idle where there is
   room. Consequences: parking is in v1 and on by default; no pre-started
   pool; the cold-resume p95 has a 20 s alert.
4. **No secrets in boxes at all.** Anything needing a secret is a
   gateway-side MCP server. Consequences: `box.yaml` has no `secrets` and no
   placeholders; stdio servers in a box are credential-free; node-side MCP
   token seeding is off for boxed sessions; the provider proxy must handle
   every credential form, the OAuth form is a blocking spike, and its
   fallback is "not boxable", never "token in the box"; private repositories
   and registries are unreachable from a box in v1.
5. **Egress: refuse by default, managed through GitOps.** The default box
   allows common package registries and code hosts. The allowlist is part of
   `box.yaml`, changed by pull request by whoever deploys slaude.
   Consequences: no runtime approval of any kind; the GitOps flow is spelled
   out; open sessions get a changed list at their next connection.
6. **Migration: opt in per persona.** Tier `none` stays supported with no end
   date. Consequences: no forced-migration step; the node manifest and the
   unboxed tools stay in the product.
7. **No secret-backed access from a box to a named host.** A proxy on the
   node that adds a token for a code host or a registry was considered and
   rejected. Private code goes through a gateway-side MCP server for the code
   host, or the persona stays unboxed. Consequences: the provider proxy is
   the only credential-adding route; this is a non-goal, not a later item;
   the opt-in checklist and `slaude box preflight` check for it.
8. **Memory overcommit: reserve about a third of each box's ceiling.**
   `memoryReserveMb` defaults to a third of `memoryMb`, and the pressure rule
   (stop admitting and park idle sessions at 90 percent of boxd's limit) is
   the safety. Consequences: about three boxes are admitted per ceiling's
   worth of memory; an idle session can be parked early under load.
