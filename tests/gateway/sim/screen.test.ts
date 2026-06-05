// tests/gateway/sim/screen.test.ts
import { test, expect } from "bun:test";
import { layoutFooter } from "../../../src/gateway/sim/screen";

const base = { hint: "hint", cols: 40, rows: 24 };

test("single line: box is 3 rows + hint, status absent", () => {
  const L = layoutFooter({ ...base, status: null, text: "hello", cursor: 5 });
  expect(L.height).toBe(4);                       // top + content + bottom + hint
  expect(L.regionBottom).toBe(24 - 4);
  expect(L.lines[0]!.startsWith("╭")).toBe(true);
  expect(L.lines[0]!.endsWith("╮")).toBe(true);
  expect(L.lines[2]!.startsWith("╰")).toBe(true);
  expect(L.lines[1]).toContain("› hello");
});

test("box width tracks cols (responsive)", () => {
  const L = layoutFooter({ ...base, cols: 20, status: null, text: "", cursor: 0 });
  expect(L.lines[0]!.length).toBe(20);
  expect(L.lines[1]!.length).toBe(20);
});

test("status line slots in above the box; box stays bottom-pinned", () => {
  const a = layoutFooter({ ...base, status: null, text: "x", cursor: 1 });
  const b = layoutFooter({ ...base, status: "⠋ Thinking… (2s)", text: "x", cursor: 1 });
  expect(b.height).toBe(a.height + 1);              // taller footer
  expect(b.lines[0]).toContain("Thinking");         // status is the topmost footer row
  expect(b.regionBottom).toBe(a.regionBottom - 1);  // borrows one row from the scroll region
  expect(b.cursorRow).toBe(a.cursorRow);            // …but the box (and cursor) don't move
});

test("footer never renders below the last terminal row", () => {
  // Bottom-anchored: regionBottom + height === rows, so lines[height-1] lands exactly on `rows`.
  const withStatus = layoutFooter({ ...base, status: "⠋ Thinking… (2s)", text: "x", cursor: 1 });
  expect(withStatus.regionBottom + withStatus.height).toBe(24);
  const noStatus = layoutFooter({ ...base, status: null, text: "x", cursor: 1 });
  expect(noStatus.regionBottom + noStatus.height).toBe(24);
});

test("long line clips horizontally, keeping the cursor on-screen", () => {
  const L = layoutFooter({ ...base, cols: 20, status: null, text: "x".repeat(50), cursor: 50 });
  expect(L.cursorCol).toBeLessThanOrEqual(20);
  expect(L.lines[1]!.length).toBe(20);            // box row still exactly cols wide
});

test("cursor maps to the right row/col on the first line", () => {
  const L = layoutFooter({ ...base, status: null, text: "abc", cursor: 2 });
  // footer occupies rows 21..24; box top row 21, content row 22.
  expect(L.cursorRow).toBe(22);
  // col: 1 "│", 2 " ", 3.. content; prompt "› " is 2 wide → "ab" puts cursor at content+2.
  expect(L.cursorCol).toBe(3 + 2 + 2);
});

test("multi-line input grows the box, capped at 10 content rows", () => {
  const text = Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n");
  const L = layoutFooter({ ...base, status: null, text, cursor: text.length });
  // 15 logical lines, capped to 10 → height = 10 + 2 borders + 1 hint = 13.
  expect(L.height).toBe(13);
  // cursor on the last logical line stays visible (bottom content row).
  expect(L.cursorRow).toBe(L.regionBottom + 1 + 10);  // regionBottom + boxTop(1) + 10th content row
});

test("continuation lines have no prompt; first line does", () => {
  const L = layoutFooter({ ...base, status: null, text: "a\nb", cursor: 3 });
  expect(L.lines[1]).toContain("› a");
  expect(L.lines[2]).toContain(" b");
  expect(L.lines[2]).not.toContain("›");
});
