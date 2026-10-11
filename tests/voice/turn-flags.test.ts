import { describe, it, expect } from "bun:test";
import { voiceTurns, injectedTurns } from "../../src/voice/turn-flags";

describe("voiceTurns", () => {
  it("counts nested enters", () => {
    voiceTurns.enter("s1");
    voiceTurns.enter("s1");
    voiceTurns.exit("s1");
    expect(voiceTurns.active("s1")).toBe(true);
    voiceTurns.exit("s1");
    expect(voiceTurns.active("s1")).toBe(false);
    voiceTurns.exit("s1"); // never negative
    expect(voiceTurns.active("s1")).toBe(false);
  });
});

describe("injectedTurns", () => {
  it("is an independent counted flag set", () => {
    injectedTurns.enter("s2");
    injectedTurns.enter("s2");
    injectedTurns.exit("s2");
    expect(injectedTurns.active("s2")).toBe(true);
    expect(voiceTurns.active("s2")).toBe(false);
    injectedTurns.exit("s2");
    injectedTurns.exit("s2");
    expect(injectedTurns.active("s2")).toBe(false);
  });
});
