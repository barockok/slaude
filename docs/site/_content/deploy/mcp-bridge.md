---
title: MCP bridge
description: How a persona's remote MCP servers reach the agent on a node through the gateway, without any MCP credential leaving the gateway.
---

# MCP bridge

In the gateway topology (`SLAUDE_ROLE=gateway` plus nodes), a persona's remote
MCP servers reach the agent through the **MCP bridge**. The node runs one small
in-process MCP server per remote server. That server forwards every tool list
and tool call to the gateway. The gateway is the real MCP client: it holds the
credential, refreshes OAuth tokens, and decides whose identity each call uses.
No MCP URL, header, token or refresh token is ever sent to a node.

`mono` does not use the bridge. A `mono` deployment mounts external MCP servers
directly, as before.

```
agent loop (CLI) on the node
  ├─ "crm"   in-process server ──┐
  └─ "docs"  in-process server ──┤  POST /v1/tools/mcpx/<server>/list|call
                                 │  (node credential + job token, label gate)
                                 ▼
                     gateway: MCP client, credential chosen per call
                                 │  MCP over streamable HTTP
                                 ▼
                     the real servers (https://crm.example.com/mcp, ...)
```

## What is bridged

The bridge serves a persona's **remote HTTP servers** (`"type": "http"` with a
`url`).

**By default only the managed persona's configuration is bridged**: the `mcp`
of a persona managed as code (or its runtime override), which is resolved at
sync and stored encrypted in the database, where an agent cannot change it.

Servers defined in **files** under `$SLAUDE_HOME` (the global `.mcp.json` and
`personas/<name>/mcp.json`) are **not** bridged. That directory is the shared
volume agent turns can write to, so a file there must not decide where the
gateway sends credentials. An operator who accepts that risk can opt in:

- `SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG=1` bridges file-defined servers too;
- with the opt-in, a `${VAR}` placeholder in a file is expanded only when `VAR`
  is listed in `SLAUDE_MCP_BRIDGE_ENV_ALLOW` (comma list, empty by default).
  Every other placeholder is left exactly as written (its name is logged once,
  never its value). Gateway-only variables are never expanded, even when
  listed.

The runtime bundle the node fetches carries only the server **names**
(`mcpServers: ["crm", "docs"]`), and only the servers the gateway will serve. A
node that predates the bridge ignores the field. A node with this release and a
gateway without it mounts no bridged servers.

**Not bridged:**

- stdio servers, legacy `sse` servers and plugin MCP servers. They run on the
  node and are governed by the node's own manifest, not by the bridge.
- server-to-client notifications (the bridge never opens the server's event
  stream), sampling, and MCP prompts and resources. Agents use tools; another
  capability is added per server when one needs it.

A bridged server name that is the same as one of slaude's own in-process servers
(for example `slaude_surface`) is not mounted.

## What the agent sees

Each bridged server is an ordinary MCP server named exactly as configured. Its
tools appear as `mcp__<server>__<tool>`, with the upstream's own names,
descriptions, input schemas, output schemas and annotations, unchanged. The
server's `instructions` are passed through. The server is listed in the
`<mcp-servers>` block of the system prompt.

### The tool list is fixed when the session starts

The agent CLI asks for a server's tool list once, when the session's agent
process starts, and does not ask again: it ignores "list changed" notifications,
and an in-process server cannot be reconnected. So the list is fetched when the
session starts, with the identity the session starts as, and **every call** still
uses the identity of the current turn.

The session restarts, and fetches the list again, on the next turn when:

- the identity the turn runs as changes: a `/1on1` lock that starts or ends, or
  a cron job that runs as its creator on a session that was running as someone
  else (the identity is part of the signed session fingerprint);
- a credential of the turn's identities was connected or disconnected (in Slack
  or the portal), or a Slack user was linked to or unlinked from an account.
  Each of these bumps a counter for that identity (in Redis); dispatch reads the
  counters of the turn's agent and person with one Redis read, and signs them
  into the session fingerprint. So a server that needed connecting when the
  session started lists its tools on the turn after the connect.

## Which credential a call uses

The gateway decides per call, from the job token's signed `runAs` (the identity
the turn runs as: the agent, or a person in a `/1on1` or a cron job created in
one). A server is **private** when it is named in `privateServices` and the turn
runs as a person.

| Turn | Credential sent to server `S` |
|---|---|
| runs as the agent | the agent's OAuth connection to `S`, else the static headers in the configuration |
| runs as a person, `S` private | the person's own OAuth connection only. Never the agent's, never the static headers, and the URL's query string is removed. A person with no linked account or no connection gets the tool error `connect S: …`, and never falls back to the agent |
| runs as a person, `S` not private | the person's OAuth connection to `S` if there is one, else the static headers in the configuration |

When an OAuth connection is used, its bearer token replaces any `Authorization`
header in the static headers; the other static headers are kept (except for a
private server, which gets none). A configuration cannot set `Host`,
`Content-Length`, `Mcp-Session-Id`, `Mcp-Protocol-Version` or hop-by-hop
headers; those are dropped.

Upstream sessions are kept per identity and server and are never shared between
identities.

### Credentials are pinned to their origin

These checks are defence in depth, on top of bridging only managed
configuration:

- a stored OAuth connection is sent only to the origin (scheme, host and port)
  it was granted for. If a server's URL moves to another host, the old token is
  not sent; the server must be connected again;
- a server's **static headers** are pinned to the origin they were first sent
  to, per persona, server and header values (in Redis, shared by every gateway
  replica). If the URL later points to another origin with the same headers,
  the call is refused with
  `S: its configured credentials are pinned to the host they were first sent to, …`
  and the new host receives nothing. Pins do not expire, and a persona sync
  that changes the URL does not reset them. To move a server on purpose,
  either rotate its header values (a new credential is pinned afresh), or
  delete the pin. The gateway logs the pin id once at the first refusal
  (`[mcp-bridge] refused: … pin id=<id>`; a hash of tenant, persona, server and
  header values, never a secret):

  ```sh
  redis-cli DEL "<SLAUDE_REDIS_PREFIX>:mcpx-origin-pin:<id>"   # prefix default: slaude
  ```

  The next call pins the new origin.

## Failures

A failure is a **tool error** for the agent, never a failed turn, and never
contains the upstream server's response body or its error message.

| Situation | What happens / tool error text |
|---|---|
| The server answers 401 with an OAuth connection | the gateway refreshes the token once (one refresh across all gateway replicas) and retries once |
| The refresh fails, the server still refuses, or a static credential is refused (401) | `this agent's connection to S needs to be re-authorised` |
| The server answers 403 | `S refused this call: permission denied for this identity` (no refresh, no card: re-authorising does not help) |
| A private server and no connection for the person | `connect S: this conversation runs as you, and S uses your own connection, which is not set up yet` |
| The upstream session is gone (a restart: 404 or 400 for the old session id) | the server rejected the request before running anything, so the pooled session is dropped and the call retried once on a fresh session |
| A tool **call** reached the server and then got a 5xx or lost its connection | **not retried**: calls are at most once, since the tool may already have run (created a ticket, sent a message). `the call to S was interrupted; it may have been executed — check before retrying` |
| The same while opening the session or listing tools (nothing was run) | retried once on a fresh session; if that fails: `S is unavailable right now; try again later` |
| The server answers with a JSON-RPC error | a fixed text per class: `S does not support this request`, `S rejected the call: unknown tool or invalid arguments`, `S rejected the request as invalid`, `S reported an internal error`, or `S returned an error (code N)` |
| The call takes too long | `S did not answer within Ns` |
| The turn is aborted | `the call to S was cancelled`: the upstream gets `notifications/cancelled` and the call's HTTP connection is closed |
| The outbound policy refuses the host | `S: outbound request refused: <host> …` (the host and the category, never the address) |
| Too many calls in flight | `too many MCP calls are in flight for this identity; S was not called` |
| The gateway refuses the node for this agent (label gate) | `the gateway refused this node for this agent; this tool cannot run here` |

For the re-authorise and connect cases, the gateway also posts the usual
**Connect** card in the thread (the same card `/mcp` shows):

- for a turn as the agent the card is for the manager (only the manager may
  connect the agent's shared identity), and only in a thread with no `/1on1`
  lock;
- for a turn as a person it is for that person, and only while they hold the
  thread's `/1on1` lock. A cron job that runs as its creator in a thread without
  their live lock gets **no** card, since nobody could use it; the tool error
  still says what to do;
- at most one card per session and server every 10 minutes, **per gateway
  replica** (the rate limit is kept in each process).

If a server's tool list cannot be fetched when the session starts, the server is
mounted with no tools and the reason as its instructions (for example the
`connect S` text), or, if the gateway cannot be reached, it is left out of that
session. A connect then restarts the session on the next turn (see above).

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `SLAUDE_MCP_BRIDGE_TIMEOUT_MS` | `50000` | One deadline per call, covering the wait for a slot, opening the session, a refresh and its retry. Keep it shorter than any timeout of the ingress or proxy in front of the gateway. A server's own `timeout` (milliseconds, in its configuration) can only lower it. |
| `SLAUDE_MCP_BRIDGE_SESSION_CONCURRENCY` | `4` | Calls in flight at once for one Slack thread's session on one server, so one thread's slow calls cannot hold up the persona's other threads. |
| `SLAUDE_MCP_BRIDGE_OWNER_CONCURRENCY` | `8` | Calls in flight at once for one identity (the agent of one persona, or one person) on one server. Further calls wait for a slot within the deadline. |
| `SLAUDE_MCP_BRIDGE_IDLE_MS` | `300000` | A pooled upstream session unused for this long is closed and reopened on the next call. |
| `SLAUDE_MCP_BRIDGE_MAX_REQUEST_BYTES` | `1048576` | Largest request body a node may send for one call (`413` above it). |
| `SLAUDE_MCP_BRIDGE_MAX_RESULT_BYTES` | `1048576` | Largest result returned to the agent. A larger result keeps its text up to the limit and ends with `[result truncated by the MCP bridge: N bytes is over the M-byte limit]`; images and structured content are dropped, and a result that had structured content is marked as an error. |
| `SLAUDE_MCP_BRIDGE_MAX_TOOLS` | `500` | Most tools listed for one server. |
| `SLAUDE_MCP_BRIDGE_MAX_LIST_BYTES` | `1048576` | Most bytes of tool definitions listed for one server. Over either list cap the gateway stops asking for further pages and appends `[tool list truncated by the MCP bridge: …]` to the server's instructions. |
| `SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG` | `0` | `1` also bridges servers defined in files under `$SLAUDE_HOME` (see [What is bridged](#what-is-bridged)). |
| `SLAUDE_MCP_BRIDGE_ENV_ALLOW` | `""` | With the file opt-in, the variable names a file's `${VAR}` placeholders may expand. |

The gateway and `mono` check every `SLAUDE_MCP_BRIDGE_*` value at boot and refuse to start, naming the variable, when one does not parse.

## Outbound policy

Every request the bridge sends goes through the gateway's
[outbound fetch policy](../reference/configuration.md#outbound-policy):

- `https` only;
- the host is resolved once and every address is checked; loopback, private,
  shared, link-local and cloud metadata addresses are refused, so a name that
  resolves inside the cluster (DNS rebinding) is refused too;
- the connection goes to the checked address;
- redirects are never followed, so a credential is never sent to a host the
  policy did not check;
- every request of a server's session is pinned to the origin in its
  configuration;
- response bodies are read as they arrive, so an answer on an event stream the
  server keeps open returns at once; the call's connection is closed when the
  call ends.

An MCP server inside the cluster (a private address, or `http`) must be listed in
`SLAUDE_OUTBOUND_INTERNAL_HOSTS` on the gateway. Loopback, link-local and metadata
addresses stay refused even for listed hosts. `SLAUDE_OUTBOUND_ALLOWED_HOSTS`
narrows the reachable hosts further.

## Routes

`POST /v1/tools/mcpx/<server>/list` and `POST /v1/tools/mcpx/<server>/call`
(body `{"name": "...", "arguments": {...}}`) are node-facing tool-plane routes.
They need the node credential and the job token, and pass the label gate like
every tool route. The tenant, persona, session, thread and identity come only
from the verified job token. A server the token's persona does not bridge answers
`404` with the same text as a server that does not exist.

## Node-side credentials (being retired)

Before the bridge, a node received access tokens through
`GET /v1/tenants/:t/mcp-credentials` and wrote them into a pod-local credential
file. That path stays in this release, unused by bridged servers, and will be
removed once the bridge has run in a cluster.
