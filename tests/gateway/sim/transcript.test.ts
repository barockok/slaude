import { describe, it, expect } from "bun:test";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n), "utf8");

describe("transcript", () => {
  it("parses preset + steps", () => {
    const t = parseTranscript(fx("restricted.yaml"));
    expect(t.preset).toBe("restricted-blocked");
    expect(t.steps.length).toBe(2);
  });
  it("runs the restricted transcript green", async () => {
    await runTranscript(parseTranscript(fx("restricted.yaml")));
  });
  it("runs the approval transcript green", async () => {
    await runTranscript(parseTranscript(fx("approval.yaml")));
  });
  it("fails a transcript whose assertion does not hold", async () => {
    const bad = parseTranscript("preset: manager-dm\nsteps:\n  - send: { text: hi }\n  - expect_drop: { reason: whitelist }\n");
    await expect(runTranscript(bad)).rejects.toThrow(/expect_drop/);
  });
});
