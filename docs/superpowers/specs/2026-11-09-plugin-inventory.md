# Plugin inventory and portal-connected plugin MCP servers

Status: proposed.

## Goal

Make Claude Code compatible plugins visible at the gateway, and let a person
connect a plugin's HTTP MCP server from the portal, without giving the console
any control over what a machine runs.

## Decisions

1. A plugin and its dependencies (Python, JS, binaries) belong to the machine.
   They are declared in the node image and pinned by `slaude install`. The
   console never installs, upgrades or enables a plugin.
2. Every agent on a machine gets every plugin on that machine. There is no
   per-agent setting. Agents differ by the node label they run on (`runsOn`).
3. The gateway holds a read-only inventory, reported by the nodes.
4. An HTTP MCP server in that inventory is offered in the portal automatically,
   with no operator approval, subject to the guards in "Trust".

Out of scope: per-agent plugin selection, installing from the console, mono mode
(which keeps mounting plugin servers from disk as it does today), and bridging
stdio or SSE plugin servers.

## What exists today

- `slaude install` clones a marketplace at a pinned ref, records it in
  `slaude.lock`, and writes `installed_plugins.json` under
  `$SLAUDE_HOME/.claude/plugins`.
- A session mounts every installed plugin's skills and commands
  (`Options.plugins`).
- On a node, a plugin's MCP servers are not read from disk. A stdio server must
  be declared in the node manifest and allowed for the persona. HTTP plugin
  servers are not mounted at all.
- `bridgeExternalMcp` is the one list of servers the gateway's MCP bridge will
  serve. The portal offer (`portalServers`, through `connectableServers`) uses
  the same list in the gateway role. Credentials stay on the gateway; a node
  reaches an HTTP server through the bridge and never holds the token.
- The stored credential key covers the server name, URL and headers
  (`oauthKey`), so a credential is already bound to its URL.
- MCP OAuth and bridge traffic already go through `src/net/outbound-policy.ts`
  (https only, private and metadata addresses refused).

## Trust

`bridgeExternalMcp` deliberately refuses server configs from files on
`$SLAUDE_HOME` unless the operator opts in, because agent turns can write to
that volume, and a file there must not name where the gateway sends
credentials. Plugins are installed under that same volume today.

A report built from those files would let a compromised turn rewrite a plugin's
`.mcp.json` and have the portal present the attacker's server to people, under a
name they trust. Automatic offering is therefore only safe from a plugin
location agents cannot write to.

Rules:

- **Image-owned plugin root.** `SLAUDE_PLUGIN_ROOT` names a directory baked into
  the node image at build time, owned by root and not writable by the node's
  user. `slaude install` can target it, and `loadInstalledPluginPaths` reads it.
  The existing location keeps working for skills and commands.
- **Sealed check.** A node reports an HTTP server as offerable only when the
  plugin directory, its `.mcp.json` and `installed_plugins.json` are not writable
  by the node's process (which is the agent's user). A node running as root
  fails this check by design. Anything else is listed with the state
  `not offered: plugin files are writable by the agent`.
- **Reported once per process**, at node start, before any turn runs.
- **No secrets.** The report carries no header or env values and strips userinfo,
  query and fragment from URLs. An HTTP server that declares headers is listed
  with the state `not offered: needs static headers`, because the bridge would
  have no values to send.
- **Verified labels.** The gateway takes the node id and labels from the verified
  node credential, never from the report body.
- **URL guards.** `https` only, checked against the outbound policy. A URL change
  needs a new connect, which `oauthKey` already enforces.
- **Portal disclosure.** The connect row names the plugin and host.

Remaining risk, accepted with the automatic offer: an attacker who fully owns a
node (its credential, not just an agent turn) can report a server URL and have
it offered. They gain a phishing surface and a tool server for agents on that
label. They do not gain existing credentials, because those are bound to their
own URLs.

## Design

### Inventory

At start, a node posts to a new node-authenticated route, `PUT
/v1/node/plugins`. The body lists, per plugin: name, marketplace, commit, counts
of skills, commands, agents and hooks, stdio MCP server names (with whether the
node manifest declares each), and HTTP MCP servers (name, URL, state). The report
replaces that node's previous one.

Storage is a new table, one row per node: node id, labels, `reported_at`, and the
report as JSON, in both the Postgres migrations and the sqlite schema.

A gateway older than this route answers 404, and the node logs it and continues.
An invalid entry is dropped and logged; the rest of the report still counts. An
oversized report is refused with 413.

### Bridge and portal

`bridgeExternalMcp` gains a source: offerable HTTP servers from the latest report
of live nodes carrying the persona's `runsOn` label. The persona's own configured
server of the same name wins. Because the portal offer and the bridge share this
list, the portal row, the "used by" list and the credential lookup all follow
without a second code path.

If nodes of one label report the same name with different URLs, the server is
neither bridged nor offered, and the console shows the conflict. A server leaves
the portal when no live node's latest report lists it.

### Console

Resources gets a read-only Plugins page, grouped by node label: plugin, commit,
contents, and per-server state. It flags two nodes of one label on different
commits, shows the time of the last report for an offline node, and marks a stdio
server missing from the node manifest as `not mounted on this node`. There are no
write actions.

## Testing

- The report never contains header or env values, URL userinfo or query.
- The sealed check: writable and read-only trees, and a root process.
- Node id and labels come from the credential, not the body.
- Bridge merge: label scoping, own config wins, URL conflict, removal.
- Portal rows and connect resolve through the merged list.
- An agent on a label without the plugin does not get the server.
- A URL change needs a new connect; a private address is refused.
- An older gateway (404) does not stop a node from starting.
- Schema match across Postgres and sqlite, and a sim scenario for the full path.

## Rollout

A node without `SLAUDE_PLUGIN_ROOT` still reports its plugins, and none of its
HTTP servers are offered. Deployments with no plugins see an empty page and no
change in behavior.
