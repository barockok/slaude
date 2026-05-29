import { describe, it, expect } from "bun:test";
import { PRESETS, getPreset } from "../../../src/gateway/sim/presets";

describe("presets", () => {
  it("ships the six built-in scenarios in order", () => {
    expect(PRESETS.map((p) => p.name)).toEqual([
      "manager-dm", "member-public", "member-trusted", "restricted-blocked", "approval-flow", "borrow-grant",
    ]);
  });
  it("getPreset resolves by name and by 1-based index", () => {
    expect(getPreset("approval-flow")?.behavior).toBe("request_approval");
    expect(getPreset("5")?.name).toBe("approval-flow");
    expect(getPreset("nope")).toBeUndefined();
  });
  it("every preset uses valid Slack-format ids", () => {
    const uid = /^[UW][A-Z0-9]+$/, cid = /^[CGD][A-Z0-9]+$/;
    for (const p of PRESETS) {
      expect(uid.test(p.actor)).toBe(true);
      expect(cid.test(p.channel)).toBe(true);
      expect(uid.test(p.soul.manager)).toBe(true);
    }
  });
});
