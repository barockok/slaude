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
  `installed_plugins.json` and every parent of each must not be writable by the
  node's process (an ancestor the process can write lets it swap the tree). Root
  fails it by design. Anything else is listed, never offered.
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
- A node's registry id is per process, but a report is per credential (several
  processes may share one). Liveness comes from a heartbeat key per credential,
  written beside the node's own heartbeat, not from the process registry.

A URL change needs a new connect because the stored credential is keyed on the
URL. Nodes of one label disagreeing on a URL offer nothing rather than pick one.
