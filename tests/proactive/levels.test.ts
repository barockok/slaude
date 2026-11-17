import { expect, test } from "bun:test";
import { LEVELS, levelRank, minLevel, parseLevel } from "../../src/proactive/levels";

test("levels order and clamp", () => {
  expect(LEVELS).toEqual(["ignore", "inform", "ask", "act"]);
  expect(levelRank("act")).toBeGreaterThan(levelRank("ask"));
  expect(minLevel("act", "inform")).toBe("inform");
  expect(minLevel("ignore", "act")).toBe("ignore");
  expect(parseLevel(" Act ")).toBe("act");
  expect(parseLevel("always")).toBeNull();
});
