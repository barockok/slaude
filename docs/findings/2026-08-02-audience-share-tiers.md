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

## Storage: brain tags, not a slaude-side index

First cut used a local sqlite index (`kb_page_audience`). Rejected on review
(operator call): a second store diverges from the brain — remote brain-server
deploys, restore-from-backup, any writer that isn't this process — and the
tier is invisible to brain tooling. Tags keep the brain the single source of
truth and make tiers auditable (`kb_list_pages({tag:"audience:manager"})`).

Encoding: frontmatter stays the authoring API; `kb_memoize` derives tags —
`audience:<tier>`, and for user tiers the pair `audience:user` (marker) +
`audience:user:<ID>` (ids uppercase; tag matching is exact-string SQL). The
marker exists because user ids aren't enumerable: "does ANY user-restricted
page exist?" must be answerable with one tag query.

Two gbrain realities shaped the write path:

- **put_page tag reconciliation is ADD-ONLY** (their #1621: re-imports must
  not wipe enrichment tags). Relying on it means a demoted page (`public` →
  `manager`) keeps BOTH tags and fails OPEN. So slaude reconciles explicitly
  after each own-slice memoize: `get_tags` → remove stale `audience:*` → add
  current. If reconcile fails after the page landed, the memoize returns an
  error instructing a retry — never silent success on an under-protected page.
- **list_pages caps at 100 rows, no pagination.** A full result may be
  truncated; an incomplete HIDDEN set fails open, so a full page ⇒ the whole
  source is treated hidden for the turn. (A truncated VISIBLE set at public
  level under-shows — already fail-closed.)

## Enforcement points (fail closed at every read path)

The per-turn filter is built from tag queries (`buildAudienceFilter`: one
slug-set query per relevant audience tag per tiered source; team/manager
compute the HIDDEN set, public computes the VISIBLE set). gbrain stays stock —
it enforces source scoping in SQL; audience is a slaude-side per-PAGE filter
on top, applied only to `audienceSources` (the agent slices):

- **`gather()` (kb_search + kb_think cross-check)** — filters inside each
  per-source result list (source known without trusting `hit.source_id`);
  slugless hits from tiered sources drop; filter build errors hide the tiered
  sources entirely.
- **`kb_get_page`** — keyed on the result's `source_id` (gbrain returns it)
  via per-slug `get_tags` (no list-truncation concerns); when absent, fails
  closed on any explicit tier for the slug in a tiered source.
- **`kb_list_pages`** — rows carry no `source_id`: at `public` level the tiered
  sources are stripped from the call scope (unlabeled pages are hidden there
  and unverifiable per-row); at `team`/`manager` rows filter against the
  hidden set (a slug must be visible in EVERY tiered source to survive).
- **`kb_graph`** — per-slug `get_tags` check per tiered source, denied when
  hidden (tag-read errors deny too); at `public` level sources stripped. Link
  targets of a readable page are its own content — no per-edge filtering.
- **`kb_think`** — gbrain's internal gather can't filter per page, so when the
  grant hides ANY page in the tiered sources, those sources drop from synthesis
  entirely; the slaude-side cross-check gather (which CAN filter) compensates
  via `search_fallback`/rescue. Cheap dynamic check: with no restricted pages
  tagged, think keeps its full scope — you only pay when the feature is used.

## Known gaps (documented, deliberate)

- **Memory prefetch** (`brain-provider.ts` timeline recall) is untouched: it
  injects recent turns agent-wide regardless of channel trust. Same behavior as
  before this change; entity-anchored + trust-aware recall is the planned
  follow-up (option b of the memory-namespace review).
- Pages written outside `kb_memoize` (ingest, timeline) carry no audience tag
  → `team` default, never `private`.
- A shared-slice page sharing a slug with a hidden agent page can be
  over-filtered in `kb_list_pages`/`kb_graph` (slug-keyed checks) — fail-closed
  by design.
- Tag-set queries add a few `list_pages`/`get_tags` calls per KB read on
  tiered sources — in-process SQL on the local backend; extra round-trips on
  the remote backend (acceptable; revisit with a bulk-tags op upstream).

## Files

- `src/knowledge/audience.ts` — parse, visibility matrix, tag encode/reconcile,
  tag-query filter build.
- `src/knowledge/scope.ts` — `AudienceGrant`, `BrainScope.audience/-Sources`,
  per-context grant resolution + allowed-channel read expansion.
- `src/knowledge/gather.ts` — per-source hit filter.
- `src/knowledge/mcp-tools.ts` — memoize validation/tag-reconcile + read-path
  enforcement.
