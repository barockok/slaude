import { describe, it, expect } from "bun:test";
import { renderMenu, decodeKey, menuReduce, type MenuItem } from "../../../src/gateway/sim/menu";

const items: MenuItem[] = [
  { label: "1. manager-dm", hint: "Manager in a DM" },
  { label: "2. member-public", hint: "Public channel" },
  { label: "3. approval-flow" },
];

describe("renderMenu", () => {
  it("renders title + one line per item + a footer hint", () => {
    const lines = renderMenu("Pick a scenario:", items, 0);
    expect(lines[0]).toContain("Pick a scenario:");
    expect(lines.length).toBe(items.length + 2);   // title + items + footer
    expect(lines[lines.length - 1]).toMatch(/Enter|Esc|↑|↓/);
  });

  it("marks the cursor row with a ❯ pointer and the others without", () => {
    const lines = renderMenu("t", items, 1);
    expect(lines[2]).toContain("❯");          // item index 1 → line index 2 (after title)
    expect(lines[1]).not.toContain("❯");
    expect(lines[3]).not.toContain("❯");
  });

  it("includes each item label and hint", () => {
    const lines = renderMenu("t", items, 0).join("\n");
    expect(lines).toContain("manager-dm");
    expect(lines).toContain("Manager in a DM");
    expect(lines).toContain("approval-flow");
  });
});

describe("decodeKey", () => {
  it("maps arrow escape sequences and vi keys", () => {
    expect(decodeKey("\x1b[A")).toBe("up");
    expect(decodeKey("\x1b[B")).toBe("down");
    expect(decodeKey("k")).toBe("up");
    expect(decodeKey("j")).toBe("down");
  });
  it("maps enter, esc, ctrl-c", () => {
    expect(decodeKey("\r")).toBe("enter");
    expect(decodeKey("\n")).toBe("enter");
    expect(decodeKey("\x1b")).toBe("esc");
    expect(decodeKey("\x03")).toBe("esc");
  });
  it("everything else is other", () => {
    expect(decodeKey("x")).toBe("other");
  });
});

describe("menuReduce", () => {
  it("up/down move the cursor and wrap around", () => {
    expect(menuReduce(0, 3, "down").cursor).toBe(1);
    expect(menuReduce(2, 3, "down").cursor).toBe(0);   // wrap forward
    expect(menuReduce(0, 3, "up").cursor).toBe(2);     // wrap back
  });
  it("enter selects, esc cancels, both keep the cursor", () => {
    expect(menuReduce(1, 3, "enter")).toEqual({ cursor: 1, done: "select" });
    expect(menuReduce(1, 3, "esc")).toEqual({ cursor: 1, done: "cancel" });
  });
  it("other is a no-op", () => {
    expect(menuReduce(1, 3, "other")).toEqual({ cursor: 1 });
  });
});
