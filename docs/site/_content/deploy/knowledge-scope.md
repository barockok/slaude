---
title: Knowledge scope
description: Limit which knowledge bases each persona reads, and what that does and does not protect.
---

# Knowledge scope

Every knowledge base installed under `$SLAUDE_HOME/knowledge/<label>/` is a
brain source named `kb-<label>` (lower-case; other characters become `-`). By
default every persona reads every installed knowledge base. On a managed
tenant ([personas as code](personas-as-code.md)) a persona can narrow that with
`kbSources` in its `persona.yaml`:

```yaml
slackUserId: "UTESTUSER1"
kbSources:
  - kb-runbook
  - kb-finance
```

| Value | Meaning |
|---|---|
| absent (or `kbSources:` with no value) | every installed knowledge base, as before the field existed |
| `[]` | no knowledge base |
| a list | only those, intersected with what is installed |

The list governs only the `kb-*` sources. The persona's own memory slice, the
user's slice in a `/1on1`, `shared`, `public` and the legacy `agent` source keep
their own rules.

## Where it is enforced

The gateway computes a turn's brain scope from the verified job token and the
**live** persona, on every call, so a sync applies from the next tool call on
that replica; another gateway replica picks it up when its persona registry
reloads (the reload signal, or its poll every 10 seconds).
It covers both paths a tool call can take: the in-process tools in `mono`, and
the REST tool plane nodes call. Concretely:

- `kb_search` and `kb_think` (its synthesis and its cross-check search) read
  only the allowed `kb-*` sources.
- `list_kbs` and `search_kbs` list only the allowed knowledge bases, and return
  `label`, `description`, `tags` and `source`, never a disk path. A persona
  cannot learn that a knowledge base it may not read exists.
- A persona that has been retired (removed from the repository) reads no
  knowledge base: its tool calls are refused (409 on the REST plane), never
  answered with the default persona's scope.
- With the brain disabled, the agent's prompt names
  `$SLAUDE_HOME/knowledge/<label>/` so it can read a knowledge base's files
  directly; the label comes from `list_kbs` or `search_kbs`. The prompt is
  built where the turn runs, so set `SLAUDE_BRAIN_DISABLED` the same on
  gateways and nodes.

There is no runtime override for `kbSources`: it changes only through a sync.
Filesystem (never-synced) deployments have no `kbSources`; every persona reads
everything.

## Validation

Each id must look like `kb-<label>` and be at most 32 characters, as the
gateway derives it from an installed knowledge base's directory name:
`^kb-[a-z0-9][a-z0-9-]{0,28}$`. A malformed or repeated id, or more than 64 ids,
fails the sync with 422 naming the persona (and the position), and
`personas render --check` fails the same way. An id that matches no installed
knowledge base is applied, with a sync warning naming the persona and the id:
the installer and the sync land independently, and the id starts working once
the knowledge base is installed. Two directory names can normalise to the same
id (`My Wiki` and `my-wiki` are both `kb-my-wiki`); a persona listing such an id
reads both, and the sync warns about it.

A payload that sets `kbSources` on any persona is `version: 3`. A gateway that
predates the field refuses it rather than dropping the field, which would
silently widen the persona to every knowledge base. Migration 0017
(`personas.kb_sources`) must be applied; a gateway whose schema lacks it refuses
a sync with 503 naming the migration.

## What it does not protect

`kbSources` filters **retrieval** through the agent's tools. It is not
isolation:

- The knowledge-base files live under `$SLAUDE_HOME/knowledge/`, on the volume
  nodes mount. An agent turn's own file tools (`Read`, `Grep`) can still reach
  them on disk.
- Personas that run on the same node share a trust domain: one persona's turn
  runs as the same OS user as another's.

Give personas that must not see each other's material separate node labels,
and keep material that must stay private out of the shared volume.
