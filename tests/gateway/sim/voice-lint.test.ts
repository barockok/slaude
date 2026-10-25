import { describe, expect, test } from "bun:test";
import { voiceLint, firstVoiceViolation } from "../../../src/gateway/sim/voice-lint";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";

describe("voiceLint", () => {
  test("rules", () => {
    expect(voiceLint("From my KB, deploys ship Thursday")).toEqual(["machinery-kb"]);
    expect(voiceLint("checked the brain: yes")).toEqual(["machinery-kb"]);
    expect(voiceLint("saved /deploy-check")).toEqual(["skill-saved"]);
    expect(voiceLint("I saved a skill for this")).toEqual(["skill-mention"]);
    expect(voiceLint("I saved a skill for this", { skillTurn: true })).toEqual([]);
    expect(voiceLint("Deploys ship every Thursday.")).toEqual([]);
    expect(voiceLint("memory usage is at 80%")).toEqual([]);
  });
  test("firstVoiceViolation only lints message cards", () => {
    expect(firstVoiceViolation([{ kind: "approval", text: "the skill" }])).toBeUndefined();
    expect(firstVoiceViolation([{ kind: "message", text: "From my KB, yes" }])?.rule).toBe("machinery-kb");
  });
});

describe("expect_natural_voice step", () => {
  test("passes on a clean stub reply", async () => {
    const t = parseTranscript(`
layer: trusted
as: member
steps:
  - send: { text: "hi" }
  - expect_natural_voice: {}
`);
    await runTranscript(t, "stub");
  });
});
