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
- **One deadline for input and decision.** Building the input (thread read, KB
  score) and the decision share the same budget; the decision gets whatever is
  left. A hung Slack or KB call cannot stall dispatch; it falls back to rules.
- **Shadow returns what today's path does** and logs `actual`; it never changes
  the outcome.
- **Slack markup is normalised before text leaves.** Channel, group and link
  syntax is reduced (channels and groups to a generic word, links to their label
  or host) so internal names and URLs are not sent to a third party. The KB score
  gets the same cleaned text.
- **The off path does no extra work.** When the gate is off there is no `await`,
  no secret fetch, no adapter built and no thread read. Off is today's behaviour
  exactly.
- **One decision per mention.** A mention arrives as two Slack deliveries. A
  per-event memo keyed by channel and event timestamp makes both share a single
  decision. A second delivery of an already claimed event gets no doubt reaction.
- **A doubted mention never engages or creates a session.** The record goes into
  the mentioned persona's own existing session only.
- **Every gate call is wrapped.** A throw (including from the logger) becomes the
  current path.
- **Bypasses.** DMs, slash commands, interactive actions and locked one-on-one
  threads never call the gate. A group DM is gated like a channel.

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
an adapter is configured and the mode is not `off`. Message text, request bodies
and the key are never logged.

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
- **Latency under load.** The 800 ms default budget has not been measured against
  real thread reads and the provider under concurrency.
- Smaller known gaps, deferred: the adapter's retry budget is not tied to the
  configured timeout, and a few edge paths (abort during a retry wait, unusual
  markup such as `tel:` links) have no tests.
