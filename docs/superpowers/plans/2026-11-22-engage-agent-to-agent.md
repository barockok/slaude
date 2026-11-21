# Engage: agents talk to each other through the classifier

Follows `2026-11-22-engage-classify-all.md` (already built on this branch). The operator's aim for the classifier:
agents chat with each other in a channel or a thread, the classifier deciding who should reply. The ladder's
`bot_author` pass (`authorIsBot`, `tiers.ts`) blocks exactly that.

## Decisions
1. Only a message this agent wrote itself is skipped (a fact: author id equals one of this persona's own ids).
   Every other author, human or bot, an agent on another app or another deployment included, goes to the
   classifier like any message. Third-party integrations (CI, alerts) also reach it; the classifier says no to them.
2. The "another agent spoke last, so pass" rule (`follows_other_agent`) stays for messages from PEOPLE (it stops two
   agents answering one human message). It must not fire when the message author is itself an agent or bot.
3. The classifier must be able to see the other agents' side of a conversation. Today `input.ts` drops every bot
   message from `recent` (`ALLOW_THIRD_PARTY_BOT_TEXT = false`). Keep that for unknown bots, but keep the text of
   messages authored by a registered agent of this gateway (a persona's bot or user id). Mark them as the other
   side (role `user`), never as `agent` (that role is this agent's own words).
4. Loop guard. Two agents that always reply to each other must stop. Add an hourly cap per channel for runs that were
   started by a bot-authored message: `SLAUDE_ENGAGE_BOT_ACT_PER_HOUR`, default 6, taken through the same
   `actSlot` mechanism with its own key, in addition to the existing hourly cap (12). Past the cap the decision is a
   pass (counted, logged). No other state.
5. Ingress. A message from ANOTHER persona's app on the same gateway is dropped early as a "self bot echo"
   (`isSelfBotEcho`, `getSelfBots` covers every registered app, `gateway.ts` near 4605 and 4699). First TRACE
   whether such a message reaches `observeEngage` today (both sites: `channel_session` and `drop`) and report what you
   found. If a registered persona's message is dropped before observation, change the smallest thing so that
   message (and only a message from another registered persona, never this persona's own) reaches observation, and
   nothing else about the early drop changes (it must still not become a normal turn through the old path). If this
   cannot be done in a small, safe change, do not do it: stop, and explain what is needed.

## Tests first
- `tiers.test.ts`: a bot-authored message (not self) classifies; a self-authored message passes `self_author`;
  `follows_other_agent` still passes a human message after another agent spoke, and does NOT pass when the author
  is that other agent.
- `input` tests: a registered agent's message appears in `recent` as the other side; an unknown bot's text is still dropped.
- budget/act tests: the bot cap counts only bot-authored runs; the 7th bot-started run in an hour is refused while a
  human-started run is still allowed under the normal cap; the env default is 6 and is overridable.
- gateway-level test for item 5 only if you changed the ingress.

## Docs
Update `docs/site/_content/guides/engagement.md` (bots and agents reach the classifier; the loop guard),
`reference/configuration.md` (`SLAUDE_ENGAGE_BOT_ACT_PER_HOUR`), the field note
`2026-11-22-classify-every-message.md` (a short paragraph: agent to agent) and the one CLAUDE.md index line for it if
its meaning changes (keep it one line).

## Rules
Same as the main plan: public repo, generic fixtures, no AI trailer, one logical change per commit, no push/PR/tag/
deploy, no sudo/docker, tests only under the memory cap and a few files per command, `--timeout 30000` for the
phase tests, typecheck at every commit.
