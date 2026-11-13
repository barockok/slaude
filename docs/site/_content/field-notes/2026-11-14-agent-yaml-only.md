---
title: "agent.yaml only: the model stops reading access out of prose"
date: 2026-11-14
---

# agent.yaml only: the model stops reading access out of prose

**Date:** 2026-11-14

## Problem

Even with `agent.yaml` available, a persona kept as `SOUL.md` still had its
manager, approvers and channel lists extracted by a model call, cached by the
text's hash, with a regex fallback when the call failed. The extraction was also
on the sync path, the console's soul edit, the boot prewarm, and, as a text
parse, on nodes. Two sources for the same facts, one of them a model's reading
of prose, and a fallback that silently kept only the approvers.

## Decision

`agent.yaml` is the only source. A persona with structure only in `SOUL.md` is
refused loudly instead of starting with an empty access list that looks healthy:
at boot (gateway and mono, filesystem tenants), at sync (422 naming the persona
and the export command), and in the console (409). The extractor survives in one
place, the offline `personas migrate` and `personas export` commands, because a
person reviews what it produces before it is written.

## What it taught

- **The extraction was on more paths than the runtime.** The survey found it in
  sync, the console's persona routes, `slaude validate` (which never read an
  `agent.yaml`), nodes (a text parse of the bundle's soul) and four cache
  fallbacks. Deleting the function was the easy part; deciding what each caller
  does instead was the work.
- **A loud refusal beats a quiet default.** With no structure source, the old
  fallbacks would have started the persona with an empty or default access list.
  Every replacement is either the compiled file or a refusal that names the fix.
- **Do not seed what the loader refuses.** The loader refuses a `SOUL.md` beside
  an `agent.yaml`, so the starter must be an `agent.yaml`, and nothing may recreate
  a `SOUL.md` on a path that reads it (a review of rc.16 found exactly that boot
  loop).
- **Unchanged is not new.** A synced persona whose soul text is unchanged keeps
  its stored structure, so a repository can be converted one persona at a time
  instead of in one flag-day commit.

## Next

The domain-model slices: users, bindings and boundaries as records, so a persona
names people by internal id and the typed references from slice A resolve to
them.
