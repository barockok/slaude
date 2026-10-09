/**
 * A gateway owns the brain work it starts at boot.
 *
 * createGateway kicks off the brain's source bootstrap and KB wiki import in
 * the background, and arms the nightly maintenance timer. Before this was
 * owned, stop() returned while that work was still running: in one `bun test`
 * process it bled into whatever file ran next (event-loop stalls, gbrain sync
 * lock contention, and a closeBrain() in the next file disconnecting the
 * engine under it — "PGLite not connected"), and every gateway left a
 * nightly timer armed for the rest of the process.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../src/config/home";
import { clearKbCache } from "../../../src/knowledge/loader";
import { closeBrain } from "../../../src/knowledge/brain";
import * as Cycle from "../../../src/knowledge/brain-cycle";
import { pendingBrainWork } from "../../../src/knowledge/brain-work";
import { SimSession } from "../../../src/gateway/sim/engine";

const KB = "lifecycle-kb";
const kbDir = join(paths.knowledge, KB);
const brainDir = mkdtempSync(join(tmpdir(), "slaude-brain-lifecycle-"));
const savedBrainHome = process.env.SLAUDE_BRAIN_HOME;

beforeAll(async () => {
  await closeBrain();
  process.env.SLAUDE_BRAIN_HOME = brainDir;
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, "README.md"), "---\ndescription: lifecycle kb\n---\n# Lifecycle\nA page to import.\n");
  clearKbCache();
});

afterAll(async () => {
  await closeBrain();
  if (savedBrainHome === undefined) delete process.env.SLAUDE_BRAIN_HOME;
  else process.env.SLAUDE_BRAIN_HOME = savedBrainHome;
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(kbDir, { recursive: true, force: true });
  clearKbCache();
});

/** Capture every `[brain] ...` line the gateway's bootstrap logs. */
function captureBrainLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const grab = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    if (s.startsWith("[brain]")) lines.push(s);
  };
  const log = spyOn(console, "log").mockImplementation(grab);
  const err = spyOn(console, "error").mockImplementation(grab);
  return { lines, restore: () => { log.mockRestore(); err.mockRestore(); } };
}

describe("gateway brain bootstrap lifecycle", () => {
  test("no boot-time brain work is still running once stop() resolves", async () => {
    const cap = captureBrainLogs();
    try {
      const s = await SimSession.create({ agent: "stub" });
      await s.dispose(); // handle.stop()
      expect(pendingBrainWork()).toBe(0);
      const atStop = cap.lines.length;
      // What the next test file typically does first.
      await closeBrain();
      await new Promise((r) => setTimeout(r, 1500));
      expect(cap.lines.slice(atStop)).toEqual([]);
    } finally {
      cap.restore();
    }
  }, 60_000);

  test("a gateway left running finishes its KB import before closeBrain() disconnects", async () => {
    const cap = captureBrainLogs();
    try {
      // Not stopped: like the many tests that never call handle.stop().
      await SimSession.create({ agent: "stub" });
      // closeBrain() lets the bootstrap finish its current step, then the
      // import stops between KBs; either way nothing fails against a closed
      // engine and nothing runs after the close.
      await closeBrain();
      expect(pendingBrainWork()).toBe(0);
      const atClose = cap.lines.length;
      await new Promise((r) => setTimeout(r, 1500));
      expect(cap.lines.filter((l) => /failed|not connected/i.test(l))).toEqual([]);
      expect(cap.lines.slice(atClose)).toEqual([]);
    } finally {
      cap.restore();
    }
  }, 60_000);

  // The shared teardown in tests/setup.ts: work from a gateway a test never
  // stopped is drained after that test, so it cannot run into the next one.
  test("(setup drain, part 1) leave a gateway running", async () => {
    await SimSession.create({ agent: "stub" });
    expect(pendingBrainWork()).toBe(1);
  }, 60_000);

  test("(setup drain, part 2) nothing from the previous test is still running", () => {
    expect(pendingBrainWork()).toBe(0);
  });

  test("stop() cancels the nightly maintenance timer it armed", async () => {
    let cancelled = 0;
    const spy = spyOn(Cycle, "scheduleNightlyMaintenance").mockImplementation(() => () => void cancelled++);
    try {
      const s = await SimSession.create({ agent: "stub" });
      expect(spy).toHaveBeenCalledTimes(1);
      await s.dispose();
      expect(cancelled).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
