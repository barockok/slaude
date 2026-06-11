# Engagement review — disengage lasted zero messages (2026-06-11)

## Symptom

User @mentions a colleague in an engaged thread (agent should bow out), but
the agent keeps answering plain replies — "sometimes" immediately, sometimes
after a while. Engage/disengage felt non-deterministic across time.

## Mechanism (gateway message router)

Per-thread engagement: in-memory `Set<"channel:thread_ts">`, disengaged by
default. @bot mention engages; mention of another user (without the bot)
disengages; plain replies handled only while engaged. A restore path
re-engages threads that have a session row, so restarts don't force a
re-@mention.

## Root cause

Disengage only deleted from the in-memory Set. Every engaged thread has a
session row by definition, so the **next plain reply** missed the Set, hit
the restore check, found the row, and re-engaged. Disengage survived exactly
zero messages. Restarts wiped the Set and the restore path resurrected
engagement the same way. The "sometimes" in the symptom = whichever moment
the Set lookup missed (always the immediate next plain message, or any
message after a pod restart).

## Fix

`sessions.engaged` column (INTEGER, default 1) is the source of truth; the
Set is just a hot cache.

- bot mention / `app_mention` → persist `engaged=1`
- mention of another user → persist `engaged=0`
- restore path honors the flag: row exists **and** `engaged=1`

Regression tests drive real Slack event sequences through the gateway seam
(`tests/gateway/core/gateway-seam.test.ts`), including a simulated restart
(fresh gateway over the same db).

## Known gaps (deliberate, not fixed here)

- **Broad disengage trigger:** any human mention without a bot mention
  disengages — including "thanks <@colleague>, deploying now" mid-conversation
  with the agent. Was masked by this bug; now it sharpens. If it annoys,
  consider leading-mention-only or N-quiet-messages heuristics.
- **`app_mention` engages before gates:** a non-whitelisted user's mention
  flips thread engagement state even though their message is dropped.
  Per-message gates still protect; cosmetic.
- **Userless bot events dropped at the router** (`if (!e.user) return`)
  contradicts handleMessage's "other bots flow through (CI alerts)" comment —
  most bot messages carry no `user`. Dead comment or dead feature; decide
  someday.
- **Test-fixture landmine (re-discovered):** sim bot id `U_SLAUDE` contains an
  underscore, which the `<@([A-Z0-9]+)>` mention regex can't match — tests
  must engage via `app_mention`, as real Slack does. Already documented in
  `tests/gateway/sim/mcp-connect.test.ts`.
