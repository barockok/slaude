---
title: "Embedding provider: gbrain labels every chunk with its default model"
date: 2026-11-08
---

# Embedding provider: gbrain labels every chunk with its default model

**Date:** 2026-11-08
**Status:** Fixed in `v0.46.0-rc.5` (branch `fix/embedding-provider`).

## Symptom

A brain configured for one embedding provider (say `EMBEDDING_PROVIDER=openai`,
`EMBEDDING_MODEL=text-embedding-3-small`) showed a handful of `content_chunks`
rows whose `model` column named gbrain's default, `zeroentropyai:zembed-1`. The
rows appeared with no operator activity, so a background writer looked
responsible: a heartbeat or wake journal, the nightly review, a commitment
check. Two models in one vector column would break search, so the question was
which process embedded without the configured settings.

## Every brain writer, and where it runs

| Writer | Code | Process |
|---|---|---|
| `memory_save` / `put_page` tools | `src/knowledge/mcp-tools.ts` | gateway (the node tool plane calls back over `/v1`) |
| per-turn memory | `src/memory/brain-provider.ts` | gateway (`/v1/tools/memory/sync` for node turns) |
| heartbeat and wake journals, feedback, rules | `src/proactive/heartbeat.ts`, `wake-tools.ts`, `feedback.ts`, `rule-tool.ts` | gateway |
| background passes (nightly review, quiet moment) | `src/background/pass-tools.ts`, `passes/quiet-moment.ts` | gateway (in-process MCP) |
| KB sync, nightly embed sweep | `src/knowledge/brain-sync.ts`, `brain-cycle.ts`, `brain-backfill.ts` | gateway |
| bundle import | `src/brain-migrate/apply.ts` | gateway (`/brain-import`) or the CLI |
| brain server | `src/knowledge/server/` | its own process, same `getBrain()` boot |

Every one goes through `getBrain()`, whose boot runs `applyEmbeddingEnv()` and
configures gbrain's embedding gateway from the process env. A node refuses to
open the brain at all (`brainEngineConfig`), and agent children get no embedding
key (`src/agent/child-env.ts`). A process without the env (a CLI one-off, a
brain server started without it) never configures the gateway, and gbrain's
`put_page` then skips embedding (`isAvailable('embedding')` is false). Without
a key for the default provider no process can embed with it at all.

## The mechanism

The label is not the model that produced the vector. gbrain's chunk write
stores

```ts
chunk.model || DEFAULT_EMBEDDING_MODEL, // postgres-engine.ts and pglite-engine.ts upsertChunks
```

and its `ON CONFLICT` branch overwrites the label from the new row. None of
gbrain's own writers set `chunk.model`: not `importFromContent` (used by
`put_page` and sync), not `embed --stale`, not `embed <slug>`. So every chunk
written or re-embedded since the pin carries `zeroentropyai:zembed-1`, while
its vector comes from whatever the gateway is configured for. A unit run on a
PGLite brain configured for OpenAI showed it directly: `put_page` embedded
through the configured gateway and the row read `model = zeroentropyai:zembed-1`,
with the brain's `config` table saying `openai:text-embedding-3-small`.

Rows with the configured label can only arrive with an explicit `chunk.model`
(a bundle import carries the source's label) or from outside gbrain. A brain
whose labels were once aligned will show the default label again on every page
that a background writer touches next.

## Fix

- **Labels describe the vector.** At boot slaude wraps the engine's
  `upsertChunks` (an own property, so gbrain's transaction engines, made with
  `Object.create(engine)`, inherit it). Every text chunk that carries a vector
  is taken as made by this process's gateway, whatever label it arrives with:
  it gets the gateway's model when that is the label model, and loses its
  vector otherwise (logged loudly; the write lands unembedded). The label
  model is the configured one only where this process can embed and the guard
  did not refuse; elsewhere it is the brain's own record. Only a caller that
  marks its chunks as carried in (`CARRIED_IN`: the bundle import) keeps
  explicit labels. Image chunks (a separate vector column) are left alone.
  (`src/knowledge/embedding-guard.ts`)
- **Guard at boot, once per boot.** After `initSchema` the boot compares the
  process's configured model and dimensions with gbrain's `config` table
  (`embedding_model`, `embedding_dimensions`):
  - same model: embed;
  - same model name and dimensions, another provider prefix (`openai:x` and
    `litellm:x`): adopt the configured name into the record and embed;
  - another model name: probe (below);
  - other dimensions, or a gateway on another model: refuse.
  A refusal logs `EMBEDDING REFUSED`, resets the gateway and marks embedding
  inactive: `put_page` writes unembedded, sync passes `no_embed`, the embed
  sweep skips.
- **Probe before refusing.** The record alone is not proof (see the upgrade
  case below). The boot re-embeds up to 6 stored chunk texts with the gateway
  and compares them with their stored vectors, plain and title-wrapped
  (gbrain's default search mode embeds chunks behind a title prefix). A brain
  can be mixed (an older model on older pages, a same-width model on newer
  ones), so the samples are spread: at most one chunk per page, pages taken
  round-robin from every source and from both ends of the update history
  (oldest and newest first) plus slug order. Every sample must reach cosine
  0.99; one miss refuses. Chunk labels that already name two or more models
  other than gbrain's default also refuse: a mixed brain is never adopted
  automatically. A full match, or no stored vector at all, adopts the
  configured name, logging the sample count and the minimum cosine
  (`[brain] embedding record adopted: <old> -> <new> (probe ok: 6 sample(s), min cosine 0.9998)`).
  The probe runs off the boot path: the boot does not wait for the provider,
  and embedding stays on while it runs (the process embedded with this same
  config before this guard existed); a mismatch refuses as soon as it is
  known. `closeBrain` waits only for the probe's short database reads (a
  close under an in-flight PGLite query is not safe) and never for the
  provider call; a result that arrives after a close is dropped. The probe is
  bounded (20 s, 60 pages); if it fails or times out it does not refuse:
  embedding stays on with a warning, because refusing a healthy brain is
  worse than a later check. Dimensions are judged by the
  vector column's declared width (as the bundle import does), not the config
  row.
- **Repair.** `slaude brain reembed --model-mismatch` lists pages with a text
  chunk labelled with another model (counts, and the first 50 pages), without
  changing anything. `--apply` re-embeds each such page whole with the
  configured model and stamps its embedding signature. When the record names
  another model, every page is re-embedded and the record is set once all are
  done; such a run resumes, skipping pages already labelled with the target
  whose signature is current. Soft-deleted pages (still inside gbrain's purge
  window) are covered via `listPages({ includeDeleted: true })`. Vectors are
  computed first, then the page's chunk texts are re-read inside the write
  transaction and the page is skipped when they changed meanwhile, so a
  gateway writing beside the repair is fine: its own write stands. Modality
  and token counts are kept from the stored chunks.
  `slaude brain reembed --adopt` is record-only: it sets the record to the
  configured model without touching a vector, for an operator who knows the
  vectors match. Both use gbrain's APIs; the one exception is a read-only
  `SELECT` of a page's `embedding_signature` and its chunks' `modality`, which
  gbrain's `rowToPage` / `rowToChunk` drop. Both refuse in remote mode,
  without a configured model and on a dimension mismatch; `--model-mismatch
  --apply` also refuses when the gateway is inactive. While either runs, the
  boot guard neither adopts nor refuses: the command decides.
- **Bundle import.** `/brain-import` marks its chunks as carried in, and when
  the bundle's model equals the target brain's, labels the carried vectors
  with it (the per-chunk labels a bundle carries are gbrain's default).

## Upgrade case: the record names gbrain's default

Brains created while gbrain's gateway was not yet configured at schema time
(slaude releases from mid-June to early October 2026 configured it after
`initSchema`) had the `config` table seeded with gbrain's default model, while
every vector came from the configured provider. A plain record comparison
would refuse every one of them at the first boot of this release. The probe
recognises them (the stored vectors match the configured model) and adopts
the configured name into the record, logged once. Where the probe cannot run
(the provider is unreachable at boot) embedding stays on and the next boot
probes again; `slaude brain reembed --adopt --apply` settles it by hand.

## Running the repair

Run it where the brain engine runs, with the same `EMBEDDING_*` env as the
gateway (inside the gateway container, or the brain server in remote mode):

```sh
slaude brain reembed --model-mismatch           # dry run: what is mislabelled
slaude brain reembed --model-mismatch --apply   # re-embed those pages
slaude brain reembed --adopt                    # dry run: record vs configured
slaude brain reembed --adopt --apply            # record the configured model only
```

With an embedded PGLite brain, stop the gateway first: PGLite is single-writer
and the boot takes over a held lock. On shared Postgres it can run beside the
gateway.

## Lesson

A label column written by a library is only as good as the library's writers.
Check who fills a provenance field before reading it as provenance; here the
honest record of the embedding space was `pages.embedding_signature`, which
gbrain stamps from the live gateway, not `content_chunks.model`.
