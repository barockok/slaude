# Pinned Bordered Input Box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sim REPL's `node:readline` input with a claude-code-style rounded input box hard-pinned to the terminal bottom, with output scrolling in the region above, responsive to resize, multi-line capped at 10 visible rows.

**Architecture:** A DECSTBM scroll region reserves the bottom rows for a footer (status spinner + bordered box + hint) drawn with absolute cursor positioning; the rest of the screen scrolls normally. A custom raw-mode line editor replaces readline. Three pure-ish modules: `keys.ts` (decode stdin → tokens), `editor.ts` (editor reducer), `screen.ts` (`layoutFooter` pure math + `Screen` I/O). `cli.ts`'s REPL branch is rewritten to wire them; `term.ts`/`LiveTerminal` is removed.

**Tech Stack:** Bun + TypeScript, `bun:test`. No new deps. Spec: `docs/superpowers/specs/2026-06-05-pinned-input-box-design.md`.

---

## File Structure

- Create `src/gateway/sim/keys.ts` — `decodeKeys(s): Key[]` raw-input decoder.
- Create `src/gateway/sim/editor.ts` — `LineEditor` reducer + `EditorAction`.
- Create `src/gateway/sim/screen.ts` — `layoutFooter(model)` pure + `Screen` class.
- Create `tests/gateway/sim/keys.test.ts`, `tests/gateway/sim/editor.test.ts`, `tests/gateway/sim/screen.test.ts`.
- Modify `src/gateway/sim/cli.ts` — rewrite the REPL (`else`) branch input loop.
- Delete `src/gateway/sim/term.ts` and `tests/gateway/sim/term.test.ts`.
- Reused unchanged: `complete.ts`, `menu.ts`, `interrupt.ts`, `render.ts` (`SPINNER_FRAMES`), `repl.ts`, `roles.ts`, `stub-agent.ts`.

---

## Task 1: Key decoder (`keys.ts`)

**Files:**
- Create: `src/gateway/sim/keys.ts`
- Test: `tests/gateway/sim/keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/keys.test.ts
import { test, expect } from "bun:test";
import { decodeKeys } from "../../../src/gateway/sim/keys";

test("printable text is one token", () => {
  expect(decodeKeys("hi")).toEqual([{ type: "text", value: "hi" }]);
});

test("arrows, home, end, delete", () => {
  expect(decodeKeys("\x1b[A")).toEqual([{ type: "up" }]);
  expect(decodeKeys("\x1b[B")).toEqual([{ type: "down" }]);
  expect(decodeKeys("\x1b[C")).toEqual([{ type: "right" }]);
  expect(decodeKeys("\x1b[D")).toEqual([{ type: "left" }]);
  expect(decodeKeys("\x1b[H")).toEqual([{ type: "home" }]);
  expect(decodeKeys("\x1b[F")).toEqual([{ type: "end" }]);
  expect(decodeKeys("\x1b[3~")).toEqual([{ type: "delete" }]);
});

test("enter, tab, backspace, controls", () => {
  expect(decodeKeys("\r")).toEqual([{ type: "enter" }]);
  expect(decodeKeys("\n")).toEqual([{ type: "enter" }]);
  expect(decodeKeys("\t")).toEqual([{ type: "tab" }]);
  expect(decodeKeys("\x7f")).toEqual([{ type: "backspace" }]);
  expect(decodeKeys("\x01")).toEqual([{ type: "ctrl-a" }]);
  expect(decodeKeys("\x05")).toEqual([{ type: "ctrl-e" }]);
  expect(decodeKeys("\x03")).toEqual([{ type: "ctrl-c" }]);
  expect(decodeKeys("\x04")).toEqual([{ type: "ctrl-d" }]);
  expect(decodeKeys("\x15")).toEqual([{ type: "ctrl-u" }]);
  expect(decodeKeys("\x17")).toEqual([{ type: "ctrl-w" }]);
});

test("lone esc vs bracketed paste markers", () => {
  expect(decodeKeys("\x1b")).toEqual([{ type: "esc" }]);
  expect(decodeKeys("\x1b[200~")).toEqual([{ type: "paste-start" }]);
  expect(decodeKeys("\x1b[201~")).toEqual([{ type: "paste-end" }]);
});

test("mixed run splits text and keys in order", () => {
  expect(decodeKeys("ab\x1b[Dc")).toEqual([
    { type: "text", value: "ab" },
    { type: "left" },
    { type: "text", value: "c" },
  ]);
});

test("paste payload decodes inner content as normal tokens (editor applies paste semantics)", () => {
  expect(decodeKeys("\x1b[200~a\nb\x1b[201~")).toEqual([
    { type: "paste-start" },
    { type: "text", value: "a" },
    { type: "enter" },
    { type: "text", value: "b" },
    { type: "paste-end" },
  ]);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test tests/gateway/sim/keys.test.ts`
Expected: FAIL — `Cannot find module '.../keys'`.

- [ ] **Step 3: Implement `keys.ts`**

```ts
// src/gateway/sim/keys.ts
// Decode a raw stdin chunk (raw mode) into editor key tokens. Pure + stateless:
// bracketed-paste semantics (newlines-as-literal) are applied by the editor via its
// `pasting` flag, so this only needs to surface the paste-start/paste-end markers.
export type Key =
  | { type: "text"; value: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "esc" }
  | { type: "ctrl-a" }
  | { type: "ctrl-e" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-u" }
  | { type: "ctrl-w" }
  | { type: "paste-start" }
  | { type: "paste-end" };

// Longest-match-first escape sequences.
const SEQ: Array<[string, Key]> = [
  ["\x1b[200~", { type: "paste-start" }],
  ["\x1b[201~", { type: "paste-end" }],
  ["\x1b[A", { type: "up" }],
  ["\x1b[B", { type: "down" }],
  ["\x1b[C", { type: "right" }],
  ["\x1b[D", { type: "left" }],
  ["\x1b[H", { type: "home" }],
  ["\x1b[F", { type: "end" }],
  ["\x1b[1~", { type: "home" }],
  ["\x1b[4~", { type: "end" }],
  ["\x1b[3~", { type: "delete" }],
  ["\x1bOH", { type: "home" }],
  ["\x1bOF", { type: "end" }],
];

const CTRL: Record<string, Key> = {
  "\r": { type: "enter" },
  "\n": { type: "enter" },
  "\t": { type: "tab" },
  "\x7f": { type: "backspace" },
  "\x08": { type: "backspace" },
  "\x01": { type: "ctrl-a" },
  "\x05": { type: "ctrl-e" },
  "\x03": { type: "ctrl-c" },
  "\x04": { type: "ctrl-d" },
  "\x15": { type: "ctrl-u" },
  "\x17": { type: "ctrl-w" },
};

export function decodeKeys(s: string): Key[] {
  const out: Key[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ type: "text", value: text }); text = ""; } };
  let i = 0;
  outer: while (i < s.length) {
    const c = s[i]!;
    if (c === "\x1b") {
      for (const [seq, key] of SEQ) {
        if (s.startsWith(seq, i)) { flush(); out.push(key); i += seq.length; continue outer; }
      }
      // Unrecognized CSI/SS3 (e.g. "\x1b[1;5C"): consume the sequence, drop it.
      if (s[i + 1] === "[" || s[i + 1] === "O") {
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j]!)) j++;
        flush(); i = j + 1; continue;
      }
      flush(); out.push({ type: "esc" }); i += 1; continue;
    }
    const ctrl = CTRL[c];
    if (ctrl) { flush(); out.push(ctrl); i += 1; continue; }
    if (c < " ") { i += 1; continue; }   // drop other C0 controls
    text += c; i += 1;
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test tests/gateway/sim/keys.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/keys.ts tests/gateway/sim/keys.test.ts
git commit -m "feat(sim): raw stdin key decoder for the line editor"
```

---

## Task 2: Line editor reducer (`editor.ts`)

**Files:**
- Create: `src/gateway/sim/editor.ts`
- Test: `tests/gateway/sim/editor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/editor.test.ts
import { test, expect } from "bun:test";
import { LineEditor } from "../../../src/gateway/sim/editor";
import type { Key } from "../../../src/gateway/sim/keys";

const feed = (e: LineEditor, ks: Key[]) => ks.map((k) => e.handle(k)).at(-1);
const txt = (v: string): Key => ({ type: "text", value: v });

test("insert and backspace", () => {
  const e = new LineEditor();
  feed(e, [txt("h"), txt("i")]);
  expect(e.view()).toEqual({ text: "hi", cursor: 2 });
  e.handle({ type: "backspace" });
  expect(e.view()).toEqual({ text: "h", cursor: 1 });
});

test("left/right/home/end move cursor", () => {
  const e = new LineEditor();
  feed(e, [txt("abc")]);
  e.handle({ type: "left" });
  expect(e.view().cursor).toBe(2);
  e.handle({ type: "home" });
  expect(e.view().cursor).toBe(0);
  e.handle({ type: "end" });
  expect(e.view().cursor).toBe(3);
  e.handle({ type: "left" });
  e.handle({ type: "delete" });   // deletes char at cursor (the "c")
  expect(e.view().text).toBe("ab");
});

test("ctrl-w deletes previous word, ctrl-u clears to start", () => {
  const e = new LineEditor();
  feed(e, [txt("foo bar")]);
  e.handle({ type: "ctrl-w" });
  expect(e.view().text).toBe("foo ");
  e.handle({ type: "ctrl-u" });
  expect(e.view()).toEqual({ text: "", cursor: 0 });
});

test("enter submits and clears", () => {
  const e = new LineEditor();
  feed(e, [txt("hello")]);
  const a = e.handle({ type: "enter" });
  expect(a).toEqual({ type: "submit", text: "hello" });
  expect(e.view()).toEqual({ text: "", cursor: 0 });
});

test("trailing backslash continues to a newline instead of submitting", () => {
  const e = new LineEditor();
  feed(e, [txt("line1\\")]);
  const a = e.handle({ type: "enter" });
  expect(a).toEqual({ type: "render" });
  expect(e.view().text).toBe("line1\n");
});

test("up/down recall history and restore draft", () => {
  const e = new LineEditor();
  feed(e, [txt("first")]); e.handle({ type: "enter" });
  feed(e, [txt("second")]); e.handle({ type: "enter" });
  feed(e, [txt("draft")]);
  e.handle({ type: "up" });
  expect(e.view().text).toBe("second");
  e.handle({ type: "up" });
  expect(e.view().text).toBe("first");
  e.handle({ type: "down" });
  expect(e.view().text).toBe("second");
  e.handle({ type: "down" });
  expect(e.view().text).toBe("draft");
});

test("ctrl-d on empty buffer is eof, otherwise forward-delete", () => {
  const e = new LineEditor();
  expect(e.handle({ type: "ctrl-d" })).toEqual({ type: "eof" });
  feed(e, [txt("x")]); e.handle({ type: "home" });
  expect(e.handle({ type: "ctrl-d" })).toEqual({ type: "render" });
  expect(e.view().text).toBe("");
});

test("bracketed paste inserts newlines literally without submitting", () => {
  const e = new LineEditor();
  const a = feed(e, [
    { type: "paste-start" },
    txt("a"), { type: "enter" }, txt("b"),
    { type: "paste-end" },
  ]);
  expect(a).toEqual({ type: "render" });
  expect(e.view().text).toBe("a\nb");
});

test("tab requests completion", () => {
  const e = new LineEditor();
  feed(e, [txt("/lay")]);
  expect(e.handle({ type: "tab" })).toEqual({ type: "complete", line: "/lay" });
  e.applyCompletion("/layer ");
  expect(e.view()).toEqual({ text: "/layer ", cursor: 7 });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test tests/gateway/sim/editor.test.ts`
Expected: FAIL — `Cannot find module '.../editor'`.

- [ ] **Step 3: Implement `editor.ts`**

```ts
// src/gateway/sim/editor.ts
import type { Key } from "./keys";

export type EditorAction =
  | { type: "render" }
  | { type: "none" }
  | { type: "submit"; text: string }
  | { type: "complete"; line: string }
  | { type: "sigint" }
  | { type: "eof" };

/** Pure line-editor reducer — readline parity (insert/erase/move/history/paste/multiline)
 *  with zero I/O. The caller decodes stdin to Keys, feeds them here, and paints `view()`. */
export class LineEditor {
  text = "";
  cursor = 0;
  pasting = false;
  #history: string[] = [];
  #hist = -1;       // -1 = live draft; else index into #history
  #draft = "";      // live line stashed while browsing history

  view(): { text: string; cursor: number } { return { text: this.text, cursor: this.cursor }; }
  applyCompletion(line: string) { this.text = line; this.cursor = line.length; }

  handle(k: Key): EditorAction {
    if (this.pasting) return this.#paste(k);
    switch (k.type) {
      case "paste-start": this.pasting = true; return { type: "none" };
      case "paste-end": return { type: "none" };
      case "text": return this.#insert(k.value);
      case "enter": return this.#enter();
      case "tab": return { type: "complete", line: this.text };
      case "backspace": return this.#erase(-1);
      case "delete": return this.#erase(0);
      case "left": return this.#move(-1);
      case "right": return this.#move(1);
      case "home": case "ctrl-a": this.cursor = 0; return { type: "render" };
      case "end": case "ctrl-e": this.cursor = this.text.length; return { type: "render" };
      case "ctrl-u": return this.#killToStart();
      case "ctrl-w": return this.#killWord();
      case "up": return this.#hist === -1 ? this.#histInto() : this.#histStep(-1);
      case "down": return this.#histStep(1);
      case "ctrl-c": return { type: "sigint" };
      case "ctrl-d": return this.text.length === 0 ? { type: "eof" } : this.#erase(0);
      case "esc": return { type: "none" };
      default: return { type: "none" };
    }
  }

  #paste(k: Key): EditorAction {
    if (k.type === "paste-end") { this.pasting = false; return { type: "render" }; }
    if (k.type === "text") return this.#insert(k.value);
    if (k.type === "enter") return this.#insert("\n");
    if (k.type === "tab") return this.#insert("\t");
    return { type: "none" };
  }

  #insert(s: string): EditorAction {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
    return { type: "render" };
  }
  #erase(off: -1 | 0): EditorAction {
    const at = this.cursor + off;
    if (at < 0 || at >= this.text.length) return { type: "none" };
    this.text = this.text.slice(0, at) + this.text.slice(at + 1);
    this.cursor = at < this.cursor ? this.cursor - 1 : this.cursor;
    return { type: "render" };
  }
  #move(d: -1 | 1): EditorAction {
    const n = this.cursor + d;
    if (n < 0 || n > this.text.length) return { type: "none" };
    this.cursor = n; return { type: "render" };
  }
  #killToStart(): EditorAction {
    if (this.cursor === 0) return { type: "none" };
    this.text = this.text.slice(this.cursor); this.cursor = 0; return { type: "render" };
  }
  #killWord(): EditorAction {
    if (this.cursor === 0) return { type: "none" };
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.text[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.text[i - 1]!)) i--;
    this.text = this.text.slice(0, i) + this.text.slice(this.cursor);
    this.cursor = i; return { type: "render" };
  }
  #enter(): EditorAction {
    if (this.text.endsWith("\\")) {            // explicit continuation
      this.text = this.text.slice(0, -1) + "\n";
      this.cursor = this.text.length;
      return { type: "render" };
    }
    const out = this.text;
    if (out.trim().length) this.#history.push(out);
    this.text = ""; this.cursor = 0; this.#hist = -1; this.#draft = "";
    return { type: "submit", text: out };
  }
  #histInto(): EditorAction {
    if (this.#history.length === 0) return { type: "none" };
    this.#draft = this.text;
    this.#hist = this.#history.length - 1;
    return this.#loadHist();
  }
  #histStep(d: -1 | 1): EditorAction {
    if (this.#hist === -1) return { type: "none" };
    const n = this.#hist + d;
    if (n < 0) return { type: "none" };
    if (n >= this.#history.length) {           // back to the live draft
      this.#hist = -1; this.text = this.#draft; this.cursor = this.text.length;
      return { type: "render" };
    }
    this.#hist = n; return this.#loadHist();
  }
  #loadHist(): EditorAction {
    this.text = this.#history[this.#hist]!; this.cursor = this.text.length;
    return { type: "render" };
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test tests/gateway/sim/editor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/editor.ts tests/gateway/sim/editor.test.ts
git commit -m "feat(sim): pure line-editor reducer (readline parity, no I/O)"
```

---

## Task 3: Footer layout math (`screen.ts` — pure `layoutFooter`)

**Files:**
- Create: `src/gateway/sim/screen.ts` (pure part only this task)
- Test: `tests/gateway/sim/screen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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

test("status line present adds a row above the box and shifts cursor", () => {
  const a = layoutFooter({ ...base, status: null, text: "x", cursor: 1 });
  const b = layoutFooter({ ...base, status: "⠋ Thinking… (2s)", text: "x", cursor: 1 });
  expect(b.height).toBe(a.height + 1);
  expect(b.lines[0]).toContain("Thinking");
  expect(b.cursorRow).toBe(a.cursorRow + 1);
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test tests/gateway/sim/screen.test.ts`
Expected: FAIL — `layoutFooter` not exported.

- [ ] **Step 3: Implement the pure `layoutFooter` in `screen.ts`**

```ts
// src/gateway/sim/screen.ts
export interface FooterModel {
  status: string | null;   // pre-composed status (spinner+label+elapsed), or null when idle
  text: string;            // editor buffer, may contain "\n"
  cursor: number;          // index into text
  hint: string;
  cols: number;
  rows: number;
}

export interface FooterLayout {
  lines: string[];         // footer rows, top→bottom: [status?], boxTop, content…, boxBottom, hint
  height: number;          // lines.length
  regionBottom: number;    // scroll-region bottom = rows - height
  cursorRow: number;       // 1-based absolute terminal row for the hardware cursor
  cursorCol: number;       // 1-based absolute terminal col
}

const MAX_ROWS = 10;       // multi-line input cap (visible content rows)
const PROMPT = "› ";

/** Pure: compute the footer's rendered lines + where the cursor lands. No I/O. */
export function layoutFooter(m: FooterModel): FooterLayout {
  const cols = Math.max(8, m.cols);
  const innerW = cols - 4;                 // "│ " + content + " │"
  const logical = m.text.split("\n");

  // Locate cursor as (line, col) within logical lines.
  let cLine = 0, cCol = 0, seen = 0;
  for (let i = 0; i < logical.length; i++) {
    const len = logical[i]!.length;
    if (m.cursor <= seen + len) { cLine = i; cCol = m.cursor - seen; break; }
    seen += len + 1;                       // +1 for the "\n"
    cLine = i + 1; cCol = 0;
  }

  // Windowing: cap to MAX_ROWS, keep the cursor line visible.
  const boxRows = Math.min(MAX_ROWS, logical.length);
  const start = cLine < boxRows ? 0 : cLine - boxRows + 1;
  const window = logical.slice(start, start + boxRows);

  // Render content rows (prompt only on logical line 0; horizontal clip keeps cursor visible).
  const content = window.map((line, idx) => {
    const prefix = start + idx === 0 ? PROMPT : "  ";
    const isCursorLine = start + idx === cLine;
    const raw = prefix + line;
    let hoff = 0;
    if (isCursorLine) {
      const cx = prefix.length + cCol;
      if (cx > innerW) hoff = cx - innerW;   // shift left so the cursor is the rightmost cell
    }
    const shown = raw.slice(hoff, hoff + innerW);
    return "│ " + shown.padEnd(innerW, " ") + " │";
  });

  const top = "╭" + "─".repeat(cols - 2) + "╮";
  const bottom = "╰" + "─".repeat(cols - 2) + "╯";
  const hint = clip(m.hint, cols);

  const lines = [...(m.status ? [clip(m.status, cols)] : []), top, ...content, bottom, hint];
  const height = lines.length;
  const regionBottom = Math.max(1, m.rows - height);

  // Absolute cursor position.
  const boxTopRow = regionBottom + 1 + (m.status ? 1 : 0);
  const cursorRow = boxTopRow + 1 + (cLine - start);
  const prefixLen = cLine === 0 ? PROMPT.length : 2;
  const cxRaw = prefixLen + cCol;
  const cxClipped = Math.min(cxRaw, innerW);
  const cursorCol = 3 + cxClipped;          // 1 "│", 2 " ", content starts at col 3

  return { lines, height, regionBottom, cursorRow, cursorCol };
}

function clip(s: string, width: number): string {
  // Clip on visible length; ANSI is rare in status/hint here and kept short by callers.
  return s.length > width ? s.slice(0, width) : s;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test tests/gateway/sim/screen.test.ts`
Expected: PASS.

> Note: if `cursorCol` for the multi-line/clip test disagrees by the horizontal-offset rule, the test asserts the first-line case (`cursor:2`, no clip) — keep `layoutFooter` matching that exact arithmetic (`3 + prefixLen + cCol` when unclipped).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/screen.ts tests/gateway/sim/screen.test.ts
git commit -m "feat(sim): pure footer layout math for the pinned input box"
```

---

## Task 4: `Screen` chrome (I/O on top of `layoutFooter`)

**Files:**
- Modify: `src/gateway/sim/screen.ts` (append the `Screen` class)
- Test: `tests/gateway/sim/screen.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/gateway/sim/screen.test.ts
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test tests/gateway/sim/screen.test.ts`
Expected: FAIL — `Screen` not exported.

- [ ] **Step 3: Append the `Screen` class to `screen.ts`**

```ts
// append to src/gateway/sim/screen.ts
import { SPINNER_FRAMES } from "./render";

type SizeFn = () => { rows: number; cols: number };

/** Owns the bottom-pinned footer (status spinner + bordered input box + hint) and the
 *  scroll region above it. I/O is injected (write sink + size getter) so layout is testable
 *  without a TTY. Mutators re-render immediately; tick() advances the spinner. */
export class Screen {
  #write: (s: string) => void;
  #size: SizeFn;
  #frames: string[];
  #now: () => number;

  #text = "";
  #cursor = 0;
  #hint = "";
  #label: string | null = null;
  #frame = 0;
  #startedAt = 0;
  #height = 0;          // current footer height (for region-change detection)

  constructor(write: (s: string) => void, size: SizeFn, opts: { frames?: string[]; now?: () => number } = {}) {
    this.#write = write;
    this.#size = size;
    this.#frames = opts.frames ?? SPINNER_FRAMES;
    this.#now = opts.now ?? (() => Date.now());
  }

  setHint(hint: string) { this.#hint = hint; this.#render(); }
  setInput(text: string, cursor: number) { this.#text = text; this.#cursor = cursor; this.#render(); }

  setStatus(label: string | null) {
    if (label === null) { this.#label = null; this.#render(); return; }
    if (this.#label === null) { this.#frame = 0; this.#startedAt = this.#now(); }
    this.#label = label; this.#render();
  }
  tick() { if (this.#label === null) return; this.#frame = (this.#frame + 1) % this.#frames.length; this.#render(); }

  /** Commit a scrollback line into the scrolling region above the footer. */
  print(line: string) {
    const { rows, cols } = this.#size();
    const L = this.#layout(rows, cols);
    for (const seg of line.split("\n")) {
      // Park at the region's last row and newline so the region scrolls up by one.
      this.#write(`\x1b[${L.regionBottom};1H\x1b[2K${seg}\n`);
    }
    this.#render();   // repaint footer + reposition cursor
  }

  resize() { this.#render(); }

  restore() {
    const { rows } = this.#size();
    this.#write("\x1b[r");                 // reset scroll region
    this.#write(`\x1b[${rows};1H`);        // park at the bottom
    this.#write("\x1b[?2004l");            // bracketed paste off
    this.#write("\x1b[?25h\n");            // show cursor + newline
  }

  #composeStatus(): string | null {
    if (this.#label === null) return null;
    const secs = Math.floor((this.#now() - this.#startedAt) / 1000);
    return `${this.#frames[this.#frame]} ${this.#label} (${secs}s)`;
  }

  #layout(rows: number, cols: number): FooterLayout {
    return layoutFooter({ status: this.#composeStatus(), text: this.#text, cursor: this.#cursor, hint: this.#hint, cols, rows });
  }

  #render() {
    const { rows, cols } = this.#size();
    const L = this.#layout(rows, cols);
    let buf = "\x1b[?25l";                                  // hide cursor during repaint
    if (L.height !== this.#height) {
      buf += `\x1b[1;${L.regionBottom}r`;                   // (re)set scroll region
      // Clear the whole footer band so a shrunk footer leaves no stragglers.
      for (let r = L.regionBottom + 1; r <= rows; r++) buf += `\x1b[${r};1H\x1b[2K`;
      this.#height = L.height;
    }
    L.lines.forEach((ln, i) => { buf += `\x1b[${L.regionBottom + 1 + i};1H\x1b[2K${ln}`; });
    buf += `\x1b[${L.cursorRow};${L.cursorCol}H\x1b[?25h`;  // park + show cursor
    this.#write(buf);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test tests/gateway/sim/screen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/screen.ts tests/gateway/sim/screen.test.ts
git commit -m "feat(sim): Screen chrome — pinned footer + scroll region (injected I/O)"
```

---

## Task 5: Wire the REPL to `Screen` + custom editor (`cli.ts`); remove `term.ts`

**Files:**
- Modify: `src/gateway/sim/cli.ts` (REPL `else` branch, ~lines 103–264)
- Delete: `src/gateway/sim/term.ts`, `tests/gateway/sim/term.test.ts`

- [ ] **Step 1: Replace the REPL branch body**

In `cli.ts`, the `else {` branch (currently constructing `LiveTerminal`, `createInterface`, the `rl.on(...)` handlers) is replaced. Keep the `if (isRun) { … }` branch above it untouched. New body:

```ts
} else {
  const { ReplController, replCommandNames } = await import("./repl");
  const { Screen } = await import("./screen");
  const { decodeKeys } = await import("./keys");
  const { LineEditor } = await import("./editor");
  const { completeLine, completeArg } = await import("./complete");
  const { sigintAction } = await import("./interrupt");
  const { LAYERS, ROLE_NAMES } = await import("./roles");
  const { BEHAVIORS } = await import("./stub-agent");
  const { renderMenu, decodeKey, menuReduce } = await import("./menu");

  const r = new ReplController(agentMode, soulMd);
  const screen = new Screen((s) => process.stdout.write(s), () => ({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  }));
  const editor = new LineEditor();
  const paint = () => { const v = editor.view(); screen.setInput(v.text, v.cursor); };

  r.onOutput((l) => screen.print(l));
  r.onStatus((l) => screen.setStatus(l));
  const spin = setInterval(() => screen.tick(), 120);

  // Tab-completion sources (same as before).
  const cmdNames = replCommandNames();
  const argMap: Record<string, string[]> = {
    "/layer": LAYERS.map((l) => l.name),
    "/as": [...ROLE_NAMES],
    "/behavior": Object.keys(BEHAVIORS),
  };
  const complete = (line: string): string | null => {
    const hits = line.includes(" ") ? completeArg(line, argMap) : completeLine(line, cmdNames);
    return hits.length === 1 ? hits[0]! : null;   // single hit → apply; ambiguous → leave as-is
  };

  // Intro.
  const modeLabel = agentMode === "real" ? "live agent" : "stub";
  const tail = `a/d/A (or 1/2/3) answers gates · /help · Ctrl-D quits.${verbose ? "" : "  (--verbose for infra logs)"}`;
  screen.setHint(tail);
  screen.print(`\x1b[1m✻ slaude sim\x1b[0m  \x1b[2m${modeLabel}\x1b[0m`);
  if (shared) {
    await r.startShared();
    screen.print(`\x1b[2mshared config (real ~/.slaude, state under sim/)\x1b[0m`);
  } else {
    await r.startDefault();
    screen.print(`\x1b[2m${soulPath ? `soul=${soulPath} · ` : ""}fixture — /layer · /as · /behavior, then chat.\x1b[0m`);
  }
  paint();

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  process.stdout.write("\x1b[?2004h");   // enable bracketed paste

  const cleanup = () => {
    clearInterval(spin);
    process.stdout.write("\x1b[?2004l");
    screen.restore();
    stdin.setRawMode?.(false);
  };
  const quit = async () => { cleanup(); await r.dispose(); process.exit(0); };

  process.stdout.on("resize", () => screen.resize());

  // Turn execution: a running turn owns the keyboard for mid-turn abort (Esc / Ctrl-C).
  let busy = false;
  let sigintPending = false;

  const runTurn = async (input: string) => {
    busy = true;
    const onAbortKey = (b: Buffer) => { const s = b.toString(); if (s === "\x1b" || s === "\x03") r.abort(); };
    stdin.on("data", onAbortKey);
    try { await r.handle(input); }
    catch (e) { screen.print(`! ${(e as Error).message}`); }
    finally { stdin.off("data", onAbortKey); busy = false; paint(); }
  };

  // Bare `/layer` / `/as` open a picker (claude-code-style), drawn through screen.print.
  const pickFrom = (title: string, items: { label: string; hint?: string }[]): Promise<number | null> =>
    new Promise((resolve) => {
      let cursor = 0;
      const draw = () => screen.print(renderMenu(title, items, cursor).join("\n"));
      draw();
      const onKey = (b: Buffer) => {
        const res = menuReduce(cursor, items.length, decodeKey(b.toString()));
        cursor = res.cursor;
        if (!res.done) { draw(); return; }
        stdin.off("data", onKey);
        resolve(res.done === "select" ? cursor : null);
      };
      stdin.on("data", onKey);
    });

  const submit = async (full: string) => {
    const t = full.trim();
    if (t === "/layer") {
      const pick = await pickFrom("Pick a channel layer:", LAYERS.map((l) => ({ label: l.name, hint: l.desc })));
      if (pick !== null) await runTurn(`/layer ${LAYERS[pick]!.name}`);
      else paint();
    } else if (t === "/as") {
      const pick = await pickFrom("Act as which role:", ROLE_NAMES.map((n) => ({ label: n })));
      if (pick !== null) await runTurn(`/as ${ROLE_NAMES[pick]}`);
      else paint();
    } else if (t) {
      await runTurn(full);
    } else { paint(); }
  };

  stdin.on("data", (buf: Buffer) => {
    if (busy) return;                                   // abort handler owns keys mid-turn
    for (const k of decodeKeys(buf.toString())) {
      const a = editor.handle(k);
      if (a.type === "render" || a.type === "none") { sigintPending = false; paint(); }
      else if (a.type === "submit") { sigintPending = false; paint(); void submit(a.text); }
      else if (a.type === "complete") { const c = complete(a.line); if (c) editor.applyCompletion(c); paint(); }
      else if (a.type === "eof") { void quit(); }
      else if (a.type === "sigint") {
        const { action, pending } = sigintAction(sigintPending, editor.view().text.length);
        sigintPending = pending;
        if (action === "clear") { editor.applyCompletion(""); paint(); }
        else if (action === "warn") { screen.print("\x1b[2m(press Ctrl-C again to exit)\x1b[0m"); paint(); }
        else void quit();
      }
    }
  });
}
```

- [ ] **Step 2: Delete the superseded terminal module + its test**

```bash
git rm src/gateway/sim/term.ts tests/gateway/sim/term.test.ts
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (If `process.stdout.on("resize", …)` or `stdin.on("data", …)` types complain, the handlers already match Node's `Buffer` signature used elsewhere in this file.)

- [ ] **Step 4: Run the full unit suite**

Run: `bun test`
Expected: PASS. No remaining references to `term.ts` (the old `term.test.ts` is gone).

- [ ] **Step 5: Commit**

```bash
git add -A src/gateway/sim/cli.ts
git commit -m "feat(sim): pinned bordered input box — raw-mode editor replaces readline"
```

---

## Task 6: Manual smoke + finding doc

**Files:**
- Create: `docs/findings/2026-06-05-pinned-input-box.md`
- Modify: `CLAUDE.md` (Findings Log index — add newest-first entry)

- [ ] **Step 1: Manual smoke test (real TTY — cannot be unit-tested)**

Run: `bun run sim --stub`
Verify each:
- Box renders at the bottom, full terminal width, rounded corners.
- Output (intro lines, `/help`) scrolls above the box; box stays pinned.
- Type text; Left/Right/Home/End/Ctrl-A/E move; Backspace/Delete/Ctrl-U/Ctrl-W erase.
- `↑`/`↓` recall history after submitting a couple of messages.
- `Tab` completes `/lay` → `/layer `.
- Trailing `\` + Enter starts a second line; box grows; Enter submits the multi-line message.
- Paste a multi-line block → arrives as one multi-line message (not N submits).
- Resize the terminal → box redraws at the new width, stays pinned.
- Trigger a gate (e.g. message that asks for a tool) → answer `a`/`d`/`A`.
- `/layer` with no arg → picker; arrow + Enter selects; Esc cancels.
- `Ctrl-C` clears a typed line; `Ctrl-C` twice on empty → exit. `Ctrl-D` on empty → exit cleanly (cursor restored, no stuck scroll region — run `reset` only if needed).

- [ ] **Step 2: Write the finding doc**

```markdown
# Pinned bordered input box (sim REPL)

**Date:** 2026-06-05

Replaced the sim REPL's `node:readline` input with a claude-code-style rounded box
pinned to the terminal bottom via a DECSTBM scroll region.

## What
- `keys.ts` decodes raw stdin → key tokens (incl. bracketed-paste markers).
- `editor.ts` is a pure line-editor reducer (readline parity, no I/O).
- `screen.ts` = pure `layoutFooter` math + `Screen` chrome (scroll region + footer, injected I/O).
- `cli.ts` REPL branch rewritten to a raw-mode loop; `term.ts`/`LiveTerminal` removed.

## Why readline had to go
readline owns a single line at the cursor and can't live inside a fixed bottom region.
A pinned box needs absolute-positioned redraws on every keystroke, so the editor is custom.

## Decisions / limits
- Multi-line input capped at 10 visible rows (windowed to keep the cursor visible).
- `↑`/`↓` are history recall (not in-buffer line navigation) — simpler, matches the old REPL.
- Bracketed paste (`ESC[?2004h`) frames pastes; ancient terminals fall back to literal insert.
- No soft-wrap inside the box — long lines clip horizontally around the cursor.

Spec: `docs/superpowers/specs/2026-06-05-pinned-input-box-design.md`
Plan: `docs/superpowers/plans/2026-06-05-pinned-input-box.md`
```

- [ ] **Step 3: Add the Findings Log index entry**

In `CLAUDE.md`, under `## Findings Log`, add as the newest (first) bullet:

```markdown
- [2026-06-05 — Pinned bordered input box (sim REPL)](docs/findings/2026-06-05-pinned-input-box.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/findings/2026-06-05-pinned-input-box.md CLAUDE.md
git commit -m "docs(sim): finding for the pinned bordered input box"
```

---

## Self-Review Notes

- **Spec coverage:** box border (Task 3/4 `layoutFooter`/`Screen`), pinned-to-bottom + scroll region (Task 4 `print`/`#render`), responsive resize (Task 4 `resize` + Task 5 `resize` listener), multi-line cap 10 (Task 3 `MAX_ROWS`), custom editor parity (Task 2), bracketed paste (Task 1+2), pickers/gates preserved (Task 5), `term.ts` removed (Task 5). All covered.
- **Types consistent:** `Key` (keys.ts) consumed by `editor.ts` + `cli.ts`; `EditorAction` variants all handled in the `cli.ts` `data` switch; `FooterModel`/`FooterLayout` shared by `layoutFooter` + `Screen`.
- **No placeholders:** every step carries full code/commands.
```
