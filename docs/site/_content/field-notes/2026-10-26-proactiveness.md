---
title: "Proactiveness: promises kept in their own thread, everything else behind code-enforced restraint"
date: 2026-10-26
---

# Proactiveness: promises kept in their own thread, everything else behind code-enforced restraint

**Date:** 2026-10-26
**Status:** Built on the epic branch, unreleased. It touches the agent loop, the dispatch path and the DB schema (migrations 0028 and 0029), so it goes out as a release candidate first. Checked against a fake brain, a scripted model and a fake Slack, on the mono gateway and, for the node path, against a real Redis. The heartbeat pass was run once with the real CLI against the repo's mock LLM: the CLI was offered exactly the six `mcp__slaude_pass__` tools (including `proactive_post`) and no built-ins, a `proactive_post` call reached the pass's server (where the mock's placeholder arguments failed validation, so nothing was posted), and the run ended `ok` with its ledger row. Not checked against a live model.

Phase E is the last phase of the teammate-agent epic. It splits into two
pieces with different rules:

- **Promises are always on.** When the agent promises something ("I'll tell
  you when the deploy is out"), it keeps the promise unprompted, whether or
  not the operator turned proactiveness on. Someone is waiting; the promise is
  the authorization.
- **Everything else is opt-in and restrained.** Where the SOUL turns
  proactiveness on, a heartbeat may speak up when something is new and worth
  an interruption. Code, not the prompt, decides whether a post is allowed.

## Promises

### The index

A promise is a `commitment` page (phase C). The page is the truth, but the
scheduler must not scan brain pages on a timer, so a small `commitments`
table mirrors each open page with a machine-readable next check. It is
written by a hook after the brain write succeeds: `kb_memoize` (on the
gateway, where every turn's brain writes land) and a background pass's
`memoize`. A `done` or `dropped` page superseding the open one closes the row.
An index failure is logged and never fails the write.

The page's `due` decides the schedule:

- an ISO-8601 instant with an offset or `Z` is a time, checked at that time
  and once more at its expiry;
- anything else ("after the deploy", or a time with no offset, which is never
  given a guessed zone) is an event, polled every 15 minutes until 24 hours
  after the promise was written. The poll before expiry is told it is the
  last.

### The check is a turn in the promise's own thread

The obvious design was a locked-down background pass, like phase D's. It
fails the main case: a pass has brain tools only, so "is the deploy out?"
cannot be answered. A check must have the thread's real tools.

So a due check is a synthetic turn dispatched into the thread that made the
promise, through the cron path: the gateway binds a route like a cron run's
(origin `cron`, so no profile write is possible), and the turn goes through
the queue in the gateway role or straight to the manager in mono. The turn is
wrapped in `<runtime-check kind="commitment">` and either replies to the
beneficiary in that thread or calls `pass`.

Three refusals keep it contained:

- **No carried identity.** Cron runs a job created in a /1on1 as its owner by
  setting a per-session "run as" user. On a real thread that setting
  persists, and every later human turn in it would run as that person. A
  promise check sets nothing; the thread's own /1on1 lock decides whom the
  turn runs as.
- **Scope must be unchanged.** The check is refused unless the thread's lock
  still matches where the promise was written: a /1on1 promise is checked
  only while that /1on1 is still locked, and an agent-scope promise only
  while the thread is unlocked. A refused check is retried and, at expiry,
  ends in one fixed line.
- **Never merged into a human's turn.** A thread with a turn running or a
  message waiting defers the check a minute and records nothing.

### Budget: the turn's own usage closes its run

The check is budgeted on the phase D ledger as pass `commitment`, at the top
of the priority list (it does not leave room for the nightly review). The
gateway opens the run before dispatch. The skill check's machinery was
generalised from "the auto-evolve input" to "any input that carries a run":

- `sendMessage(…, { backgroundRun })` tags the input by its sequence number;
  that input's own `result` finishes the run with its own usage (the
  result's running `modelUsage` minus the previous result's);
- on a node, the run id is signed into the job token as `bgRun` and carried
  in the payload; the node finishes it through `POST /v1/background/turn/finish`,
  which accepts only the token's own `bgRun` and only while it is an open
  `commitment` run of the token persona's agent;
- a job a human message was merged into does not attribute (the turn is not
  only the check's), and a run whose turn never reached its result (a reboot,
  a dead node) stays open until the stale-run sweep closes it at its
  estimate. It is never priced at zero.

When the budget refuses, the check is recorded `skipped-budget` and retried
at the next poll. If it refuses the last check, code posts one fixed line in
the thread: `<@beneficiary> I couldn't confirm this in time: <due>.`

## Proactiveness

### The switch is SOUL text only

`## Proactive` (and `### Proactive` inside a `## Channel <#C…>` block) is
parsed by a small deterministic parser from the persona's SOUL text. It is
deliberately not part of the LLM structured extraction: a mis-extraction must
never turn it on. Tests pin that no runtime override field, no structured
soul field and no extraction prompt line names it (invariant 3). A person's
profile can only lower it.

### The heartbeat is a pass that speaks through one tool

When the switch is on anywhere, a heartbeat pass runs every 30 minutes. It
reads the agent's own checklist (`self/heartbeat`), which the agent keeps
itself. Unlike a promise check it is a phase D pass, so it is locked down,
agent-scoped (no person's private slice is readable) and budgeted behind the
nightly reserve. Its checks are brain and KB reads only. An absent checklist
runs nothing and records nothing.

It can speak only through `proactive_post`, executed on the gateway:

- evidence is required, and at most three posts go out per heartbeat;
- `checkProactive` decides, in code: the audience ladder (manager when on; a
  person only with `pings: yes` and a topic they listed; a channel only when
  its block resolves on), SOUL quiet hours, the recipient's own quiet hours
  and mutes, a per-recipient daily cap and cooldown, and "unchanged" (the same
  normalised text to the same recipient within 7 days posts nothing);
- a refusal names its rule, and the prompt tells the model not to rephrase
  around it;
- every post is recorded in `proactive_posts`.

What is "meaningfully new" and whether content concerns a channel are left to
the model.

### Feedback

A reply under a proactive post, or a reaction to it, is recorded as an
`outcome`. A reply starting "stop", "not this", "mute" or "no more" from the
person it was addressed to (anyone, for a channel post) adds that post's topic
to their profile `mutes`, quoting the reply, and the agent says so in one
line. One dismissal mutes one topic, never everything. A reaction never
mutes. Outcomes record only the signal, never what was said, and a DM's
outcome goes to that person's own slice.

## Review

An independent review of the phase diff found these, all fixed with a test:

- **A promise could get stuck for good.** Its check slot is claimed before
  anything else runs. A throw after the claim (a Redis blip in the busy check,
  a failed post) left the row at the same `next_check_at`, so every later
  tick failed the claim, and twenty such rows at the head of the due list
  starved every other promise of that agent. Now every path after the claim
  moves the row on, and a claim that never moved its row (a leader that died
  mid-check) is recovered after ten minutes.
- **A check that could never be dispatched never expired.** A /1on1 promise
  whose lock was released since was refused every 15 minutes, forever, and
  the person never heard back. Now a failed last check expires the row, with
  the fixed line where the thread's scope still allows it, and silently where
  it does not (even the fixed line names the promise).
- **A commitment's `thread` was trusted.** It comes from frontmatter the model
  writes, so a turn in one thread could schedule a check, with its own
  `check` text, into another channel's thread or someone's DM. A commitment
  is now scheduled only for a thread the write came from: the live turn's own
  thread, or a thread the background pass reviewed.
- **Re-saving a promise reopened it or postponed it.** The upsert set `open`
  on a finished row and recomputed an event promise's expiry from each write.
  A rewrite now never reopens a finished row and keeps the schedule unless
  `due` changed.
- **Any reply starting with "stop" muted the topic and was swallowed**
  ("stop the rollout, the numbers are wrong" under a channel post). Only a
  reply that is nothing but a stop request mutes now; anything else reaches
  the agent.
- **Feedback ran before de-duplication**, so a Slack retry or a second app's
  copy of the same reply posted the confirmation twice. Each reply and
  reaction is now claimed once.
- **The busy check read a stale queue index as busy**, deferring a promise
  for up to ten minutes after a turn ended. It now checks that the indexed
  job is still waiting.
- **Promise checks waited behind other agents' passes** in the same tick.
  They now run for every agent before any pass.
- Smaller ones: an agent-scope promise had no team, so the beneficiary's
  quiet hours were never read (the thread's team is looked up); a ledger
  failure after a successful proactive post was reported as a failed post,
  inviting a second one; a top-level `#` heading did not end the
  `## Proactive` section.

Also found while closing the phase: the new scenario test reused another
test's Slack message ts, and the process-wide event de-duplication then
dropped that test's message. The scenario now uses its own ts and clears
what it leaves behind.

Left as is: a DM reply at the top level (not in the post's thread) is not
read as feedback; a human message that lands in a promise check's job in the
moment between the busy check and the dispatch runs under the check's token
(origin cron, so it fails closed: no profile is read or written).

## Rulings

- Promise checks are turns, not passes; the heartbeat is a pass. The
  difference is tools: a promise needs the thread's, a heartbeat must have
  none.
- Event-based promises are polled, never pushed: no webhook ingress.
- Only the beneficiary's own quiet hours defer a promise check, never the
  SOUL's: they asked for it.
- Cooldown defaults to 4 hours (the spec names a cooldown without a value).
- Ping preferences are fields on the profile page, parsed by code; topics
  are free text matched case-insensitively.
- The heartbeat checklist guidance lives in the `slaude:memory` built-in
  skill, not the always-on core.

## Not verified

- A live model deciding what is "meaningfully new", writing commitments with
  usable `due` values, or honouring a refusal without rephrasing.
- Real Slack delivery of `reaction_added` (the manifest now subscribes to it;
  the scope was already granted) and of thread replies under a bot DM.
- HA failover mid-check, and two gateway replicas against real Postgres (the
  claim is the same `background_slots` insert phase D uses).
- DST edge cases in quiet hours: windows are computed at minute precision in
  local time, and a deferral's end ignores a DST shift.
- A real gbrain engine for the profile mute rewrite and outcome pages (fake
  brain only).
