# Post as the agent's real Slack user (opt-in xoxp)

**Date:** 2026-06-09
**Status:** shipped (opt-in, default off)

## Problem

Each agent has its own email + Slack account, but the runtime posts via the app
**bot token** (`xoxb`) — so every deploy needs *both* a bot identity and the real
account. Owner asked: can the agent reply as its own Slack account instead, to
avoid maintaining two identities per agent?

## Answer

Partially. Slack splits capability by token type:

- **Bot token (`xoxb`)** — posts as the app. Required for Socket Mode event
  intake and Block Kit **interactivity** (button `action_id` callbacks only
  dispatch to the app that posted them).
- **User token (`xoxp`)** — posts/edits/reacts/uploads **as the real user**.
  Cannot open Socket Mode; user-token buttons don't route interactivity.

So the app **cannot** be dropped — it stays for events + gates. But agent
*content* (replies, edits, reactions, uploads) can go out as the user. One
shared app + per-agent user token + a paid Slack seat per agent.

## Design

- Single chokepoint: all outbound content flows through one injected `WebClient`
  (`surface.ts`, `mcp-tools.ts` `ctx.client`). Swap that for a user-token client;
  leave gates (`permission-gate`, `approval-gate`) on `t.client` (bot).
- **Opt-in flag** `SLACK_POST_AS_USER=true` (+ existing `SLACK_USER_TOKEN`).
  Critical backward-compat: `SLACK_USER_TOKEN` was already documented for
  **presence only** (`users.profile.set`). Flipping behavior on its mere presence
  would silently change posting identity for existing deploys — hence a separate
  explicit flag. Default off → bot posting unchanged.
- Reads (`conversations.replies`, `users.info`, …) also route through the user
  client in this mode, so the xoxp needs read scopes too (`channels:history`,
  `groups:history`, `im:history`, `users:read`) plus writes (`chat:write`,
  `reactions:write`, `files:write`). Bonus: `search.messages` is user-token-only,
  so it starts working in this mode.

## The trap: self-echo infinite loop

Bot-posted messages arrive with `event.bot_id`; the self-filter
(`gateway.ts`) drops them by matching the app's bot id. **A real user's posts
have no `bot_id`** — they look like any human message. Posting as the user means
the agent's own output re-enters as a normal `message` event → re-ingested →
loop, and also drives thread engagement/disengagement.

Guard: resolve the user token's own `user_id` via `auth.test()` once, and drop
events where `event.user === selfUserId`. Added in **both** the message router
(engagement layer) and `handleMessage` (ingestion layer); both emit
`slaude_slack_drops_total{reason="self_user"}`. Null/inactive when posting as bot
(the `bot_id` filter already covers that case).

Test seam: `GatewayOptions.outClient` injects the user client directly, so the
loop guard is unit-tested without a live xoxp
(`tests/gateway/core/post-as-user.test.ts`).

## Not done / caveats

- Interactive gates still post as the **bot** — a thread will show agent replies
  as the user but permission/approval prompts as the app. Acceptable hybrid;
  user-token buttons can't carry interactivity.
- Real accounts consume paid Slack seats (bots are free). Identity vs cost.
