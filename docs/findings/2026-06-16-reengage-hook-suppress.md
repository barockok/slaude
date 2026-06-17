# Re-engage via in-session suppression (hook-only), not Slack backfill

**Date:** 2026-06-16
**Status:** shipped
**Supersedes:** the re-engage *backfill* approach (reconstructing the gap from
Slack on re-`@mention`), which was abandoned before merge.

## Problem

When a channel thread disengages (a user `@mentions` a colleague), the gateway
gate dropped every later plain message — they never reached the Claude session.
On re-`@mention` the agent resumed **blind to everything said in the gap**.

The first attempt rebuilt that gap on re-engage by re-fetching the thread from
Slack and injecting a synthetic preamble. It worked but was heavy: a Slack
round-trip, name resolution, recency caps, and a truncation story — all to
reconstruct context the session could simply have kept in the first place.

## Better framing: keep the gap *in* the session

Don't drop and later reconstruct — let disengaged messages flow into the session
so the transcript stays continuously populated, and just stop the model from
*responding* while disengaged. On re-engage there is nothing to backfill: the
context is already there, as real conversation history.

The mechanism is a `UserPromptSubmit` hook keyed on the thread's `engaged` flag.

## The load-bearing detail: `continue:false`, NOT `decision:"block"`

A throwaway spike against the pinned SDK (`@anthropic-ai/claude-agent-sdk
0.3.173`) settled which hook return achieves "persist but don't process". The
hook fires before any model call, so no real auth is needed to observe it:

| hook return | model runs? | user prompt persisted to transcript? |
|---|---|---|
| `decision:"block"` | no | **no** — discarded *before* the enqueue/persist step (no jsonl written at all) |
| (no hook) | yes | yes — `{"type":"user",…}` written even when the model call itself fails |
| **`continue:false`** | **no** (no `assistant` event) | **yes** — `{"type":"user",…}` lands in the transcript jsonl |

So `decision:"block"` is the wrong primitive despite what the type docs imply
(`UserPromptSubmitHookSpecificOutput.suppressOriginalPrompt` governs the
*ephemeral* block message shown in-the-moment, not durable persistence).
`continue:false` enqueues/persists the user turn, then halts before generation —
exactly "session stays populated, model never processes it", at ~0 output tokens.
On re-engage the next turn resumes with the gap already in history.

## Implementation

- `src/agent/manager.ts`
  - `disengagedHookDecision(row)` — pure, exported for tests: returns
    `{continue:false, suppressOutput:true, …}` when `row.engaged === 0`, else
    `{continue:true}`.
  - A `UserPromptSubmit` hook calls it (reading the row **live** via
    `Sessions.findById`, not closed over — a re-`@mention` takes effect on the
    very next message) and increments `disengaged_suppressed_total`.
- `src/gateway/core/gateway.ts`
  - The engagement gate no longer drops disengaged messages. When a thread has a
    session, both the disengaging colleague-mention and subsequent plain replies
    are routed into the session via `handleMessage(args, {suppress:true})`.
  - `suppress` skips all Slack-visible feedback (no 👀, no "thinking…", no ✅ on
    `done`) and swaps the reply directive for a "recorded for context only — do
    NOT reply" note. A colleague-mention in a thread with **no** session is still
    dropped (never spin one up for an unrelated thread).
- `src/metrics.ts` — `slaude_disengaged_suppressed_total`.

## Tests

- `tests/agent/disengage-hook.test.ts` — the pure decision (engaged / disengaged
  / no-row), and an explicit guard that it never emits `decision:"block"`.
- `tests/gateway/core/gateway-seam.test.ts` — rewrote the engage/disengage
  durability block to the new contract: disengaged messages are *recorded but
  suppressed* (classified by envelope), never processed; no-session
  colleague-mention is dropped; disengage survives a restart; re-`@mention`
  re-engages.

## Note

The user-facing guarantee is unchanged from the durability work — slaude does
not reply after you turn to a colleague. What changed is the mechanism: the gap
is retained as genuine session history instead of being dropped and later
rebuilt from Slack.
