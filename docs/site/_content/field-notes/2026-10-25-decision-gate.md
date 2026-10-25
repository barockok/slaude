---
title: "Decision gate: ask a small model whether a message deserves a turn, before spending one"
date: 2026-10-25
---

# Decision gate: ask a small model whether a message deserves a turn, before spending one

**Date:** 2026-10-25
**Status:** Built on the epic branch, unreleased. Off by default. Not verified against the live provider or real threads.

Every mention and every message in an engaged thread started a full agent turn,
even when the message was about the agent rather than to it, or when the question
had already been answered. The gate decides that before the turn, with a cheap,
bounded call, and falls back to today's behaviour whenever it cannot decide.

## The mechanism

**A provider-neutral decision core.** `src/decision/` knows nothing about Slack,
the gate or any vendor. A consumer hands it a state string and a set of named
two-option questions; an adapter returns, per question, the chosen option, the
probabilities and a confidence. The core owns the timeout, the request metric and
the error type. Any failure (timeout, bad output, transport error) is a
`DecisionError`, never an answer: an error is not read as "no". Adapters are
registered by type and only the registry imports them; the first one is a hosted
classifier ("Jev"). Config is one JSON variable. Secrets are never literals, only
`env://PERSONA_*` or `vault://` references resolved by the gateway.

**The gate runs before the turn, on two paths.**

| Situation | Questions asked | Action when sure (confidence at or above `tAct`) |
|---|---|---|
| Mentioned | is it addressed to the agent | yes: run. Otherwise `record_doubt` |
| Engaged thread, not mentioned | is it a question or request; can the agent help; was it already answered | request and can help and not answered: run. Otherwise record |

`record_doubt` means: write the message into the session transcript so a later
turn has it, react with a thinking-face emoji, log it, and do not reply. It never
engages the thread and never creates a session. A doubted mention is the visible
sign that the gate held back, so a person can say it again more directly.

**Rules fallback equals today's behaviour.** If the adapter is missing, errors or
times out, the policy is computed from rules that reproduce the current path
(a mention runs, an engaged thread runs). So an outage degrades to the old
behaviour, not to silence.

**Shadow mode is the evaluation path.** In `shadow` the gate asks, logs what it
would have done next to what happened (`actual`), counts disagreements, and
returns exactly what the off path would do. Shadow is therefore equivalent to off
by construction, and the disagreement counter is the data for choosing `tAct`
before turning `on`.

## Design points found in review

- **Thread replies are oldest-first.** A "last N messages" request returns the
  head of a long thread, which is the stalest context. The gate reads the tail
  with a fixed 200-message page size and at most five pages, bounded by the event
  timestamp, then keeps the last few.
- **One deadline for input and decision.** `timeoutMs` (default 800 ms) bounds
  building the input (thread read, KB score) and the decision together; the
  decision gets whatever is left. An input that misses the deadline gives
  today's path; an adapter that misses it gives the rules decision (the same
  outcome on the gated paths). A hung Slack or KB call cannot stall dispatch.
  The Jev adapter also has its own 800 ms retry budget, a separate constant that
  only decides whether a 429/529 retry is attempted; the core deadline is the
  hard bound.
- **Shadow returns what today's path does** and logs `actual`; it never changes
  the outcome.
- **Slack markup is normalised before text leaves.** Mentions become `<agent>` or
  `<user>`, channels, groups and broadcasts a generic word, emails `<email>`. A
  web link becomes its prose label, or its host when it has no label or when the
  label is itself URL-shaped: Slack writes an auto-linked URL as `<url|url>` or
  `<url|host/path?query>`, so keeping every label had sent full URLs (internal
  hosts, query tokens, a pasted callback) to the adapter. `<tel:…>` becomes
  `<phone>` and any other `<scheme:…>` form `<link>`. The KB score gets the same
  cleaned text. Limits: this scrubs Slack markup only, not the prose. A URL or
  number typed without Slack linking it, and HTML entities, pass as written. The
  URL-shaped test is conservative, so a label such as `README.md` also becomes
  the host.
- **The off path does no extra work.** When the gate is off there is no `await`,
  no secret fetch, no adapter built and no thread read. Off is today's behaviour
  exactly.
- **One decision per mention.** A mention arrives as two Slack deliveries. A
  per-event memo keyed by channel and event timestamp makes both share a single
  decision. A second delivery of an already claimed event gets no doubt reaction.
  That check reads the dedup table and is not atomic with handleMessage's claim,
  so a rare 🤔 can land on a message the other copy is answering. The memo is per
  replica: two replicas receiving the two copies make two adapter calls.
- **A doubted mention never engages or creates a session.** The record goes into
  the mentioned persona's own existing session only.
- **Every gate call is wrapped.** A throw becomes the current path. In shadow the
  runner guards its own logger. In `on` the runner's log calls are not guarded
  themselves: a throwing logger is caught by the gateway's wrapper, so that
  decision is lost and today's path runs.
- **The addressed identity is the persona being spoken to.** The first version
  always used the delivering bot's user id, so a persona mention reached the
  adapter as `<user> can you look?`. The question "is it addressed to
  `<agent>`?" then has no `<agent>` to find, and a real model would doubt every
  persona mention. The routed persona's id now becomes `<agent>`. Posts by any
  of the deployment's own identities (each app's bot, each persona user, the
  post-as-user identity) are role `agent` in the context, so "already answered"
  sees the agent's own answers. The tests missed this because the fake adapter
  keyed on a word in the message, not on `<agent>`. It now answers the way a
  model reads the framing.
- **The gate runs only after the ingress drop filters.** It sat in front of
  handleMessage's filters, so in shadow or `on` the text of a blocked user, an
  ignored user or thread, or a non-manager in an unlisted channel went to the
  adapter. In `on` a doubted one got a visible 🤔 where today it gets silence. The
  gate now returns today's path, before reading anything, when the ingress would
  drop the event: missing team or user, self echo (the `app_mention` path had no
  check of its own), ignore gate, blocklist, channel mode, or a mention with no
  text. The channel-mode rule is one function shared with handleMessage.
- **Bypasses.** DMs, slaude's text commands (`/help`, `/abort`, `/1on1`,
  `/mcp`, any command handleMessage parses after stripping the bot or persona
  mention), a possible pasted connect callback while a paste-back flow is parked
  for that person in that thread, and locked one-on-one threads never call the
  gate. Commands are message text parsed inside handleMessage, so the first
  version gated them: a doubted `/help` in a new thread got a 🤔 and no answer,
  and `/abort` waited for the decision. Approval clicks and other interactive
  actions arrive through the action handler, not the message path, so they never
  reach the gate. That holds by construction and has no test. A group DM is gated
  like a channel.

## Decisions

- **Two-option choice questions, not a yes/no classifier.** The policy needs the
  confidence field, which the choice shape returns.
- **The key is gateway-only.** Both the config variable and the provider key are
  on the gateway-only list, so no node or agent child sees them.
- **Secret references follow the existing grammar.** `env://` is limited to
  `PERSONA_*` names, the same limit other secrets have, so a config cannot read an
  arbitrary variable.
- **Wire retries are narrow.** Auth and validation errors never retry; overload
  retries once only if the advertised wait fits the remaining time.

## Data egress

Thread text (a bounded excerpt plus the message) goes to a third party only when
an adapter is configured and the mode is not `off`, and only for messages the
agent would act on: never for a message the ingress drops, a text command or a
pasted callback. The excerpt is the thread's recent history as Slack returns it,
so it can include earlier messages from people the agent ignores. Message text,
request bodies and the key are never logged.

## Metrics

`slaude_decision_requests_total{adapter,outcome}` (core),
`slaude_gate_decisions_total{action,source,mode}` and
`slaude_gate_shadow_disagree_total{would,actual}`.

## Not verified

- **The live provider API.** The request and response contract comes from a
  third-party reference; the vendor's docs host was unreachable from the build
  environment. That includes the response envelope: the adapter accepts the
  answers either nested or at the top level, and should be pinned to one shape
  once the docs can be read.
- **Real shadow data.** No threads have been run through shadow, so `tAct` at 0.8
  is a default, not a measured threshold.
- **Latency and rate limits under load.** The 800 ms default `timeoutMs` has not
  been measured against real thread reads and the provider under concurrency.
  Each gated message costs at least one `conversations.replies` call, which
  shares the app's Slack rate-limit budget with the agent's own reads.
- Smaller known gaps, deferred: the adapter's retry budget is not tied to the
  configured timeout, and a few edge paths (abort during a retry wait) have no
  tests.
