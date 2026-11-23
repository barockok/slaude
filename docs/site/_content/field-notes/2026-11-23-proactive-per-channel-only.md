---
title: "Proactive is per channel only: the agent-level summarising round removed"
date: 2026-11-23
---

# Proactive is per channel only

**Date:** 2026-11-23
**Status:** shipped in `v0.46.0-rc.44`. Follows [Proactive means a channel session](2026-11-10-proactive-per-channel.md).

## The decision

rc.14 made proactive a per-channel switch but kept a second, agent-level mode beside it: a timer round that read the MCP
sources under `Watch:`, kept `self/heartbeat-journal`, and routed items to the manager. Nothing in a channel configured it,
and after rc.14 it could no longer route to a channel. It is removed. Proactive now means one thing: a channel session with
its own wakes, checklist and limits.

## Why it had to go

- **It crossed the boundary between channels.** The journal lived in the agent's memory slice, so `memory_search` in any
  trusted channel could return the round's notes about watched sources. Two channels that should know nothing of each
  other shared that page.
- **A global switch gave a false picture.** `Enabled: yes` at the top level started no wake but did start the round, so a
  persona read as proactive in channels where it did nothing, and a channel without its own block fell back to it.
- **The channel allowlist was global too.** `Read:` let any turn read a named channel, which is a way across a boundary
  that no channel's own configuration controlled.

## What stays

The post path (`sendProactive` and its restraint rules), learned rules, the checklist per channel, and the global limits
(`Max per day`, `Quiet hours`, `Highest`, `Cooldown`, `Wake: no`) that a channel inherits unless it sets its own. The heartbeat
slot is still the tick that wakes due channels.

## Known edges

- The schema still accepts `proactive.enabled`, `proactive.read` and `proactive.watch` so an existing file does not stop
  booting. They warn and compile to nothing; a later release can make them an error.
- The restraint rules still have manager and person audiences, which no wake can reach (a wake posts only to its own
  channel). They are dead code that a later change can drop with `readPingPrefs`.
- Pages the old round wrote (`self/heartbeat-journal`, and the per-agent `self/heartbeat`) stay in the agent's slice. They
  are not read by anything, but a memory search can still return them. Clearing them is an operator task per deployment.
