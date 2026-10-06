# Brain migration: from a single-agent deployment into the gateway

**Date:** 2026-10-07
**Depends on:** the centralized persona runtime (gateway-owned brain on Postgres, personas as
code, gateway-only secrets)
**Related:** `docs/site/_content/deploy/multi-node.md` (the gateway topology),
`src/cli/migrate-sqlite.ts` (the sibling tool for sessions and cron rows)

## 1. Intent

An operator who has run one agent per deployment (mono role, embedded PGLite brain on a
volume) wants to move that agent into the gateway topology without losing what it learned. The
gateway topology refuses embedded storage for the brain: the brain lives in Postgres, owned by
the gateway, and every agent is a named persona with its own private slice.

This spec adds a repeatable, auditable way to copy an agent's **memory slices** (its private
mind, the people it talked to, the shared and public pages) from the old PGLite brain into the
gateway's brain, **rewriting the agent slice id** on the way, with embeddings, dates, tags,
links and timeline preserved.

Decisions from the operator that drive this spec:

- **Scope: memory slices only.** `kb-*` sources are re-created by the gateway from the knowledge
  repositories in the manifest; they are not copied.
- **The gateway is the only writer.** The tool never needs the brain's database URL or the job
  secret, which are gateway-only.
- **The target agent slice is derived from a persona name**, not typed as an id.

## 2. Why the existing tools do not fit

- **`gbrain migrate --to supabase`** (the pinned `gbrain` ships it) reads and **overwrites**
  `~/.gbrain/config.json`, never copies the `sources` registry (a write into a missing source
  fails on `pages_source_id_fkey`), rebuilds links as same-source only, and cannot rewrite slice
  ids.
- **`kb_memoize` and `memory/sync` on the node tool plane** derive the slice from a signed job
  token, take markdown only (the gateway re-embeds it), stamp timeline entries with today's date,
  cap a call at 20 pages, and send every `shared` write to a Slack approval card. A faithful copy
  cannot go through them.

## 3. Scope

In:

- `brain-export`: read an old PGLite brain into a portable, checksummed bundle.
- A token-guarded gateway endpoint that imports a batch of pages into the gateway's brain.
- `brain-import`: a client that verifies a bundle and posts it in batches.
- A source remap (agent-like sources to the persona's agent slice) and a conflict policy.
- A runbook and tests.

Out (v1):

- **Remote brain mode** (`SLAUDE_BRAIN_MODE=remote`). The remote server exposes two generic
  tools and no op that carries embeddings. The endpoint refuses in remote mode.
- **`kb-*` content.** Re-synced from git.
- **Sessions, cron jobs, `/1on1` locks.** `migrate-sqlite` covers the relational rows.
- Merging two agents' `shared` pages with semantic conflict resolution (see §6, conflicts).

## 4. Design

### 4.1 Bundle format

A directory:

```
bundle/
  manifest.json
  pages.jsonl        # one page per line
```

`manifest.json`:

| Field | Meaning |
|---|---|
| `version` | Bundle format version (`1`). |
| `createdAt` | ISO timestamp. |
| `engine` | `{ schemaVersion, embeddingModel, embeddingDimensions }` read from the source brain. |
| `sources` | `[{ id, pages, chunks, embedded }]`: the inventory the import validates against. |
| `files` | `{ "pages.jsonl": "<sha256>" }`. |
| `excluded` | Source ids skipped by the filter (`kb-*` by default). |

A `pages.jsonl` line:

```json
{ "source": "agent-default", "slug": "...", "type": "...", "title": "...",
  "compiledTruth": "...", "timeline": "...", "frontmatter": {}, "contentHash": "...",
  "chunks": [{ "index": 0, "text": "...", "source": "...", "embedding": [..], "model": "...", "tokens": 0 }],
  "tags": [], "timelineEntries": [{ "date": "...", "source": "...", "summary": "...", "detail": "..." }],
  "raw": [{ "source": "...", "data": {} }],
  "links": [{ "toSource": "...", "toSlug": "...", "type": "...", "context": "..." }] }
```

Embeddings are plain number arrays (a 1280-dimension vector is about 12 KB as JSON; the bundle
is large but streamable, and never held in memory whole).

### 4.2 Export: `bun run brain-export`

```
brain-export --home <dir> --out <bundle> [--include <source>...] [--exclude <source>...]
```

- Reads a **copy** of the PGLite directory: the command copies `--home` to a temp directory
  first and opens the copy, so it never opens (or takes a lock on) a live brain. The runbook
  tells the operator to stop the pod, or work from a volume snapshot.
- Uses the `gbrain` engine directly (`createEngine`, `listPages`, `getChunksWithEmbeddings`,
  `getTags`, `getTimeline`, `getRawData`, `getLinks`). It does **not** call slaude's `getBrain()`,
  which clears stale locks and runs schema initialisation (writes).
- Default filter: every source except `kb-*`. `--include` / `--exclude` override by exact id or
  prefix `kb-`.
- Streams pages to `pages.jsonl`, computes sha256 as it writes, and writes the manifest last,
  so an interrupted export has no manifest and the import refuses it.
- Prints the source inventory so the operator can see which agent-like sources exist before
  importing.

### 4.3 Import endpoint

`POST /brain-import/v1/personas/:persona`, mounted beside `/deploy`.

**Auth.** Its own `SLAUDE_BRAIN_IMPORT_TOKEN`, presented as `Authorization: Bearer`, compared in
constant time. Unset means the endpoint does not exist: every path and method answers 404 before
anything else is read, exactly as `/deploy` does. The name is added to the gateway-only list
(`src/config/gateway-only-env.ts`), so a node refuses to boot holding it and the agent child
never sees it. The token is never the node token or the deploy token.

**Request** (JSON, body capped at 4 MB):

| Field | Meaning |
|---|---|
| `dryRun` | `true` validates and reports; writes nothing. |
| `onConflict` | `skip` (default), `overwrite` or `fail`, per page. |
| `map` | Optional `{ "<from-source>": "<to-source>" }` overrides (§4.4). |
| `engine` | The bundle's `{ embeddingModel, embeddingDimensions }`. |
| `pages` | A batch of page objects as in §4.1 (at most 100 pages per request). |

**Refusals**, each a 4xx with a fixed message that names the cause and never echoes page text:

- brain disabled, or `SLAUDE_BRAIN_MODE=remote` (409);
- the persona is not live (`livePersona` throws `PersonaNotLiveError`), or has no Slack user id
  (409);
- `engine.embeddingModel` or `engine.embeddingDimensions` differs from the target brain's
  configuration (409): vectors of another width or model would silently degrade search, so the
  import refuses instead of re-embedding;
- a source in the batch is `kb-*` (422: out of scope, not silently skipped);
- an agent-like source with no mapping (§4.4) (422).

**Writes**, per page, on the local engine through the same trusted path the brain's other admin
work uses: `ensureSource(target)`, then `putPage` with the explicit source id, `upsertChunks`
with the carried embeddings, `addTag`, `addTimelineEntry` with the original dates,
`putRawData`, and `addLink` (endpoints remapped). A page is written whole or the batch reports
it failed; one page failing does not abort the batch.

**Response**: per target source `{ written, skipped, overwritten, failed, linksWritten,
linksDropped }`, plus the list of failed slugs (slugs only).

**Audit.** One log line per request: persona, the per-source counts, `dryRun`, `onConflict`.
Never page text, titles or slugs of user slices.

### 4.4 Source remapping

A page's `source` is rewritten to a target source before anything else:

| Bundle source | Target source |
|---|---|
| `agent`, `agent-default`, and any `agent-<id>` | `agent-<persona.slackUserId>` |
| `user-<slackUserId>` | unchanged |
| `shared`, `public` | unchanged |
| `kb-*` | refused (out of scope) |
| anything else | refused (no mapping) |

`persona.slackUserId` comes from the gateway's registry for `:persona`; the operator never types
it. `map` entries win over the table for the sources they name, so an operator can route an odd
source explicitly. Every mapped target must itself be one of: the persona's agent slice,
`user-*`, `shared`, `public`; a `map` that points at a `kb-*` source or at another persona's
agent slice is refused.

Several bundle sources can map to one target (for example `agent-default` and `agent-U0OLD`
both to `agent-U0NEW`). Slug collisions inside one target follow `onConflict`.

Link endpoints are remapped with the same table. A link whose target page is not in the
imported set (for example a link into a `kb-*` page) is **dropped and counted** in
`linksDropped`, never written dangling.

### 4.5 Conflicts

- `skip` (default): a page whose `(target source, slug)` already exists is left alone. This
  makes a re-run, or a resumed run, idempotent.
- `overwrite`: the page, its chunks, tags, timeline and raw data are replaced by the bundle's.
- `fail`: the first existing page makes that page fail (reported), nothing else is changed
  for it.

`shared` and `public` are the common case for collisions when several agents are imported into
one gateway: the first import wins under `skip`. The runbook states this and recommends
importing `shared` once, from the agent whose `shared` slice is the reference.

### 4.6 Import client: `bun run brain-import`

```
brain-import --gateway <url> --persona <name> [--token-env VAR] [--dry-run]
             [--on-conflict skip|overwrite|fail] [--map from=to ...] <bundle>
```

- The token is read from an environment variable (default `SLAUDE_BRAIN_IMPORT_TOKEN`), never a
  flag, so it is not in shell history or the process list.
- Verifies `manifest.json` and the sha256 of `pages.jsonl` before sending anything; a mismatch
  exits non-zero.
- Streams `pages.jsonl` in batches (at most 100 pages or 1 MB, whichever first).
- Retries a batch on a network error or 5xx with backoff; a 4xx stops the run with the
  gateway's message.
- `--dry-run` sends every batch with `dryRun: true` and prints the mapping and the counts.
- Ends by comparing the accumulated per-source counts with the manifest's inventory (after
  mapping) and **exits non-zero** on any mismatch other than pages the chosen `onConflict`
  accounts for.
- Refuses to start if the manifest holds an agent-like source that neither the table nor `--map`
  covers, so nothing is dropped or merged silently.

### 4.7 Safety

- The export never mutates the source brain (it reads a copy).
- The import never writes outside the target sources it derived; it cannot write `kb-*`.
- The token is gateway-only, constant-time compared, and absent unless the operator sets it. The
  runbook says to set it for the import and unset it afterwards.
- A user's slice is imported only under that user's own id and only by an operator-held token;
  nothing in the endpoint reads a slice back.
- Errors and logs name sources and counts, never page content.
- The runbook requires a Postgres backup of the brain database before the first non-dry run.

## 5. Components

| Unit | Does | Depends on |
|---|---|---|
| `src/brain-migrate/bundle.ts` | Bundle read/write, manifest, checksums, streaming | none |
| `src/brain-migrate/remap.ts` | Source mapping table, `map` overrides, validation | `knowledge/scope` |
| `src/cli/brain-export.ts` | Export command | `bundle`, gbrain engine |
| `src/cli/brain-import.ts` | Import client | `bundle`, `fetch` |
| `src/gateway/brain-import/api.ts` | The endpoint, auth, refusals | `remap`, brain engine, persona registry |
| `src/brain-migrate/apply.ts` | Writing one page to the engine, conflict policy | gbrain engine |
| `docs/site/_content/deploy/brain-migration.md` | Runbook | none |

`remap.ts` and `bundle.ts` have no I/O beyond files, so they test without an engine.

## 6. Error handling and edge cases

- **Export of a busy brain.** Reading a copy avoids PGLite's single-writer lock; the runbook
  still says to stop the writer first so the copy is consistent.
- **Embedding mismatch.** Refused, with both values in the message. The fix is operator-side:
  align `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS`, or re-export after re-embedding. The tool
  never re-embeds silently.
- **Pages without embeddings** (embedding was off in the old brain) import without chunks'
  vectors; the response reports the count, and the brain's own embed pass fills them later.
- **Soft-deleted pages** are not exported (the engine's default listing excludes them).
- **Large brains.** Batching bounds memory on both sides; `listPages` is read in pages of the
  engine's own cursor, not the 100 000-row cap the stock `migrate` command uses.
- **Resume.** Idempotent by construction under `skip`; no manifest of progress is kept.
- **Crash mid-batch.** A page is written whole or reported failed; re-running with `skip`
  finishes the rest. `overwrite` re-runs rewrite pages already written, which is safe.
- **Wrong persona.** The persona decides the agent slice, so the runbook tells the operator to
  run `--dry-run` first and read the printed target before applying.
- **Concurrent writers.** The persona's live sessions may write to its agent slice during an
  import; `skip` never overwrites them. The runbook recommends importing before the persona's
  Slack traffic is cut over.

## 7. Testing

- **Unit:** the remap table and `map` overrides (every row of §4.4, a `map` into a `kb-*`
  source, a `map` into another persona's slice); bundle round trip; a flipped byte fails the
  checksum; a manifest without `files` is refused.
- **Integration (PGLite to PGLite, endpoint in-process):**
  - an `agent-default` bundle lands in `agent-<slackUserId>` with chunks, embeddings, original
    timeline dates, tags and links intact;
  - `user-<id>` pages keep their source id and appear in no other slice;
  - a `kb-*` page in a bundle is refused (422), and the default export excludes them;
  - a re-run under `skip` writes nothing and reports everything skipped;
  - `overwrite` replaces and `fail` reports;
  - an embedding model or dimension mismatch is refused with nothing written;
  - a persona that is not live, or has no Slack user, is refused;
  - brain disabled and remote mode are refused;
  - a link into a page outside the set is dropped and counted;
  - unset token: every method and path 404s; a wrong token 401s.
- **Security:** the new variable is on the gateway-only list (node boot refuses it, the child
  scrub removes it, `.mcp.json` placeholders do not expand it); error bodies and the audit line
  contain no page text.
- **Client:** the batching boundary, retry on 5xx, stop on 4xx, and the final count comparison.

## 8. Rollout

This adds a route and two CLIs and changes no schema, queue or agent-loop behaviour. It ships in
the next minor release as a normal release (not a release candidate): the route does not exist
unless `SLAUDE_BRAIN_IMPORT_TOKEN` is set. Release notes link the runbook.

## 9. Open items the implementation plan resolves

- The exact engine calls for writing a page with explicit chunks and embeddings in one
  transaction (the stock `migrate` uses `putPage` then `upsertChunks`; the plan checks whether a
  transactional form exists in the pinned `gbrain`).
- Whether the bundle compresses (`pages.jsonl.gz`) by default; deferred unless real bundles are
  large enough to matter.
