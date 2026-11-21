# 2026-11-22: Engage classifies every message the safety rules leave open

## Why

A person wrote "Dude, ..." right after the agent had spoken. The implicit-engagement ladder read "Dude" as another person's name (a capitalised word before a comma) and passed the message at tier 0, as a note to a colleague. The classifier never saw it, so a real follow-up was dropped. Every rule of that kind (the vocative, the acknowledgement list, the follow-up test, the hot window, the root question band) is a guess at meaning, and a guess is wrong somewhere. A word list of nicknames would only move the error.

## What

The ladder keeps only rules that state a certain fact: the channel level, restricted, a system subtype, a bot author, a lock, an @mention of the agent (run), an @mention of another person, a group or `@here` (pass), another registered agent named with a comma or having spoken last (pass, so two agents do not answer one message), and an engaged thread (today's path). Everything else is `classify`, the reason is `classify`, and the classifier decides with the recent messages in front of it.

Removed with the guesses: the vocative and acknowledgement logic, the follow-up run (tier 2) and its sample, the name rules, the root band with its 60 second debounce and re-check, the thread-opened-by-the-agent rule, the users cache and its `users.list` read, the humans-alternating flag. The classifier input's `continuation` is now set from one fact: this agent spoke last here within the window.

Because every candidate is now asked, the shortcuts that skipped the classifier after a "no" went too: the per-thread pass memory and the root cooldown. Two candidates in a row, the first answered "no", both reach the classifier (a test pins it).

Mentions of the agent are unchanged: they take the mention path and always run.

## Cost

One classifier call, and one bounded Slack read for its input, per candidate. The budget defaults move to fit: `SLAUDE_ENGAGE_DAILY_BUDGET` 50 to 2000 and `SLAUDE_ENGAGE_MINUTE_CEILING` 6 to 20. The acted-run cap stays at 12 an hour, so the cost is classifier calls, not extra turns. `SLAUDE_ENGAGE_SAMPLE` is gone with the sampled decisions it sampled. The breaker, the one-owner claim, the admission check and shadow mode are as before.

## Open

- Messages that mention the agent but need no reply still always run. The decision gate's mention row (`record_doubt`) can ask the classifier about them once a deployment turns it on; that is configuration, not part of this change.
- Tune the budgets from real counts. With the pass memory gone, a very chatty channel will spend its daily bucket sooner and then be silent until the next UTC day.
