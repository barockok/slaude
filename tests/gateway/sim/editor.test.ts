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

test("insert mid-string at cursor", () => {
  const e = new LineEditor();
  feed(e, [txt("ac")]);
  e.handle({ type: "left" });
  feed(e, [txt("b")]);
  expect(e.view()).toEqual({ text: "abc", cursor: 2 });
});

test("ctrl-d at end of non-empty buffer is a no-op (not eof)", () => {
  const e = new LineEditor();
  feed(e, [txt("x")]);   // cursor at end
  expect(e.handle({ type: "ctrl-d" })).toEqual({ type: "none" });
  expect(e.view().text).toBe("x");
});

test("empty enter submits empty text without recording history", () => {
  const e = new LineEditor();
  expect(e.handle({ type: "enter" })).toEqual({ type: "submit", text: "" });
  e.handle({ type: "up" });                  // nothing in history → no change
  expect(e.view().text).toBe("");
});

test("tab requests completion", () => {
  const e = new LineEditor();
  feed(e, [txt("/lay")]);
  expect(e.handle({ type: "tab" })).toEqual({ type: "complete", line: "/lay" });
  e.applyCompletion("/layer ");
  expect(e.view()).toEqual({ text: "/layer ", cursor: 7 });
});
