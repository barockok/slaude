---
title: Plugin inventory, and why automatic portal offers need an image-owned root
description: Nodes report plugins to a read-only gateway inventory; HTTP plugin servers reach the portal only from a root agents cannot write.
---

# Plugin inventory, and why automatic portal offers need an image-owned root

A plugin belongs to the machine, so the console can only show plugins, not
change them. The interesting part is offering a plugin's HTTP MCP server in the
portal with no approval step.

The bridge deliberately refuses server configs from files on `$SLAUDE_HOME`:
agent turns can write that volume, and a file there must not name where the
gateway sends credentials. Plugins have always lived on that volume, so a report
built from those files would let one compromised turn rewrite a plugin's
`.mcp.json` and have the portal present the attacker's server under a name
people trust.

What makes automatic offering safe:

- `SLAUDE_PLUGIN_ROOT` is a directory baked into the node image at build time,
  owned by root. `slaude install` can target it; the plugin loader reads it first.
- A **sealed check** at report time: the plugin directory, its `.mcp.json`,
  `installed_plugins.json` and every parent of each must be owned by uid 0 and
  writable by nobody else (an ancestor the process can write lets it swap the
  tree). Root fails it by design. Anything else is listed, never offered.
- The first version asked only `access(W_OK)`, and the variable could come from
  `$SLAUDE_HOME/.env`: a turn could point the root at a tree it owned, chmod it
  read-only and pass after a restart. Ownership is what a process cannot forge,
  and `.env` may no longer set the variable.
- The report is built and sent **once, at node start, before the worker claims a
  job**: nothing an agent wrote this run can be in it.
- The gateway takes the node's id and labels from its verified credential, drops
  invalid entries, strips URL secrets again, and refuses non-https or private
  addresses against its own outbound policy.

Two mechanics worth keeping:

- `bridgeExternalMcp` is synchronous and read per request, while the inventory
  lives in the database and liveness in Redis. The gateway holds one derived
  in-memory snapshot, recomputed at start, after a report and every 15 seconds;
  a purely derived snapshot needs no coordination between replicas. A failed
  refresh keeps the last snapshot for at most 5 minutes, then reads empty.
- Several processes may share a credential, so a report is keyed by credential
  and process id, and is live only while that process heartbeats. One row per
  credential let one process overwrite another's report and hid conflicts, and a
  new process whose report failed inherited the old one's servers.
- Only sealed reports can create a URL conflict; otherwise an agent-writable
  plugin could veto a legitimate server.

A URL change needs a new connect because the stored credential is keyed on the
URL. Sealed reports disagreeing on a URL offer nothing rather than pick one.

Residual: a tool at the node's uid is one step from the node's credential. A
non-dumpable process closes the `/proc` route on Linux only if nothing else holds
the token: `bun run worker` leaves an unhardened parent as PID 1 whose environment
still has it, so nodes must exec the entry directly. The gateway cannot tell a
forged report from a real one once a token is stolen, and the full guarantee needs
tools under a separate uid from the node.
