import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../../src/config/env";

afterEach(() => {
  delete process.env.SLAUDE_MEMORY_BOUNDARIES;
});

describe("SLAUDE_MEMORY_BOUNDARIES", () => {
  test("defaults to shadow", () => {
    expect(env.memory.boundaries()).toBe("shadow");
  });

  test("reads off, shadow and on, ignoring case and spaces", () => {
    for (const [raw, want] of [["off", "off"], [" OFF ", "off"], ["shadow", "shadow"], ["on", "on"], [" On", "on"]] as const) {
      process.env.SLAUDE_MEMORY_BOUNDARIES = raw;
      expect(env.memory.boundaries()).toBe(want);
    }
  });

  test("anything else reads as shadow", () => {
    for (const raw of ["", "1", "true", "garbage", "union"]) {
      process.env.SLAUDE_MEMORY_BOUNDARIES = raw;
      expect(env.memory.boundaries()).toBe("shadow");
    }
  });
});
