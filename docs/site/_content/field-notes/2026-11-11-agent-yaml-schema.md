---
title: "agent.yaml has one schema: the validator and the editor read the same definition"
date: 2026-11-11
---

# agent.yaml has one schema: the validator and the editor read the same definition

**Date:** 2026-11-11

## Problem

`compileAgent` checked `agent.yaml` by hand: eight key allowlists, a
`refuseUnknown` call per level, and a type check per field. Nothing described
the file to an editor, so an operator got no completion and no warning until a
sync failed.

## What changed

`src/persona/agent-schema.ts` is a Zod schema for the whole file. Every object
is strict, every field has operator-facing help text, and the messages carry
the field path but never the value. `compileAgent` parses with it; what is left
in code is what is not a shape: the name matching its directory, repeated
entries, a valid redaction pattern, and the soul's own `## Channel` sections.

`bun run schema:agent` turns the same schema into `schemas/agent.schema.json`
(`zod-to-json-schema`, a dev dependency), which the docs build publishes. A
test regenerates it and fails if the committed file differs. A second test runs
a corpus of accepted and refused inputs through both the validator and the JSON
Schema (`ajv`), so the two agree on every shape rule. `personas export` starts
each file with the `yaml-language-server` modeline.

## Findings

- Some accepted input is looser than it looks, and was kept as it was: `mode`
  takes any value and reads an unknown one as `extend` with a warning,
  `slackUserId` is read as text whatever it is, and `kbSources` entries are not
  checked. The schema documents these rather than tightening them.
- A null entry in an id list (`public: [null]`) used to escape as a raw Zod
  error from the soul parser. It is now a normal refusal naming the path.
- A path is built from the schema's own keys; the one user-chosen segment, a
  key under `channels`, goes through `safeKey` unless it is a valid channel id.
