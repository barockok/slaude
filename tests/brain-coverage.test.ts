import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config/home";
import { db } from "../src/db/schema";
import { clearKbCache } from "../src/knowledge/loader";
import { closeBrain, embeddingActive, ensureSources, getBrain } from "../src/knowledge/brain";
import { backfillMemoryTurns, embedStaleChunks } from "../src/knowledge/brain-backfill";
import { parseCycleTime, runNightlyMaintenance, scheduleNightlyMaintenance } from "../src/knowledge/brain-cycle";
import { kbSourceId } from "../src/knowledge/scope";

// Failure-path coverage for brain-cycle / brain-backfill. Strategy: boot one
// real brain with an ACTIVE embedding gateway (keyless litellm recipe — see
// tests/brain-embed-gateway.test.ts), exercise the active embed sweep on an
// empty brain (zero stale chunks → no network), then disconnect the engine
// WITHOUT closeBrain so every subsequent phase fails and the catch branches
// report instead of throwing. Tests in this file are order-dependent.

const brainDir = mkdtempSync(join(tmpdir(), "slaude-braincov-"));
process.env.SLAUDE_BRAIN_HOME = brainDir;
process.env.EMBEDDING_URL = "http://127.0.0.1:9"; // never contacted — zero stale chunks
process.env.EMBEDDING_MODEL = "test-embed";
process.env.EMBEDDING_DIMENSIONS = "8";

// KB fixture so the nightly extract loop has a wiki to fail on post-disconnect.
const kbDir = join(paths.knowledge, "covwiki");
mkdirSync(join(kbDir, "wiki"), { recursive: true });
writeFileSync(join(kbDir, "README.md"), "---\ndescription: coverage wiki\n---\n# Cov\n");
writeFileSync(join(kbDir, "wiki", "page.md"), "# Page\nCoverage fixture.\n");
clearKbCache();

// Same erased-specifier trick as src/knowledge/brain.ts — tsc must not
// descend into gbrain. Used to install the test embed transport so the
// embed preflight passes without real provider credentials.
const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

async function setEmbedTransport(fn: unknown): Promise<void> {
  const gw = (await gbrainImport("ai/gateway")) as {
    __setEmbedTransportForTests: (f: unknown) => void;
  };
  gw.__setEmbedTransportForTests(fn);
}

afterAll(async () => {
  await setEmbedTransport(null).catch(() => {});
  await closeBrain().catch(() => {}); // engine may already be disconnected
  delete process.env.SLAUDE_BRAIN_HOME;
  delete process.env.EMBEDDING_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.LITELLM_BASE_URL;
  delete process.env.SLAUDE_BRAIN_CYCLE;
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(kbDir, { recursive: true, force: true });
  clearKbCache();
  db.run("DELETE FROM memory_turns");
});

describe("embedStaleChunks (active gateway)", () => {
  test("runs the embed sweep when the gateway is active (zero stale chunks)", async () => {
    await ensureSources();
    expect(embeddingActive()).toBe(true);
    // Stub transport: passes runEmbedCore's credential preflight; never called
    // for real because the fresh brain has no stale chunks.
    await setEmbedTransport(async (opts: { values: string[] }) => ({
      embeddings: opts.values.map(() => new Array(8).fill(0)),
      usage: { tokens: 0 },
    }));
    const logs: string[] = [];
    const r = await embedStaleChunks((m) => logs.push(m));
    expect(r).toEqual({ embedded: 0 });
    expect(logs.some((l) => l.includes("embedded 0 stale chunk"))).toBe(true);
  }, 120_000);
});

describe("failure paths after the engine goes away", () => {
  test("backfillMemoryTurns counts per-session errors instead of throwing", async () => {
    // Disconnect WITHOUT closeBrain: getBrain() keeps resolving to a dead
    // engine, so every brain call throws — exactly the failure mode the
    // catch branches exist for.
    const engine = (await getBrain()) as unknown as { disconnect(): Promise<void> };
    await engine.disconnect();

    db.run("DELETE FROM memory_turns");
    db.run(
      "INSERT INTO memory_turns (session_id, ts, user_text, assistant_text) VALUES ('cov-sess', ?, 'q', 'a')",
      [Date.now()],
    );
    const logs: string[] = [];
    const r = await backfillMemoryTurns((m) => logs.push(m));
    expect(r).toEqual({ sessions: 1, turns: 0, errors: 1 });
    expect(logs.some((l) => l.includes("cov-sess failed"))).toBe(true);
  }, 120_000);

  test("runNightlyMaintenance reports per-phase failures", async () => {
    const report = await runNightlyMaintenance();
    expect(report.kbSync.find((r) => r.label === "covwiki")?.ok).toBe(false);
    const ex = report.extract.find((r) => r.sourceId === kbSourceId("covwiki"));
    expect(ex?.ok).toBe(false);
    expect(ex?.error).toBeTruthy();
    expect(report.embed.ok).toBe(false); // gateway still flagged active → sweep ran and failed
    expect(report.embed.error).toBeTruthy();
    expect(report.orphans.ok).toBe(false);
    expect(report.purge.ok).toBe(false);
  }, 120_000);

  test("scheduleNightlyMaintenance arms, fires, survives a throwing observer, re-arms, cancels", async () => {
    const captured: Array<() => Promise<void>> = [];
    let cleared = 0;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    (globalThis as any).setTimeout = (fn: () => Promise<void>) => {
      captured.push(fn);
      return { unref() {} };
    };
    (globalThis as any).clearTimeout = () => { cleared++; };
    try {
      process.env.SLAUDE_BRAIN_CYCLE = "04:30";
      const reports: unknown[] = [];
      const cancel = scheduleNightlyMaintenance((r) => {
        reports.push(r);
        throw new Error("observer boom"); // exercises the catch around onReport
      });
      expect(captured.length).toBe(1);
      await captured[0]!(); // fire the nightly tick (fast: brain is down)
      expect(reports.length).toBe(1);
      expect(captured.length).toBe(2); // re-armed for the next night
      cancel();
      expect(cleared).toBe(1);

      // "off" never arms a timer.
      process.env.SLAUDE_BRAIN_CYCLE = "off";
      const cancelOff = scheduleNightlyMaintenance(() => {});
      expect(captured.length).toBe(2);
      cancelOff();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      delete process.env.SLAUDE_BRAIN_CYCLE;
    }
  }, 120_000);
});

describe("parseCycleTime", () => {
  test("accepts HH:MM, rejects off/garbage/out-of-range", () => {
    expect(parseCycleTime("03:00")).toEqual({ hour: 3, minute: 0 });
    expect(parseCycleTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseCycleTime("off")).toBeNull();
    expect(parseCycleTime(undefined)).toBeNull();
    expect(parseCycleTime("nope")).toBeNull();
    expect(parseCycleTime("24:00")).toBeNull();
    expect(parseCycleTime("12:60")).toBeNull();
  });
});
