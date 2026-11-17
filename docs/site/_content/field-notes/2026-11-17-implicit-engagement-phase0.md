---
title: "Implicit engagement, phase 0: deterministic tiers first, the classifier last, observe only"
date: 2026-11-17
---

# Implicit engagement, phase 0: deterministic tiers first, the classifier last, observe only

**Date:** 2026-11-17

## Problem

An agent answers only when it is @mentioned or already engaged in a thread. A
teammate does more: answers when addressed by name, answers the follow-up to
its own answer, and sometimes joins a question it can help with. Doing that
with a model call per message would be slow, costly and would send every
channel message to a third party. The first release of this work (rc.29) ships
only the part that cannot change behavior: decide what would have happened and
count it. The guide is
[Joining in without an @mention](../guides/engagement.md#17-joining-in-without-an-mention-implicit-engagement-phase-0).

## Mechanism

- **Deterministic tiers first, the classifier last.** `runTiers` is a pure
  function of normalised message facts: no clock, database, Slack call or
  model. Tier 0 passes on cheap facts (level, restricted, subtype, bot author,
  locks, a name for someone else, an acknowledgement, another agent speaking
  last); tier 1 runs on an @mention, a name then a comma and a request, or an
  engaged thread; tier 2 runs on the last-speaker record. Only what those rules
  cannot settle is tier 3, the one place a model is useful. This keeps the
  expected model cost proportional to the ambiguous fraction of messages, and
  makes the ladder testable with a table.
- **The classifier is a seam, and a neutral one.** `EngageClassifier.classify`
  returns `run` or `pass`; the gate-backed implementation asks the decision
  runner for an implicit consult, which talks to whatever adapter the
  deployment registered. Engagement code imports only neutral types and the
  registry, the questions are written about "the agent", and the adapter
  neutrality guard test fails the build if a vendor adapter is named outside its
  own file. Adapter and credentials are deployment config
  (`SLAUDE_DECISION_CONFIG`), never per channel. With no adapter the tiers still
  work and tier 3 is a pass.
- **Channel mode is independent of gate mode.** The gate's `off`, `shadow` and
  `on` describe the mention paths. An implicit consult is awaited and answers
  from the adapter whenever one is configured, whatever the gate's mode,
  because the channel's own `engage.mode` decides whether to act. The adapter
  is therefore built at boot when configured even with the gate off. In the
  gate classifier a `shadow` channel still calls the adapter (and the runner
  logs the decision) but the answer is always a pass.
- **Memo safety.** One decision per message used to be keyed by channel and
  timestamp. Two personas, two apps delivering the same event, a continuation
  and an implicit consult each ask a different question of the same message, so
  the key now carries persona, app, continuation and implicit level, and a
  stored decision made under other flags is a miss that is recomputed and not
  stored. This changed the `key=` text of the `[gate]` log line.
- **Fail closed.** An implicit consult never uses the rules fallback (it reads
  every candidate as an open request, so at `contribute` it would run on every
  message during an outage). No adapter, an error, a timeout or an input
  failure is a drop or `undefined`, and `undefined` at the new call sites means
  pass, where on older paths it means run.
- **Last-speaker record.** When the agent posts, a record of message id,
  persona, app and the person answered is written per (persona, channel,
  thread or top level), read and cleared by the next human message in one
  atomic step (`GETDEL` in Redis with a TTL equal to the window, a map delete in
  memory), so two replicas cannot both believe the agent spoke last and tier 2
  needs no history call. Redis is best effort: an error reads as no record.
- **Phase 0 observation.** `observeEngage` runs the ladder on a message the
  agent was not going to answer, increments
  `slaude_engage_total{tier,outcome,level}` and logs one `[engage] phase0` line
  without text. At `mention` it returns before reading anything. No adapter,
  history read or post is involved, so nothing leaves the box.

## Review findings that mattered

- **A ReDoS bound.** Name matching builds patterns from alias text and runs
  them over message text. Text is cut to 4,000 characters before any matching
  (counted by `slaude_engage_truncated_total`), an email is judged one
  whitespace-free token at a time with an anchored pattern, and aliases are
  limited to one word of letters and digits.
- **A persona-keyed record with a non-consuming marker.** In a channel with
  two agents a shared record would let one agent's read clear the other's, so
  the record is keyed by persona. To tell "another registered agent spoke last"
  an agent peeks at the other personas' records without consuming them, bounded
  to a few.
- **Not consuming before tier 0.** Reading and clearing the record before the
  text rules ran would mean a bot post, an acknowledgement or a message to a
  colleague destroyed the record that the person's real follow-up needed. The
  record is now read only for a message the text rules did not settle, and the
  read has a 100 ms budget (a slow Redis reads as no record).
- **Unattended replies are not recorded.** A reply the agent posts with no
  person waiting on it is not an answer to anyone, so recording it would make
  the next message from some person look like a follow-up. Such replies are not
  recorded, and a record derived from the agent's echo only fills in when the
  outbound path wrote none.

## Open items

- Not built: classifier calls for tier 3, per-channel and daily budgets, pass
  memory, a circuit breaker, acting on a decision (`mode: on` changes nothing),
  a users cache (a human sharing the agent's name is not detected; the stub
  treats none as shared), and detection of two humans alternating (the stub
  says they did not, so the humans-alternating pass never fires).
- The 5 and 15 percent tier 3 targets and the daily bucket size are estimates
  to be checked against phase 0 counters on real channels.
- The ack list, the minimum alias length and the common-word list are small on
  purpose and will need tuning. Whether text from other bots is ever sent to a
  classifier is undecided.
- The counter has no channel label; per-channel counts come from the log lines.
- With several apps in a channel each app's copy observes a message, so the
  counter counts per copy. A deterministic owner for an implicit run is a later
  phase.

## Phase 1 (rc.30): the shadow classifier

Phase 1 asks the classifier about tier 3 candidates and a sample of tier 2 run
decisions and only records the answer. What shaped it:

- **The candidate is always shadow.** The observer hands the classifier a
  candidate in shadow whatever the channel's mode, and reads the model's own
  verdict from a detailed entry point instead of the mode-applied one, so
  `mode: on` cannot act by accident in this phase and the log can still say
  what the model would have done.
- **Budget keyed by channel, ownership by claim.** Two apps (or replicas) in a
  channel both see a message. An atomic `SET NX` on channel and ts picks the
  one copy that does anything about it; the daily bucket and the minute ceiling
  are channel keys, so they are not doubled. The budget store fails closed (a
  pass) and the memories fail open (read as empty).
- **Pass memory has a narrow reach.** Unmentioned messages without the name
  mostly never reach tier 3 (they are tier 0 `no_band`), and a message after
  the agent spoke has its own record, so the memory chiefly matters for
  follow-ups that failed the tier 2 test and for top-level questions, where a
  cooldown replaces it. It is kept because the plan asked for it and it is
  cheap, but the counter will say whether it ever fires.
- **A scrubbed input, one read.** The input is built only after the budget
  passes, so no message that is skipped costs a history call. The thread read
  and the root read are one call each. Name rewriting happens after
  neutralisation using private-use placeholders, so a forged `<agent>` or tag
  in chat text cannot survive and the tokens the module writes do.
- **Unknown is the safe side for the users cache.** Before a users list exists a
  name counts as shared, so "Name, ..." is a tier 3 candidate rather than a run.
  The list is workspace wide, which errs the same way.
- **Review round.** Claims, pass memory and cooldown are keyed by persona (two
  personas on one message must not share them); the budget stays per channel
  with the Slack team in its keys. Admission (blocked, ignored, `/1on1`) is
  checked before the budget is spent, because the observer's own lock read has
  a 100 ms bound that reads a timeout as unlocked. Reads use the no-retry
  lookup client and a single page: Slack's replies return the oldest page of a
  window, so a thread read is a 20 minute window, which for a hot thread is the
  start of the window, not its tail (an open limitation). The breaker hands out
  tickets so a late failure cannot double a newer backoff. A shadow consult is
  counted only by the engage counters. A root question's 60 second wait ends
  with one history read to see whether it was answered, edited or deleted.
- **The deployment's own provider for the model.** The `anthropic` adapter
  reuses the credentials the gateway already holds and forces one tool call so
  an answer is structured or an error; its size limit and its error mapping
  live in its own module.

Open after phase 1: acting on a decision, a deterministic owner for an implicit
run across apps, a channel label on the counter, tuning the sample rate and
budget from real counts, and whether the root debounce (60 seconds) should
re-check the thread for a human answer before asking.
