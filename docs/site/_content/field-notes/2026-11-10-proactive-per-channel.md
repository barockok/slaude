---
title: "Proactive means a channel session: a per-channel switch, a per-channel checklist, and the agent-level wake gone"
date: 2026-11-10
---

# Proactive means a channel session

**Date:** 2026-11-10
**Status:** branch `feat/channel-proactive`, shipped in `v0.46.0-rc.14`. Spec: the rc.14 section of `docs/superpowers/specs/2026-11-10-channel-session.md` in the repository. User guide: [Channel sessions](../guides/channel-sessions.md).

## The decision

Proactive had two paths: an agent-level wake (a fresh session a slot, a checklist page and a notes page to stand in for memory) and a channel wake in channel mode. A channel session has memory, so the agent-level path has no reason left. `### Proactive` `Enabled: yes` under a channel now means a channel session with wakes.

## What the mechanism turned on

- **`sessions` stays what the soul wrote.** `parseProactive` keeps `sessions` to written `Mode` lines, and one function (`hasChannelSession`) adds "or `Enabled: yes`". Deriving it into `sessions` would have broken the export, because `proactive: true` would round-trip as `session: channel, proactive: true`. An invalid `Mode` exports as `proactive: false`, or importing it would turn a dead channel on.
- **A channel's page is lowercase, in one function.** gbrain stores slugs lowercased and `memory_save` lowercases what an agent writes; a Slack channel id is uppercase. `channelChecklistSlug` is the only place the slug is built, and the prompt names the exact slug so the agent does not guess.
- **Migration is claimed in `background_slots`, not inferred from the page.** "The channel has no page" alone would copy the old page again if the agent deleted its own.
- **The round is no longer a checklist reader**, and it no longer routes to a channel: every proactive channel is a channel session with ceiling `act`, and items from watched sources are untrusted.

## What it costs

Every channel that had `Enabled: yes` becomes a session on upgrade: root replies at root, root messages are recorded, nodes need `channel-session/1`, and its `Highest`, `Cooldown` and `Max per day` stop applying. The release notes carry that warning first.
