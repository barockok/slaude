---
title: "Per-persona config on nodes: an MCP bridge instead of credentials on the node, and a KB scope that is a filter"
date: 2026-10-05
---

A persona managed as code could declare remote MCP servers and knowledge bases,
but on a node neither took effect: the runtime bundle carried no MCP config, and
every persona read every knowledge base. This work makes both per persona on
nodes, and serves episodic memory for node turns from the gateway. The operator
pages are [MCP bridge](../deploy/mcp-bridge.md) and
[Knowledge scope](../deploy/knowledge-scope.md).

## The MCP bridge

**Why not send the config to the node.** A persona's `mcp` is stored with its
`${PERSONA_*}` placeholders already resolved, so it holds real header and env
secrets, and every person's OAuth tokens for those servers live in the
gateway's store. Sending either to a node puts it in reach of every agent turn
on that node. So the bundle carries only server **names** (`mcpServers`), the
node mounts one generic in-process relay per name, and every `tools/list` and
`tools/call` goes to the gateway over `/v1/tools/mcpx/<server>/...`, label-gated
like every tool route. The gateway chooses the credential per call (the agent's,
or the person's in a locked 1:1), talks to the upstream, and refreshes tokens
single-flight across replicas.

**A transparent HTTP proxy was investigated and rejected.** The CLI would carry a
bearer on its argv fixed at boot with no rotation; a static `Authorization`
header turns off the CLI's own OAuth so a 401 becomes terminal; without it the
CLI starts OAuth discovery against the gateway's URL; and legacy `sse` servers
would need their endpoint event rewritten.

**The spike.** A throwaway upstream, a gateway-side relay and a node-side
generic bridge were run with the real CLI through the Agent SDK. Model-free, 15
of 15 checks passed, including tool definitions byte-equal to a direct
connection. Through the CLI, five tool shapes (simple, nested schema, image
content, `isError`, `structuredContent`) reached the upstream with intact
arguments, and the upstream saw the agent's credential in one turn and the
user's in the next, in the same live session. **Measured: the CLI lists tools
once**, at boot. After a `tools/list_changed` notification it did not list
again, and reconnecting an in-process server throws. So the tool list is fixed
when the session starts, and a connect bumps a per-identity epoch signed into
the session-config fingerprint, which reboots the warm session so it lists again.

**Only the managed persona's configuration is bridged by default.** Files under
`$SLAUDE_HOME` (the global `.mcp.json`, `personas/<name>/mcp.json`) sit on the
shared volume that agent turns can write, so a file there must not decide where
the gateway sends credentials. File configs need an explicit opt-in, and their
`${VAR}` placeholders expand only for listed names.

**Every request goes through the outbound policy**: https only, every resolved
address checked, the connection pinned to the checked address, no redirects. A
server's static headers are pinned to the origin they were first sent to, so a
config change cannot redirect them.

### What went wrong in the bridge

- **Retries made calls run twice.** A 5xx or a dropped connection after the
  request was sent may mean the tool ran. Bridged calls are now at most once:
  only a stale-session rejection is retried. A call that loses its answer says
  it may have run.
- **One failure retired a session other calls were using.** Pooled sessions are
  now leased and reference-counted; a failure marks that session stale and it
  closes when its last call finishes.
- **Deadlines.** A shared session open inherited its first caller's remaining
  budget, and a call waiting on that open ignored its own abort. Each call now has
  one deadline across slot wait, open and retry, and an open gets the configured
  timeout.
- **`/mcp connect` and the bridge disagreed** about a server's configuration, so
  a connect stored a credential under a key the bridge never looked up. In the
  gateway role both now use the bridge's view.

## Knowledge scope

`kbSources` names the `kb-<label>` sources a persona may read. The gateway
intersects it with the installed KBs on every call, for the in-process tools and
for the node's REST tool plane. `list_kbs` and `search_kbs` were unscoped and
returned disk paths; they are now filtered and path-free, so a persona cannot
learn that a KB it may not read exists. **This is a filter, not isolation**: the
KB files are on the shared volume and a node's agent turns can read them with
file tools. The page says so.

A payload carrying `kbSources` is version 3, so a gateway that predates the
field refuses it instead of dropping it and widening the persona to every KB.

## Episodic memory on nodes

The Secret split removed the database URL from nodes, which exposed that node
turns had run memory against the brain directly, and that the node process,
which never learns a persona's identity, wrote **every** persona's transcripts,
1:1s included, into one `agent-default` slice. Memory for node turns now runs on
the gateway through `/v1/tools/memory/prefetch` and `/sync`, scoped by the
persona's own agent id and the turn's lock (the more private of the live lock
and the token's claim). Calls are bounded on both sides (3 s on the node, 2 s on
the gateway) and never break a turn; failures are counted in
`slaude_memory_gateway_failures_total`.

`mono` still uses the in-process provider with the process-wide identity, so in
`mono` named personas' turns land in the default persona's slice. That is a
tracked follow-up, and so is the case of a manager speaking in someone else's
locked thread, which `memoryScopeFor` writes to the persona's shared slice.

## Prompt injection found on the way

The `kb_think` synthesis child is fed gbrain's gathered pages. It was started
with `allowedTools: []` and `bypassPermissions`; the SDK drops an empty
`allowedTools`, so the CLI ran with no tool restriction. Against the real CLI
with a stub model, a prompt-injected page made the synthesis child run Bash. It
now runs with no tools, `dontAsk`, a strict MCP config and no setting sources,
and a page starting with `/` can no longer be read as a slash command.

## Not done

The node-side MCP credential seeding stays until the bridge has run on a
cluster, then a cleanup removes it. Not measured: the bridge's added latency and
gateway load on a cluster, and abort propagation and large results end to end.
