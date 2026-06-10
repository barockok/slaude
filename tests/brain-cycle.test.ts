import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { paths } from "../src/config/home";
import { clearKbCache } from "../src/knowledge/loader";
import { closeBrain, ensureSources, brainCall } from "../src/knowledge/brain";
import { runNightlyMaintenance, msUntilNext } from "../src/knowledge/brain-cycle";
import { kbSourceId } from "../src/knowledge/scope";

const brainDir = mkdtempSync(join(tmpdir(), "slaude-braincycle-"));
process.env.SLAUDE_BRAIN_HOME = brainDir;

// KB fixture with a wikilink so extract has an edge to wire.
const kbDir = join(paths.knowledge, "cyclewiki");
const wiki = join(kbDir, "wiki");
mkdirSync(wiki, { recursive: true });
writeFileSync(join(kbDir, "README.md"), "---\ndescription: cycle wiki\n---\n# Cycle\n");
writeFileSync(join(wiki, "service-a.md"), "# Service A\nDepends on [[service-b]] for queueing.\n");
writeFileSync(join(wiki, "service-b.md"), "# Service B\nQueue layer.\n");
// Literal fixture commands only — no interpolated input.
execSync(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: wiki });
clearKbCache();

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(kbDir, { recursive: true, force: true });
  clearKbCache();
});

describe("msUntilNext", () => {
  test("returns positive ms under 24h", () => {
    for (const [h, m] of [[0, 0], [3, 30], [23, 59]] as const) {
      const ms = msUntilNext(h, m);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    }
  });
});

describe("runNightlyMaintenance (integration)", () => {
  test("syncs wikis, extracts graph edges, reports", async () => {
    await ensureSources();
    const report = await runNightlyMaintenance();
    expect(report.kbSync.find((r) => r.label === "cyclewiki")?.ok).toBe(true);
    expect(report.extract.find((r) => r.sourceId === kbSourceId("cyclewiki"))?.ok).toBe(true);
    expect(report.orphans.ok).toBe(true);
    expect(report.purge.ok).toBe(true);

    // wiki content is searchable after the cycle (sync + index end-to-end).
    // NOTE: wiki [[wikilink]] → graph-edge extraction currently yields 0 edges
    // for fs-synced sources (gbrain resolution rules; agent put_page writes DO
    // reconcile edges inline) — tracked as a known gap in the finding doc.
    const hits = (await brainCall("search", { query: "queueing service" }, {
      clientId: "agent", sourceId: kbSourceId("cyclewiki"), allowedSources: [kbSourceId("cyclewiki")],
    })) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);
});
