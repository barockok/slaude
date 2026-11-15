---
title: "Test suite: a skipped file leaked SLAUDE_BRAIN_DISABLED=1 into the brain tests"
date: 2026-11-16
---

# Test suite: a skipped file leaked SLAUDE_BRAIN_DISABLED=1 into the brain tests

**Date:** 2026-11-16
**Status:** Fixed on branch `fix/brain-pglite-flake` (tests and test helpers only).

## Symptom

The `typecheck + tests + coverage` job and the release workflow failed on
many runs with the same tests, then passed on rerun:

- `/brain-import against a real brain` (both tests)
- `a link to a page in a later batch is dropped first and healed within the same command`
- `mono default slice -> gateway persona: memory remains` (1 to 9)

The error in the logs was `gateway refused the batch (409): the brain is
disabled on this gateway` and, for the mono scenario, an empty search and
`agentSource` null. It looked like the slow-brain cliff of the 2026-11-09 note,
but nothing timed out and no brain was slow.

## Cause

Those tests need a brain that is on. `brainEnabled()` is
`process.env.SLAUDE_BRAIN_DISABLED !== "1"`, so any earlier file in the same
bun process that left it at `1` turns them off. `tests/node/worker-e2e.test.ts`
did: it set `SLAUDE_BRAIN_DISABLED=1`, `SLAUDE_AUTO_EVOLVE=0` and
`SLAUDE_IDLE_MINUTES=0` at the top level of the file, and unset the first one at the
end of an `afterAll` that returns early when no Redis is configured. The CI
coverage job has no Redis, so every test in the file is skipped. Bun still loads
the top level of a file whose tests are all skipped, and it runs no `afterAll`
for it. The value stayed set until some later file deleted it.

Bun's file order differs from run to run, so whether a file that deletes it ran
between the leak and the brain tests changed per run. That is the flake: the
same 12 tests fail or pass depending on the order.

Reproduced locally with no Redis:

- `bun test tests/node/worker-e2e.test.ts tests/gateway/brain-import
  tests/brain-migrate/scenario-mono-to-gateway.test.ts`: 10 fail (the 9 and
  the 3 of the list above that fail with a disabled brain), every run.
- `SLAUDE_BRAIN_DISABLED=1 bun test tests/brain-migrate tests/gateway/brain-import`: the same 10.

Two of the 12 (mono 1 and 2) failed in CI but pass here with only
`SLAUDE_BRAIN_DISABLED=1`; they failed in the CI order with some other leaked
setting. The helper below also clears `SLAUDE_BRAIN_MODE`. That part is not
proven.

## Fix

- `worker-e2e.test.ts` sets its three variables only when the suite is armed
  (a Redis is configured), and restores all three in `afterAll`.
- `tests/helpers/brain-on.ts` (`brainOn()`): a file that needs a local brain on
  clears `SLAUDE_BRAIN_DISABLED` and `SLAUDE_BRAIN_MODE` for its tests and
  puts them back after. Used by the brain-import and mono scenario files, so a
  leak from any other file cannot fail them.

A test file that sets an env var at its top level leaks it when all its
tests are skipped, because no hook runs for it. Set it in `beforeAll` (or only
when the suite is armed) and restore it in `afterAll`.

## Second leak: the cached brain backend (mono scenario 1 to 9)

After the fix above the 9 mono scenario tests still failed in the CI job.
`getBackend()` (`src/knowledge/backend.ts`) caches one backend per process.
A file that stubs it with `setBackendForTest`, or resolves it under
`SLAUDE_BRAIN_MODE=remote`, and does not reset it, makes every later brain call
come back from that backend: the seed writes straight to the engine, then
`search` returns nothing (test 1 at the search, the rest cascade). A file with
a stubbed backend left in place reproduces all 9 failures with the CI
signature (`bun test <stub file> tests/brain-migrate/scenario-mono-to-gateway.test.ts`:
1 pass, 9 fail). I could not name the one CI file that leaves it: no single
file that touches the backend or `SLAUDE_BRAIN_MODE` fails when run just before
the scenario.

- `brainOn()` now also resets the backend before and after the file, and
  `useBrain` (scenario-steps) resets it before every brain switch.
- `tests/env-leak-guard.test.ts` fails, naming the file, for a gated test file
  that assigns a brain env var at its top level, and for a file that stubs the
  backend without resetting it. Bun cannot run a preload hook per file, so a
  runtime per-file check is not possible; this is a static check.
