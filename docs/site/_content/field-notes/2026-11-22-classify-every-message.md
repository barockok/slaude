# 2026-11-22: Engage classifies every message the safety rules leave open

## Why

A person wrote "Dude, ..." right after the agent had spoken. The implicit-engagement ladder read "Dude" as another person's name (a capitalised word before a comma) and passed the message at tier 0, as a note to a colleague. The classifier never saw it, so a real follow-up was dropped. Every rule of that kind (the vocative, the acknowledgement list, the follow-up test, the hot window, the root question band) is a guess at meaning, and a guess is wrong somewhere. A word list of nicknames would only move the error.

## What

The ladder keeps only rules that state a certain fact: the channel level, restricted, a system subtype, the agent's own message as author, a lock, an @mention of the agent (run), an @mention of another person, a group or `@here` (pass), another registered agent named with a comma or having spoken last (pass, so two agents do not answer one message), and an engaged thread (today's path). Everything else is `classify`, the reason is `classify`, and the classifier decides with the recent messages in front of it.

Removed with the guesses: the vocative and acknowledgement logic, the follow-up run (tier 2) and its sample, the name rules, the root band with its 60 second debounce and re-check, the thread-opened-by-the-agent rule, the users cache and its `users.list` read, the humans-alternating flag. The classifier input's `continuation` is now set from one fact: this agent spoke last here within the window.

Because every candidate is now asked, the shortcuts that skipped the classifier after a "no" went too: the per-thread pass memory and the root cooldown. Two candidates in a row, the first answered "no", both reach the classifier (a test pins it).

Mentions of the agent are unchanged: they take the mention path and always run.

## Cost

One classifier call per candidate; its input comes from the gateway's own conversation log, not a Slack read (see below). The budget defaults move to fit: `SLAUDE_ENGAGE_DAILY_BUDGET` 50 to 2000 and `SLAUDE_ENGAGE_MINUTE_CEILING` 6 to 20. The acted-run cap stays at 12 an hour, so the cost is classifier calls, not extra turns. `SLAUDE_ENGAGE_SAMPLE` is gone with the sampled decisions it sampled. The breaker, the one-owner claim, the admission check and shadow mode are as before.

## Agent to agent

The aim is for agents to talk to each other in a channel or a thread, the classifier deciding who replies, so a bot author is no longer a pass: only this agent's own message is skipped (`self_author`). "Another agent spoke last" still stops two agents answering one person, and no longer fires when the author is itself an agent. A registered agent's text is kept in the classifier's recent messages as the other side (never as this agent's own words). (rc.42 added a separate bot cap; rc.43 removed it, see the end of this note.) Not done: a message from another persona's app on the same gateway is dropped at ingress as a self bot echo (`isSelfBotEcho` in the message handler), before observation; letting it through also needs the admission check, which shares that echo test, to tell "another registered agent" from "this agent". So today the path works for bots and agents outside this gateway.

## Context comes from a conversation log

Reading Slack for every candidate message was one rate-limited, Slack-only call per message, and engagement is a generic feature. The gateway now keeps a small log per conversation (`src/gateway/engage/conversation-log.ts`): the newest 30 entries for 24 hours, a channel's top level and each thread separately, in Redis when there is one and in memory otherwise, idempotent by message id. It is fed where the gateway already sees messages: every channel message and @mention at a level other than `mention`, the agent's posts at the outbound choke point, and the echo of a post (a second source of the same entry). It is not the session transcript, which lives with the worker node, does not exist for a thread with no session yet and does not hold the message being judged. Entries written by an agent of this gateway carry its persona, so the reader can give the classifier the agent's own lines as `agent` and another registered agent's as the other side.

## Open

- A log is empty right after a channel is switched on, after a restart with no Redis, and for anything said before the gateway started hearing the channel. There is no fallback to Slack, by decision: the classifier sees the message alone until the log fills. Messages from a bot with no user id (a webhook post) are not heard by the message handler and so are not in the log; the classifier never sees third-party bot text anyway.

- Messages that mention the agent but need no reply still always run. The decision gate's mention row (`record_doubt`) can ask the classifier about them once a deployment turns it on; that is configuration, not part of this change.
- Tune the budgets from real counts. With the pass memory gone, a very chatty channel will spend its daily bucket sooner and then be silent until the next UTC day.

## Review fixes

An independent review of the change found four things, fixed before merging:

- **The loop guard did not cover an engaged thread.** The bot cap applied only to a run that started in the engagement path. That run engages the thread, so every later bot reply took the engaged path with no cap: two agents each answering once were then both engaged and answered each other without a limit. A bot's reply in an engaged thread now takes a slot from the same hourly bot bucket, wherever implicit engagement is on for the channel, and past the cap it is recorded, not run.
- **An agent with a user token looked like a person.** Slack marks no bot on a message posted with a user token. `SLAUDE_ENGAGE_AGENT_USERS` names such agents; they count as bots for the cap and the last-speaker rule.
- **The conversation log kept raw text.** Secrets are now masked before an entry is stored (it lives in Redis for 24 hours), and a message deleted or edited by a person at the source is forgotten (an edit is heard again as new). An agent's own streamed edits are left alone so its entry keeps its agent mark. Still true: text from an author the agent would not admit is stored until it expires and is filtered when read.
- **A shared app logged by one agent's level only.** A delivery to an app that serves several agents wrote to the log only when the app's own agent was above `mention`. It now writes when any agent it speaks for is.

Not changed: the claim is taken before the caps, the caps are clock-hour buckets, the minute ceiling is shared by every persona in a channel, and the breaker is one per process.

## One rule for every author (rc.43)

rc.42 told bots and agents apart in two places: a separate hourly bot cap (`SLAUDE_ENGAGE_BOT_ACT_PER_HOUR`, also applied to replies in an engaged thread) and a list of user ids for agents that post with a user token (`SLAUDE_ENGAGE_AGENT_USERS`). Both are gone. The list was a patch on the cap, because Slack marks a bot on its messages but not an agent that posts with a user token, and a list someone has to keep current is the wrong place to decide who is an agent. The classifier already treats every author alike. Every author now shares the one cap on acted runs (12 an hour per channel).

What this leaves open: replies in a thread the agent is already engaged in never reach the classifier, because the channel `engage` setting covers only messages that would otherwise get no turn. Those replies are the decision gate's (`gate.mode` in `SLAUDE_DECISION_CONFIG`, deployment wide, off by default), which fails open. So two agents that engage one thread can answer each other without a limit until the gate is on. That was also true before this feature.

