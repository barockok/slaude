import { test, expect } from "bun:test";
import { forText } from "../../../../src/gateway/sim/tui/ansi";

test("plain text is unchanged", () => {
  expect(forText("hello")).toBe("hello");
});

test("ANSI escape sequences are stripped for <text>", () => {
  expect(forText("\x1b[1mhi\x1b[0m")).toBe("hi");
  expect(forText("\x1b[32m⏺\x1b[0m reply")).toBe("⏺ reply");
});
