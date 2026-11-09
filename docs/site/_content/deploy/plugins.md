---
title: Plugins on nodes
description: Bake Claude Code plugins into the node image under SLAUDE_PLUGIN_ROOT, what the gateway's read-only inventory shows, and how a plugin's HTTP MCP server reaches the portal.
---

# Plugins on nodes

A plugin and everything it needs (Python, JavaScript, binaries) belongs to the
machine. It is declared in the node image and pinned by `slaude install`; the
console can show a plugin but never installs, upgrades or enables one. Every
agent on a machine gets every plugin on that machine: agents differ by the node
label they run on (`runsOn`).

## The image-owned plugin root

`SLAUDE_PLUGIN_ROOT` names a directory baked into the node image at build time,
owned by root and not writable by the node's user:

```
$SLAUDE_PLUGIN_ROOT/
  plugins/installed_plugins.json
  plugins/cache/<marketplace>/<plugin>/<version>/...
```

Why it matters: a plugin's HTTP MCP server is offered in the portal automatically,
with no approval step, so a file an agent turn can write must never be able to
name that server's URL. `$SLAUDE_HOME` is the volume agents write to, so a plugin
installed there still works for skills and commands but its HTTP servers are not
offered. A node reports a server as offerable only when the plugin is listed
under `SLAUDE_PLUGIN_ROOT` and the plugin directory, its `.mcp.json`,
`installed_plugins.json` and every parent directory of each are owned by root and
not writable by the node's process, its group or others. The only exception is a
root-owned sticky directory above the root, such as `/tmp`. Anything else is
listed with the state `not offered: plugin files are writable by the agent`.

Set `SLAUDE_PLUGIN_ROOT` in the container's real environment (`ENV` in the image,
or the pod spec). A `.env` file under `$SLAUDE_HOME` cannot set it: agents can
write that file.

A node running as root fails this check by design: root can write anything. The
repository Dockerfile leaves the runtime user to the deployment, so set a
non-root user for the node's container, for example:

```yaml
securityContext:
  runAsUser: 1000
  runAsGroup: 1000
  runAsNonRoot: true
```

## Baking plugins into the image

Build from the repository Dockerfile (or `FROM` your published image), run the
installer as root at build time, and make the node run as another user. The
target directory must have the same path at build time and at run time, because
`installed_plugins.json` records absolute paths.

```dockerfile
FROM slaude:node AS base

# Run as root: the plugin files end up owned by root and not writable by the
# node's user.
USER root
ENV SLAUDE_PLUGIN_ROOT=/opt/slaude/plugins
# Not under /data: that is a VOLUME, so build-time writes there are discarded.
COPY slaude.json slaude.lock /build/.slaude/
RUN SLAUDE_HOME=/build/.slaude bun run install-deps --frozen --plugin-root "$SLAUDE_PLUGIN_ROOT" \
 && chmod -R a-w,u+w "$SLAUDE_PLUGIN_ROOT"
# Any Python or JS the plugins need goes in here too, as root.

USER 1000:1000
```

The node's volume at `/data` must be writable by that user (for example
`fsGroup` in Kubernetes, or `chown` on first use).

Equivalently, leave `--plugin-root` off and set `SLAUDE_PLUGIN_ROOT` for the
`RUN bun run install-deps` step: the flag wins when both are given. Skills,
knowledge and `slaude.lock` still go under `$SLAUDE_HOME` as before.

Set `SLAUDE_PLUGIN_ROOT` to the same value in the node's environment at run
time. Without it a node still reports its plugins, and none of their HTTP
servers are offered.

## What the gateway sees

At start, before it claims any job, a node posts its report to
`PUT /v1/node/plugins`: per plugin its name, marketplace, commit, counts of
skills, commands, agents and hooks, the names of its stdio MCP servers and
whether the [node manifest](node-manifest.md) declares each, and its HTTP MCP
servers with their URL (scheme, host and path only) and state. The report carries
no header or env value. The gateway takes the node's id and labels from its
verified credential, never from the report body, and checks every offerable URL
against its outbound policy. A report is sent once per node process, and the gateway keeps
only the first for that process; a change to the image needs a node roll to show.
A report counts only while its process heartbeats. Revoking a node credential
removes its reports (Postgres: sqlite has no revocation).

A URL path is stored as written. Do not put a secret in a plugin server's URL
path: it is not detected, though the console and the portal show only the host.

Console: **Resources > Plugins**, read-only, grouped by node label. It shows each
plugin's commit, contents and per-server state, flags two nodes of one label on
different commits, shows the last report time of an offline node, and marks a
stdio server missing from a node's manifest as `not mounted on this node`.

## What reaches the portal

An HTTP server from a plugin is offered to a person when a live node carrying
the agent's `runsOn` label lists it as offerable. The portal row names the plugin
and host; a connect then works exactly as for any other server, per-user OAuth
through the [MCP bridge](mcp-bridge.md) with credentials staying on the gateway.
A node never holds the token.

| Situation | Result |
| --- | --- |
| The agent's own persona config has a server of the same name | The persona's own server wins |
| Sealed reports on one label give the same name different URLs | Neither bridged nor offered; the console shows the conflict |
| An unsealed report disagrees with a sealed one | Still offered; the console shows a warning, so an agent cannot veto the server |
| No live node process's report lists the server | It leaves the portal |
| The node uses the shared legacy token | `not offered: node uses the shared legacy token` (mint a signed credential) |
| The URL has a query or userinfo | `not offered: url carries query or credentials` |
| The host does not resolve at the gateway | `not offered: host did not resolve`, checked again at every refresh |
| The server declares headers | `not offered: needs static headers` (the bridge has no values to send) |
| The URL resolves to a private or metadata address, or is not https | `not offered: refused by the outbound policy` / `not offered: invalid url` |

Plugin servers only ever reach agents by label: an agent on a label without the
plugin does not get the server. A URL change requires a new connect, because the
stored credential is keyed on the URL. stdio and SSE plugin servers are not
bridged (a stdio server still runs on the node when the node manifest allows it).

The gateway reads the inventory into memory on start, after a report, and every
15 seconds, so a change is visible across gateway replicas within that interval.

## What the guarantee rests on

At start a Linux node makes itself non-dumpable, so a tool running at the node's
uid cannot read the node's environment from `/proc` or ptrace it for its
credential. The node warns if it cannot. This narrows the risk and does not
remove it: **the automatic offer's full guarantee needs agent tools running under
a separate uid from the node process.** Someone who holds a node's credential and
a live process id can report a server URL and have it offered on that node's
labels; existing credentials stay safe, because each is bound to its own URL.

A node without plugins, or a deployment with none, sees an empty page and no
change in behavior. Mono mode is unchanged.
