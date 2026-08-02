# Audience share-tiers: per-page disclosure control for the agent's mind

**Date:** 2026-08-02
**Status:** shipped (branch `feat/audience-share-tiers`)

## Problem

Per-agent brain slices (2026-07-24) gave the agent a private mind with free-form
slugs — but visibility is SOURCE-granular only. A page in `agent-<id>` has no
audience marker: the agent cannot record "fair to tell the team" vs "manager
only" vs "about user X, for user X only". And in allowed (public) channels the
agent's mind is not readable at all, so there was no "public team" tier either —
the whole slice dropped out rather than the sensitive part of it.

## The model: audience tiers, filtered at disclosure time

A page in the agent's own slice may declare, via YAML frontmatter:

```yaml
---
audience: manager   # private | manager | team | public | user:<slack-id>
---
```

Each turn context resolves an `AudienceGrant` level alongside the brain scope:

| Turn context                    | Grant level | Sees tiers                          |
| ------------------------------- | ----------- | ----------------------------------- |
| background/cron (`userId=null`) | `all`       | everything, incl. `private`         |
| manager turn                    | `manager`   | `manager`, `team`, `public`, `user:<self>` |
| trusted channel / own `/1on1`   | `team`      | `team` (default), `public`, `user:<self>` |
| allowed (public) channel        | `public`    | `public`, `user:<self>` — **new: the agent slice now rides along read-only here** |
| unknown channel                 | —           | no agent slice at all (unchanged)   |

Unlabeled pages default to `team` — preserves pre-feature behavior in trusted
channels, fails closed in public ones. `user:<id>` pages surface only when that
user is the current speaker, at any level (the "per-individual" tier).
`private` is the agent's alone: hidden even from manager *turns* (the operator
can always inspect the db; the tier governs conversation context, not storage).

## Why self-declared tiers are safe (destination-not-intent holds)

The 2026-07-24 rule — classify write DESTINATION, never self-reported intent —
is not violated: an audience tier only ever RESTRICTS the agent's own recall.
It grants nothing to anyone. Escalating a page to other *readers* still goes
through the destination-classified gate (`kb_memoize target:"shared"`, carded).
A disclosure filter is also the only enforceable mechanism here: once a page is
in the model's context, no rule can stop it leaking into a reply — so
enforcement means keeping restricted pages OUT of context on lower-trust turns.

## Enforcement points (fail closed at every read path)

Source of truth is a local sqlite index (`kb_page_audience`), written through
on every `kb_memoize` into the agent's own slice (validated pre-write; a
re-memoize without the key clears back to default). gbrain stays stock — it
enforces source scoping in SQL; audience is a slaude-side per-PAGE filter on
top, applied only to `audienceSources` (the agent slices):

- **`gather()` (kb_search + kb_think cross-check)** — filters inside each
  per-source result list (source known without trusting `hit.source_id`);
  slugless hits from tiered sources drop.
- **`kb_get_page`** — keyed on the result's `source_id` (gbrain returns it);
  when absent, fails closed on any explicit index entry for the slug.
- **`kb_list_pages`** — rows carry no `source_id`: at `public` level the tiered
  sources are stripped from the call scope (unlabeled pages are hidden there
  and unverifiable per-row); at `team`/`manager` explicit hidden slugs filter.
- **`kb_graph`** — hidden slugs denied outright; at `public` level sources
  stripped. Link targets of a readable page are its own content — no per-edge
  filtering needed.
- **`kb_think`** — gbrain's internal gather can't filter per page, so when the
  grant hides ANY page in the tiered sources, those sources drop from synthesis
  entirely; the slaude-side cross-check gather (which CAN filter) compensates
  via `search_fallback`/rescue. Cheap dynamic check: with no restricted pages
  indexed, think keeps its full scope — you only pay when the feature is used.

## Known gaps (documented, deliberate)

- **Memory prefetch** (`brain-provider.ts` timeline recall) is untouched: it
  injects recent turns agent-wide regardless of channel trust. Same behavior as
  before this change; entity-anchored + trust-aware recall is the planned
  follow-up (option b of the memory-namespace review).
- Pages written outside `kb_memoize` (ingest, timeline) carry no index row →
  `team` default, never `private`.
- A shared-slice page sharing a slug with a hidden agent page can be
  over-filtered in `kb_list_pages`/`kb_graph` (slug-keyed checks) — fail-closed
  by design.

## Files

- `src/knowledge/audience.ts` — parse, visibility matrix, sqlite index store.
- `src/knowledge/scope.ts` — `AudienceGrant`, `BrainScope.audience/-Sources`,
  per-context grant resolution + allowed-channel read expansion.
- `src/knowledge/gather.ts` — per-source hit filter.
- `src/knowledge/mcp-tools.ts` — memoize validation/write-through + read-path
  enforcement.
- `src/db/schema.ts` — `kb_page_audience` table.
