---
title: "Channel session: one long-lived session per agent, per channel, without touching the turn"
date: 2026-11-10
---

# Channel session

**Date:** 2026-11-10
**Status:** branch `docs/channel-session-spec`, shipped in `v0.46.0-rc.13`. User guide: [Channel sessions](../guides/channel-sessions.md).

## Problem

Each root mention started a new session, and an agent's proactive wake ran as one fresh session per slot, stitched together by a notes page and an activity block. In a channel where context builds up over days, the agent had no continuity at root and rebuilt it each time. The mode needed to add a long-lived session per channel, per agent, without changing what a thread, a DM or a channel not in the mode does.

## The mechanisms

### The reserved key stays out of the turn

The session is keyed by a reserved thread value, `channel:<channelId>`, in the existing `slack_thread_ts` column. The key only finds or creates the session. A root turn's `threadTs` stays the triggering message's `ts`, so reactions, status, cards, error posts, lock lookups and the job token's `thread` claim all keep a real Slack value without changing the code that computes them. Replies reach root through the existing `postTarget: "channel"` seam and a new signed `post: "channel"` claim, because the `/v1` tool plane rebuilds its context from the claims. A wake has no triggering message, so it uses the reserved key as its thread, as `wake:` and `cron:` keys do, and never posts to its thread.

`/new` renames the key to `channel-archived:<channelId>:<ts>`, which frees it. The row and transcript stay; the console shows it as archived and refuses a console chat into it.

### A query's caps and tools are fixed at boot

`maxBudgetUsd`, `maxTurns` and `disallowedTools` are set when the query starts and cannot change on a live one. A session therefore has a boot kind, wake or normal, and it restarts on its transcript when the kind of the next turn differs. That costs a process start and keeps the conversation. A wake always gets a query of its own, because the CLI measures a budget cap against the whole process, so a warm wake query would run on what the last wake left.

A person's message restarts a session booted as a wake, and it waits while a wake's turn is in flight. A wake waits while a running turn holds the session.

Tested against the real CLI: a headless resume starts its budget at zero, so a wake cap does not count the channel's lifetime spend. A first process spent 0.60 USD, a resume with a 0.25 USD cap ran normally (0.0005 USD), and the same cap stopped a resumed run that overspent by itself, reporting only its own cost.

### Folded inputs, and suppression by content

Recording uses the existing suppress path: the input is delivered and the `UserPromptSubmit` hook returns `continue: false`. Each input has an entry saying whether it is suppressed, and the hook finds its entry by the text of the prompt, not by position. A position would break twice: the CLI folds an input queued during a turn into that turn, so its hook never fires, and inputs joined at dequeue arrive as one newline-joined prompt, suppressed only if all of them were. Older entries are discarded with a match; a prompt matching nothing, a check or a command, is not suppressed and disturbs nothing.

Tested against the real CLI: `UserPromptSubmit` does not fire for a raw `/compact`, so a command pushed straight to a live session passes through this matcher without taking an entry.

Folded inputs also leave a session's pending count high. A restart for a kind change treats the remaining inputs as folded only when the query has been silent since its last result; anything seen since means a turn is running and it waits for that turn to end.

### Per-agent event claims

Inbound events are claimed once by channel and `ts`. With one Slack app per agent, every app receives its own copy, and a channel-session event must reach each agent or only the first would record it. A channel-session event is claimed per channel, `ts` and persona. An unmentioned root message is never parsed as a slash command.

### A recording cannot merge with a mention or borrow its identity

A recording queues behind a running turn, in order, and leaves that turn's route (the record of who the turn belongs to) alone, so a turn's reply, reactions and permission cards keep following the person who started it. A recording at idle ends quietly: it posts nothing and reacts to nothing. It cannot join a mention's turn as its author.

### A wake never takes a person's route

A channel wake runs only with the route to itself. It is refused if a turn is running or a mention is held, and a mention that arrives during a wake waits for it, then gets its own route when the wake ends. The same check is synchronous with setting the route, so a message cannot slip in between. A console chat during a wake is refused with a plain 409.

### Recorded text has its envelope tags neutralised

A recording's text is someone's Slack message placed in the channel's transcript. Tags that look like the runtime's own envelopes are neutralised before they reach the session, so a message cannot pose as a channel envelope, a runtime check or a wake.

### The wake-state table is separate

`channel_wake_state` is keyed on agent and channel, on both schemas. `heartbeat_wake_state` stays keyed on the agent for agent-level wakes. Changing that primary key would need a table rebuild on sqlite for no benefit, and two tables keep one channel's backoff from delaying another. A channel in this mode leaves the agent-level wake, which keeps serving DMs and other channels.

## What the real CLI showed

- `disallowedTools` does not remove an in-process MCP tool from the request's tool list; a call to it is refused at call time. The wake and normal tool sets hold at that point (and on the `/v1` tool plane), not in the listing the model sees, so a model may try a tool and be told no.
- A wake denies every `canUseTool` call, so its own tools (`proactive_post`, `finish_round`) only run in a session that never asks: bypass mode, or a mode where the tool needs no permission.

## Files

`src/gateway/core/channel-session.ts`, `src/gateway/core/gateway.ts`, `src/agent/manager.ts` (`#settleBootKind`, `#takeSuppressed`), `src/proactive/channel-wake.ts`, `src/db/channel-wake-state.ts`, `src/soul/proactive.ts`, `tests/integration/channel-session.test.ts`.
