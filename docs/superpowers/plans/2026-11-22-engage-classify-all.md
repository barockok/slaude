# Engage: every message goes to the classifier

## Problem
The implicit-engagement ladder (`src/gateway/engage/tiers.ts`) decides by rules whether a message is for the agent
and calls the classifier only for the cases the rules leave open. The rules guess at meaning and guess wrong. Example:
a person wrote "Dude, ..." right after the agent had spoken. `vocative()` read "Dude" as another person's name and
passed the message at tier 0 (`vocative_other`), before the classifier saw it. Every extra rule (hot marker, vocative
exceptions, follow-up window) is another guess. The operator's decision: keep it simple. Rules only for safety. Meaning
goes to the classifier, for every message.

## Principles
- A rule is allowed only when it states a certain fact, not a judgment about meaning.
- A message the agent does not answer is still recorded into the session (already true; unchanged).
- The classifier already sees the recent messages (agent and people) and the message, anonymised
  (`src/gateway/engage/input.ts`), so it can tell "a follow-up to the agent" from "people talking".
- Fail closed: no adapter, error, timeout, breaker open, or budget used up means a pass (silence). Unchanged.

## Scope
In: non-mention messages in a channel whose engage `level` is `addressed` or `contribute` and whose `mode` is `on`
(and the same decisions counted in `shadow`).
Out: messages that @mention the agent. They keep today's path (always a turn). The decision gate has a mention row
(`record_doubt`) that a deployment can switch on through its gate mode and config; that is configuration, not part of
this change.

## New ladder (`runTiers`)
Keep, in this order (all are facts, none is a judgment):
1. `level === "mention"` -> pass `level_mention`
2. `restricted` -> pass
3. disallowed `subtype` -> pass
4. `authorIsBot` -> pass
5. `locks.oneOnOne` -> pass
6. text mentions this agent -> run `mention` (tier 1, unchanged)
7. text mentions another person -> pass `names_other_person`; group or broadcast -> pass `names_group`
8. the message starts with another registered agent's name and a comma ("Robin, ...") -> pass `names_other_agent`
   (a known registered agent, not a guess; no other vocative handling)
9. `locks.mentionOnly` -> pass; `locks.disengaged` -> pass
10. another registered agent spoke last here, within the window, and after this agent did -> pass
    `follows_other_agent` (prevents two agents answering one message)
11. `threadEngaged` -> `existing` `engaged_thread` (unchanged: engaged threads are handled elsewhere)
12. everything else -> `{ tier: 3, action: "classify", reason: "classify" }`

Remove from the ladder and from `TierFacts` where nothing else uses them: the vocative logic (`vocative`,
`NOT_A_NAME`, `ACK_LEAD_LONGEST_FIRST` if only used there), `isAckOnly` / `startsWithAck` / `hasAddressShape` /
`hasRequestShape` / `leadingName` / `namesAnywhere` / `names()` (only where unused after the change), the
`follows_agent` run, `humans_alternating`, `follower_failed_test`, `agent_thread_reply`, `root_question`, `name_*`,
`same_named_human`, `no_band`, and the facts that only fed them (`lastSpeaker` may stay if observe still uses it for
`continuation`; check). Do not leave dead code behind: grep before deleting, delete what has no caller, and delete the
tests of what you delete.

## Cost and shadow (`shadow.ts`, `budget.ts`, `env.ts`)
- The classifier now runs for every candidate, so the "skip it after a no" shortcuts must go: remove the pass memory
  (`state.passed` / `markPass` / `clearPass`) and the root cooldown (`state.cooling` / `markCooldown`) from the job and
  from `record.ts`, and the methods themselves if nothing else uses them. Keep: the one-owner claim, the per-channel
  minute ceiling and daily bucket, the breaker, the admission check, the hourly cap of acted runs, shadow mode.
- Raise the defaults so a normal channel is not silent by afternoon: `SLAUDE_ENGAGE_DAILY_BUDGET` 50 -> 2000,
  `SLAUDE_ENGAGE_MINUTE_CEILING` 6 -> 20. Keep `SLAUDE_ENGAGE_ACT_PER_HOUR` at 12.
- Tier 2 (the sampled "rules said run" decisions) disappears with the follow-up rule. Remove the sampling code and
  `SLAUDE_ENGAGE_SAMPLE` only if nothing else uses it; otherwise leave it and say so.
- `continuation` (the flag the classifier input carries): today it is true after a follow-up test. Now set it from the
  fact "this agent spoke last here within the window" if the last-speaker record is still read, else false. Choose the
  smallest change that keeps `buildImplicitInput` and the gate policy working, and say what you chose.

## Tests (write first, see them fail)
- `tests/gateway/engage/tiers.test.ts`: rewrite the table to the new ladder. Required rows: "Dude, can you check
  that?" with no other facts -> classify; "thanks" -> classify; a root message with no agent history -> classify;
  a thread reply -> classify; "Robin, can you look?" (registered other agent) -> pass `names_other_agent`;
  a mention of another person -> pass; broadcast -> pass; a bot author -> pass; level `mention` -> pass;
  a self mention -> run; another agent spoke last -> pass; an engaged thread -> existing.
- `shadow.test.ts` / `observe.test.ts` / `budget.test.ts` and the Redis fakes: update to the removed methods, and add
  a test that two candidates in a row, the first answered "no", both reach the classifier (no memory, no cooldown).
- `tests/gateway/core/engage-phase1.test.ts` and `engage-phase2.test.ts` are known flaky and fail 1 or 2 tests on the
  base commit; run them, report what fails, and do not try to fix the flakiness.

## Docs
Update `docs/site/_content/guides/engagement.md` (the ladder is now: safety rules, then the classifier; remove the
tier 2 and follow-up explanation) and `docs/site/_content/reference/configuration.md` (new default budgets). Add a
short field note `docs/site/_content/field-notes/2026-11-22-classify-every-message.md` (why: a rule read a nickname as a
name and dropped a follow-up before the classifier; what: safety rules only, everything else asked; cost: budget
defaults, one Slack read per candidate; open: mentions that need no reply, which the gate's mention row can do once a
deployment turns it on). Add one index line at the top of the Findings Log in `CLAUDE.md`.

## Verify
`bun run typecheck`, then the tests in `tests/gateway/engage` and every other file that imports a changed module
(grep for `engage/tiers`, `engage/shadow`, `engage/budget`, `engage/observe`, `engage/record`, `fake-engage-redis`).
Run tests only under a memory cap, a few files per command (see Rules).

## Rules
Public repo: no deployment names, people, channel ids or secrets in code, tests, docs or commit messages; generic
fixtures only ("Budi", "Robin", "Dude" are fine). No `Co-Authored-By` or any AI trailer. One logical change per
commit, plain messages. Do not push, open a PR, tag, deploy, or touch a running container. No sudo, no docker.
Tests: `cd /home/ubuntu/slaude && timeout 300 systemd-run --user --scope -p MemoryMax=1500M -q env PATH=$HOME/.bun/bin:$PATH bun test <files>`.
Never run the whole suite. Typecheck: `PATH=$HOME/.bun/bin:$PATH bun run typecheck`.
