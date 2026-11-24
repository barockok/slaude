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

describe("SLAUDE_MEMORY_BOUNDARIES_PERSONAS", () => {
  afterEach(() => {
    delete process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS;
  });
  test("empty means every persona, a list narrows `on` to the names in it", () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "on";
    expect(env.memory.placePersonas()).toEqual([]);
    expect(env.memory.placesOn("anyone")).toBe(true);
    expect(env.memory.placesOn(undefined)).toBe(true);
    process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS = " Alpha, beta ,";
    expect(env.memory.placePersonas()).toEqual(["alpha", "beta"]);
    expect(env.memory.placesOn("ALPHA")).toBe(true);
    expect(env.memory.placesOn("gamma")).toBe(false);
    expect(env.memory.placesOn(undefined)).toBe(false);
    process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS = "default";
    expect(env.memory.placesOn(undefined)).toBe(true);
  });
  test("the list never turns anything on when the mode is off or shadow", () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES_PERSONAS = "alpha";
    for (const mode of ["off", "shadow"]) {
      process.env.SLAUDE_MEMORY_BOUNDARIES = mode;
      expect(env.memory.placesOn("alpha")).toBe(false);
    }
  });
});
