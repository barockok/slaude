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

// ── Screen class tests ────────────────────────────────────────────────────────

import { Screen } from "../../../src/gateway/sim/screen";

const mkScreen = () => {
  const w: string[] = [];
  const s = new Screen((x) => w.push(x), () => ({ rows: 24, cols: 40 }), { now: () => 0 });
  return { s, out: () => w.join("") };
};

test("setInput renders a bordered box with the text", () => {
  const { s, out } = mkScreen();
  s.setInput("hello", 5);
  expect(out()).toContain("╭");
  expect(out()).toContain("› hello");
  expect(out()).toContain("╰");
});

test("setStatus shows a spinner line; clearing removes it", () => {
  const { s, out } = mkScreen();
  s.setInput("x", 1);
  s.setStatus("Thinking…");
  expect(out()).toContain("Thinking…");
  s.setStatus(null);
  // last full render should no longer carry the label on the status row
  expect(out().split("Thinking…").length - 1).toBe(1); // appeared once, not re-emitted after clear
});

test("print emits a scrollback line and sets the scroll region", () => {
  const { s, out } = mkScreen();
  s.setInput("", 0);
  s.print("scrollback line");
  expect(out()).toContain("scrollback line");
  expect(out()).toContain("\x1b[1;");          // DECSTBM region set
});

test("restore resets the region and shows the cursor", () => {
  const { s, out } = mkScreen();
  s.setInput("", 0);
  s.restore();
  expect(out()).toContain("\x1b[r");            // region reset
  expect(out()).toContain("\x1b[?25h");         // cursor shown
  expect(out()).toContain("\x1b[?2004l");       // bracketed paste off
});

test("resize re-sets the scroll region even when footer height is unchanged", () => {
  const w: string[] = [];
  let rows = 24;
  const s = new Screen((x) => w.push(x), () => ({ rows, cols: 40 }), { now: () => 0 });
  s.setInput("x", 1);                           // region set for rows=24 → 1;20r
  expect(w.join("")).toContain("\x1b[1;20r");
  w.length = 0;
  rows = 30;                                    // terminal grew; height unchanged
  s.resize();
  expect(w.join("")).toContain("\x1b[1;26r");   // region tracks the new rows (30-4)
});

test("print on a fresh Screen sets the region before scrolling", () => {
  const { s, out } = mkScreen();
  s.print("hi");                                // no setInput first
  const o = out();
  // The DECSTBM set must appear before the scroll-park write.
  expect(o.indexOf("\x1b[1;")).toBeGreaterThanOrEqual(0);
  expect(o.indexOf("\x1b[1;")).toBeLessThan(o.indexOf("hi"));
});

test("clearing status wipes the freed status row (no ghost)", () => {
  const { s, out } = mkScreen();
  s.setInput("x", 1);
  s.setStatus("Thinking…");                     // height 4→5, regionBottom 20→19
  out();
  // clearing: height 5→4, regionBottom 19→20; row 20 (old status) must be cleared.
  const before = out().length;
  s.setStatus(null);
  const after = out().slice(before);
  expect(after).toContain("\x1b[20;1H\x1b[2K");  // explicit clear of the freed row
});
