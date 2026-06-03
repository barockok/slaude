import { describe, it, expect } from "bun:test";
import { LiveTerminal } from "../../../src/gateway/sim/term";

const CLEAR = "\r\x1b[2K";   // carriage-return + erase-line

function harness(now = () => 0) {
  const w: string[] = [];
  const t = new LiveTerminal((s) => w.push(s), { frames: ["A", "B", "C"], now });
  return { t, w, out: () => w.join("") };
}

describe("LiveTerminal — bottom-pinned live status region", () => {
  it("status() paints a clear + frame + label + elapsed, in place", () => {
    const { t, out } = harness(() => 0);
    t.status("Thinking…");
    const o = out();
    expect(o).toContain(CLEAR);
    expect(o).toContain("A");           // first frame
    expect(o).toContain("Thinking…");
    expect(o).toContain("(0s)");
    expect(o).not.toContain("\n");      // in place — never a newline
  });

  it("tick() advances the spinner frame without changing the label", () => {
    const { t, w } = harness(() => 0);
    t.status("Thinking…");
    w.length = 0;
    t.tick();
    const o = w.join("");
    expect(o).toContain("B");           // next frame
    expect(o).toContain("Thinking…");
    expect(o.startsWith(CLEAR)).toBe(true);
  });

  it("elapsed seconds track the injected clock", () => {
    let ms = 0;
    const { t, w } = harness(() => ms);
    t.status("Working…");
    ms = 4200;
    w.length = 0;
    t.tick();
    expect(w.join("")).toContain("(4s)");
  });

  it("print() commits a scrollback line above the status, then repaints status", () => {
    const { t, w } = harness(() => 0);
    t.status("Thinking…");
    w.length = 0;
    t.print("⏺ Bash(ls)");
    const o = w.join("");
    // clear region → line + newline → repaint status
    const line = o.indexOf("⏺ Bash(ls)");
    const nl = o.indexOf("\n", line);
    const restatus = o.indexOf("Thinking…");
    expect(line).toBeGreaterThanOrEqual(0);
    expect(nl).toBeGreaterThan(line);
    expect(restatus).toBeGreaterThan(nl);          // status repainted after the committed line
    expect(o.startsWith(CLEAR)).toBe(true);
  });

  it("print() with no active status just writes the line + newline (no stray frame)", () => {
    const { t, w } = harness(() => 0);
    t.print("hello");
    const o = w.join("");
    expect(o).toContain("hello\n");
    expect(o).not.toContain("A");                  // no spinner frame painted
  });

  it("status(null) clears the region and leaves no label", () => {
    const { t, w } = harness(() => 0);
    t.status("Thinking…");
    w.length = 0;
    t.status(null);
    const o = w.join("");
    expect(o).toContain(CLEAR);
    expect(o).not.toContain("Thinking…");
    expect(o).not.toContain("\n");
  });

  it("tick() is a no-op while no status is active", () => {
    const { t, w } = harness(() => 0);
    t.tick();
    expect(w.join("")).toBe("");
  });
});
