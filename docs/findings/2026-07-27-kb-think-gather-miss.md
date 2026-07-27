# kb_think gather miss — runThink vs gather() source scoping

**Date:** 2026-07-27
**Symptom:** `kb_think` returns `pagesGathered: 0` ("nothing in KB") for a project that
exists. `kb_search` with the same entity name finds it immediately with `evidence: "high_vector_match"`.

## Root cause

Two separate issues compound:

### 1. runThink uses gbrain's pooled search (sourceId-anchored)

`brainThink` calls gbrain's `runThink` with:
```
sourceId: scope.sourceId       // current agent's slice
allowedSources: [slice1, ...]  // allowed filter
```

gbrain's internal gather anchors its vector search to `sourceId`, then applies `allowedSources`
as a post-filter. Pages stored under a *different* source (e.g. `agent-<other-id>`) are
not found even when they're in `allowedSources`, because the vector index is searched from
the wrong anchor.

`gather()` bypasses this: it fires one `brainCall("search", ...)` **per source** with
`sourceId = that source`. Each source is searched within its own vector space. No source
is skipped because of a mismatched anchor.

### 2. Cross-check swallowed exception on first call (transient)

The cross-check guard in `kb_think` runs `gather(distillQuery(question), scope)` after
`runThink`. If `gather` finds pages not cited by the synthesis, they appear as `search_fallback`.

On the first call after service restart, the cross-check threw (embedding gateway cold-start /
first-call initialization) and the `catch {}` swallowed it silently. The agent received a clean
`pagesGathered: 0` result and said "nothing in KB" — a false negative that eroded user trust.

## Fix (shipped in this PR)

**`src/knowledge/mcp-tools.ts`:**

1. **Log the cross-check exception** instead of silently catching it, so the failure is
   visible in journal logs and diagnosable.

2. **Rescue synthesis when `pagesGathered === 0` and cross-check finds pages.** When
   `runThink` gathers nothing but `gather()` surfaces hits:
   - Format the fallback pages as a context block
   - Call `sdkThinkClient` directly with `question + context`
   - Return the synthesized answer with `gather_rescue: true` flag
   
   This converts a false-negative "nothing in KB" into a real answer, using the same SDK
   auth path as the normal synthesis. The `search_fallback` field is still included so
   callers can see what pages were used.

## What is NOT fixed

`runThink`'s internal gather still misses. The rescue is a slaude-side workaround — the
underlying gbrain `allowedSources` scoping issue needs an upstream fix in gbrain. Until
then, `gather_rescue: true` in the response signals that runThink's gather was bypassed.

## Embeddings

This investigation also confirmed that without embeddings (`EMBEDDING_MODEL` / `ZEROENTROPY_API_KEY`
not set), `kb_think`'s keyword-only fallback is query-length-sensitive: short slug-form
queries ("projects/guestcrm") hit, long NL queries ("What is the guestcrm project?...") miss.

**Resolution:** ZeroEntropy `zembed-1` configured in `data/.env`. `brain/config.json` written
on next boot. All searches now use hybrid (vector + keyword + graph).

## Verification

```
kb_think("What is the guestcrm project?...")
→ Before: pagesGathered: 0, no search_fallback (cross-check exception swallowed)
→ After:  gather_rescue: true, answer synthesized from projects/guestcrm page
```
