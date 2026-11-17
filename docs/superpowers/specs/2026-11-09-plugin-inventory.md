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
  The existing location keeps working for skills and commands. It is read from
  the real process environment only: `loadDotenv` refuses the name, because
  `$SLAUDE_HOME/.env` is agent-writable.
- **Sealed check.** A node reports an HTTP server as offerable only when the
  plugin directory, its `.mcp.json` and `installed_plugins.json`, and every
  ancestor of each, resolve inside the plugin root (the ancestors above it
  excepted), are owned by uid 0, and are not writable by the node's process, its
  group or others. `access(2)` alone is not enough: a process can make a tree it
  owns read-only. The one exception to the mode rule is a root-owned sticky
  directory above the plugin root, where a non-owner cannot rename a root-owned
  entry. A node running as root fails this check by design. Anything else is
  listed with the state `not offered: plugin files are writable by the agent`.
- **Reported once per process**, at node start, before any turn runs. The gateway
  keeps one report per credential and process id; the first stands and a later
  one gets 409. A process id is unique across credentials.
- **Per-process liveness.** A report counts only while the process that sent it
  heartbeats under its id, so a new process whose report failed does not inherit
  the previous process's servers. A row goes only after 7 days unseen and a fresh
  check that the process is gone, so a live process's report slot never reopens.
- **No secrets.** The report carries no header or env value and strips userinfo,
  query and fragment from URLs. An HTTP server that declares headers is listed
  with the state `not offered: needs static headers`, because the bridge would
  have no values to send. A URL with a query or userinfo is `not offered: url
  carries query or credentials`, because the stripped URL would be a different
  endpoint. A secret in a URL path is not detected: the path is stored and used,
  never shown in the console or the portal.
- **Verified labels.** The gateway takes the node id and labels from the verified
  node credential, never from the report body. The shared `legacy` token names no
  one machine: its report is listed with `not offered: node uses the shared
  legacy token`.
- **Revocation.** Revoking a credential deletes its rows, and each refresh voids
  a row whose credential was issued (`iat`) before the revocation time. On sqlite there is no
  `node_revocations` table, so a credential cannot be revoked there at all.
- **URL guards.** `https` only, checked against the outbound policy. A DNS failure
  is `not offered: host did not resolve`, distinct from a policy refusal and
  re-evaluated at every gateway refresh. A URL change needs a new connect, which
  `oauthKey` already enforces.
- **Portal disclosure.** The connect row names the plugin and host.
- **Bridge label.** A job's server list is scoped by the job's signed label, not
  the persona's current one.
- **Process hardening.** Nodes are started by executing `src/node/main.ts`
  directly; `bun run worker` would leave a parent (PID 1 in a container) holding
  the credential, and the shipped manifests are tested against it. As the entry's
  first import a Linux node makes itself non-dumpable (`PR_SET_DUMPABLE`), so a
  same-uid tool cannot read `/proc/<pid>/environ` or ptrace it for
  `SLAUDE_NODE_TOKEN`. This also disables its core dumps. Best effort: it warns
  when it cannot.
- **No `.env` on a node.** A node never reads `$SLAUDE_HOME/.env`, so a turn
  cannot set `SLAUDE_GATEWAY_URL`, `NODE_TLS_REJECT_UNAUTHORIZED` or the like for
  the next start. Its settings come from its real environment.
- **Bounded input.** A node may send only the states a node can know; a state the
  gateway decides is an invalid entry. One credential holds at most 256 rows, and
  a report triggers at most one refresh per 5 seconds.

Remaining risks, accepted with the automatic offer:

- **The gateway cannot tell a forged report from a real one if the node's token is
  stolen.** A report is a claim made with a bearer credential. The rules above
  limit what a holder can do (the first report per process stands, a report counts
  only under a heartbeating process id, input is bounded), but someone holding the
  token and Redis access can report a server URL under a process id that has not
  reported, and have it offered on that credential's labels. They gain a phishing
  surface and a tool server for agents on those labels. They do not gain existing
  credentials, because those are bound to their own URLs.
- **The automatic offer's guarantee against an agent turn depends on the
  direct-exec entry plus `prctl` on Linux.** Together they keep the token out of a
  same-uid tool's reach through `/proc` and ptrace. A deployment that starts the
  node another way, a platform without `prctl`, or a kernel or container that
  allows the read loses that protection, and the node only warns.
- **The full guarantee needs agent tools running under a separate uid from the
  node process.** At the node's uid, other routes to the token remain possible
  (a token placed on a readable path, for instance). The sealed check protects
  the plugin files in either case.

## Design

### Inventory

At start, a node posts to a new node-authenticated route, `PUT
/v1/node/plugins`. The body lists, per plugin: name, marketplace, commit, counts
of skills, commands, agents and hooks, stdio MCP server names (with whether the
node manifest declares each), and HTTP MCP servers (name, URL, state). It also
names the process id the node heartbeats under.

Storage is a new table, one row per credential and process: node id, process id,
labels, `reported_at`, and the report as JSON, in both the Postgres migrations
and the sqlite schema, plus the credential's issue time and when the process was
last seen. A refresh prunes rows of long-dead processes, keeping an offline
credential's latest report for the console.

A gateway older than this route answers 404, and the node logs it and continues.
An invalid entry is dropped and logged; the rest of the report still counts. An
oversized report is refused with 413, a second report from one process with 409,
and a report past the credential's row cap with 429.

### Bridge and portal

`bridgeExternalMcp` gains a source: offerable HTTP servers from the reports of
live node processes carrying the job's signed label (the persona's `runsOn` label
where there is no job, as for the portal). The persona's own configured
server of the same name wins. Because the portal offer and the bridge share this
list, the portal row, the "used by" list and the credential lookup all follow
without a second code path.

If sealed reports on one label give the same name different URLs, the server is
neither bridged nor offered, and the console shows the conflict. An unsealed
report cannot create a conflict, so an agent-writable plugin cannot veto a sealed
server; the console shows its disagreement as a warning. A server leaves the
portal when no live process's report lists it.

### Console

Resources gets a read-only Plugins page, grouped by node label: plugin, commit,
contents, and per-server state, by host (a URL path can hold a secret and is
never shown). It flags two nodes of one label on different
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
