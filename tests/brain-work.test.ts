import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config/home";
import { clearKbCache } from "../src/knowledge/loader";
import { closeBrain } from "../src/knowledge/brain";
import { syncKbWikis } from "../src/knowledge/brain-sync";
import {
  brainClosing,
  pendingBrainWork,
  settleBrainWork,
  trackBrainWork,
  whileClosing,
} from "../src/knowledge/brain-work";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("brain work registry", () => {
  test("tracks a job until it settles, rejected ones included", async () => {
    const ok = trackBrainWork(sleep(30));
    const bad = trackBrainWork(sleep(10).then(() => Promise.reject(new Error("boom"))));
    expect(pendingBrainWork()).toBe(2);
    await settleBrainWork();
    expect(pendingBrainWork()).toBe(0);
    await ok;
    await expect(bad).rejects.toThrow("boom");
  });

  test("settle also waits for work started while it waits", async () => {
    let second = false;
    trackBrainWork(sleep(10).then(() => void trackBrainWork(sleep(30).then(() => void (second = true)))));
    await settleBrainWork();
    expect(second).toBe(true);
  });

  test("brainClosing() is true only inside whileClosing", async () => {
    expect(brainClosing()).toBe(false);
    await whileClosing(async () => expect(brainClosing()).toBe(true));
    expect(brainClosing()).toBe(false);
  });

  test("closeBrain() waits for tracked work instead of closing under it", async () => {
    let finished = false;
    trackBrainWork(sleep(150).then(() => void (finished = true)));
    await closeBrain();
    expect(finished).toBe(true);
  });
});

describe("syncKbWikis while the brain is closing", () => {
  const labels = ["bw-one", "bw-two"];
  const brainDir = mkdtempSync(join(tmpdir(), "slaude-brain-work-"));
  const saved = process.env.SLAUDE_BRAIN_HOME;
  beforeAll(async () => {
    await closeBrain();
    process.env.SLAUDE_BRAIN_HOME = brainDir;
    // Only this file's KBs: the test home is shared with every other file.
    rmSync(paths.knowledge, { recursive: true, force: true });
    for (const l of labels) {
      mkdirSync(join(paths.knowledge, l), { recursive: true });
      writeFileSync(join(paths.knowledge, l, "README.md"), `---\ndescription: ${l}\n---\n# ${l}\n`);
    }
    clearKbCache();
  });
  afterAll(async () => {
    await closeBrain();
    if (saved === undefined) delete process.env.SLAUDE_BRAIN_HOME;
    else process.env.SLAUDE_BRAIN_HOME = saved;
    rmSync(brainDir, { recursive: true, force: true });
    for (const l of labels) rmSync(join(paths.knowledge, l), { recursive: true, force: true });
    clearKbCache();
  });

  test("stops before the next KB once a close is waiting", async () => {
    const run = trackBrainWork(syncKbWikis());
    await closeBrain(); // waits for `run`, which must not start the second KB
    const results = await run;
    expect(results.map((r) => r.label)).toEqual(["bw-one"]);
  }, 60_000);
});
