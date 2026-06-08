import { test, expect } from "bun:test";
import { ansiToStyledText, banner } from "../../../../src/gateway/sim/tui/banner";

test("parses truecolor fg/bg runs into styled chunks", () => {
  const st = ansiToStyledText("\x1b[38;2;255;0;0mA\x1b[0mB");
  expect(st.chunks.length).toBe(2);
  expect(st.chunks[0]!.text).toBe("A");
  expect(st.chunks[0]!.fg).toBeDefined();         // red fg applied
  expect(st.chunks[1]!.text).toBe("B");
  expect(st.chunks[1]!.fg).toBeUndefined();        // reset → plain
});

test("a combined fg+bg run carries both colors", () => {
  const st = ansiToStyledText("\x1b[38;2;10;20;30m\x1b[48;2;40;50;60m▀\x1b[0m");
  expect(st.chunks[0]!.text).toBe("▀");
  expect(st.chunks[0]!.fg).toBeDefined();
  expect(st.chunks[0]!.bg).toBeDefined();
});

test("the amartha logo loads and parses to a non-empty StyledText", () => {
  expect(banner.chunks.length).toBeGreaterThan(50);   // many colored half-block runs
});
