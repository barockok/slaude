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

The bridge serves the persona's **remote HTTP servers** (`"type": "http"` with a
`url`): the same servers `/mcp connect` and the portal offer. It takes them from
the persona's MCP configuration on the gateway (personas as code, or the
persona's `mcp.json`, or the global `.mcp.json` for the default persona).

The runtime bundle the node fetches carries only the server **names**
(`mcpServers: ["crm", "docs"]`). A node that predates the bridge ignores the
field. A node with this release and a gateway without it mounts no bridged
servers.

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
and an in-process server cannot be reconnected. So:

- the list is fetched when the session starts, with the identity the session
  starts as;
- **every call** still uses the identity of the current turn. If a session that
  started as the agent later runs a turn as a person, that turn's calls use the
  person's credential;
- a `/1on1` lock that starts or ends restarts the session, which fetches the list
  again;
- a cron job that runs as its creator on a session that is already running keeps
  the list that session started with. A tool that needs the creator's own
  credential then fails cleanly with a tool error.

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
private server, which gets none).

A stored connection is used only for the origin (scheme, host and port) it was
granted for. If a persona's server URL moves to another host after a connection
was made, the old token is not sent to the new host; the server must be
connected again.

Upstream sessions are kept per identity and server and are never shared between
identities.

## Failures

A failure is a **tool error** for the agent, never a failed turn, and never
contains the upstream server's response body.

| Situation | Tool error text |
|---|---|
| The server answers 401 with an OAuth connection | the gateway refreshes the token once (one refresh across all gateway replicas) and retries once |
| The refresh fails, the server still refuses, or a static credential is refused | `this agent's connection to S needs to be re-authorised` |
| A private server and no connection for the person | `connect S: this conversation runs as you, and S uses your own connection, which is not set up yet` |
| The server is down or answers an error | `S is unavailable right now; try again later` |
| The call takes too long | `S did not answer within Ns` |
| The turn is aborted | `the call to S was cancelled` (the upstream gets a cancellation and its request is closed) |
| The outbound policy refuses the host | `S: outbound request refused: <host> …` (the host and the category, never the address) |
| Too many calls in flight for one identity | `too many MCP calls are in flight for this identity; S was not called` |
| The gateway refuses the node for this agent (label gate) | `the gateway refused this node for this agent; this tool cannot run here` |

For the re-authorise and connect cases, the gateway also posts the usual
**Connect** card in the thread (the same card `/mcp` shows), at most once per
session and server every 10 minutes per gateway replica. For a turn as the agent
the card is for the manager (only the manager may connect the agent's shared
identity); for a turn as a person it is for that person, who must still hold the
thread's `/1on1` lock when clicking.

If a server's tool list cannot be fetched when the session starts, the server is
mounted with no tools and the reason as its instructions (for example the
`connect S` text), or, if the gateway cannot be reached, it is left out of that
session.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `SLAUDE_MCP_BRIDGE_TIMEOUT_MS` | `50000` | Longest one upstream call may take. Keep it shorter than any timeout of the ingress or proxy in front of the gateway. A server's own `timeout` (milliseconds, in its configuration) can only lower it. |
| `SLAUDE_MCP_BRIDGE_OWNER_CONCURRENCY` | `8` | Calls in flight at once for one identity (the agent of one persona, or one person). Further calls wait for a free slot within the timeout. |
| `SLAUDE_MCP_BRIDGE_MAX_REQUEST_BYTES` | `1048576` | Largest request body a node may send for one call (`413` above it). |
| `SLAUDE_MCP_BRIDGE_MAX_RESULT_BYTES` | `1048576` | Largest result returned to the agent. A larger result keeps its text up to the limit and ends with `[result truncated by the MCP bridge: N bytes is over the M-byte limit]`; images and structured content are dropped, and a result that had structured content is marked as an error. |

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
  configuration.

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
