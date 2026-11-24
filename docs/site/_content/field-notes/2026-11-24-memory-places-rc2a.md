---
title: "Memory places, release 2a: saved pages, checklists, commitments and rules move into the place"
date: 2026-11-24
---

# Memory places, release 2a

**Date:** 2026-11-24
**Status:** in `v0.46.0-rc.46`, behind `SLAUDE_MEMORY_BOUNDARIES=on` and a per-persona canary list. Design:
`docs/superpowers/specs/2026-11-24-memory-architecture.md`. Follows release 1 (`2026-11-24-memory-places-rc1`).

## The decision

Release 1 measured. This one makes `on` real for the memory a person can read back: pages saved with `memory_save`, a
channel's checklist, commitments and rules scoped to a channel or DM. The second half of the design's one large release
(transcripts, summaries, passes, history dual read, narrowing `read_channel` and `list_cron_jobs`, the move job) is a separate
step, so that this part can be canaried on one persona first. The flag semantics stay simple: `off` and `shadow` behave as before,
`on` applies to the personas in `SLAUDE_MEMORY_BOUNDARIES_PERSONAS` (empty means all).

## What it does

- The scope function adds the place over the legacy scope instead of replacing it. A turn that wrote the persona's slice now
  writes its place, and reads place first, then the tiers. A place that cannot be worked out, or cannot be bound in the registry,
  leaves the legacy scope: persona-wide, the page marked `place: unknown`, a counter moved (owner decision 3).
- A promotion is a write with an explicit source and a different tier: the gate classifies it `manager` before it looks at who
  the turn is (a wake is denied outright), approval comes from the soul's manager and backup only, and the card carries the exact
  text. The approver is known only after the click, so the gated call now passes who approved to the write, and `promoted_by`
  is stamped then.
- The registry is checked where a brain call leaves the gateway: a scope naming a place source not bound to the calling agent is
  refused. A place is bound (insert or ignore, cached for the process) when a scope is built for it.
- The background code (the channel wake, the rule tool, the reply context) has no turn gate, so it asks one small module
  (`src/proactive/place-home.ts`) for the channel's place scope; the checklist copy into the place is claimed once per channel
  in `background_slots`.

## What the design got wrong against the code

- The design puts the registry check in the SQL layer. The remote brain server may not hold the registry, so the check sits in the
  gateway's brain call (and in the local think path, which reads the engine directly and never went through that call).
- The per-source gather built a fresh scope per source and dropped any new field: a place source would have been refused by the
  new check. It now carries the owning agent along.
- `memoryScopeFor` derives the transcript's source from the KB scope, so under `on` the transcript would have moved into the
  place by accident. Transcripts are release 2b: the function maps a place back to the persona's slice.
- The design says a /1on1 held by a manager reads that manager's DM place. No table maps a person to a DM channel, so the
  gateway opens the DM through Slack (cached, one second and a half at most) and reads the place only when it is already bound.
  A failure reads less, never more. This path was tested with a fake opener only; it has not run against Slack.
- The stored manager grants count as "manager" in the approver list the gate uses, which would let a stored grant approve a
  promotion. A separate list (the soul's managers) is passed for promotions only.
- Mode `off` used to compute no place at all, which would have made rollback hide the pages written while `on`. `off` now still
  resolves the place when the registry holds any row (a cached read), and reads a place only when it is bound.
- The live-model sim scenario for the isolation property (`scenarios-real/memory-places-isolation.yaml`) needs a model and a
  real brain, so it was written but not run here; the property is tested through the real tool handlers on the fake brain.

## Open

- Whether the unknown-place rate, in a soak with the flag on for one persona, is low enough to widen the canary.
- A page written persona-wide for an unknown place carries `place: unknown`; nothing moves those pages yet (the move job).
- An untyped page saved to an unknown place gains a frontmatter block; typed pages gain provenance keys. Both are for audit
  only: no reader trusts them.
- A promotion over 2400 characters is refused so the card can show it whole; whether that is the right limit is for the first
  real promotion to say.
