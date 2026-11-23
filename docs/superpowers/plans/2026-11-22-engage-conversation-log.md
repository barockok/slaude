# Engage: the classifier reads a conversation log, not Slack

Follows `2026-11-22-engage-classify-all.md` and `2026-11-22-engage-agent-to-agent.md` (both built on this branch).

## Problem
`buildImplicitInput` (`src/gateway/engage/input.ts`) takes its recent messages through two injected readers, `replies`
and `history`. The gateway wires them to Slack's `conversations.replies` and `conversations.history`
(`gateway.ts`, near the `buildImplicitInput` call). Engagement is a generic feature, not a Slack one, and now that
every candidate message is classified this is one Slack read per message (rate-limited, slow, Slack only).

## Decision
The classifier's context comes from a small per-conversation log that the gateway keeps itself, fed from the same
inbound and outbound stream the session sees. It does not read the surface and it does not read the session
transcript (the transcript lives with the worker node, does not exist for a thread with no session yet, and does not
yet hold the message being judged).

## Design
New module `src/gateway/engage/conversation-log.ts`:
- `ConversationLog { append(key, entry): Promise<void>; recent(key, limit): Promise<LogEntry[]> }`, a memory store
  and a Redis store (a capped list per key: push, trim to 30, expire after 24 h), chosen the same way `last-speaker.ts`
  chooses (`setConversationLogRedis(client | null, prefix)`; Redis optional; a Redis error reads as "no entries" and
  never reaches a caller; every operation has a short time budget like `RECORD_READ_BUDGET_MS`).
- `LogEntry`: `{ ref, author, isBot, text, threadRef? }` with neutral names (`ref` is the surface's message id, `author`
  the surface user or bot id). Text is stored cut to 1000 characters, secrets are not masked here (masking happens
  when the classifier input is built, as today). `append` is idempotent by `ref` (a message arrives as both a
  `message` and an `app_mention` event, and an agent post arrives both from the outbound call and from its echo).
- Keys are surface-neutral: `<surface>:<channel>` for the top-level conversation of a channel and
  `<surface>:<channel>:<thread>` for a thread. Use the existing surface id (`slack`).
- Reading for a thread candidate: that thread's log. For a top-level candidate: the channel's log.
  An empty log means the classifier sees the message alone (no fallback to Slack, by decision). Say so in the docs.

Feeding it (find the smallest set of places, report them):
- Inbound: every message the gateway observes in a channel whose engage level is not `mention`: the non-mention path
  (`observeEngage` callers) and the @mention path (a mention is part of the conversation too). Skip nothing a person or
  bot wrote except this process's echo duplicates (idempotent by `ref`).
- Outbound: the agent's own posts, at the existing seam `noteAgentMessage` (`record.ts`, called from `outbound.ts` and
  from `noteEcho` in `gateway.ts`). Add the text to `AgentMessage` and append it with `isBot: true` and the persona's own
  author id; the echo path uses the event's own fields.
- Channels at level `mention` write nothing (as `record.ts` already does).

Reading it: replace the two Slack readers in the `buildImplicitInput` wiring with a reader over the log, returning the
existing `ThreadMsg` shape (map `ref`->`ts`, `author`->`user`, bot flag -> `bot_id` placeholder, `threadRef`->`thread_ts`,
`text`) so `filter`, `dropMessage`, `isSelf`, `isAgent` and the ordering logic stay exactly as they are. Keep
`ENGAGE_READ_LIMIT` as the read size. Remove the Slack readers that become unused, and the `reader` they used if nothing
else in that block needs it (check `admit` and `filter`, which have their own wiring).

## Tests first
- `conversation-log.test.ts`: memory and Redis stores (use the fake Redis; extend `tests/helpers/fake-engage-redis.ts`
  only as needed): append and read in order, cap at 30 keeping the newest, idempotent by `ref`, separate keys for a
  thread and its channel, expiry, a Redis error reads empty, the time budget.
- `record.test.ts`: `noteAgentMessage` appends the agent's text, once for outbound plus echo; nothing at level `mention`.
- `input.test.ts`: unchanged behaviour with the log-backed reader (filter, third-party bot drop, registered agent kept).
- gateway-level (engage-phase1 or 2): a candidate is classified with context that came from earlier messages the
  gateway saw, and the fake Slack records NO `conversations.history` / `conversations.replies` call for it.

## Docs
`engagement.md` (where the context comes from, the cold start, 24 h / 30 entries), the field note (a short paragraph and
the open point: a log is empty right after a channel is switched on), and `CLAUDE.md` index line only if its meaning changes.

## Rules
Same as the other plans: public repo and generic fixtures, no AI trailer, one logical change per commit (module and its
tests; feeding it; reading it; docs), no push/PR/tag/deploy, no sudo/docker, tests only under the memory cap and a few files per
command with `--timeout 30000`, typecheck clean at every commit. Do not touch the ingress drop for same-gateway personas.
