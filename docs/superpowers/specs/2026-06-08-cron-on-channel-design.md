# cron-on-channel — Design

## Goal

Let a cron job post its output as a **fresh top-level channel message** (a scheduled
broadcast/digest) instead of replying inside the thread where `/cron-add` ran.

Opt-in per job. Thread-bound posting stays the default and is unchanged.

## Background

Today every cron job binds to the thread (or channel root) where `/cron-add` was
invoked. Each run resumes that thread's session and posts a reply *into* the thread.
For recurring digests ("daily standup summary", "what changed today") this buries the
output inside one ever-growing thread instead of surfacing it to the whole channel.

Relevant current behavior:

- `commands.ts` parses `/cron-add "<expr>" "<prompt>"` (two quoted args).
- `gateway.ts` `create()` stores `slackThreadTs = isDM ? undefined : threadTs`.
- `cron-scheduler.ts` `#execute` builds the session key
  `thread_ts: job.slackThreadTs ?? "cron:${job.id}"` and posts via the normal Slack
  MCP `reply` tool.
- `reply` (`mcp-tools.ts`) posts `chat.postMessage({ channel, thread_ts: ctx.threadTs })`.
  An empty/omitted `thread_ts` posts at channel root.

## Decisions (resolved during brainstorming)

1. **Opt-in via a new flag on `/cron-add`** — not a separate command, not a replacement.
   Backward compatible.
2. **Persistent internal session, fresh root post each run** — channel jobs keep an
   internal session keyed `cron:${job.id}` so the agent recalls prior runs, but each
   run posts a new top-level channel message.
3. **Replies to a broadcast are normal fresh-thread engagement** — no new wiring. A
   human reply lands under the broadcast's root ts and the adapter's existing
   `ensureSession` spins up an ordinary thread session.

## Data model

Add one column to `cron_jobs`:

```sql
target TEXT NOT NULL DEFAULT 'thread'   -- 'thread' | 'channel'
```

Migration follows the existing PRAGMA-check + `ALTER TABLE ... ADD COLUMN` pattern in
`schema.ts` (see the `slack_team_id` block ~line 166). Existing rows default to
`'thread'`, preserving current behavior.

`CronJob` type gains `target: "thread" | "channel"`. `create()` accepts an optional
`target` (default `"thread"`) and persists it. `mapRow` reads it.

## Command syntax

Extend the `/cron-add` parser to accept an optional trailing target keyword:

```
/cron-add "0 9 * * 1" "standup digest" channel
/cron-add "0 9 * * 1" "standup digest"            # → thread (unchanged)
```

The `cron-add` parsed command gains a `target: "thread" | "channel"` field. The regex
grows an optional `\s+(channel|thread)?` group after the second quoted arg; absent →
`"thread"`. An unrecognized trailing token is a parse error (so typos don't silently
fall back).

## Posting target

**channel jobs:**

- `cron-scheduler.ts` `#execute`: always use the internal session key
  `thread_ts: "cron:${job.id}"` (never a real Slack thread_ts) so the session is
  persistent and decoupled from any posted message.
- `gateway.ts` `onExecute`: for a channel job, set `ctx.threadTs = ""` so replies post
  at channel root. For a thread job, behavior is unchanged
  (`ctx.threadTs = job.slackThreadTs ?? job.channelId`).
- `mcp-tools.ts` `reply`: change `thread_ts: ctx.threadTs` →
  `thread_ts: ctx.threadTs || undefined`. Empty string posts to channel root; real ts
  is unaffected. Safe for all existing callers (thread sessions always carry a real ts).

**thread jobs:** entirely unchanged.

## Reply handling

No new code. A human reply under a broadcast arrives with `thread_ts = <root msg ts>`.
The adapter's normal `ensureSession` keys on real `(team, channel, thread_ts)` and
spawns an ordinary thread session — separate from the cron job's internal
`cron:${job.id}` session. The agent engages normally and sees the broadcast text via
its channel/thread history fetch. The cron session is untouched and keeps posting roots
on schedule.

## `/cron-list` display

Show a per-job target tag so managers can tell broadcasts from thread jobs:

```
• `abcd1234` `0 9 * * 1` [channel] → standup digest
• `ef567890` `*/30 * * * *` [thread] → watch deploys
```

## Surface area

- `src/db/schema.ts` — migration + `target` column.
- `src/db/cron-jobs.ts` — `CronJob.target`, `create()` arg, `mapRow`.
- `src/gateway/slack/commands.ts` — parse optional target keyword on `cron-add`.
- `src/gateway/core/gateway.ts` — pass `target` to `create()`; channel-aware
  `ctx.threadTs` in `onExecute`; `[target]` tag in `cron-list` output.
- `src/gateway/slack/cron-scheduler.ts` — channel jobs use `cron:${job.id}` session key.
- `src/gateway/slack/mcp-tools.ts` — `reply` `thread_ts` conditional.
- `src/gateway/sim/scenarios/cron-channel.yaml` — new sim scenario.

## Testing

- **Unit (parser):** `/cron-add` with `channel` / `thread` / absent → correct `target`;
  unknown trailing token → parse error.
- **Unit (reply):** `reply` omits `thread_ts` when `ctx.threadTs` is empty; includes it
  when set.
- **Sim scenario `cron-channel.yaml`:** `/cron-add "<expr>" "<prompt>" channel` →
  job stored with `target=channel`; `/cron-list` shows `[channel]` tag.

## Out of scope

- Linking reply-threads back to cron session memory (explicitly rejected — normal
  engagement only).
- Editing an existing job's target (remove + re-add).
- Channel-targeting a *different* channel than where `/cron-add` ran (still binds to the
  current channel; only the posting style changes).
