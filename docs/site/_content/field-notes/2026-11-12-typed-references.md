---
title: "Typed references: agent.yaml says what kind of thing an id is"
date: 2026-11-12
---

# Typed references: agent.yaml says what kind of thing an id is

**Date:** 2026-11-12

## Problem

`agent.yaml` named people and channels by bare Slack id. A bare id says nothing
about what it points to or which service issued it, which blocks everything that
follows: an email address in an ACL, a second Slack workspace, a WhatsApp group.
The design is in `docs/superpowers/specs/2026-11-12-domain-model-and-references.md`;
this is slice A, the grammar only.

## What changed

- `src/refs/` holds one parser and normaliser (`parseRef`, `formatRef`). A
  reference is internal (`user:<id>`), external (`slack:user:<id>`,
  `whatsapp:phone:+...`), an email, or a selector (`trust:public`, `dm`). Each
  scheme fixes its number of leading segments, so a `:` in the last segment
  needs no escaping. A refusal reason is fixed text that never carries the input,
  every pattern is linear and the length is checked first.
- The agent.yaml schema takes a reference wherever it took a user or channel id.
  Each field accepts a set of kinds: a user field takes user references, a
  channel field channel references, `mandate.scoped[].boundary` a channel
  reference or a selector. The JSON Schema describes both the typed and the legacy
  bare form, and its parity test runs the same corpus through both.
- Compilation still produces the same `SoulData`: a `slack:` reference is read
  down to the Slack id and a scoped boundary to the `channel:<id>` that
  `mandate-scope.ts` expects. Other schemes parse and validate and are refused at
  compile, naming the field and the scheme, until records exist.
- A bare id, and the older `channel:<id>` boundary, are accepted for one more
  release with one warning per field path. `personas render` prints them;
  `personas export --format agent-yaml` writes the typed form.

## Decisions worth keeping

- A reference in the wrong field is a validation error, not a compile error: a
  channel reference in a user field fails in the editor too, because the JSON
  Schema carries a pattern per field kind.
- Upper-casing a Slack id must not fold lookalikes (a dotless i) into ASCII, so
  Slack ids are required to be plain ASCII before they are normalised.
- Email normalisation stops short of joining identities: plus-addressing and dots
  stay, because merging two addresses is a human act.
- Multiple Slack workspaces per deploy are now planned, so references carry an
  optional workspace from the start; the compile drops it while one workspace is
  connected.

## Left for later slices

Records (users, bindings, boundaries), access on internal ids, sessions keyed by
boundary, environments as definitions. Bare ids stop being accepted in the release
after the first stable one that carries this change.
