---
title: "Brain migration: moving a single-agent brain into a gateway persona, and the three defects only a scenario test found"
date: 2026-10-07
---

A standalone deployment keeps its agent's memory in an embedded brain on a local
volume. A gateway keeps every persona's memory in one Postgres brain. Moving from
the first to the second needs a one-off copy that keeps the embeddings, the links
and the timeline dates, and lands in the slice the gateway will actually read. This
note records the mechanism, the decisions and what went wrong. The operator steps
are in the [runbook](../deploy/brain-migration.md).

## Mechanism

`brain-export` writes a bundle (a manifest plus `pages.jsonl`, checksummed, manifest
last so an interrupted export has none). `brain-import` verifies the bundle, then
posts batches of at most 100 pages or 1 MB to a gateway endpoint guarded by its own
token. The endpoint remaps each page's source, checks the embedding shape, and
writes each page through the gateway's own brain engine. The client then reconciles
the manifest's page counts against what the gateway reports and exits non-zero on
any difference.

## Decisions

- **The export reads a copy.** The embedded engine takes a lock inside its data
  directory. Copying a live brain copied the lock too, and the copy then looked
  held by a foreign process and hung. The copy now skips the lock, and the original
  is never opened, so a running brain is not locked and nothing in it changes. The
  cost is disk: the whole home is copied to a temporary directory.
- **Embeddings are carried, not re-made.** Re-embedding a whole brain costs money
  and changes recall. The import compares shapes instead: dimensions must match
  exactly, the model name only when both sides have one. A default brain has no
  `config.json`, so the dimension comes from the pgvector column (1280 for the
  default), with the config as fallback. Export and import share one helper, so
  they cannot disagree.
- **The target slice is derived, not typed.** The first draft built
  `agent-<slackUserId>`. The gateway's own memory and KB paths go through
  `agentSourceId`, which sanitises the id and drops dashes, so a hand-built name
  would orphan the data for any id the sanitiser changes. The slice now comes from
  the same function, from the persona registry.
- **A page is written whole or not at all**, in one engine transaction. Links go in
  a second pass, because a link needs both pages.
- **Scope is enforced on the gateway, not trusted from the client.** `kb-*` sources
  are refused even when a `map` names them, a map target must be the persona's
  slice, a user slice, `shared` or `public`, and the token is on the gateway-only
  list so a node cannot hold it and the agent child never inherits it.

## What was measured, and what went wrong

- **Overwrite by deleting the page row cascaded away incoming links.** The first
  `overwrite` deleted the row and re-inserted it, which also deleted every link
  from other pages that pointed at it. It now deletes the page's dependent rows
  (chunks, tags, timeline, raw data, outgoing links) and keeps the row.
- **Links written after their page dropped cross-batch links.** A link to a page
  in a later batch found nothing and was dropped. Within a batch the links now run
  after all pages. Across batches (or after a crash between a page and its links)
  they still drop, so a skipped page now still gets its links: a re-run heals
  them. Links are idempotent (`addLink` upserts), at the price that re-running
  rewrites the context of identical edges.
- **The scenario test found three defects the unit tests missed.** Migrating a
  mono default-slice brain into a gateway persona and asking it to recall showed:
  a process-wide cache of ensured sources survived `closeBrain`, so a later brain
  skipped creating its source and failed on a foreign key; a link to a later page
  in the same batch was dropped; and Postgres engines have no `.db`, only
  `executeRaw`, so code written against the embedded engine failed on the real
  target. A Postgres variant of the scenario ran against a throwaway pgvector
  container.
- **Review found links written raw.** A link whose target source was `kb-*` or
  unmapped was written under its raw source instead of dropped. Links are now
  remapped and filtered by the same rule as pages.
- **Mono exposes the token.** The route is mounted on `mono` as well as `gateway`
  (a single deployment may migrate into its own brain), and there the agent child
  shares the OS user and can read the token. This is stated in the runbook: set it
  for the duration of the import only.

- **Two copies of one slug, and the oldest won.** A brain that predates per-agent
  slices holds the legacy `agent` slice beside `agent-<id>`; all of them import into
  one slice, and the export ordered sources by id, so under the default `skip` the
  oldest copy was written first and the current one was counted skipped, with
  reconciliation passing and exit 0. The export now writes the most specific source
  first and the client reports collisions (source pairs, never slugs).
- **Links lost their provenance.** Every imported link became `manual` with no
  origin, but gbrain's link reconciliation never touches manual edges: a later edit
  would have added a `markdown` edge beside the manual copy, and former `mentions`
  edges would have started counting in ranking. Provenance (source, origin page and
  field) now travels with the link, with the origin dropped when its page is not in
  the target. "Migrate once, exit 0" also had to mean complete, so the client runs
  one automatic heal pass for links whose target arrived in a later batch.

## Not verified

- Bundles over a few gigabytes. The whole home is copied and pages are streamed,
  but nothing was measured at that size.
- Postgres at scale: the Postgres scenario ran on a small seed.
- A real gateway cluster. The operator's mock HA test is the first place the
  endpoint will see replicas and a real ingress.
- A page soft-deleted in the target stays deleted under `skip` and may stay hidden
  under `overwrite`; this is documented, not fixed.
- Bundle compression was deferred.
