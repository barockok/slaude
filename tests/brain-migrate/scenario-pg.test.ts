// Gated: the same migration with the gateway-side brain on Postgres/pgvector (the production target).
//   SLAUDE_BRAIN_PG_TEST_URL=postgres://user:pass@localhost:5432/slaude_brain_scenario_test bun test tests/brain-migrate/scenario-pg.test.ts
// Use a THROWAWAY, empty database with the vector extension available: the test
// expects a fresh brain and deletes pages from it. The mono brain stays PGLite.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMonoBrain } from "./seed";
import { dryRunStep, identity, importStep, recallStep, rerunStep } from "./scenario-steps";

const url = process.env.SLAUDE_BRAIN_PG_TEST_URL;
const root = mkdtempSync(join(tmpdir(), "bm-scenario-pg-"));
const monoHome = join(root, "mono");
const gwHome = join(root, "gateway");
const bundleDir = join(root, "bundle");
const keys = ["SLAUDE_BRAIN_HOME", "SLAUDE_AGENT_ID", "SLAUDE_BRAIN_ENGINE", "SLAUDE_BRAIN_DATABASE_URL"] as const;
let cleanup = false;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

afterAll(async () => {
  const { closeBrain } = await import("../../src/knowledge/brain");
  const { resetAgentId } = await import("../../src/knowledge/agent-identity");
  if (cleanup && url) {
    // Leave the database as found (it was verified empty): a second run must work.
    try {
      process.env.SLAUDE_BRAIN_ENGINE = "postgres";
      process.env.SLAUDE_BRAIN_DATABASE_URL = url;
      process.env.SLAUDE_BRAIN_HOME = gwHome;
      const { getBrain } = await import("../../src/knowledge/brain");
      const e = (await getBrain()) as any;
      await e.executeRaw("DELETE FROM pages");
      await e.executeRaw("DELETE FROM sources WHERE id <> 'default'");
    } catch { /* best effort */ }
  }
  await closeBrain();
  resetAgentId();
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!url)("mono (PGLite) -> gateway persona on Postgres", () => {
  test("seed and export the PGLite mono brain", async () => {
    delete process.env.SLAUDE_BRAIN_ENGINE;
    delete process.env.SLAUDE_BRAIN_DATABASE_URL;
    await seedMonoBrain(monoHome);
    const { exportBrain } = await import("../../src/brain-migrate/export");
    const { manifest } = await exportBrain({ home: monoHome, out: bundleDir });
    expect(manifest.sources.map((s) => s.id)).toContain("agent-default");
  }, 120_000);

  test("dry run into the empty Postgres brain writes nothing", async () => {
    const { closeBrain } = await import("../../src/knowledge/brain");
    await closeBrain();
    process.env.SLAUDE_BRAIN_ENGINE = "postgres";
    process.env.SLAUDE_BRAIN_DATABASE_URL = url!;
    process.env.SLAUDE_BRAIN_HOME = gwHome;
    await identity("UANA-1x");
    const { getBrain } = await import("../../src/knowledge/brain");
    const pre = (await getBrain()) as any;
    const n = (await pre.executeRaw("SELECT count(*)::int AS n FROM pages"))[0].n;
    if (n !== 0) throw new Error("SLAUDE_BRAIN_PG_TEST_URL must point at an EMPTY throwaway database; it already holds pages");
    cleanup = true;
    await dryRunStep(bundleDir);
  }, 120_000);

  test("real import reconciles", () => importStep(bundleDir), 120_000);
  test("the persona recalls everything, embeddings round-trip through pgvector", () => recallStep(), 120_000);
  test("re-run is idempotent; a crashed run resumes", () => rerunStep(bundleDir), 120_000);
});
