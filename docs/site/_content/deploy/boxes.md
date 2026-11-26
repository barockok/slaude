---
title: Boxes
description: One sandbox per session, built from a reviewed image, with no secret inside. What persists, the box.yaml format, the GitOps flow, tiers, egress, what "no secrets" means for tools, refresh, sizing, operations and the security limits.
---

# Boxes

> **Status: in development, off by default, not proven on a cluster.**
> Everything this page describes is implemented and off unless you switch it
> on (`SLAUDE_BOX=off` on the gateway and `SLAUDE_BOX_TIER=none` on nodes are
> the defaults; with both, nothing here runs).
>
> What has run: a real node worker with the real agent CLI in real gVisor and
> bwrap sandboxes, against a mock model, **on a development VM and in a
> privileged container on that VM**, including a session that moved between
> nodes through an object store.
>
> What has **not** run, so do not treat it as shipped behaviour yet:
>
> - **No cluster.** The Kubernetes overlay renders and its shape is tested;
>   it has never been applied. Whether runsc starts nested in a privileged
>   container of a pod on your cluster is unanswered.
> - **No real model and no real provider credential.** The provider proxy ran
>   against a mock and a local recorder only. Whether the OAuth token form
>   works behind it against the real provider is not established.
> - **The default box image has never been built**, and the workflows that
>   publish it have never run.
> - Performance against the first-turn budget, amd64, long runs, and a node
>   worker that is not root.
>
> The exact list, with what the owner of a deployment must run first, is in
> the field notes:
> [smoke test](../field-notes/2026-11-25-box-smoke.md) and
> [deployment and review](../field-notes/2026-11-25-box-deployment-and-review.md).

A **box** is a reviewed image plus a policy. A persona that names a box has
each of its sessions run in its own sandbox built from that image, inside the
node pod. Opt in per persona; a persona that names no box runs on the node as
it always has (tier `none`), and that stays supported.

## What persists and what does not

| | Kept between turns and between nodes | Not kept |
|---|---|---|
| The agent's home directory (`/home/agent`): tool caches, user-level installs, shell history | Yes, with `SLAUDE_STORAGE=s3` | |
| The workspace, and the conversation transcript | Yes, as today | |
| Installed project dependencies in the workspace (`node_modules`, `.venv` and the like) | Yes, per image, with `SLAUDE_STORAGE=s3` | Emptied by a [refresh](#refresh) |
| System-level writes (`apt install`, files under `/usr`, `/etc`) | | Thrown away when the sandbox stops |

Without `SLAUDE_STORAGE=s3` the home and the installed dependencies stay on
the node that ran the session. A session that resumes on another node then
starts with an empty home.

On the gVisor tier the agent cannot write a system directory at all (it is
an unprivileged user and the image's files are root's), so "not kept" is "not
possible" there: tools install into the home. On the bwrap tier a system
install works inside the session and is gone when the sandbox stops.

A node that dies before it stored a session's latest edits costs exactly the
edits since its last successful flush. The next node continues from that
flush and counts the loss (`slaude_storage_unflushed_loss_total`).

## Concepts

| Word | Meaning |
|---|---|
| Box | A name, an image pinned by digest, and a policy (limits, egress list, environment, stdio servers). Defined in the deploy repository, stored and signed by the gateway. |
| Tier | How the sandbox is built: `gvisor` (a user-space kernel), `bwrap` (Linux namespaces on the node's kernel) or `none` (no sandbox, today's behaviour). |
| Box supervisor (`boxd`) | A privileged process next to the node worker that starts and stops sandboxes. It holds no credential and makes no network call. |
| Pin | The image digest a session got at its first turn. It changes only by a refresh. |
| Egress proxy | One per session, in the node worker. The only way out of a box, and it refuses every host that is not on the box's list. |
| Provider proxy | One per session, in the node worker. It adds the model provider's credential to the box's model requests; the box holds a placeholder. |
| Home (`hm`) and workspace extras (`wx`) | The two packed units a boxed session adds to remote storage, beside the workspace and the transcript. |
| Parked | A session that went idle: its files are stored, its sandbox is stopped, and its local copies stay on the node so a return is fast. |

## The box.yaml format

A box lives in the deploy repository beside the personas:

```
boxes/
  ruby-dev/
    box.yaml
    Dockerfile        # when image.build is used
```

```yaml
# yaml-language-server: $schema=https://barockok.github.io/slaude/schemas/box.schema.json
version: 1
name: ruby-dev                      # must equal the directory name
description: Ruby and Node for the storefront repositories

image:
  # Exactly one of build or ref.
  build:
    dockerfile: Dockerfile
    context: .
  # ref: ghcr.io/example/boxes/ruby-dev@sha256:...   (a digest; a tag is refused)

tier: gvisor                        # the weakest tier this box may run on

resources:
  cpu: 2                            # cores, a ceiling
  memoryMb: 3072                    # a ceiling; the sandbox is ended above it
  memoryReserveMb: 1024             # what a node sets aside to admit this box (default: a third of memoryMb)
  pids: 512
  homeMb: 4096                      # the durable home (a soft limit)
  workspaceExtrasMb: 4096           # node_modules, .venv and the like (a soft limit)
  rootOverlayMb: 2048               # throwaway system-level writes (gVisor only)

egress:
  allow:                            # everything else is refused
    - registry.npmjs.org
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
  exclude: []                       # home paths never stored, for example ".cache/huggingface"

refresh:
  force: false                      # true: sessions on an older image move at their next message
  note: ""                          # shown to users when force is true
```

There is **no `secrets` key and no placeholder syntax**. `${` anywhere in the
file fails the sync, and so does an `env` value or an argument shaped like a
credential; the message names the field and never the value. Unknown keys
fail at every level. The schema is published as
`https://barockok.github.io/slaude/schemas/box.schema.json`.

**What the image must have** (checked by `slaude box check` and again by the
node when it unpacks): Linux with glibc, a user `agent` with uid and gid
10001 and home `/home/agent`, `git` and CA certificates. Its `ENTRYPOINT` and
its `USER` are not used. Only `PATH` of the image's own environment reaches a
box; set anything else under `env` in `box.yaml`. What the image puts in
`/home/agent` seeds a new session's home once.

**A persona names a box** with one key in its `agent.yaml`:

```yaml
box: ruby-dev
```

### The default box

`boxes/default/` in the slaude repository is a box with the tools the slaude
image itself carries (git, curl, bun, uv), package managers pointed at the
home (`NPM_CONFIG_PREFIX`, `PIP_USER`, `GOPATH`, `BUN_INSTALL`, the uv
directories), and an egress list of the public package registries and code
hosts. Each release is meant to publish it as
`ghcr.io/<owner>/<repository>-box-default` and to record its digest in the
slaude image (`/app/boxes/default/image.ref`, one line per architecture), so
that `box: default` and `SLAUDE_BOX_DEFAULT=default` work with no
`boxes/default` in your deploy repository.

- A `boxes/default` of your own always wins. Copy the directory to narrow
  the egress list; it is a starting point, not a recommendation.
- The gateway serves the digest of its own architecture. A deployment whose
  nodes run another architecture than its gateway must define its own
  `default`.
- An image built without the digest file (a source checkout, a pull request
  build) has no built-in box: `box: default` is then an unknown box, as
  before.
- **Not proven:** the image has never been built, and the publishing steps
  have never run. Treat the built-in default as absent until a release has
  shown it.

## The GitOps flow

Boxes change only through the deploy repository, the same way personas do
([Personas as code](personas-as-code.md)).

1. **A pull request** edits `boxes/<name>/box.yaml` or its Dockerfile. CI
   runs `slaude box check .` (the schema and the image rules) and
   `slaude personas render . --no-push`, which builds what the registry lacks
   without pushing and prints the diff. The digest in that output is a
   stand-in, and a real sync refuses it.
2. **The merge** runs `slaude personas render .` with
   `SLAUDE_BOX_REGISTRY=<registry>/<prefix>` set in the pipeline. For
   `image.build` it hashes the build context; if the registry already holds
   that context it reuses the digest, otherwise it builds and pushes. A
   rebuild happens only when a reviewed file changed. The gateway and the
   nodes never build.
3. **The sync** sends the boxes with the personas (payload version 8). The
   gateway validates again, stores a new version of a box when its digest or
   its policy changed, signs the set, and writes a `box.synced` audit row per
   changed box. It refuses to delete a box a persona names, and refuses a
   persona that names a box that does not exist.
4. **Nodes** hear the deploy, pull the new image ahead of use, and apply a
   changed egress list to running sessions at their next connection. A
   changed image reaches new sessions only; see [Refresh](#refresh).

With `SLAUDE_BOX=off` the sync still validates and stores `boxes/`, and
nothing reads the result.

## Tiers

| Tier | Isolation | Needs | Notes |
|---|---|---|---|
| `gvisor` | A user-space kernel (runsc) per session | A privileged supervisor container or a root service | The tier the design is built for. 1.4 to 8 times slower than a plain container on git and small-file work on the development VM that was measured |
| `bwrap` | Linux namespaces and a seccomp deny list; **the node's kernel is shared** | The same supervisor | A kernel bug is an escape. The box's files are root's on the node's disk, and the root overlay has no size limit |
| `none` | None: the agent runs as the node's user | Nothing | Today's behaviour. Stays supported |

A box's `tier` is the weakest tier it may run on, and a node offers one tier
(`SLAUDE_BOX_TIER`). A node on a sandbox tier that cannot reach its
supervisor refuses to start. **A box that cannot be started is a failed
turn, never a run without a sandbox.**

Clusters that forbid privileged containers (Pod Security `restricted` or
`baseline`, some managed modes) cannot run the supervisor: there, personas
stay unboxed.

## Egress and its limits

- **Refuse by default.** `egress.allow` lists host names, with an optional
  port (443 unless stated) and an optional leading `*.`. `egress.deny` wins.
- The proxy resolves a name once and connects to the address it checked.
  Private, loopback, link-local and metadata addresses are refused whatever
  the list says, and so are the gateway, Redis and the object store.
- A refused host gets a 403 with one sentence saying the host is not on the
  box's allowlist. Tools that ignore proxy variables have no route at all.
- The list changes only through the deploy repository. There is no runtime
  approval of a host.
- A refusal is logged on the node with the session and the host (once a
  minute per host) and counted in `slaude_box_egress_total`.

**The limits, plainly.** There is no TLS inspection, so the proxy sees the
host of a connection and nothing else. An allowed CDN can front for another
site on the same provider, and an allowed host that accepts uploads is a way
out for data. The allowlist narrows where data can go; it does not prove
what was sent.

## No secrets, and what that means for tools

**Nothing in a box is a secret.** No provider key, no node token, no Redis or
bucket credential, no tool token, in any form: not in the environment, not in
a file, not in an argument. There is no flag that makes an exception.

What that means for an agent that today inherits a token from its node:

- **Public package installs and public clones work**, through the box's
  egress allowlist (`egress.allow` in `box.yaml`). A host that is not on the
  list is refused, and the list changes only through the deploy repository.
- **A private repository cannot be cloned or pushed with `git`, and a private
  package registry cannot be read.** That would need a token in the box.
- Cloud CLIs, database clients and the like have no credentials to use.
- **Anything that authenticates is a gateway-side MCP server**: declared in
  the persona's `mcp` in `agent.yaml`, over HTTP, with its credential as a
  `${PERSONA_*}` placeholder or connected through the portal. It reaches the
  agent through the [MCP bridge](mcp-bridge.md), and the credential never
  leaves the gateway.

There is **no credential-adding route from a box to a code host or a
registry**, and slaude does not ship a code-host MCP server. The provider
proxy is the only place a credential is added, and only for the model
provider's own address. This was considered and decided: a second such route
would be a place where a box can spend a secret it cannot read.

### Private code: a gateway-side MCP server for the code host

The supported path for a persona that works on private repositories is an MCP
server for your code host, **deployed by you** next to the gateway, and
declared in the persona's `mcp`. The agent then reads files, opens pull
requests and comments through that server's tools. It does not `git clone`
the private repository into its shell.

A worked example. You run an MCP server for your code host as an HTTP service
the gateway can reach (the server's own HTTP transport, or a stdio-to-HTTP
wrapper beside the gateway). In the deploy repository:

```yaml
# personas/platform-bot/agent.yaml
name: platform-bot
slackUserId: slack:user:UTESTUSER1
box: default
soul: |
  You are the platform team's assistant.
mcp:
  mcpServers:
    code-host:
      type: http
      url: https://code-host-mcp.internal.example.com/mcp
      headers:
        Authorization: "Bearer ${PERSONA_PLATFORM_BOT_CODE_HOST_AUTHORIZATION}"
```

Set `PERSONA_PLATFORM_BOT_CODE_HOST_AUTHORIZATION` in the **gateway's**
environment (see [Personas as code](personas-as-code.md)). The value is
resolved on the gateway at sync; it is never in the repository, never on a
node and never in a box.

**A persona without such a server stays unboxed** if it needs private code.
That is a supported state with no end date, not a failure. The same holds for
a persona that needs a tool which requires both a secret and the session's
files: it stays unboxed, or the tool is split into a credential-free part in
the box and a gateway-side part.

### Stdio MCP servers

A stdio MCP server is a program, so in a box it belongs with the toolchain:
in the image, declared in `box.yaml`.

```yaml
# boxes/ruby-dev/box.yaml
mcp:
  stdio:
    ruby-lsp:
      command: /usr/local/bin/ruby-lsp-mcp
      args: [--stdio]
```

- `command` is an absolute path inside the image. There is no `env` on a
  server: it gets the box's environment (`env` in `box.yaml`), which holds no
  credential.
- `${` is refused anywhere, at sync and again on the node, because the CLI
  would expand it.
- **A boxed session ignores the [node manifest](node-manifest.md).** It gets
  exactly its box's servers plus the gateway-side ones. A node logs one
  warning for a persona that is both boxed and allowed servers in its
  manifest.

To see what becomes of the servers a node manifest allows a persona:

```sh
slaude box from-manifest /etc/slaude/node.json platform-bot
```

It prints, per server, one of three things: an `mcp.stdio` block to paste
(a server with no env, or only literal non-secret values); "needs a
gateway-side server" with the names of the env entries that carry a node
secret (never a value); or "needs both a token and the workspace". Pass
`--workspace <server,...>` to say which servers read the session's files; the
manifest cannot say, and without the flag an argument that names the
workspace is taken as a sign.

## Refresh

A session is pinned to one image digest at its first turn and **never moves
on its own**. A new box version changes new sessions only.

| Command | Who | What it does |
|---|---|---|
| `/box` or `/box status` | Anyone in the thread | Shows the box, the image (short digest), the sandbox tier, the limits, and whether a newer image exists. Answers privately. |
| `/box refresh` | The agent's manager, or the channel's approvers | Moves the thread to the box's current image. Answers privately. |

A refresh is a new image and nothing else. The home, the workspace and the
conversation are kept. Installed project dependencies are not: the agent's
next turn is told so and reinstalls what it needs. Compiled caches in the
home (a build cache, wheels built for the old runtime) can be stale against
the new image; tools mostly notice, and the agent clears one that does not.

A refresh never happens during a turn. `/box refresh` while a turn is running
or queued answers that it was put off; run it again afterwards.

**Forced refresh.** A box version with `refresh.force: true` makes every
older image of that box stale. A session on a stale image moves at its next
message, before the turn starts, and the person who sent the message is told
privately, with the box's `refresh.note`. Use it for a security fix in the
image, not for routine updates.

Both commands exist only where `SLAUDE_BOX=on` and turns run on nodes.
Elsewhere `/box ...` is ordinary text, as it always was. Every refresh is one
`box.refreshed` row in the audit trail, with who asked and both digests.

## Sizing

Boxes run inside the node pod, so the node pod is the unit of capacity. The
model, the boot check, admission when a node is full and the drain
arithmetic are in
[Scale operations](scale-operations.md#boxes-sizing-admission-and-drain).
In short:

- A node runs at most `SLAUDE_NODE_MAX_BOXES` sandboxes, and reserves each
  box's `memoryReserveMb` plus an overhead against 85 percent of the
  supervisor's memory limit. A node whose settings cannot hold its boxes
  refuses to start and names the numbers.
- A full node parks an idle session to make room, or stops claiming new
  sessions and hands the job back to its queue. **It never fails a job for
  capacity, and it never refuses a turn of a session it already holds.**
- The numbers in the shipped manifests are the design's worked example, not
  measurements.

## Operations

### Deploying it

| Where | How | State |
|---|---|---|
| Kubernetes | `kubectl apply -k deploy/k8s-scale-box` (or `deploy/k8s-scale-box/with-s3` on the S3 overlay). Adds a privileged `boxd` container with no Secret and no `envFrom` to every node Deployment, two volumes, the capacity settings and the autoscaling triggers | Renders, shape tested, **never applied to a cluster** |
| Docker Compose | `docker compose -f docker-compose.scale.yaml --profile boxes up` with `SLAUDE_BOX_TIER=gvisor` and `SLAUDE_BOX=on` | Validates with `docker compose config`, **never started** |
| A plain host | Two systemd units: [Boxes on a plain host](boxes-plain-host.md) | **Written, not run** |
| The local cluster | `SLAUDE_LOCAL_BOX=gvisor ./up.sh` in `deploy/k8s-local` | Renders, **never applied** |

The supervisor must be started as
`tini -- bun --no-env-file src/box/boxd/main.ts ...`: it is not an init, and
without one every ended sandbox process stays as a zombie. It refuses to
start with a credential in its environment. The node worker must be root or
uid 10001.

Two things the Kubernetes overlay cannot do for you: an `emptyDir` size
limit is not visible inside the pod, so the image and park budgets are set
explicitly there; and boxes keep a home across nodes only with
`SLAUDE_STORAGE=s3`.

### Switches

| Variable | Where | Default | |
|---|---|---|---|
| `SLAUDE_BOX` | gateway | `off` | `on`: a persona that names a box is pinned and dispatched only to a node that offers its tier. `off`: boxes are validated and stored, and nothing reads them. |
| `SLAUDE_BOX_DEFAULT` | gateway | unset | The box of a persona that names none. |
| `SLAUDE_BOX_UNBOXED` | gateway | `allow` | What happens to a persona that names a box and cannot be boxed (a provider credential form no box can use): `allow` runs it unboxed with a warning at sync; `refuse` does not run it and fails the sync. |
| `SLAUDE_BOX_TIER` | node and supervisor | `none` | The sandbox tier the node offers: `none`, `gvisor` or `bwrap`. |
| `SLAUDE_NODE_MAX_BOXES` | node | `8` | Most sandboxes at once on this node. |

The full list is in the [configuration reference](../reference/configuration.md).

### Metrics

On each node's `/metrics`. None carries a session, persona or host label.

| Metric | Says |
|---|---|
| `slaude_node_boxes_running`, `_capacity`, `_full`, `_parked` | Occupancy, and whether the node stopped claiming for lack of room |
| `slaude_box_memory_reserved_bytes` | What the running boxes set aside |
| `slaude_box_admission_total{result}` | `admit`, `make-room`, `full` |
| `slaude_box_pressure_evictions_total` | Idle sessions parked early for memory |
| `slaude_box_start_seconds{tier,phase,result}` | A start, by phase: `pull` (the image), `hydrate` (the files), `start` (the sandbox) |
| `slaude_box_resume_seconds{kind}` | From a claimed turn to a ready sandbox: `warm`, `parked`, `cold`. The first-turn budget of 20 s is the cold p95 |
| `slaude_box_pack_seconds{unit,op}`, `slaude_box_pack_bytes_total{unit,op}` | Flush and hydrate of the home (`hm`) and the workspace extras (`wx`) |
| `slaude_box_home_bytes` | Home size at each flush |
| `slaude_box_egress_total{decision}` | `allowed`, `refused` |
| `slaude_box_image_pull_seconds{result}`, `slaude_box_images_cached` | The node's image cache |
| `slaude_box_quota_exceeded_total{kind,state}` | A home or the extras over its limit (`over`: stored and the agent is told; `refused`: over twice the limit, not stored) |

Not emitted yet: a count of sandboxes ended for memory, and the time from
spawning the CLI to its first message. A sandbox ended for memory shows as a
failed turn.

The alerts are in [Alerts](alerts.md): every node of a label full, and cold
resume p95 above 20 s.

### Audit

| Row | When |
|---|---|
| `box.synced` | A sync recorded a new version of a box, with a summary of what changed |
| `box.pinned` | A session got its image at its first turn |
| `box.refreshed` | A session moved to another image: who asked (a person, or the forced refresh), and both digests |
| `box.unavailable`, `box.not_boxable`, `box.node.unsupported` | A turn was refused: the box or its image is gone, the persona cannot be boxed where unboxed runs are refused, or no node of the label offers the tier |

A refused connection, a home over its limit and an image a node could not
fetch are **node log lines and metrics, not audit rows**: a node has no
route that writes the gateway's audit trail.

### Images and the registry

A node keeps unpacked images under `SLAUDE_BOX_DIR` up to
`SLAUDE_BOX_IMAGE_BUDGET_MB`, evicting the least recently used and never one
a running session uses. It pulls with skopeo by digest
(`SLAUDE_BOX_REGISTRY_AUTH` for a private registry; that credential stays on
the node and is never given to a box).

For a registry retention job, on the gateway host:

```sh
slaude box digests --in-use
```

prints one `<repository>@sha256:<digest>` per line: every stored version of
every box, the built-in default, and every digest a session row is still
pinned to. Keep those; anything else of your box repositories is unused by
slaude. The list errs on the side of keeping.

### The opt-in checklist

Before adding `box:` to a persona:

```sh
slaude box preflight platform-bot --repo . --manifest /etc/slaude/node.json --private-code --code-host code-host
```

| Check | Passes when |
|---|---|
| `persona`, `box` | The persona has an `agent.yaml` and the box it names is defined under `boxes/`. |
| `provider` | Its provider credential is of a form a box can be served. A persona with no provider of its own uses the deployment's, which the command cannot see: it says so. |
| `seeding` | Its MCP servers are all HTTP (they go through the bridge). A plugin on the node that relies on a token seeded on the node cannot be seen from the files: it says so. |
| `manifest` | No server the node manifest allows it carries a node secret. |
| `tier` | A live node of the persona's label offers the box's sandbox tier. Asked only where `SLAUDE_REDIS_URL` is set; otherwise it says it was not checked. |
| `private-code` | It needs no private repository or registry (`--no-private-code`), or its `mcp` declares a code-host server (`--code-host <name>`). On a terminal the command asks when neither flag is given. |

The command **reports only and edits nothing**. An item it cannot decide
from the files is printed as `check`, never as `ok`. It exits 1 when
something failed, with "stays unboxed" and the reason.


### What can go wrong, and what you see

| Situation | What happens |
|---|---|
| The stored box set does not verify, or is older than one the gateway has seen (a restored database backup) | Every boxed turn is refused with "the sandbox could not be started"; a sync is refused with 503. It never runs unboxed instead. After a deliberate restore, an operator clears the mark (the `box-set:<tenant>` entry in `$SLAUDE_HOME/guardrails/.high-water.json` and the Redis key `<prefix>:guardrails:high-water:box-set:<tenant>`), then syncs. |
| A payload rendered with `personas render --no-push` is deployed | Refused with 422: its image digest names an image that was never pushed. A dry run still prints the diff. |
| No node of the label offers the box's tier | The turn is not run; the thread is told no worker for the sandbox is available. |
| The image a session is pinned to is gone | The turn is refused; `/box status` says so and `/box refresh` moves the thread to the current image. |

## Security

**What a box gives you on the gVisor tier, if gVisor holds:**

- A session cannot read or write another session's workspace, home,
  configuration, scratch files, environment or memory.
- There is no credential in the box to steal: not the provider's, not the
  node's, not a job token, not a tool token.
- A session connects nowhere except through its own proxy.
- A session cannot change its own image, policy or limits. They come from
  the signed set and are applied outside the box.
- A session cannot take more than its limits, and its node cannot be pushed
  past its capacity by its sessions.

**What it does not give you:**

- **A sandbox escape lands in a privileged container.** From there the
  node's disk and the worker's files are reachable. gVisor narrows the
  kernel's attack surface a great deal; it is not a second machine. Node
  labels remain the answer for workloads that must not share a host.
- **The bwrap tier shares the node's kernel.** Its seccomp filter is a short
  deny list, not an allow list.
- **Data can leave through an allowed host.** See the egress limits above.
- **A box can spend the model provider's credential without holding it.** A
  prompt-injected turn can make model calls, bounded by the existing
  budgets.
- **What a user pastes into a thread** is in the transcript and can end up
  in a file.
- **A shared channel folder is shared** by the sessions that use it.
- **Redis and the bucket are as before.** A node still reaches Redis and
  holds the bucket credential. Boxes make the node worker much harder to
  compromise (the agent no longer shares its user); they do not make Redis
  safer.
- **Persistence inside one session.** An agent can leave something in its
  own home that runs in a later turn of the same session. It cannot cross to
  another session.

**What the supervisor is.** It is privileged, so it is kept small: a fixed
set of requests over a socket that only the node worker can open (mode
0600, in a volume only the two containers mount, never given to a box),
every path checked against its box directory and the mount roots it was
started with, no Secret, no `envFrom`, and a refusal to start with any
credential-named variable in its environment. Treat the manifests' rule
that `boxd` mounts no Secret as a rule, not a default: tests in the
repository fail if the shipped manifests break it.
