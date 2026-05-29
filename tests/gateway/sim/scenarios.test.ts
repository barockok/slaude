import { describe, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";

const dir = join(import.meta.dir, "../../../src/gateway/sim/scenarios");
describe("scenario transcripts", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
    it(`runs ${f} green`, async () => {
      await runTranscript(parseTranscript(readFileSync(join(dir, f), "utf8")));
    });
  }
});
