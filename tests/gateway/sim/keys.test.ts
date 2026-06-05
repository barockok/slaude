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

test("unrecognized CSI sequences are dropped, surrounding text preserved", () => {
  // Ctrl-Right ("\x1b[1;5C") isn't in the table → consumed and dropped.
  expect(decodeKeys("a\x1b[1;5Cb")).toEqual([
    { type: "text", value: "a" },
    { type: "text", value: "b" },
  ]);
  // A CSI with no terminator in this chunk consumes to end without skipping a phantom byte.
  expect(decodeKeys("x\x1b[1;5")).toEqual([{ type: "text", value: "x" }]);
});
