# Sim REPL on OpenTUI (React) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sim REPL's hand-rolled raw-mode TUI with OpenTUI's React binding — flexbox layout, `scrollbox`, `input`, `select`, focus/keyboard hooks — while keeping `ReplController` and the `sim run` CI path unchanged.

**Architecture:** A React app (mounted by `@opentui/react`) is a new view over `ReplController`'s existing `onOutput`/`onStatus` streams. Pure logic (submit routing, ANSI handling) is extracted into framework-free, unit-tested modules; the JSX components are thin shells verified by manual TTY smoke. A throwaway spike (Task 1) gates the whole migration.

**Tech Stack:** Bun + TypeScript + React via `@opentui/core` / `@opentui/react`. `bun:test`. Spec: `docs/superpowers/specs/2026-06-05-sim-tui-opentui-design.md`.

---

## CRITICAL: Spike gates everything — DONE, PASSED (2026-06-05)

Task 1 ran and **passed**: native lib loads, the React reconciler renders under Bun, and the view is
**headlessly unit-testable** via `@opentui/react/test-utils` `testRender` + `waitForFrame`. Verdicts
recorded in `src/gateway/sim/tui/API-NOTES.md`:
- **ANSI:** `<text>` does NOT parse raw ANSI → **strip** via core `stripAnsiSequences` (Task 3 uses this).
- **Render:** `createRoot(await createCliRenderer(cfg)).render(<App/>)`.
- **Components ARE testable** — Tasks 5–7 add `testRender`-based tests (mount, feed `mockInput`, assert frame),
  not just manual smoke. Treat the manual smoke as a final check, not the only safety net.

Task 1 (install + tsconfig + API notes) is already committed; skip it during execution.

OpenTUI is pre-1.0; the exact element/prop/hook names below are from its docs and may differ slightly from the installed version. **The spike records the real API in `tui/API-NOTES.md`; later tasks adapt the skeleton code to it.** Where this plan's code and the installed types disagree, the installed types win — adjust and note it.

## File Structure

- `src/gateway/sim/tui/API-NOTES.md` — spike output: confirmed imports, element names, hook signatures, ANSI behavior.
- `src/gateway/sim/tui/route.ts` — pure: classify a submitted line → an action (send / picker / help). Unit-tested.
- `src/gateway/sim/tui/ansi.ts` — pure: ANSI handling for `<text>` (passthrough or strip), per spike. Unit-tested.
- `src/gateway/sim/tui/use-repl.ts` — React hook: subscribe to `ReplController` → `{messages, status}`.
- `src/gateway/sim/tui/app.tsx` — root layout (scrollbox + status + input/overlays).
- `src/gateway/sim/tui/picker.tsx` — `<select>` overlay for `/layer`·`/as`.
- `src/gateway/sim/tui/help.tsx` — modal overlay for `/help`.
- `src/gateway/sim/tui/mount.tsx` — `render(<App/>)` + controller wiring + teardown.
- Modify `src/gateway/sim/cli.ts` — REPL branch calls `mountTui`.
- Delete `keys.ts`, `editor.ts`, `screen.ts`, `menu.ts`, `interrupt.ts` + their tests.
- Keep `repl.ts`, `render.ts`, `roles.ts`, `stub-agent.ts`, `transcript.ts`, `complete.ts`.

---

## Task 1: Spike — prove OpenTUI runs under Bun (throwaway)

**Files:**
- Create (temporary): `spike/tui.tsx`
- Create: `src/gateway/sim/tui/API-NOTES.md`

- [ ] **Step 1: Install deps**

Run:
```bash
bun add @opentui/core @opentui/react react
bun add -d @types/react
```
Expected: installs without error; note the resolved `@opentui/*` versions.

- [ ] **Step 2: Configure JSX for the spike**

Add to `tsconfig.json` `compilerOptions` (if not present): `"jsx": "react-jsx"`, `"jsxImportSource": "react"`. Run `bun run typecheck` to confirm it still passes for the existing (non-JSX) codebase.

- [ ] **Step 3: Write a minimal app exercising the primitives we need**

```tsx
// spike/tui.tsx
import { render, useKeyboard, useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"

function App() {
  const [msgs, setMsgs] = useState<string[]>(["plain line", "\x1b[1mbold?\x1b[0m \x1b[32mgreen?\x1b[0m"])
  const [val, setVal] = useState("")
  const renderer = useRenderer()
  useKeyboard((k: any) => { if (k.name === "escape") renderer.destroy?.() ?? process.exit(0) })
  useEffect(() => { const t = setInterval(() => setMsgs((m) => [...m, `tick ${m.length}`]), 1000); return () => clearInterval(t) }, [])
  return (
    <box flexDirection="column" height="100%">
      <scrollbox flexGrow={1}>{msgs.map((m, i) => <text key={i}>{m}</text>)}</scrollbox>
      <select options={[{ name: "alpha", value: "a" }, { name: "beta", value: "b" }]} />
      <input value={val} onInput={setVal} onSubmit={(t: string) => setMsgs((m) => [...m, `> ${t}`])} focused />
    </box>
  )
}
render(<App />)
```

- [ ] **Step 4: Run it and observe**

Run: `bun spike/tui.tsx` (in a real terminal). Verify, recording each answer in `API-NOTES.md`:
- Does it launch, render the box/scrollbox/input/select, and exit on Esc/Ctrl-C?
- **ANSI:** does the `"\x1b[1mbold?…"` line show as styled text, or as literal escape codes? (Decides `ansi.ts`.)
- Confirm the real element names (`box`/`scrollbox`/`input`/`select`/`textarea`), the real `render` signature, and the real `useKeyboard` key object shape (`.name`? `.raw`?). Note any divergence from this skeleton.
- Does `input` expose `onInput`/`onSubmit`/`focused`? Does `select` expose `options`/`onChange`/`focused` and arrow-key nav? Does a multi-line paste into `input` keep newlines, or do we need `textarea`?

- [ ] **Step 5: Record findings + decide**

Write `src/gateway/sim/tui/API-NOTES.md` with: resolved versions, confirmed imports + element/prop/hook names, ANSI verdict (passthrough vs strip), input-vs-textarea decision for multi-line, and any blockers. **If OpenTUI won't run under Bun here, write that and STOP** (report BLOCKED — the migration is abandoned, keep the current implementation).

- [ ] **Step 6: Remove the spike file, commit the notes**

```bash
rm -rf spike
git add tsconfig.json package.json bun.lock src/gateway/sim/tui/API-NOTES.md
git commit -m "spike(sim): validate OpenTUI+React under Bun; record API notes"
```

---

## Task 2: Pure submit-routing (`route.ts`)

**Files:**
- Create: `src/gateway/sim/tui/route.ts`
- Test: `tests/gateway/sim/tui/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/tui/route.test.ts
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test tests/gateway/sim/tui/route.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `route.ts`**

```ts
// src/gateway/sim/tui/route.ts
// Pure classification of a submitted REPL line into a view action. Keeps the React
// component free of branching logic and makes the routing unit-testable.
export type SubmitAction =
  | { kind: "noop" }
  | { kind: "help" }
  | { kind: "picker"; which: "layer" | "as" }
  | { kind: "send"; text: string };

export function routeSubmit(raw: string): SubmitAction {
  const t = raw.trim();
  if (!t) return { kind: "noop" };
  if (t === "/help") return { kind: "help" };
  if (t === "/layer") return { kind: "picker", which: "layer" };
  if (t === "/as") return { kind: "picker", which: "as" };
  return { kind: "send", text: raw };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test tests/gateway/sim/tui/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/tui/route.ts tests/gateway/sim/tui/route.test.ts
git commit -m "feat(sim): pure submit-routing for the TUI"
```

---

## Task 3: ANSI handling for `<text>` (`ansi.ts`)

Spike verdict: `<text>` does NOT parse raw ANSI → **strip**, using core's `stripAnsiSequences` (don't
hand-roll a regex — the core stripper handles the full escape grammar, not just SGR `…m`).

**Files:**
- Create: `src/gateway/sim/tui/ansi.ts`
- Test: `tests/gateway/sim/tui/ansi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/tui/ansi.test.ts
import { test, expect } from "bun:test";
import { forText } from "../../../../src/gateway/sim/tui/ansi";

test("plain text is unchanged", () => {
  expect(forText("hello")).toBe("hello");
});

test("ANSI escape sequences are stripped for <text>", () => {
  expect(forText("\x1b[1mhi\x1b[0m")).toBe("hi");
  expect(forText("\x1b[32m⏺\x1b[0m reply")).toBe("⏺ reply");
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test tests/gateway/sim/tui/ansi.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ansi.ts`**

```ts
// src/gateway/sim/tui/ansi.ts
import { stripAnsiSequences } from "@opentui/core";

// Adapt a render.ts line for an OpenTUI <text>: <text> renders raw ANSI as literal characters
// (spike verdict, API-NOTES.md), so strip the escape codes. Color is dropped in MVP; a future
// enhancement can convert ANSI → StyledText (core: StyledText/fg/bold) to restore it.
export function forText(line: string): string {
  return stripAnsiSequences(line);
}
```

> If `stripAnsiSequences` isn't importable from `@opentui/core` at runtime (verify), fall back to
> the regex `line.replace(/\x1b\[[0-9;]*m/g, "")` and note it — but prefer the core export.

- [ ] **Step 4: Run test, verify it passes**

Run: `bun test tests/gateway/sim/tui/ansi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/tui/ansi.ts tests/gateway/sim/tui/ansi.test.ts
git commit -m "feat(sim): ANSI handling for OpenTUI text lines"
```

---

## Task 4: ReplController subscription hook (`use-repl.ts`)

**Files:**
- Create: `src/gateway/sim/tui/use-repl.ts`

(No unit test — it is a thin React effect over `ReplController`; covered by manual smoke. Keep it tiny.)

- [ ] **Step 1: Implement the hook**

```tsx
// src/gateway/sim/tui/use-repl.ts
import { useEffect, useState } from "react";
import type { ReplController } from "../repl";
import { forText } from "./ansi";

/** Subscribe to a ReplController's output/status streams and expose them as React state.
 *  `messages` accumulates committed scrollback lines (ANSI-adapted); `status` is the live
 *  spinner label (or null). Wiring runs once. */
export function useRepl(r: ReplController) {
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    r.onOutput((line) => setMessages((m) => [...m, forText(line)]));
    r.onStatus((label) => setStatus(label));
  }, [r]);
  return { messages, status };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean (confirms `ReplController.onOutput`/`onStatus` signatures match: `onOutput(fn: (line: string) => void)`, `onStatus(fn: (label: string | null) => void)`).

- [ ] **Step 3: Commit**

```bash
git add src/gateway/sim/tui/use-repl.ts
git commit -m "feat(sim): React hook bridging ReplController streams"
```

---

## Task 5: Overlays — picker + help (`picker.tsx`, `help.tsx`)

Adapt element/prop names to `API-NOTES.md`. Skeletons below assume the documented API.

**Files:**
- Create: `src/gateway/sim/tui/picker.tsx`
- Create: `src/gateway/sim/tui/help.tsx`

- [ ] **Step 1: Implement `picker.tsx`**

```tsx
// src/gateway/sim/tui/picker.tsx
import { LAYERS, ROLE_NAMES } from "../roles";

export interface PickerProps {
  which: "layer" | "as";
  onPick: (value: string) => void;   // the chosen layer name or role name
  onCancel: () => void;
}

/** A <select> overlay for bare /layer · /as. OpenTUI's select owns arrow-nav + Enter;
 *  Esc cancels. The chosen value is forwarded as a command by the parent. */
export function Picker({ which, onPick, onCancel }: PickerProps) {
  const options =
    which === "layer"
      ? LAYERS.map((l) => ({ name: `${l.name} — ${l.desc}`, value: l.name }))
      : ROLE_NAMES.map((n) => ({ name: n, value: n }));
  const title = which === "layer" ? "Pick a channel layer:" : "Act as which role:";
  return (
    <box flexDirection="column" border title={title}>
      <select options={options} focused onSelect={(opt: any) => onPick(opt.value)} />
    </box>
  );
}
```

- [ ] **Step 2: Implement `help.tsx`**

```tsx
// src/gateway/sim/tui/help.tsx
import { forText } from "./ansi";

export interface HelpProps { lines: string[]; }

/** Scrollable modal for /help. OpenTUI's scrollbox owns ↑/↓; the parent closes it on Esc. */
export function Help({ lines }: HelpProps) {
  return (
    <box flexDirection="column" border title="help — Esc to close">
      <scrollbox flexGrow={1} focused>
        {lines.map((l, i) => <text key={i}>{forText(l)}</text>)}
      </scrollbox>
    </box>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean (or only JSX-element-typing notes resolved against the installed `@opentui/react` types).

- [ ] **Step 4: Commit**

```bash
git add src/gateway/sim/tui/picker.tsx src/gateway/sim/tui/help.tsx
git commit -m "feat(sim): picker + help overlays for the TUI"
```

---

## Task 6: Root app + mount (`app.tsx`, `mount.tsx`)

**Files:**
- Create: `src/gateway/sim/tui/app.tsx`
- Create: `src/gateway/sim/tui/mount.tsx`

- [ ] **Step 1: Implement `app.tsx`**

```tsx
// src/gateway/sim/tui/app.tsx
import { useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { ReplController } from "../repl";
import { replCommandNames } from "../repl";
import { LAYERS, ROLE_NAMES } from "../roles";
import { BEHAVIORS } from "../stub-agent";
import { completeLine, completeArg } from "../complete";
import { useRepl } from "./use-repl";
import { routeSubmit } from "./route";
import { Picker } from "./picker";
import { Help } from "./help";

export interface AppProps { repl: ReplController; hint: string; helpLines: string[]; }
type Overlay = { kind: "none" } | { kind: "help" } | { kind: "picker"; which: "layer" | "as" };

const CMD_NAMES = replCommandNames();
const ARG_MAP: Record<string, string[]> = {
  "/layer": LAYERS.map((l) => l.name),
  "/as": [...ROLE_NAMES],
  "/behavior": Object.keys(BEHAVIORS),
};
const completeOne = (line: string): string | null => {
  const hits = line.includes(" ") ? completeArg(line, ARG_MAP) : completeLine(line, CMD_NAMES);
  return hits.length === 1 ? hits[0]! : null;
};

export function App({ repl, hint, helpLines }: AppProps) {
  const { messages, status } = useRepl(repl);
  const [value, setValue] = useState("");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const renderer = useRenderer();

  useKeyboard((k: any) => {
    const name = k?.name ?? k?.raw;
    if (name === "escape") {
      if (overlay.kind !== "none") setOverlay({ kind: "none" });
      else repl.abort();
    } else if (name === "tab" && overlay.kind === "none") {
      const c = completeOne(value);
      if (c) setValue(c);
    }
  });

  const submit = (raw: string) => {
    setValue("");
    const a = routeSubmit(raw);
    if (a.kind === "noop") return;
    if (a.kind === "help") { setOverlay({ kind: "help" }); return; }
    if (a.kind === "picker") { setOverlay({ kind: "picker", which: a.which }); return; }
    void repl.handle(a.text);
  };

  return (
    <box flexDirection="column" height="100%">
      <scrollbox flexGrow={1} stickyScroll>
        {messages.map((m, i) => <text key={i}>{m}</text>)}
      </scrollbox>
      {status ? <text>{status}</text> : null}
      {overlay.kind === "help" ? (
        <Help lines={helpLines} />
      ) : overlay.kind === "picker" ? (
        <Picker
          which={overlay.which}
          onPick={(v) => { setOverlay({ kind: "none" }); void repl.handle(`/${overlay.kind === "picker" ? (overlay.which === "layer" ? "layer" : "as") : ""} ${v}`); }}
          onCancel={() => setOverlay({ kind: "none" })}
        />
      ) : (
        <box flexDirection="column">
          <input value={value} onInput={setValue} onSubmit={submit} focused />
          <text>{hint}</text>
        </box>
      )}
    </box>
  );
}
```

> Note: the `onPick` inline above re-reads `overlay.which`; if the installed React batching makes that stale, capture `which` in the `Picker` element instead: `onPick={(v) => { const w = overlay.which; setOverlay({kind:"none"}); void repl.handle(`/${w === "layer" ? "layer" : "as"} ${v}`); }}`. Verify in smoke; prefer the captured-`w` form.

- [ ] **Step 2: Simplify the picker dispatch (apply the captured-`w` form)**

Replace the `onPick` prop with the stale-safe version:

```tsx
        <Picker
          which={overlay.which}
          onPick={(v) => {
            const w = overlay.which;
            setOverlay({ kind: "none" });
            void repl.handle(`/${w} ${v}`);   // w is "layer" | "as" → "/layer x" | "/as x"
          }}
          onCancel={() => setOverlay({ kind: "none" })}
        />
```

- [ ] **Step 3: Implement `mount.tsx`**

```tsx
// src/gateway/sim/tui/mount.tsx
import { render } from "@opentui/react";
import type { ReplController } from "../repl";
import { App } from "./app";

export interface MountOpts { hint: string; helpLines: string[]; }

/** Mount the OpenTUI React app over a ReplController. Resolves when the app exits
 *  (Ctrl-C / Ctrl-D), after disposing the controller. */
export async function mountTui(repl: ReplController, opts: MountOpts): Promise<void> {
  await render(<App repl={repl} hint={opts.hint} helpLines={opts.helpLines} />, { exitOnCtrlC: true });
  await repl.dispose();
}
```

> If the installed `render` is not promise-based (does not resolve on exit), adapt per `API-NOTES.md`: register an exit/teardown callback on the renderer that calls `repl.dispose()` and resolves. Keep `mountTui`'s signature (`Promise<void>`) stable for the cli.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/tui/app.tsx src/gateway/sim/tui/mount.tsx
git commit -m "feat(sim): OpenTUI React app + mount over ReplController"
```

---

## Task 7: Wire cli.ts; delete the old raw-mode stack

**Files:**
- Modify: `src/gateway/sim/cli.ts` (REPL `else` branch only)
- Delete: `keys.ts`, `editor.ts`, `screen.ts`, `menu.ts`, `interrupt.ts` and their tests.
- Add `helpLines()` access (already on `ReplController` from the prior feature).

- [ ] **Step 1: Replace the REPL branch body**

In `cli.ts`, replace the entire interactive `else { … }` block (the raw-mode loop: `Screen`, `decodeKeys`, `LineEditor`, pickers, `runTurn`, the `stdin.on("data")` handler, etc.) with:

```ts
} else {
  const { ReplController } = await import("./repl");
  const { mountTui } = await import("./tui/mount");
  const r = new ReplController(agentMode, soulMd);

  const modeLabel = agentMode === "real" ? "live agent" : "stub";
  const tail = `a/d/A (or pick) answers gates · /help · Ctrl-D quits.${verbose ? "" : "  (--verbose for infra logs)"}`;
  if (shared) await r.startShared();
  else await r.startDefault();

  // mountTui owns the screen until the user exits; it disposes the controller on teardown.
  await mountTui(r, { hint: tail, helpLines: r.helpLines() });
  process.exit(0);
}
```

> `agentMode`, `soulMd`, `shared`, `verbose` are existing in-scope vars. The intro lines that the old code printed (`✻ slaude sim`, ready message) are emitted by `ReplController.startShared`/`startDefault` via `onOutput`, so they land in the scrollbox — no separate print needed. Confirm in smoke; if the banner is wanted, push it via `r`-level output before mount or add a header `<text>` in `app.tsx`.

- [ ] **Step 2: Delete the superseded modules + tests**

```bash
git rm src/gateway/sim/keys.ts src/gateway/sim/editor.ts src/gateway/sim/screen.ts \
       src/gateway/sim/menu.ts src/gateway/sim/interrupt.ts \
       tests/gateway/sim/keys.test.ts tests/gateway/sim/editor.test.ts \
       tests/gateway/sim/screen.test.ts tests/gateway/sim/menu.test.ts
```

(There is no `interrupt.test.ts`; do not try to remove it. `complete.ts` + `tests/gateway/sim/complete.test.ts` STAY.)

- [ ] **Step 3: Confirm no dangling imports**

Run:
```bash
grep -rn "/sim/keys\|/sim/editor\|/sim/screen\|/sim/menu\|/sim/interrupt\|LiveTerminal\|decodeKeys\|LineEditor" src tests
```
Expected: no matches (the cli no longer imports them; `repl.ts` only had a comment reference — update it if grep finds one).

- [ ] **Step 4: Typecheck + full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all tests pass (the deleted modules' tests are gone; `complete` + `route` + `ansi` + ReplController/transcripts remain green).

- [ ] **Step 5: Commit**

```bash
git add -A src/gateway/sim/cli.ts
git commit -m "feat(sim): REPL renders via OpenTUI; remove the raw-mode stack"
```

---

## Task 8: Manual smoke + docs

**Files:**
- Create: `docs/findings/2026-06-05-sim-tui-opentui.md`
- Modify: `CLAUDE.md` (Findings Log index — newest first)

- [ ] **Step 1: Manual TTY smoke (real terminal — cannot be unit-tested)**

Run: `bun run sim --stub`
Verify:
- Output area scrolls; input pinned at bottom; Enter submits; resize reflows (flexbox).
- ↑/↓ history (OpenTUI input); Tab completes a slash command (`/lay`→`/layer `).
- Multi-line paste arrives as one message (or, per `API-NOTES.md`, via textarea).
- Open a gate → `a`/`d`/`A` answers it.
- `/layer` (no arg) → `<select>` overlay, arrows + Enter selects, Esc cancels. `/as` likewise.
- `/help` → scrollable overlay, Esc closes.
- Esc aborts a running turn; Ctrl-C / Ctrl-D exits cleanly, terminal restored (no raw-mode hangover — run `reset` only if needed).
- `bun run sim run` (CI path) still works headlessly (no TUI mounted).

- [ ] **Step 2: Write the finding doc**

```markdown
# Sim REPL on OpenTUI (React)

**Date:** 2026-06-05

Replaced the hand-rolled raw-mode TUI (keys/editor/screen/menu) with OpenTUI's React
binding. `ReplController` and the `sim run` CI path are unchanged — the React app is a new
view over the controller's onOutput/onStatus streams.

## What
- `tui/` — React app: `scrollbox` (output) + status + `input`, `select` pickers, scrollable `/help`.
- Pure, tested: `route.ts` (submit classification), `ansi.ts` (text adaptation).
- Removed: keys.ts, editor.ts, screen.ts, menu.ts, interrupt.ts + tests. Kept: complete.ts, render.ts, repl.ts.

## Why OpenTUI / React
Real flexbox + scrollbox + input/select beat bespoke ANSI bookkeeping. React (not Solid) because
Bun transpiles plain JSX natively; Solid needs its compile-time transform.

## Decisions / caveats
- OpenTUI is pre-1.0 + native FFI — accepted for a dev-only sim; the Slack runtime never imports it.
- ANSI strategy (passthrough vs strip) chosen by the spike — see tui/API-NOTES.md.
- Spike-gated migration; the raw-mode stack and its unit tests were retired.

Spec: docs/superpowers/specs/2026-06-05-sim-tui-opentui-design.md
Plan: docs/superpowers/plans/2026-06-05-sim-tui-opentui.md
```

- [ ] **Step 3: Add the Findings Log index entry**

In `CLAUDE.md` under `## Findings Log`, add as the newest bullet:

```markdown
- [2026-06-05 — Sim REPL on OpenTUI (React)](docs/findings/2026-06-05-sim-tui-opentui.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/findings/2026-06-05-sim-tui-opentui.md CLAUDE.md
git commit -m "docs(sim): finding for the OpenTUI React migration"
```

---

## Self-Review Notes

- **Spec coverage:** spike + risks (Task 1), React app/layout (Task 6), scrollbox/input/status (Task 6), pickers via select (Task 5), help overlay (Task 5), Tab completion via complete.ts (Task 6), ANSI strategy (Task 3), cli integration + module removal (Task 7), sim-run untouched (Task 7 step 4 + Task 8), deps/tsconfig (Task 1), manual smoke + finding (Task 8). Covered.
- **Pre-1.0 API risk:** every JSX task says to reconcile against `API-NOTES.md` / installed types; the spike is the single source of truth for element/prop/hook names.
- **Types consistent:** `SubmitAction` (route.ts) consumed in app.tsx; `forText` (ansi.ts) used in use-repl.ts + help.tsx; `mountTui(repl, {hint, helpLines})` matches the cli call; `ReplController.helpLines()` exists from the prior feature.
- **No placeholders:** the only conditional is `ansi.ts`'s strip-vs-passthrough, explicitly chosen by the spike with both branches shown.
