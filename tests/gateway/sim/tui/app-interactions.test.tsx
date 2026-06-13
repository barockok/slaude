/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ReplController } from "../../../../src/gateway/sim/repl";
import { App } from "../../../../src/gateway/sim/tui/app";

// Keyboard-driven interactions: Escape (abort / overlay close), Tab completion, and the
// submit router (noop / help / picker). Ctrl-C and Ctrl-D remain untestable — driving
// ctrl-modified keys through mockInput segfaults OpenTUI's native lib under Bun (see the
// note in view.test.tsx); those handlers are verified by manual TTY smoke.

function makeFake() {
  let out: (l: string) => void = () => {};
  let status: (l: string | null) => void = () => {};
  const handled: string[] = [];
  let aborted = 0;
  const fake = {
    onOutput(fn: (l: string) => void) { out = fn; },
    onStatus(fn: (l: string | null) => void) { status = fn; },
    handle(text: string) { handled.push(text); return Promise.resolve(); },
    abort() { aborted += 1; },
    dispose() { return Promise.resolve(); },
    helpLines() { return [] as string[]; },
  };
  return {
    repl: fake as unknown as ReplController,
    pushOutput: (l: string) => out(l),
    pushStatus: (l: string | null) => status(l),
    handled,
    abortCount: () => aborted,
  };
}

const header = { name: "A-Claw", version: "0.0.0", meta: [] as string[] };

test("Escape with no overlay aborts the running turn", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={header} />, { width: 80, height: 24 });
  try {
    // Wait for the first paint so the global keyboard subscription is live — the
    // OpenTUI test harness drops the very first key delivered straight after mount.
    await t.waitForFrame((fr) => fr.includes("A-Claw"), { maxPasses: 40 });
    await act(async () => { t.mockInput.pressEscape(); });
    await t.waitFor(() => f.abortCount() > 0, { maxPasses: 40 });
    expect(f.abortCount()).toBeGreaterThan(0);
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("submitting /help opens the help overlay; Escape closes it back to the input", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="the-hint-line" helpLines={["help body line"]} header={header} />, { width: 80, height: 24 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await act(async () => {
      await t.mockInput.typeText("/help");
      t.mockInput.pressEnter();
    });
    let frame = await t.waitForFrame((fr) => fr.includes("Esc to close"), { maxPasses: 40 });
    expect(frame).toContain("help body line");
    expect(f.handled).toEqual([]);            // /help is view-local, never forwarded
    await act(async () => { t.mockInput.pressEscape(); });
    frame = await t.waitForFrame((fr) => !fr.includes("Esc to close") && fr.includes("the-hint-line"), { maxPasses: 40 });
    expect(frame).toContain("the-hint-line");
    expect(f.abortCount()).toBe(0);           // Escape closed the overlay, didn't abort
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("submitting an empty line is a noop (nothing echoed, nothing handled)", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={header} />, { width: 80, height: 24 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await act(async () => { t.mockInput.pressEnter(); });
    await new Promise((r) => setTimeout(r, 100));
    expect(f.handled).toEqual([]);
    const frame = await t.waitForFrame(() => true, { maxPasses: 4 });
    expect(frame).not.toContain("›");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("Tab completes the command head, then the first argument", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={header} />, { width: 80, height: 24 });
  try {
    // First paint primes the keyboard subscription (harness drops the first key after mount).
    await t.waitForFrame((fr) => fr.includes("A-Claw"), { maxPasses: 40 });
    // Type and press Tab in SEPARATE act() blocks: the Tab handler (useKeyboard) reads the
    // `value` state, which must re-render after the typed text before Tab captures it.
    await act(async () => { await t.mockInput.typeText("/beh"); });   // unique head prefix
    await t.waitForFrame((fr) => fr.includes("/beh"), { maxPasses: 40 });
    await act(async () => { t.mockInput.pressTab(); });
    let frame = await t.waitForFrame((fr) => fr.includes("/behavior"), { maxPasses: 40 });
    expect(frame).toContain("/behavior");
    await act(async () => { await t.mockInput.typeText(" request_ap"); });
    await t.waitForFrame((fr) => fr.includes("/behavior request_ap"), { maxPasses: 40 });
    await act(async () => { t.mockInput.pressTab(); });              // arg completion via ARG_MAP
    frame = await t.waitForFrame((fr) => fr.includes("/behavior request_approval"), { maxPasses: 40 });
    expect(frame).toContain("/behavior request_approval");
    await act(async () => { t.mockInput.pressEnter(); });
    await t.waitFor(() => f.handled.includes("/behavior request_approval"), { maxPasses: 40 });
    expect(f.handled).toContain("/behavior request_approval");
  } finally {
    t.renderer.destroy();
  }
}, 15000);

test("bare /layer opens the picker; Enter picks an option and routes it to the repl", async () => {
  const f = makeFake();
  const t = await testRender(<App repl={f.repl} hint="hint" helpLines={[]} header={header} />, { width: 80, height: 24 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await act(async () => {
      await t.mockInput.typeText("/layer");
      t.mockInput.pressEnter();
    });
    const frame = await t.waitForFrame((fr) => fr.includes("layer — "), { maxPasses: 40 });
    expect(frame).toContain("trusted");        // options listed
    await act(async () => { t.mockInput.pressEnter(); });   // pick the highlighted option
    await t.waitFor(() => f.handled.some((h) => h.startsWith("/layer ")), { maxPasses: 40 });
    const picked = f.handled.find((h) => h.startsWith("/layer "))!;
    expect(picked).toMatch(/^\/layer (dm|trusted|allowed|restricted)$/);
    // the pick is echoed into the timeline and the overlay closes back to the input
    const after = await t.waitForFrame((fr) => fr.includes(`› ${picked}`), { maxPasses: 40 });
    expect(after).toContain(`› ${picked}`);
  } finally {
    t.renderer.destroy();
  }
}, 15000);
