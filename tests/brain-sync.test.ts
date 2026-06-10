import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { paths } from "../src/config/home";
import { clearKbCache } from "../src/knowledge/loader";
import { closeBrain, ensureSources, brainCall } from "../src/knowledge/brain";
import { syncKbWikis } from "../src/knowledge/brain-sync";
import { kbSourceId } from "../src/knowledge/scope";

// Brain in its own temp dir; KB fixture inside the preload-provided test home
// (paths.home is frozen at first config/home import, so per-file env overrides
// of SLAUDE_HOME don't work — write into the shared test home and clean up).
const brainDir = mkdtempSync(join(tmpdir(), "slaude-brainsync-"));
process.env.SLAUDE_BRAIN_HOME = brainDir;

const kbDir = join(paths.knowledge, "runbook");
const wiki = join(kbDir, "wiki");
mkdirSync(wiki, { recursive: true });
writeFileSync(join(kbDir, "README.md"), "---\ndescription: runbook\n---\n# Runbook\n");
writeFileSync(join(wiki, "alerts.md"), "# Alerts\nGrafana dashboard quirks for billing.\n");
// Literal fixture commands only — no interpolated input.
execSync(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: wiki });

// Second KB deliberately WITHOUT .git — mirrors image-baked installs
// (slaude install copies content only). syncKbWikis must self-init.
const kbDir2 = join(paths.knowledge, "nogit");
mkdirSync(kbDir2, { recursive: true });
writeFileSync(join(kbDir2, "README.md"), "---\ndescription: nogit kb\n---\n# NoGit\n");
writeFileSync(join(kbDir2, "rates.md"), "# Rates\nLending margin xylophone fact.\n");
clearKbCache();

afterAll(async () => {
  await closeBrain();
  delete process.env.SLAUDE_BRAIN_HOME;
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(kbDir, { recursive: true, force: true });
  rmSync(kbDir2, { recursive: true, force: true });
  clearKbCache();
});

describe("syncKbWikis (integration)", () => {
  test("imports wiki markdown into kb-<label> source, searchable in scope", async () => {
    await ensureSources();
    const results = await syncKbWikis();
    expect(results.find((r) => r.label === "runbook")?.ok).toBe(true);
    const src = kbSourceId("runbook");
    const hits = (await brainCall("search", { query: "grafana billing" }, {
      clientId: "U1", sourceId: "shared", allowedSources: ["shared", src],
    })) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  }, 60_000);

  test("self-inits git for KBs installed without .git", async () => {
    const results = await syncKbWikis();
    expect(results.find((r) => r.label === "nogit")?.ok).toBe(true);
    const src = kbSourceId("nogit");
    const hits = (await brainCall("search", { query: "xylophone lending" }, {
      clientId: "U1", sourceId: "shared", allowedSources: ["shared", src],
    })) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  }, 60_000);
});
