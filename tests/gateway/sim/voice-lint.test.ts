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

describe("expect_natural_voice scoping", () => {
  test("ignores violating cards before the latest send; fails on ones after", async () => {
    const { SimSession } = await import("../../../src/gateway/sim/engine");
    const fake: any[] = [];
    const bad = { kind: "message", text: "From my KB, yes", resolved: false, actionIds: [], channel: "C1", raw: {} };
    const origCreate = SimSession.create;
    (SimSession as any).create = async () => ({
      cards: () => fake,
      send: async (x: any) => { if (x.text === "bad") fake.push(bad); },
      dispose: async () => {},
    });
    try {
      fake.push({ ...bad }); // posted before any send
      const ok = parseTranscript(`
steps:
  - send: { text: "ok" }
  - expect_natural_voice: {}
`);
      await runTranscript(ok, "stub");
      const fail = parseTranscript(`
steps:
  - send: { text: "bad" }
  - expect_natural_voice: {}
`);
      await expect(runTranscript(fail, "stub")).rejects.toThrow(/expect_natural_voice failed: machinery-kb/);
    } finally {
      (SimSession as any).create = origCreate;
    }
  });
});
