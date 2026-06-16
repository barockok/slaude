import { describe, it, expect } from "bun:test";
import { disengagedHookDecision } from "../../src/agent/manager";

// The UserPromptSubmit hook keeps a disengaged thread's transcript populated
// without running the model. `continue:false` (NOT `decision:"block"`) is the
// load-bearing choice: verified against the pinned SDK, block discards the
// prompt before it persists, whereas continue:false persists then halts.
describe("disengagedHookDecision", () => {
  it("suppresses (continue:false) when the thread is disengaged", () => {
    const d = disengagedHookDecision({ engaged: 0 });
    expect(d.continue).toBe(false);
    expect(d.suppressOutput).toBe(true);
    expect(d.stopReason).toContain("disengaged");
  });

  it("passes through (continue:true) when the thread is engaged", () => {
    const d = disengagedHookDecision({ engaged: 1 });
    expect(d.continue).toBe(true);
    expect(d.suppressOutput).toBeUndefined();
  });

  it("passes through when there is no session row", () => {
    expect(disengagedHookDecision(null).continue).toBe(true);
  });

  it("never uses decision:block (would discard the prompt pre-persist)", () => {
    const d = disengagedHookDecision({ engaged: 0 }) as Record<string, unknown>;
    expect(d.decision).toBeUndefined();
  });
});
