# Decision notes need a visibility boundary separate from 1on1 engagement

**Date:** 2026-08-22

## Finding

A Slack thread lock and a Slack privacy boundary are different controls. A
locked 1on1 limits whose messages the agent processes, but its replies are
still visible to members of the containing channel. Allowing cross-channel
decision history there could disclose a private summary to unrelated channel
members.

## Decision

Decision-note reads use these boundaries:

- channel conversations return only notes sourced from that channel;
- actual DMs may aggregate across source conversations only after a paginated
  membership check confirms the requester belongs to each one;
- membership errors and pagination anomalies fail closed;
- persona and Slack team scopes are always exact;
- inaccessible records do not affect tags, counts, titles, or summaries.

The agent receives the same filtered records through two read-only tools. Note
creation has no agent tool and remains an explicit `/note-add` operation.

## Additional defenses

Capture input is bounded, command and later messages are excluded, structured
summaries must cite supplied message timestamps, and every stored row requires
a validated Slack HTTPS permalink. Stored Slack-derived text is escaped before
rendering, author ids are displayed without generating mentions, and internal
tool errors do not expose storage details.

## Verification

Focused unit and gateway tests cover authorization, source selection,
idempotency, provenance failure, prompt-like source text, malformed timestamps,
bounded input, output escaping, same-channel isolation, DM membership filtering,
fail-closed membership errors, and the absence of an agent-facing write tool.
