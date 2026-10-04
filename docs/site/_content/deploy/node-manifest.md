---
title: Node MCP manifest
description: Declare which stdio MCP servers a node runs, and for which personas. Plugin MCP servers run on a node only when declared here.
---

# Node MCP manifest

**A node is one trust domain.** Every agent child on a node runs as the node's
user, and so does every stdio MCP server those children start. One child's Bash
tool, a plugin subprocess or a prompt-injected turn can read the node process's
environment and the other processes' environment and arguments
(`/proc/<pid>/environ`, `cmdline`). The manifest decides which stdio servers a
persona's session gets; it does **not** keep personas that share a node apart.
Labels separate trust between nodes. Put personas that must not see each
other's secrets on nodes with different labels (see
[Multi-node scale-out](multi-node.md)).

A stdio MCP server is a program installed on the machine, so the node, not the
gateway, chooses it. The node reads a manifest file at start; the gateway never
reads it.

> **Behaviour change for nodes.** A node mounts **no** stdio MCP server, and
> **no plugin MCP server**, unless this manifest declares it and allows it for
> the session's persona. Before this release a node mounted every installed
> plugin's MCP servers for every persona. A node without a manifest file now
> mounts none. Servers resolved by the gateway (the reply and approval tools,
> `slaude_session`, gateway-side MCP servers) are not affected.

`mono` is unchanged: it reads no manifest and mounts installed plugin MCP
servers as before. The manifest applies only to `SLAUDE_ROLE=node`.

## The file

`SLAUDE_NODE_MANIFEST` names the file; the default is `/etc/slaude/node.json`.

```json
{
  "version": 1,
  "mcpServers": {
    "tf": { "command": "terraform-mcp", "args": ["--stdio"], "env": { "TF_TOKEN": "${NODE_TF_TOKEN}" } },
    "gh": { "command": "gh-mcp" }
  },
  "allow": {
    "platform-bot": ["tf", "gh"],
    "support-bot": ["gh"],
    "ops-bot": "*"
  }
}
```

| Field | Meaning |
|---|---|
| `version` | Must be `1`. |
| `mcpServers.<name>` | A stdio server. `command` (required), `args` (strings), `env` (string values), `type` (only `"stdio"`). No other key is accepted. Names match `^[a-z0-9][a-z0-9_-]{0,63}$`. |
| `allow.<persona>` | The servers that persona's sessions mount: a list of names from `mcpServers`, or `"*"` for every server in the file. |

The file is read and checked once, when the node starts. A change needs a pod
restart. The node refuses to start, with an error naming the field, when:

- the file is not valid JSON, is empty, or has a duplicate key;
- a key is unknown, `version` is not `1`, or a server is not stdio (a `url`, or
  `type` other than `"stdio"`);
- a server name is malformed, or an `allow` entry names a server that is not in
  `mcpServers` or names one twice;
- an `env` value references a variable the node does not have, or a variable
  that may never reach a subprocess (below);
- `${` appears anywhere the CLI would expand it (below).

A missing file is not an error: it is an empty manifest, so no persona gets a
stdio server. The node logs one line at start with the server and persona
names it loaded.

## Who gets what

- A persona **not listed** in `allow` gets nothing.
- A listed persona gets exactly the servers in its list, or every server for
  `"*"`.
- The persona is the one in the session's **job token**, which the gateway
  signs, never the persona id in the queued job's payload. A node holds no
  signing key, so before it mounts anything it fetches that persona's runtime
  bundle with the token: the gateway answers only a token it signed for that
  persona. If the gateway refuses, the session does not start.

The persona name is the name the gateway uses for it (the default persona is
`default`).

## Plugin MCP servers must be declared

A plugin installed on the node still provides its skills, commands, hooks and
agents. Its MCP servers are **not** read from the plugin: the manifest is the
only source of stdio servers on a node. To run a plugin's server, copy its
entry from the plugin's `.mcp.json` into `mcpServers` (same name, command and
arguments) and allow it for the personas that need it. An installed plugin
whose server is not in the manifest runs without that server.

## Environment

A plain `${VAR}` in an `env` value is expanded when the node starts, from the
node's own environment. Literal values are kept as written. A reference to a
variable the node does not have stops the node.

These variables can never be used, as a reference or as an `env` key: every
gateway-only variable (the list under `SLAUDE_NODE_BOOT_CHECK` in the
[configuration reference](../reference/configuration.md#queue-redis)), plus
`SLAUDE_NODE_TOKEN`, `SLAUDE_REDIS_URL` and `SLAUDE_ENCRYPTION_KEY`. A manifest
that uses one stops the node, naming the variable.

**The CLI expands `${…}` a second time.** The Claude CLI that starts each
server expands `${VAR}` and `${VAR:-default}` in the server's `command`, `args`
and `env` values against its own environment, which is the agent child's and
holds the persona's provider credentials. To leave it nothing to expand, the
node refuses to start, naming the field (never the value), when:

- `command` or an `args` entry contains `${` (expansion happens only in `env`
  values; use an absolute path, or pass the value through `env`);
- an `env` value uses any form other than a plain `${NAME}`: a default
  (`${NAME:-x}`), another modifier, or an unterminated `${`;
- an `env` value, once expanded, still contains `${` (the node variable's own
  value holds one);
- `PATH`, `HOME`, `LANG` or `TMPDIR` in the node's environment contains `${`.

Each server starts with an **explicit minimal environment**: its own `env`,
plus `PATH`, `HOME`, `LANG` and `TMPDIR` from the node. A server's own `env`
overrides one of the four. slaude starts the server through a small wrapper
that receives the variable names in its arguments and the values in its
environment, and starts the real command with only those. The server does not
inherit the agent child's environment, and because no `${` reaches the CLI,
the CLI cannot substitute one of the child's variables into the server's
arguments or `env`.

The expanded values are part of the MCP configuration the agent child is
started with, and the Agent SDK passes that configuration on the child's
command line; the wrapper then holds them in its environment. Any process on
the node can read both, which is the trust model above: give a node only the
credentials every persona on it may see.

## Name collisions and other MCP sources

The node merges the manifest's servers first and the gateway-resolved servers
after them. When both have a server with the same name, the gateway's server
wins and the node logs a warning naming it.

The node starts every agent child with `strictMcpConfig`: the CLI uses only the
servers slaude passes and reads no project `.mcp.json`, user settings or plugin
MCP configuration. The `<mcp-servers>` block in the system prompt lists exactly
the servers the session mounts.

## Shipping the manifest

Bake it into the node image:

```dockerfile
COPY node.json /etc/slaude/node.json
```

Or mount it from a ConfigMap on the node Deployment:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: slaude-node-manifest
data:
  node.json: |
    {
      "version": 1,
      "mcpServers": { "gh": { "command": "gh-mcp" } },
      "allow": { "support-bot": ["gh"] }
    }
---
# in the node Deployment's pod spec
volumes:
  - name: node-manifest
    configMap:
      name: slaude-node-manifest
containers:
  - name: node
    volumeMounts:
      - name: node-manifest
        mountPath: /etc/slaude
        readOnly: true
```

A credential an `env` value references (`NODE_TF_TOKEN` above) goes in the
node Secret, never in the ConfigMap. The program each server runs must be
installed in the node image. Nodes with different labels can ship different
manifests.
