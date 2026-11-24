---
title: Boxes
description: One sandbox per session, built from a reviewed image, with no secret inside. What persists, what "no secrets" means for tools, private code, stdio MCP servers, refresh, and the opt-in checklist.
---

# Boxes

> **Status: in development, off by default.** The gateway side is in place
> behind `SLAUDE_BOX`: box definitions in the deploy repository, the sync, the
> signed box set, pinning a session to an image, refresh, the inventory of
> which node holds which image, and the capacity rules. The node side now
> exists too: the box supervisor, the gVisor and bwrap drivers and the two
> proxies described below. **It has run on a development VM and in a
> privileged container there, never on a cluster**, and the Kubernetes and
> compose manifests that add the supervisor container are not written yet. So
> a deployment cannot switch it on from the shipped manifests today. This page
> describes the design so a deployment can prepare its personas. What was
> measured, and what was not, is in the
> [smoke test field note](../field-notes/2026-11-25-box-smoke.md).

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

## No secrets

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

## Stdio MCP servers

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
  would expand it. *(This check exists today.)*
- **A boxed session ignores the [node manifest](node-manifest.md).** It gets
  exactly its box's servers plus the gateway-side ones. A node logs one
  warning for a persona that is both boxed and allowed servers in its
  manifest. *(The resolver exists today; it is used only on a node set to a
  sandbox tier.)*

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

## The opt-in checklist

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

## Switches

| Variable | Where | Default | |
|---|---|---|---|
| `SLAUDE_BOX` | gateway | `off` | `on`: a persona that names a box is pinned and dispatched only to a node that offers its tier. `off`: boxes are validated and stored, and nothing reads them. |
| `SLAUDE_BOX_DEFAULT` | gateway | unset | The box of a persona that names none. |
| `SLAUDE_BOX_UNBOXED` | gateway | `allow` | What happens to a persona that names a box and cannot be boxed (a provider credential form no box can use): `allow` runs it unboxed with a warning at sync; `refuse` does not run it and fails the sync. |
| `SLAUDE_BOX_TIER` | node | `none` | The sandbox tier the node offers. No tier other than `none` works in this release. |

The full list is in the [configuration reference](../reference/configuration.md).

## What can go wrong, and what you see

| Situation | What happens |
|---|---|
| The stored box set does not verify, or is older than one the gateway has seen (a restored database backup) | Every boxed turn is refused with "the sandbox could not be started"; a sync is refused with 503. It never runs unboxed instead. After a deliberate restore, an operator clears the mark (the `box-set:<tenant>` entry in `$SLAUDE_HOME/guardrails/.high-water.json` and the Redis key `<prefix>:guardrails:high-water:box-set:<tenant>`), then syncs. |
| A payload rendered with `personas render --no-push` is deployed | Refused with 422: its image digest names an image that was never pushed. A dry run still prints the diff. |
| No node of the label offers the box's tier | The turn is not run; the thread is told no worker for the sandbox is available. |
| The image a session is pinned to is gone | The turn is refused; `/box status` says so and `/box refresh` moves the thread to the current image. |
