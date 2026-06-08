/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ReplController } from "../../../../src/gateway/sim/repl";
import { App } from "../../../../src/gateway/sim/tui/app";
import { Help } from "../../../../src/gateway/sim/tui/help";
import { Picker } from "../../../../src/gateway/sim/tui/picker";
import { banner } from "../../../../src/gateway/sim/tui/banner";

/** Minimal stand-in for ReplController exposing only what App touches. Captures the onOutput /
 *  onStatus callbacks so the test can drive scrollback + status, and records handle() calls. */
function makeFake() {
  let out: (l: string) => void = () => {};
  let status: (l: string | null) => void = () => {};
  const handled: string[] = [];
  const fake = {
    onOutput(fn: (l: string) => void) { out = fn; },
    onStatus(fn: (l: string | null) => void) { status = fn; },
    handle(text: string) { handled.push(text); return Promise.resolve(); },
    abort() {},
    dispose() { return Promise.resolve(); },
    helpLines() { return [] as string[]; },
  };
  return {
    repl: fake as unknown as ReplController,
    pushOutput: (l: string) => out(l),
    pushStatus: (l: string | null) => status(l),
    handled,
  };
}

test("output lines render into the scrollback", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={{ name: "A-Claw", version: "0.0.0", meta: [] }} />, { width: 80, height: 24 });
  try {
    f.pushOutput("agent says hi");
    const frame = await t.waitForFrame((fr) => fr.includes("agent says hi"), { maxPasses: 40 });
    expect(frame).toContain("agent says hi");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("a status label renders below the scrollback", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={{ name: "A-Claw", version: "0.0.0", meta: [] }} />, { width: 80, height: 24 });
  try {
    f.pushStatus("Thinking…");
    const frame = await t.waitForFrame((fr) => fr.includes("Thinking"), { maxPasses: 40 });
    expect(frame).toContain("Thinking");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("the hint shows in the default (no-overlay) frame", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="enter to send" helpLines={[]} header={{ name: "A-Claw", version: "0.0.0", meta: [] }} />, { width: 80, height: 24 });
  try {
    const frame = await t.waitForFrame((fr) => fr.includes("enter to send"), { maxPasses: 40 });
    expect(frame).toContain("enter to send");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("the header shows name, version and meta in the scroll body", async () => {
  const f = makeFake();
  const t = await testRender(
    <App repl={f.repl} hint="hint" helpLines={[]} header={{ name: "A-Claw", version: "9.9.9", meta: ["stub agent · fixture"] }} />,
    { width: 80, height: 24 },
  );
  try {
    const frame = await t.waitForFrame((fr) => fr.includes("A-Claw") && fr.includes("v9.9.9"), { maxPasses: 40 });
    expect(frame).toContain("A-Claw");
    expect(frame).toContain("v9.9.9");
    expect(frame).toContain("stub agent · fixture");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("the help overlay shows its lines and the close hint", async () => {
  const t = await testRender(<Help lines={["line A", "line B"]} />, { width: 80, height: 24 });
  try {
    const frame = await t.waitForFrame((fr) => fr.includes("line A"), { maxPasses: 40 });
    expect(frame).toContain("line A");
    expect(frame).toContain("line B");
    expect(frame).toContain("Esc to close");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("typing a line and pressing Enter routes through to repl.handle (mockInput)", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={{ name: "A-Claw", version: "0.0.0", meta: [] }} />, { width: 80, height: 24 });
  try {
    await new Promise((r) => setTimeout(r, 100)); // let the input focus + mount settle
    await act(async () => {
      await t.mockInput.typeText("hello world");
      t.mockInput.pressEnter();
    });
    await t.waitFor(() => f.handled.includes("hello world"), { maxPasses: 40 });
    expect(f.handled).toContain("hello world");
    // the submitted line is echoed into the timeline
    const frame = await t.waitForFrame((fr) => fr.includes("› hello world"), { maxPasses: 40 });
    expect(frame).toContain("› hello world");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

// NOTE: the Ctrl-C arm/clear/exit flow can't be unit-tested — driving Ctrl-C through the test
// harness (mockInput.pressCtrlC / pressKey "c"+ctrl) segfaults OpenTUI's native lib under Bun.
// The handler logic in app.tsx is small + typechecked; verified by manual TTY smoke.

test("the logo banner renders its half-block glyphs to the frame", async () => {
  const t = await testRender(<box><text content={banner} /></box>, { width: 60, height: 14 });
  try {
    const frame = await t.waitForFrame((f) => f.includes("▀") || f.includes("▄"), { maxPasses: 40 });
    expect(frame.includes("▀") || frame.includes("▄")).toBe(true);
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("the picker renders the layer options", async () => {
  const t = await testRender(
    <Picker which="layer" onPick={() => {}} onCancel={() => {}} />,
    { width: 80, height: 24 },
  );
  try {
    const frame = await t.waitForFrame((fr) => fr.includes("trusted"), { maxPasses: 40 });
    expect(frame).toContain("trusted");
  } finally {
    t.renderer.destroy();
  }
}, 15000);
