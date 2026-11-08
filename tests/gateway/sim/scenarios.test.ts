import { afterAll, beforeAll, describe, it } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closeBrain } from "../../../src/knowledge/brain";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";
import { freshBrainHome } from "../../helpers/brain-template";

const dir = join(import.meta.dir, "../../../src/gateway/sim/scenarios");

// Each scenario's gateway boots the brain in the background. Booted into the
// shared test home, the first scenario could pay a fresh PGLite initdb and
// gbrain's migrations, which late in the suite took 20 s or more and timed it
// out. Give the file a copy of the per-process template brain instead
// (tests/helpers/brain-template.ts): opening it is cheap. Building the
// template, when no earlier file in this process has, is setup work and runs
// here, not in the first scenario.
let brainDir: string | null = null;
const savedBrainHome = process.env.SLAUDE_BRAIN_HOME;
beforeAll(async () => {
  await closeBrain();
  brainDir = await freshBrainHome("slaude-scenarios-");
  process.env.SLAUDE_BRAIN_HOME = brainDir;
}, 60_000);
afterAll(async () => {
  await closeBrain();
  if (savedBrainHome === undefined) delete process.env.SLAUDE_BRAIN_HOME;
  else process.env.SLAUDE_BRAIN_HOME = savedBrainHome;
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
});

describe("scenario transcripts", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
    it(`runs ${f} green`, async () => {
      await runTranscript(parseTranscript(readFileSync(join(dir, f), "utf8")));
    });
  }
});
