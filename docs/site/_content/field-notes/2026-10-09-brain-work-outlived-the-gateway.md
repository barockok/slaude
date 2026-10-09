---
title: "Brain work that outlived its gateway, and PGLite writing the exit code"
date: 2026-10-09
---

**Finding:** PGLite and sim tests failed or stalled when run back to back in one `bun test` process. Each file passed on its own. The cause was not PGLite instances leaking between files. It was brain work that `createGateway()` starts and that nothing owned. Every gateway started the brain's source bootstrap and KB wiki import in the background, and armed a nightly maintenance timer. `stop()` returned while that work was still running. Many tests never call `stop()` at all. All test files share one process, so one test's import ran on into later tests and files. Separately, PGLite's Emscripten runtime writes the exit status of its WASM programs into `process.exitCode`. That is the "bun 1.3.11 exits 99 with zero failures" quirk the CI workflow had been tolerating.

## The mechanism

- `createGateway()` ran `ensureSources().then(syncKbWikis)` as fire-and-forget, plus `scheduleNightlyMaintenance()`, whose cancel function it discarded. The brain is a process-wide singleton (gbrain's PGLite, file-backed under the brain home). The import runs `git` synchronously and imports pages through WASM, so while it runs the event loop stalls.
- Test files installed KB fixtures into the shared test home and never removed them (`persona-kb`, `kb-scope`, `kb-loader`). From then on, every gateway in the run imported those KBs. A file that creates several gateways, such as `sim/mcp-connect` with 12 and no `stop()`, started several imports at once. They contended on gbrain's sync lock ("Another sync is in progress") and spilled into the next file. That file was `sim/transcript`, which matches the reported stall location: the last lines were the next gateway's `[slack-auth]` diagnostics.
- A brain test's `closeBrain()` disconnected the engine while an earlier file's import still held it. The import then failed ("PGLite not connected"), or it booted a new brain in whatever `SLAUDE_BRAIN_HOME` was current.
- Under CPU contention, for example when several suite runs share a machine, the stalls stack on top of PGLite's own cost of about 1 s per open. Three concurrent full runs reproduced the reported failures: `node-token` "revoke" timed out at 5000 ms, `migrate-sqlite` took 7.3 s, and `transcript > fails a transcript whose assertion does not hold` took 21-22 s in all three runs, with KB import output printed inside it.

## Evidence

- Minimal repro: run a file that installs KBs, then `tests/gateway/sim/transcript.test.ts`, then a probe file that measures event-loop lag. Before the fix, the probe file showed brain sync output, lock-contention errors, a worst event-loop stall of 1350 ms, and the process exited 99 with 0 failures. After the fix, the same order (with `mcp-connect` added) shows no brain output in the probe file, a worst stall of 5 ms, and exit 0.
- PGLite open time does not grow with the number of instances: 25 open+migrate+close cycles in one process held at about 0.8-1.5 s each. External memory plateaued; it did not climb. So "instances not closed" was ruled out. The slaude test files that open PGLite do close it.
- The exit code, measured directly. gbrain's PGLite (0.4.3) sets `process.exitCode` to 99 when it opens and to 100 after any SQL error, and its close sets 0. slaude's PGLite (0.5.7) sets 0 on open and close, which would also hide a real non-zero code. Its SQL errors leave the code alone. The source is Emscripten's `quit_` handler (`process.exitCode = status`). After the fix below, a probe preload that logged every change to the exit code between tests found three writers in a full run: brain-migrate's export engine, which left 1 (now fixed), and the `brain-migrate/apply` tests that roll back a transaction on purpose, which leave 100.
- `--parallel=1` is not a `bun test` flag in 1.3.11. Bun accepts unknown flags without an error, and test files always run one after another in a single process. The CI comment that credits it with serializing files is wrong.

## The fix

- `src/knowledge/brain-work.ts`, a registry of background brain jobs. `closeBrain()` waits for tracked work before it disconnects. `syncKbWikis` stops before its next KB while a close is waiting, so a close never waits for a full import.
- The gateway tracks its bootstrap. `stop()` cancels the nightly timer and waits for the bootstrap, as a close would.
- `tests/setup.ts` adds a global `afterEach` that settles tracked brain work. This is the shared teardown for the many tests that never stop their gateway. It does nothing when no work is in flight.
- The three test files remove their KB fixtures.
- Every PGLite open and close (slaude's driver, the brain engine, and brain-migrate's export engine) restores the `process.exitCode` it found. Bun ignores `process.exitCode = undefined`, so the helper restores 0 in that case. A process that boots a brain and fails nothing now exits 0. Queries are not wrapped, so a brain SQL error still leaves 100, and a full test run still exits 100 with zero failures. CI's tolerance for 99/100 therefore stays, and its comment now names the real cause.

Regression guards: `tests/gateway/core/brain-bootstrap-lifecycle.test.ts` covers stop, close and the setup drain. `tests/brain-work.test.ts` covers the registry and stopping between KBs. `tests/brain-exit-code.test.ts` covers the exit code, including a subprocess that must exit 0. Each was seen failing before its fix.

## Not proven

The four-hour stall at 100% CPU was not reproduced. One long apparent hang here turned out to be the machine sleeping: the monotonic clock in the test stopped while the wall clock kept going. Treat a "stall" measured by wall clock on a laptop with care. A sample of a slow run showed the main thread idle in `kevent` and the CPU going to JSC's WASM compile threads. Before this fix, a run that crossed 03:00 local time would also fire one nightly maintenance per gateway created so far. That is a plausible source of hours of CPU, but it was not observed.
