---
title: "Proactiveness: promises kept in their own thread, everything else behind code-enforced restraint"
date: 2026-10-26
---

# Proactiveness: promises kept in their own thread, everything else behind code-enforced restraint

**Date:** 2026-10-26
**Status:** Built on the epic branch, unreleased. It touches the agent loop, the dispatch path and the DB schema (migrations 0028 and 0029), so it goes out as a release candidate first. Checked against a fake brain, a scripted model and a fake Slack, on the mono gateway and, for the node path, against a real Redis. A live-model run is described below. Before it, the heartbeat pass was run with the real CLI against the repo's mock LLM (whose `multi-tool` scenario now takes base64url `args`): the CLI was offered exactly the six `mcp__slaude_pass__` tools (including `proactive_post`) and no built-ins; the first heartbeat's `proactive_post` went out to the manager's DM and was recorded in `proactive_posts`; the second, with the same text, was refused by the daily cap (`refused: daily-cap`) and posted nothing; both runs ended `ok` in the ledger.

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

## Live run

Once the build environment could reach a live Anthropic-compatible provider,
an embedding provider and the decision-model API, each was exercised once.
Test data was synthetic, and the model's price was a placeholder (so the
dollar figures below check the arithmetic, not real prices).

- **Promise, end to end through the real agent loop** (mono gateway, real
  `AgentManager` and CLI, fake Slack and brain). In a /1on1 Alice asked to be
  told when a deploy is out. The live model replied in her thread and wrote
  the commitment itself: in `user-<id>`, an event `due`, a `check`, and
  `close-in-one-line`, indexed to run as her. Fifteen minutes later the check
  turn went into her thread, carrying its run. The model searched memory and
  Slack and replied in one line that the deploy was not out yet. The run
  closed `ok`, charged by that turn's own usage.
- **Heartbeat** (real CLI, live model). It read its checklist, found a
  six-day-old investigation, and sent the manager one line with the
  investigation as evidence. The second heartbeat's post was refused
  (`daily-cap`), and the model accepted the refusal.
- **Decision model:** the adapter's request shape returned HTTP 200 in about
  0.5 s, with `answers.<id>.{choice, confidence, probabilities}`. That
  envelope is now pinned in the adapter's tests. The adapter's own fetch
  could not be run there: its outbound guard resolves hosts itself, and that
  environment reaches the internet only through a proxy.
- **Embeddings and the real engine:** `text-embedding-3-small` (1536
  dimensions) with a local gbrain. Typed pages round-trip, `list_pages` by
  type works, semantic search finds the commitment, and an agent-scope search
  does not see a person's private slice.

Found by the live run, and fixed:

- **The same news, reworded, got past "unchanged".** On its second heartbeat
  the model rewrote the same news under a slightly different topic. The text
  check would have let it through the next day; only the daily cap stopped
  it. A post resting on the same evidence, to the same recipient, within
  seven days is now unchanged too.
- **`pass` looped.** After `pass` returned "passed", this model kept calling
  `pass` instead of ending its turn. `pass` now says the turn is over and to
  end it with no further tool call. A run afterwards still showed a few
  repeated passes, but every turn ended.
- **A promise was scheduled twice.** The model also scheduled a cron
  reminder next to the commitment. The memory skill now says a commitment is
  checked for you, so no cron job is needed, and how to write `due`.
- **The real engine's record shape.** gbrain keeps a page's `type` in its
  own column and returns `as_of` as a timestamp, so `memory_about` would have
  labelled every entry "untyped". The record reader now takes the column and
  reads the date back. `get_page`'s `tags` came back empty even for a tagged
  page, so superseded status must come from a tag listing (`supersededSlugs`).
  The phase C readers already do this; phase E reads only pages that are
  rewritten, never retired by tag.

Observed, not changed:

- **A check turn is expensive.** It resumes the whole thread session: about
  237k input tokens for one check. At real prices the default $1 daily
  budget covers only a few checks. The start rule uses the last ok cost as
  its estimate, so it adapts, but operators should size
  `SLAUDE_BACKGROUND_BUDGET_USD` or `SLAUDE_PROMISE_POLL_MINUTES` for
  promise-heavy personas.
- **Minor voice slips:** the check reply began "Checked —".
- **Container environment, not the product.** In that container, a child
  CLI inherits the host session's own Claude Code variables and
  authenticates as that session; the runs unset them. The interactive
  harness settings in the provided env file (`ENABLE_TOOL_SEARCH`) were also
  left out: they hid slaude's MCP tools behind a search step.

## Feedback over the HTTP event path, and failover across processes

- **`reaction_added` and a "stop" reply over Slack's HTTP event path**
  (`e2e/fake-slack/proactive-feedback.test.ts`): the real gateway on the real
  HTTP transport, the wire-level fake Slack, and a fake brain. A signed
  `reaction_added` on a proactive post passes the transport's signature check,
  reaches the gateway's handler and is recorded once as an outcome in the
  recipient's slice. A redelivery records nothing new, and a badly signed
  event gets 401. A signed "stop" reply in the post's thread mutes that topic
  in the replier's profile, quoting them. The agent confirms in one line in
  that thread, and the stop never becomes an agent turn.
- **Failover across separate processes** on a real Postgres 16 and a real
  Redis. Two scheduler processes contend for the `background` leader role. The
  leader claims a due promise and is killed with SIGKILL inside the check's
  dispatch. The survivor takes the lead and does not repeat the check while the
  dead leader's claim is fresh. Past `STALE_CLAIM_MS` (the clock is shared
  through a file so the run need not wait ten minutes) it checks the promise
  exactly once. Postgres then shows one check and the next poll fifteen minutes
  on. The run also applied migrations 0028 and 0029 on Postgres.

## Daylight saving

The end of a beneficiary's quiet hours was computed as now plus the local
clock difference. That assumes a 24-hour day, so on a clock-change day a
deferral ended an hour off: 07:00 instead of 08:00 after falling back, 09:00
after springing forward (America/New_York). It now corrects the first guess by
however far its local time is off. Tests pin both transitions. They also pin
SOUL quiet hours on both sides of a change, and the daily cap counted by local
day across the fall-back night.

## Feedback writes on the real engine

Against a local gbrain with live embeddings, a "stop please" reply under a
DM post about `deploys` added `deploys` to the person's profile `mutes`. Their
other preferences and the profile body were kept, and the reply is the
recorded quote. The DM's outcome page landed in their `user-<id>` slice, and a
channel post's reaction outcome in the agent's slice. Each carries only its
signal (`asked to stop`, `reacted :eyes:`).

## Not verified

- The live run above was one run of each path, with synthetic data and a
  placeholder price. It does not test behaviour across many threads, people
  or days.
- Real Slack itself: that it delivers `reaction_added` for a bot's DM post
  under the granted scopes, and delivers thread replies under a bot DM. The
  fake Slack sends what Slack documents; it is not Slack.
- Failover between Kubernetes pods (separate OS processes on shared Postgres
  and Redis were checked, above).
