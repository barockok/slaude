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

The `cron-add` parsed command gains a `target: "thread" | "channel"` field. Exact regex:

```
/^\/cron-add\s+"([^"]+)"\s+"([^"]+)"(?:\s+(channel|thread))?$/
```

Verified against: two args → `target` group `undefined` → defaults `"thread"`;
`channel`; `thread`; trailing garbage → no match. Note on the no-match case: per current
control flow (`commands.ts` returns `null` on no-match → `gateway.ts` forwards the text
to the agent as a normal message), `/cron-add "x" "y" garbage` is **not** surfaced as a
parse error — it falls through to the model. This is pre-existing behavior for every
malformed slash command; we accept it rather than add a two-stage validator.

## Posting target

We add a dedicated `postTarget` flag to `SlackContext` rather than overloading
`ctx.threadTs`. Blanking `ctx.threadTs` would have channel-wide blast radius —
`get_thread_history` (`conversations.replies({ ts })`), `upload`, `approvals.request`,
`status.set`, and the error/compacting post-back paths all read `ctx.threadTs`. Only
`reply` should change. So:

- `mcp-tools.ts` `SlackContext`: add `postTarget?: "thread" | "channel"` (absent =
  thread).
- `mcp-tools.ts` `reply`: branch this one tool only —
  `thread_ts: ctx.postTarget === "channel" ? undefined : ctx.threadTs`. Every other tool
  keeps reading `ctx.threadTs` unchanged.
- `gateway.ts` `onExecute`: for a channel job set `ctx.postTarget = "channel"`. Leave
  `ctx.threadTs` as-is (`job.slackThreadTs ?? job.channelId`) so approval/status/error
  paths behave identically to a thread cron job. (A channel cron session has no real
  thread; `get_thread_history` is no more meaningful than it already is for cron sessions
  today — pre-existing, not introduced here.)
- `cron-scheduler.ts` `#execute`: **branch explicitly on `job.target`.** Channel jobs
  always key the session `thread_ts: "cron:${job.id}"`; do not rely on the
  `slackThreadTs ?? "cron:${job.id}"` null-fallback (which would silently bind a real
  thread if `slackThreadTs` were populated). Thread jobs keep current behavior.
- `gateway.ts` `create()` for a channel job also stores `slackThreadTs: null`
  (belt-and-suspenders; the scheduler no longer depends on it).

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

There are **two** job-listing renderers — keep them consistent:
- `gateway.ts` `/cron-list` slash handler.
- `mcp-tools.ts` `listCronJobs` (the `list_cron_jobs` MCP tool the agent can call).

Both get the `[target]` tag.

## Surface area

- `src/db/schema.ts` — migration + `target` column.
- `src/db/cron-jobs.ts` — `CronJob.target`, `create()` arg, `mapRow`.
- `src/gateway/slack/commands.ts` — parse optional target keyword on `cron-add`
  (corrected regex above).
- `src/gateway/core/gateway.ts` — pass `target` (+ `slackThreadTs: null` for channel) to
  `create()`; set `ctx.postTarget` in `onExecute`; `[target]` tag in `cron-list` output.
- `src/gateway/slack/cron-scheduler.ts` — branch on `job.target` for the session key.
- `src/gateway/slack/mcp-tools.ts` — add `SlackContext.postTarget`; `reply` branches on
  it; `listCronJobs` renderer gets `[target]` tag.
- `src/gateway/sim/scenarios/cron-channel.yaml` — new sim scenario.

### Second creation entry point

The agent can also create cron jobs via the `add_cron_job` MCP tool
(`mcp-tools.ts` `addCronJob`). It stays **thread-only** for now: `create()`'s `target`
defaults to `"thread"`, so `addCronJob` keeps compiling unchanged and the agent cannot
self-create channel broadcasts. Extending the MCP tool is out of scope (noted below).

## Testing

- **Unit (parser):** `/cron-add` with `channel` / `thread` / absent → correct `target`;
  trailing garbage → no match (falls through, no `cron-add` hit).
- **Update existing test:** `tests/commands.test.ts` asserts an **exact** `.toEqual`
  for `/cron-add "..." "..."`. That assertion must add `target: "thread"` or it breaks.
- **Unit (reply):** `reply` omits `thread_ts` when `ctx.postTarget === "channel"`;
  includes `ctx.threadTs` otherwise.
- **Sim scenario `cron-channel.yaml`:** `/cron-add "<expr>" "<prompt>" channel` →
  job stored with `target=channel`; `/cron-list` shows `[channel]` tag.

## Out of scope

- Linking reply-threads back to cron session memory (explicitly rejected — normal
  engagement only).
- Editing an existing job's target (remove + re-add).
- Channel-targeting a *different* channel than where `/cron-add` ran (still binds to the
  current channel; only the posting style changes).
- Agent self-creating channel broadcasts via the `add_cron_job` MCP tool (stays
  thread-only).
