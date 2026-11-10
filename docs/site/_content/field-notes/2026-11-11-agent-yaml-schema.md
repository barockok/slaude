---
title: "agent.yaml has one schema: the validator and the editor read the same definition"
date: 2026-11-11
---

# agent.yaml has one schema: the validator and the editor read the same definition

**Date:** 2026-11-11

## Problem

`parseAgentYaml` checked `agent.yaml` by hand: eight key allowlists, a
`refuseUnknown` call per level, and a type check per field. Nothing described
the file to an editor, so an operator got no completion and no warning until a
sync failed.

## What changed

`src/persona/agent-schema.ts` is a Zod schema for the whole file. Every object
is strict, every field has operator-facing help text, and the messages carry
the field path but never the value; a key is echoed only through `safeKey`. `parseAgentYaml` parses with it; what is left
in code is what is not a shape: the name matching its directory, repeated
entries, a valid redaction pattern, and the soul's own `## Channel` sections.

`bun run schema:agent` turns the same schema into `docs/site/schemas/agent.schema.json`
(`zod-to-json-schema`, a dev dependency), which the docs build publishes. A
test regenerates it and fails if the committed file differs. A second test runs
a corpus of accepted and refused inputs through both the validator and the JSON
Schema (`ajv`), so the two agree on every shape rule. `personas export` starts
each file with the `yaml-language-server` modeline.

## Findings

- Message changes against the hand-written checks: a non-string `name` reads
  "must be a string" (it said "must equal the directory name"); a null id in
  `access.channels.public` or `trusted` used to escape as a raw Zod error from
  the soul parser and is now a normal refusal naming the path; a null
  `approvers[].user` reads "is required".
- `mode` stays loose on purpose: any value is accepted, and an unknown one is
  a warning read as `extend`. The JSON Schema lists the three values as
  examples without constraining the type.
- Review tightened two fields the old code let through: `slackUserId` is a
  string or number (an unquoted id reads as a number), and `memory.kbSources`
  entries are strings. A list or map as `slackUserId` used to become
  `[object Object]`, and a deeply nested one escaped as a `RangeError`.
- A path is built from the schema's own keys; the one user-chosen segment, a
  key under `channels`, goes through `safeKey` unless it is a valid channel id.
- `z.record` drops a `__proto__` key from `provider` and `mcp`.
- The generated file lives under `docs/site/schemas/`, a path the Pages
  workflow already watches (`docs/**`). The test that compares it with the
  schema means a change to the schema always changes a file there, so the
  published copy cannot go stale.
