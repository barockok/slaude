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
