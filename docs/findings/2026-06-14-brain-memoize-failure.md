# 2026-06-14 — Brain memoize: two failure modes break "remember it"

**Theme:** brain memoize — the remember / think / explore → persist-to-brain →
recall-it-later loop.

**Status:** root cause confirmed; both modes **fixed** (2026-06-14). See "Fix
landed" at the end.

## Summary

Three UAT cases, **two distinct failure modes**, same user-visible symptom
("I told you to remember this, but you don't know it"):

- **Mode A — write never lands (Case 1).** `kb_put_page` FK-fails on an
  un-bootstrapped source; agent silently degrades to file writes; `trigger_ingest`
  never runs. The lesson is genuinely absent from the brain.
- **Mode B — write lands, recall misses (Case 2).** `kb_put_page` succeeds and
  the page is indexed, non-stale, in the right scope — but `kb_think` returns a
  zero-citation "not captured" on a verbose NL query, while a tight-keyword
  `kb_search` finds it at rank 1. The lesson is present but the agent reports it
  missing.

Mode A is a write defect (`src/knowledge` source bootstrap). Mode B is a
retrieval defect (gbrain `kb_think` recall + no think→search fallback). Fixing
only one leaves the symptom alive.

---

# Case 1 — Mode A: ingest silently fails, recall stays thin

## Trigger

UAT thread `amartha.slack.com/C0B2SL1LUTS/1781076888.704939` (hermes-uat, agent
"Maria"). Gabbar asked Maria to pull ITGC audit history from GDrive and
"memoize" it into her brain. Later DM (`D0AKKK79DT8/1781412338`) probed recall:
"who is Gabbar, purely from brain" → Maria returned a one-line stub. Operator
(barock) flagged the whole remember/think/explore experience as not optimal and
shipped the session JSONL (61 files, session dir
`-data-workspaces-T1WTF90DS-C0B2SL1LUTS-1781076888-704939`) for forensics.

## What happened (traced from JSONL, not the Slack surface)

The 06-14 ingest session (`50555749-…jsonl`) ran this chain:

```
gather  → workbench google_sheets_read ×2   (only 2 ranges — thin coverage)
store   → kb_put_page ×4   →  ALL FAILED
          "insert or update on table \"pages\" violates foreign key
           constraint \"pages_source_id_fkey\""
fallback→ Write raw/*.md + episodic memo project_itgc-ingestion.md
          ("NOT yet ingested into brain — manager to decide")
ingest  → trigger_ingest NEVER CALLED
result  → zero brain pages for ITGC → recall is a thin stub
```

A separate 06-10 session (`11abec57-…jsonl`) proves the pipeline works when
driven correctly: `trigger_ingest` → "ingested 2 raw file(s); 3 wiki pages
changed; pushed 615b33c". So the machinery is sound; this session bypassed/broke
it and **degraded silently** — neither Maria nor the user got a signal that the
brain write hard-failed and the task was incomplete.

The episodic memory layer captured the fallback correctly but recorded
"NOT yet ingested" as if it were a clean checkpoint, masking the failure.

## Why recall is thin (the user-visible symptom)

The facts about Gabbar/ITGC never became queryable knowledge. They live in:
- `raw/itgc-*.md` (staged, never ingested into the wiki index), and
- a *status memo about pending work* (`project_itgc-ingestion.md`),

not as `entities/*` or `concepts/*` pages the brain can `kb_think` over. "Who is
Gabbar" therefore returns one stub line after a whole session about him.

## Mode-A defect (write side) — ROOT CAUSE CONFIRMED

**Every `kb_put_page` inside a `/1on1`-locked thread FK-fails, because per-user
brain sources are never created.**

Confirmed against the live UAT brain (PGLite snapshot, 2026-06-14):

- The `sources` table holds exactly `agent`, `default`, `public`, `shared`, and
  one `kb-<label>` per installed KB (incl. `kb-maria-memory`, 5 pages — so the
  KB source bootstrap is *fine*; the earlier "missing maria-memory source"
  hypothesis was **wrong**). There are **no `user-*` rows**.
- `resolveBrainScope` (`src/knowledge/scope.ts:56-63`): when a thread is
  `/1on1`-locked and the lock owner is the caller, write scope becomes
  `sourceId = userSourceId(userId)` → e.g. `user-u06ensb6pv0…`.
- `userSourceId()` is only ever used to *set the write target* (`scope.ts:58`)
  and *classify the gate* (`gated-dispatch.ts:41`). **Nothing inserts that
  source.** `ensureSources()` (`brain.ts:275`) only bootstraps
  `baselineSources()` = agent/shared/public + `kb-*` (`brain.ts:263`); no
  per-user source is registered at boot, at lock time, or on write.
- The 06-14 ITGC thread was `/1on1`-locked (lock + engage markers in the
  session JSONL). So the write hit `user-<barock>` → not in `sources` →
  `pages_source_id_fkey` violation, ×4.

**Control:** the Case 2 jot lesson (06-11) was *not* locked, so it scoped to
`shared` (which exists) and wrote cleanly. Same agent, same channel — the only
difference is the `/1on1` lock. That isolates the cause precisely.

So `kb_put_page` works in normal channels and breaks in exactly the place you'd
most want durable memory — a focused 1:1 "remember this" session.

Compounding (same as before): the raw Postgres FK error leaks to the agent
(`src/knowledge/mcp-tools.ts:138`), and no stop-guard catches "intent was a
brain write, zero pages changed" — so Maria degraded to file writes and reported
a clean checkpoint.

### Fix (Mode A)

Register the user source before it's written. Cleanest options, in order:
1. In `gatedBrainCall`/`kb_put_page`, ensure `scope.sourceId` exists before the
   op (lazy `sources_add` for `user-*`), then insert. Covers every path.
2. On `/1on1` lock acquisition, call `ensureSources([userSourceId(owner)])`.
3. Have `resolveBrainScope`'s user-source branch be backed by a guaranteed
   registration step.
Plus: map FK/brain errors to actionable text; stop-guard for failed-intent
brain writes.

---

# Case 2 — Mode B: write lands, retrieval misses

## Trigger

Same lesson, two threads, three days apart:

- **Thread `C0B2SL1LUTS/1781143233` (2026-06-11) — write confirmed.** Operator:
  "patri ini in your brain, do't make the same mistake in the future" (etch this
  in). Maria wrote it via a single `kb_put_page`:
  - slug `lessons/jot-deployment-pattern`, KB `lending-business`
  - tool_result: `{status:"created_or_updated", chunks:2, write_through:{written:true,
    path:".../lending-business/.sources/shared/lessons/jot-deployment-pattern.md"}}`
  - **No FK error, no `trigger_ingest` needed** (synchronous write-through),
    no fallback. Maria: "Sudah diukir tajam di brain." Mode A did not occur here.

- **Thread `C0B2SL1LUTS/1781168759` (2026-06-14) — retrieval missed it.**
  Operator: "what lesson you learn on deploying dashboard with jot to workbench?"
  Maria ran `kb_think` ("What lessons were learned about deploying dashboards
  with jot to workbench?") → result: *"The brain does not contain information
  about lessons learned…"*, diagnostics `pagesGathered:40, takesGathered:0,
  graphHits:0, citations:[]`. Maria replied **"Not captured yet."** User: 😞.
  Only when the operator explicitly said "kb search jot deployment" did Maria run
  `kb_search "jot deployment"` → **1 hit, rank 1, score 1.083**, slug
  `lessons/jot-deployment-pattern`, page_id 2443, `stale:false` → **"Found it!"**

## What this proves

The page was present the whole time — indexed, non-stale, in the `shared` scope
both tools hit. Not ingest lag, not wrong KB, not slug mismatch, not an
unopened KB. The defect is **retrieval**:

- `kb_think`'s hybrid retriever gathered 40 candidate pages on a verbose NL query
  ("deploying **dashboards** with jot to workbench") and the target page
  ("Jot Deployment **Pattern**", about web artifacts) **didn't make the top-40
  set** — swamped by dbt-stub noise; `takesGathered:0, graphHits:0` so graph and
  takes paths contributed nothing. The synthesizer then *truthfully* answered
  "not in the brain" from an impoverished candidate set.
- `kb_search` with the tight keyword "jot deployment" lexically matched the title
  and hit rank 1 instantly.

## Mode-B defect (retrieval side)

1. **`kb_think` recall miss → false "not captured."** A zero-citation think
   result is reported to the user as authoritative absence. The page exists and
   is trivially findable by keyword. (gbrain `kb_think` retrieval — candidate-set
   truncation / ranking on long NL queries.)
2. **No think→search fallback.** When `kb_think` returns empty/zero-citation, the
   agent should auto-retry with extracted keywords via `kb_search` before
   declaring absence. Today it gives up. `src/knowledge/brain-think.ts` +
   `src/knowledge/mcp-tools.ts` (`kb_think` handler).
3. **`kb_think` is the default recall verb but has worse recall than `kb_search`
   for known-item lookup.** The tool description steers the agent to `kb_think`
   ("prefer this over kb_search when you need an answer"), which is exactly wrong
   for "do I have a note on X" — a known-item query where keyword search wins.

---

# Cross-cutting

## Brain/memory tool surface (observed)

- `mcp__slaude_kb__`: `list_kbs`, `open_kb`, `kb_list_pages`, `kb_get_page`,
  `kb_put_page`, `kb_delete_page`, `kb_search`, `kb_think`, `kb_graph`
- `mcp__slaude_runtime__trigger_ingest` (raw → wiki pipeline)
- episodic memory = plain `Write` to `…/memory/*.md`
- write-through: `kb_put_page` writes synchronously to
  `…/<kb>/.sources/<scope>/<slug>.md` (no separate ingest when it works)

## Fix direction (NOT yet implemented — collecting cases)

**Write side (Mode A):**
- `kb_put_page` lazily ensures its source exists and retries once on FK error
  after re-running `ensureSources`.
- Map brain/Postgres errors to actionable text; never let a raw FK message reach
  the agent.
- Stop-guard: a turn whose intent was a brain write but changed zero pages must
  not exit reporting success.

**Retrieval side (Mode B):**
- `kb_think` zero-citation → automatic `kb_search` keyword fallback before the
  agent reports "not captured."
- Reconsider the `kb_think`-first steer for known-item lookups; route
  "do I have X / what did I learn about X" to `kb_search` (or a hybrid that runs
  both and merges).
- Investigate `kb_think` candidate-set truncation (top-40 gather + ranking) so a
  present page isn't crowded out by stub noise.

## Open questions

- Mode A: RESOLVED — reproducible on every `kb_put_page` inside a `/1on1` lock
  (per-user source never registered). Decide which fix layer (lazy-ensure in the
  write path vs. ensure-on-lock).
- Mode B: is the recall miss query-phrasing-specific, or does `kb_think`
  systematically under-rank `lessons/*` and `entities/*` pages vs dbt stubs?
- Provenance: tag pages `source: ingested|explored|seeded` so the operator can
  audit what was actually learned vs seeded.

## Fix landed (2026-06-14)

- **Mode A** — `brainCall` now calls `ensureSource(scope.sourceId)` before any
  scope-write op (`src/knowledge/brain.ts`; `isScopeWriteOp` added to
  `src/knowledge/gated-dispatch.ts`). `ensureSource` idempotently `sources_add`s
  the source (swallows source_id_taken / duplicate), cached per id. A `/1on1`
  write to `user-<id>` now self-registers instead of FK-failing. Verified live:
  `sources` confirmed to hold no `user-*` rows; control = unlocked write to
  `shared` already worked.
- **Mode B** — `kb_think` falls back to keyword `kb_search` when synthesis
  returns zero citations, attaching `search_fallback` hits, so a present page is
  never reported "not captured" (`src/knowledge/mcp-tools.ts`).
- Tests: `tests/brain.test.ts` (Mode A: put_page auto-ensures an un-bootstrapped
  user source), `tests/brain-mcp-tools.test.ts` (Mode B: zero-citation →
  fallback; citations present → no fallback). Full suite 987 pass, tsc clean.
- **Not yet done** (lower priority): actionable FK→agent error mapping;
  failed-intent brain-write stop-guard; deeper `kb_think` candidate-set ranking.

## 2026-06-15 update — deeper investigation (live UAT brain)

Followed three more recall complaints to the live UAT brain (PGLite snapshot +
ArgoCD exec, read-only). This corrected several earlier guesses.

### Confirmed via live DB

- **Mode C (scope silo) is real:** a `/1on1` memoize lands in `user-<id>`, which
  a normal-channel recall (scope = `shared`+`public`+`kb-*`) cannot read. The
  OKR pages existed in BOTH `user-u06enbs6pv0` (from the `/1on1`) and `shared`
  (from a later manual re-memoize). The operator had to re-memoize to get them
  recallable — friction worth removing (default `/1on1` memoize to `shared`?).
- **Mode D (embedding gap) RULED OUT:** every chunk is embedded
  (`zeroentropyai:zembed-1`, 3442/3442, `missing=0`), vectors are a consistent
  **1280-dim**, and an HNSW cosine index exists. Embeddings are healthy.
- **Embedding config bug (latent):** `values.yaml` sets
  `EMBEDDING_DIMENSIONS=2560` but the actual column/vectors/index are **1280**
  (zembed-1 native). Works by luck (doc + query both 1280); if any path ever
  honors 2560 for the query, recall breaks. Fix: set `EMBEDDING_DIMENSIONS=1280`
  in `deploy-hermes/agents/maria/uat/values.yaml`.
- **The real recall bug is `kb_think` ranking, not storage.** `gather.ts`
  already does hybrid (vector + keyword + RRF). A rich (3054-char), well-titled
  (`notes/amartha-2026-company-okr` → "Amartha 2026 Company OKRs"), embedded,
  in-scope page still lost the rank race to many BU/dbt OKR pages, and the LLM
  produced a confident non-empty answer from neighbors — so the zero-citation
  fallback (above) never fired. Verbose query dilutes; the jot case proved a
  tight `kb_search` keyword hits rank 1 where full-question `kb_think` misses.
  Levers: query distillation (verbose → keywords) [highest-confidence],
  title/slug match boost, larger `gather_limit`. Decide retrieval-fix vs
  synthesis-fix once the recall jsonl confirms gathered-but-ignored vs
  not-gathered.
- **Maria misdescribes her own mechanics.** She told the operator memoize
  "writes a local file, not indexed, needs `/ingest`." False — `kb_memoize` →
  `put_page` upserts the gbrain DB (chunk+embed) directly; the `.sources/*.md`
  write-through is an inert byproduct. Worth a soul/skill note so she stops
  asserting the wrong model.

### Storage model (confirmed)

gbrain DB is the single retrieval source. Boot/nightly `syncKbWikis` index the
git `wiki/` dirs into `kb-*` sources; runtime memoize writes `shared`/`user-*`
sources directly; all recall reads the DB. Nightly sync targets `kb-*` only, so
it never reconciles/wipes memoized pages, and it reads `wiki/`, never the
`.sources/` write-through mirror.

### Follow-ups

- **Durability gap (memoized knowledge has no git backup).** Seed KBs survive a
  DB wipe (re-sync from git `wiki/`). Memoized `shared`/`user-*` pages live ONLY
  in the PVC gbrain DB — the `.sources/*.md` write-through is **never
  re-imported** by sync (sync reads `wiki/`), so it is not a real backup. If PVC
  durability is insufficient, add a real backup path: nightly export memoized
  `shared`/`user-*` pages into a git-backed writable-KB `wiki/` so sync
  round-trips them. (This also reframes the "remove write-through" request:
  removing the mirror loses nothing for recovery — it was already inert.)
- **`open_kb` removed** (2026-06-15, branch `refactor/remove-open-kb`): it was
  the last KB tool that `readFileSync`'d local markdown at runtime; capability
  covered by DB-backed `kb_list_pages`/`kb_get_page`/`kb_search`. Every KB tool
  now sources purely from the gbrain DB.
- Memoize DB-only (drop write-through): cosmetic now that the mirror is known
  inert; needs gbrain `write_through:false` (SHA-pinned dep → fork/patch).
- `EMBEDDING_DIMENSIONS` 2560 → 1280 in deploy-hermes values.

## Artifacts

Session JSONL retained locally (gitignored, not committed):
- `jsonl/thread-1781076888/` — Case 1 (Mode A). `50555749-…` = the FK failure,
  `11abec57-…` = a working ingest reference.
- `jsonl/thread-1781143233/` — Case 2 write. `26ecbaef-…` = the successful
  `kb_put_page` of `lessons/jot-deployment-pattern`.
- `jsonl/thread-1781168759/` — Case 2 retrieval. `52b01ab2-…` = `kb_think` miss
  then `kb_search` hit.
