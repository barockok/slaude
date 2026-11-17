---
title: "Test suite: fresh PGLite brains past the cliff, and brain homes left pointing at deleted dirs"
date: 2026-11-09
---

# Test suite: fresh PGLite brains past the cliff, and brain homes left pointing at deleted dirs

**Date:** 2026-11-09
**Status:** Fixed on branch `fix/test-suite-load` (tests and test helpers only).

## Symptom

CI and the release workflow failed now and then on main with
`scenario transcripts > runs cron-authz.yaml green` timing out at 5 s
(taken 19 to 27 s). It is the first test in `tests/gateway/sim/scenarios.test.ts`.
The CI log shows the brain's migration banner (`Schema version 1 → 115`) inside
that test: its gateway booted a fresh brain.

## Mechanism

Every test file runs in one bun process (`--parallel=1` is not a bun 1.3.11
flag). A fresh brain is a PGLite initdb in gbrain's copy of PGLite (0.4.3),
then 110 gbrain migrations. Early in the process an initdb takes about 1 s.
Past a point it jumps to 12 to 21 s and stays there for every later fresh
brain. The point depends on what the process ran before, fresh brains above
all:

- 13 brain test files run alone, in suite order: initdbs 1 to 14 took 0.9 to
  1.9 s, the 15th 15 s.
- The full suite on main: brain initdbs 1 to 15 took 0.9 to 2.6 s, then 14.4 to
  21.4 s for all 15 that followed.
- A loop of 30 bare initdbs (no migrations, no coverage) grew slowly (1.5 to
  9 s); 60 opens of a copied data dir stayed at 0.15 to 0.2 s.
- slaude's own PGLite (0.5.7, the DB facade) did not slow down: its 21 initdbs
  stayed at 1 to 5 s after the brain's had gone to 15 s.

Raising JavaScriptCore's JIT memory reservation
(`BUN_JSC_jitMemoryReservationSize=3221225472`) moved the jump from 15 s to
about 5 s on the same 13-file run, so exhausted executable memory (WebAssembly
falling back to a slower tier) is the likely cause. That is not proven and
not what the fix relies on.

Two things put the suite past the point:

1. **Fresh brains per file.** About 20 test files (and the brain-migrate
   helpers) booted a brain into a new temp dir, some several per file: 30 fresh
   brains in a local full run. In CI's file order the scenario file's was the
   32nd.
2. **Brain homes left pointing at deleted dirs.** Six files set
   `SLAUDE_BRAIN_HOME` to a temp home, deleted it in `afterAll`, and left the
   variable set. Every gateway that a later file started then booted a fresh
   brain into the deleted dir. Locally that is what made
   `expect_natural_voice step > passes on a clean stub reply` (sim voice-lint)
   take 25.8 s and fail.

## Fix

- `tests/helpers/brain-template.ts` (the rc.5 guard test's template, moved and
  shared): one template brain per embedding setup per process; a test gets a
  copy of its data dir (`freshBrainHome`, `seedBrainHome`). Opening a copy
  skips initdb and the migrations.
- The brain test files, the brain-migrate helpers (`seedMonoBrain`,
  `useBrain`), the brain-import tests and the scenario file use copies. A test
  about the first boot itself (`brain-exit-code`) keeps a fresh dir.
- The six files unset or restore `SLAUDE_BRAIN_HOME` when they delete the home.

## Result (CI-style `bun test --coverage --parallel=1`, local)

| | before | after (two runs) |
|---|---|---|
| fresh brain initdbs | 30 (15 of them at 14.4 to 21.4 s) | 5 (0.8 to 1.7 s) |
| first scenario | 27.4 s in CI (timeout) | 0.015 s |
| sim voice-lint clean stub reply | 25.8 s (fail) | 3.1 s |
| suite wall time | 1022 s | 554 s, 537 s |

A new test that needs a booted brain should take a template copy. One that
points `SLAUDE_BRAIN_HOME` somewhere must restore it.
