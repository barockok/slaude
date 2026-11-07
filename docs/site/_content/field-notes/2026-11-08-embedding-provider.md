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

- **Label every write with the brain's model.** At boot slaude wraps the
  engine's `upsertChunks` (an own property, so gbrain's transaction engines,
  made with `Object.create(engine)`, inherit it). A chunk without a label gets
  the configured model, or the brain's recorded one when the process has none.
  Explicit labels are kept. (`src/knowledge/embedding-guard.ts`)
- **Refuse to embed on a mismatch.** After `initSchema` the boot compares the
  process's configured model and dimensions with gbrain's `config` table
  (`embedding_model`, `embedding_dimensions`) and the gateway's model. On a
  mismatch it logs `EMBEDDING REFUSED`, resets the gateway and marks embedding
  inactive: `put_page` writes unembedded, sync passes `no_embed`, the embed
  sweep skips. At write time, a vector the gateway produced with a model other
  than the brain's is dropped with the same loud log; with no gateway, a vector
  can only have been carried in (a bundle import, checked against the brain's
  dimensions there) and is kept.
- **Repair.** `slaude brain reembed --model-mismatch` lists chunks whose label
  differs from the configured model, by label and page, without changing
  anything. `--apply` re-embeds each listed page whole with the configured
  model and stamps its embedding signature; when the brain's record names
  another model, every page is re-embedded and the record is set afterwards.
  It uses gbrain's APIs only (`sources_list`, `listPages`, `getChunks`,
  `upsertChunks`, `setPageEmbeddingSignature`, `getConfig`/`setConfig`,
  `embedBatch`); no SQL on gbrain tables. It refuses in remote mode, without a
  configured model, on a dimension mismatch (the column width cannot change by
  re-embedding), and with `--apply` when the gateway is inactive.

## Running the repair

Run it where the brain engine runs, with the same `EMBEDDING_*` env as the
gateway (inside the gateway container, or the brain server in remote mode):

```sh
slaude brain reembed --model-mismatch           # dry run: what is mislabelled
slaude brain reembed --model-mismatch --apply   # re-embed those pages
```

With an embedded PGLite brain, stop the gateway first: PGLite is single-writer
and the boot takes over a held lock. On shared Postgres it can run beside the
gateway.

## Lesson

A label column written by a library is only as good as the library's writers.
Check who fills a provenance field before reading it as provenance; here the
honest record of the embedding space was `pages.embedding_signature`, which
gbrain stamps from the live gateway, not `content_chunks.model`.
