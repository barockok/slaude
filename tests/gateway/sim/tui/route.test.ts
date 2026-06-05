import { test, expect } from "bun:test";
import { routeSubmit } from "../../../../src/gateway/sim/tui/route";

test("bare /layer and /as open pickers", () => {
  expect(routeSubmit("/layer")).toEqual({ kind: "picker", which: "layer" });
  expect(routeSubmit("  /as  ")).toEqual({ kind: "picker", which: "as" });
});

test("/help opens help", () => {
  expect(routeSubmit("/help")).toEqual({ kind: "help" });
});

test("/layer with an arg is a normal send (not a picker)", () => {
  expect(routeSubmit("/layer trusted")).toEqual({ kind: "send", text: "/layer trusted" });
});

test("plain text and gate answers send through", () => {
  expect(routeSubmit("hello team")).toEqual({ kind: "send", text: "hello team" });
  expect(routeSubmit("a")).toEqual({ kind: "send", text: "a" });
});

test("blank line is a no-op", () => {
  expect(routeSubmit("   ")).toEqual({ kind: "noop" });
});
