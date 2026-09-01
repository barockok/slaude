# 2026-06-15 — Per-source `gather()`: fix bulk-corpus retrieval noise drowning curated pages

**Status:** Implemented (slaude-side wrapper), tested. Upstream promotion to
gbrain is a separate follow-up (see "Promotion" below).

## Symptom

"Same question, different answer." In a warm-context thread, a directory lookup
("who is the lead of team X") resolved to the right person. In a cold thread the
same question → *"the brain does not contain that data."* Reproduced
cold-vs-warm cleanly.

## Diagnosis (traced from session jsonl + live brain)

Two layers, one root.

1. **Warm context masks the bug.** A long thread loads the curated directory
   page early (an earlier lookup), and it stays in the conversation window — so
   later role questions are answered from context with **zero KB calls**
   (verified: the answer fired only a `reply`, no `kb_*`). A cold thread starts
   empty every time and is forced through retrieval.

2. **The cold retrieval is poisoned by a bulk auto-generated corpus.** That
   source holds thousands of near-empty `# model / no documented columns` stubs.
   On any **common domain-word** query they score high base-vector and **fill
   the candidate gather by sheer volume** — a live `kb_think` gathered 25 pages,
   *all 25 bulk stubs*; the curated page never entered the pool, so the reranker
   (which correctly tanks the stubs to ~0.06) never got to sort it up. Proof
   it's volume, not scope: in the *same* thread, a distinctive-token query (a
   rare name no bulk model is named after) hit the curated page at rank 1
   instantly.

So: distinctive-token queries work anywhere; common domain-word queries fail
anywhere (even warm, if context were empty). Warm threads just rarely fire a
cold domain-word query.

## Root cause

gbrain pools **all** allowed sources into ONE ranked candidate set (the `search`
op and `think`'s internal gather both do). A high-volume source monopolises the
gather before the reranker runs. Per-source representation is not guaranteed.

## Fix — slaude-side per-source `gather()`

`src/knowledge/gather.ts`: fan out one `search` per allowed source
(single-source scope each), take top-K from **each**, merge + re-rank the union
by gbrain's own `rerank_score`. Every source — including small curated ones — is
guaranteed K candidate slots; no source can monopolise by volume. The reranker
then sorts the stubs down and the curated page up.

- `kb_search` → routes through `gather()`.
- `kb_think`'s zero-citation cross-check (#38) → uses `gather()` (per-source)
  instead of a single pooled `search`, so the uncited present page actually
  surfaces in `search_fallback` rather than more bulk-corpus junk.
- gbrain stays **stock** (`github:garrytan/gbrain#03ffc6e`) — we only orchestrate
  its `search` op. No fork.
- Total-failure posture: a single source failing drops to `[]`; if **every**
  source fails the brain is down, so `gather` rethrows → handler maps to an
  error (never papers over a dead brain with empty results — cf.
  [2026-06-14-brain-memoize-failure.md]).

## Known limitation (follow-up)

`kb_think`'s **primary** gather is inside gbrain's `runThink` — the slaude
wrapper can't reach it, so the synthesis still gathers pooled. Today the
per-source cross-check rescues the answer via `search_fallback`; the full fix is
to re-point `kb_think`'s candidate step at the shared `gather()` (compose
gbrain's `renderPagesBlock` + prompt builders + the SDK synth client). Deferred:
higher risk (faithful think-prompt reproduction), to be proven separately.

## Promotion

This slaude wrapper is the proving ground. Once validated in prod, promote
per-source ranking **upstream to gbrain** (`gather.ts` / the `search` op) so it
heals back into the dependency and both entry points gain it natively.

## Tests

`tests/gather.test.ts` — deterministic injected-call units (fan-out,
flood-survival, dedup-by-slug, finalLimit+sort, score fallback, single-source
fallback, partial-failure tolerated, total-failure rethrows) + one self-contained
real-gbrain smoke. `tests/brain-mcp-tools.test.ts` updated for the new
`kb_search` contract (returns gathered hits; fans out per source). Full suite:
1024 pass / 2 fail, both pre-existing env flakes (embedding-gateway env present
in this pod; OAuth loopback fake-IdP) — confirmed failing on pristine `main`.
