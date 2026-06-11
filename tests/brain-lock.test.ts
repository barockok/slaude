import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "slaude-brainlock-"));
process.env.SLAUDE_BRAIN_HOME = home;

// Simulate the k8s restart trap: a lock left by a previous pod whose PID is
// alive in THIS process namespace (we use our own pid — guaranteed alive and
// not the engine). Without takeover, connect would block 60s then throw.
const lockDir = join(home, "db", ".gbrain-lock");
mkdirSync(lockDir, { recursive: true });
writeFileSync(join(lockDir, "lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));

import { getBrain, closeBrain } from "../src/knowledge/brain";

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("brain boot lock takeover", () => {
  test("clears a leftover PGLite lock and boots", async () => {
    await getBrain(); // would time out without takeover
    expect(true).toBe(true);
  }, 90_000);
});
