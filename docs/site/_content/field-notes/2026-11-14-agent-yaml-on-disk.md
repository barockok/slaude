---
title: "agent.yaml on disk: a persona kept in a folder is defined by the same file"
date: 2026-11-14
---

# agent.yaml on disk: a persona kept in a folder is defined by the same file

**Date:** 2026-11-14

## Problem

A persona synced from git was defined by one typed file. A persona kept in
`$SLAUDE_HOME` was still a markdown soul, and its access and settings were
extracted by a model call, cached, and backed by a regex fallback. Two sources
of truth for the same facts, one of them a model's reading of prose.

## Decision

The folder reads the same file. `readFileAgent` compiles `agent.yaml` with
`parseAgentYaml` and yields what a database-backed persona carries: the soul
text, the compiled structure and the definition. The registry fills those
fields, so each reader that already asked "is this persona defined by an
agent.yaml" worked with no change. The default persona is installed as the same
soul pair the managed default row installs.

## What it taught

- **Skipping is not safe.** A folder persona that fails to load is skipped, and
  an unlisted name on a filesystem registry falls back to the default persona.
  A typo in `agent.yaml` would have handed one agent's channel to another's
  identity. A bad file stops the process at boot instead.
- **Inheritance changes meaning.** A SOUL.md persona inherits the access fields it
  leaves out from the default persona; an agent.yaml persona inherits nothing. A
  migration that copied only what the soul said would have emptied access.
  `migrate` writes the effective values and compares the compiled file with what
  the soul read before it writes.
- **Refuse what you cannot honour.** A file on disk cannot set `model`, `mcp`,
  `runsOn`, `provider`, `kbSources`, `background` or `userToken` yet. Reading the
  file and ignoring those keys would be worse than refusing it, so it refuses
  and names where each one lives.

## Next

Release two stops reading structure out of SOUL.md: a persona with structure
only in its soul text is refused at boot, and the extraction, its cache and the
regex fallback are deleted.
