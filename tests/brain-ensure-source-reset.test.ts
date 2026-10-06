// ensureSource caches per process; a closed brain must not leave that cache
// claiming sources exist in whichever brain boots next.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "brain-ensure-reset-"));
const saved = process.env.SLAUDE_BRAIN_HOME;
import { closeBrain, ensureSource, getBrain } from "../src/knowledge/brain";

afterAll(async () => {
  await closeBrain();
  if (saved === undefined) delete process.env.SLAUDE_BRAIN_HOME; else process.env.SLAUDE_BRAIN_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

test("closeBrain clears the ensured-source cache so a second brain home gets its source", async () => {
  process.env.SLAUDE_BRAIN_HOME = join(root, "a");
  await ensureSource("user-ureset");
  await closeBrain();
  process.env.SLAUDE_BRAIN_HOME = join(root, "b");
  await ensureSource("user-ureset");
  const e = (await getBrain()) as any;
  const rows = (await e.db.query(`SELECT id FROM sources WHERE id = 'user-ureset'`)).rows;
  expect(rows.length).toBe(1);
}, 120_000);

test("an ensureSource whose sources_add straddles closeBrain does not cache for the next brain", async () => {
  const { setBackendForTest, getBackend } = await import("../src/knowledge/backend");
  const real = getBackend();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  setBackendForTest({
    call: real.call.bind(real),
    adminCall: async () => { entered(); await gate; return {}; },
  } as typeof real);
  try {
    process.env.SLAUDE_BRAIN_HOME = join(root, "c");
    const inflight = ensureSource("user-urace");
    await started;
    await closeBrain(); // clears the cache while sources_add is pending
    release();
    await inflight;
  } finally {
    setBackendForTest(undefined);
  }
  process.env.SLAUDE_BRAIN_HOME = join(root, "d");
  await ensureSource("user-urace");
  const e = (await getBrain()) as any;
  expect((await e.db.query(`SELECT id FROM sources WHERE id = 'user-urace'`)).rows.length).toBe(1);
}, 120_000);
