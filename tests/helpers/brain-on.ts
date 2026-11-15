// tests/helpers/brain-on.ts
//
// For a test file that needs a local brain that is ON: no earlier file's env
// may decide that for it.
//
// All test files share one bun process, and SLAUDE_BRAIN_DISABLED=1 and
// SLAUDE_BRAIN_MODE=remote are set by many of them (the node, gateway and
// panel suites). One that leaks either (a file whose tests are all skipped runs
// no afterAll, and bun still loads its top level) makes a later brain file see
// "the brain is disabled on this gateway" (409) or an empty memory. Which file
// leaks to which is decided by the run's file order, so the failure came and
// went between CI runs. See the 2026-11-16 field note.
//
// A cached backend (src/knowledge/backend.ts) is process-wide too: a file that
// stubbed it with setBackendForTest and did not reset it, or that resolved it
// under SLAUDE_BRAIN_MODE=remote, would answer every brain call of a later file
// (an empty search). It is reset around the file as well.
//
// Call once at the top of the file. The keys are cleared before the file's tests
// and put back after them.
import { afterAll, beforeAll } from "bun:test";

const KEYS = ["SLAUDE_BRAIN_DISABLED", "SLAUDE_BRAIN_MODE"] as const;

export function brainOn(): void {
  const saved: Record<string, string | undefined> = {};
  // Now, not only in beforeAll: a file with top-level awaits reads the env while loading.
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  const resetBackend = async () => (await import("../../src/knowledge/backend")).resetBackend();
  beforeAll(async () => { for (const k of KEYS) delete process.env[k]; await resetBackend(); });
  afterAll(async () => {
    await resetBackend();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}
