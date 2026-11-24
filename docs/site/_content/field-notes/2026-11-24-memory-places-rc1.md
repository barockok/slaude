---
title: "Memory places, release 1: measure first, and one gate fix"
date: 2026-11-24
---

# Memory places, release 1

**Date:** 2026-11-24
**Status:** shipped in `v0.46.0-rc.45`. Design: `docs/superpowers/specs/2026-11-24-memory-architecture.md`.

## The decision

Memory writes that belong to one channel or DM land today in the agent's own slice, which every trusted turn of that agent
reads. The design gives each (agent, boundary) pair its own source, so a conversation, a checklist or a commitment stays where
it happened. The first release builds the machinery and changes no read or write, so the second can switch writes over with a
measured unknown-place rate in hand.

## What the first release is

- A place is named by one pure function in one file (`src/memory/place-id.ts`): `mb-` and 28 hex characters of
  sha256(agent id, NUL, boundary id). A guard test scans all of src and fails when any other file names the prefix, so the
  naming cannot spread.
- `placeFor` returns a place or a typed reason there is none, from the session or job row first. It is allowed to be wrong
  or slow only in ways that cost nothing: it never throws, is time bounded and cached, and no decision reads it.
- `place` is a required field of the scope and gate inputs, so a new caller cannot forget it. Sending `{ kind: "none" }` is
  always valid.
- The shadow counters sit at the write points a later release will redirect, with a fixed set of surface labels.

## One real fix

The brain gate returned "automatic" for every write of a turn with no person, so a wake's `memory_save target: "shared"`
never reached a card, and could silently overwrite a page the team relied on. The new rule is the narrowest that is safe:
create a page that does not exist is automatic, anything that changes an existing shared page is refused with a message that
points at the channel. The existence check is a read of `shared` itself; a failed read refuses.

## What the design got wrong against the code

- The spec lists `cron_jobs.boundary_id` as a column to read; it exists, but no reader of `boundary_id` did (sessions strip it
  from the rows they return), so two small repo reads were added.
- The spec expects the resolver to say "lookup failed". The existing boundary resolver returns null for both "absent" and
  "failed", so it gained a read of its own failure backoff.
- Checklists and commitments are not separate write paths: both are `memory_save` pages (a slug prefix and a page type), so
  the counters tell them apart there.
- `delete_page` from a tool always targets the turn's own slice, never `shared`, so the "wake may not delete a shared page"
  rule is enforced in the gate but is not reachable from a tool today.
- An existence check then a write is not atomic. Two wakes creating the same new shared page at once can both pass; the
  second overwrites the first. Accepted for this release; a second release can write with an "insert only" guard.

## Open

- Whether the unknown-place rate is near zero in a soak: that is what this release is for.
- Nothing yet populates `memory_scopes`; the next release binds a place before its first write.
