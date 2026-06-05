# Sim REPL on OpenTUI (React)

**Date:** 2026-06-05

Replaced the hand-rolled raw-mode TUI (the `keys`/`editor`/`screen`/`menu` stack built earlier the
same day) with **OpenTUI**'s React binding. `ReplController` and the `sim run` CI/transcript path are
unchanged — the React app is a new *view* over the controller's `onOutput`/`onStatus` streams.

> Supersedes the same-day [pinned input box](2026-06-05-pinned-input-box.md) work — those modules
> (custom key decoder, line editor, scroll-region painter, modal panels) are deleted. That finding
> stays as history; this is the live design.

## What shipped

- `tui/` (React, `@opentui/react`): `app.tsx` (root: `scrollbox` output + status + `input`/overlays),
  `picker.tsx` (`<select>` for `/layer`·`/as`), `help.tsx` (scrollable `<scrollbox>` sheet),
  `use-repl.ts` (subscribe controller → state), `mount.tsx` (`createRoot(createCliRenderer()).render`).
- Pure + unit-tested: `route.ts` (submit → action), `ansi.ts` (`forText` strips ANSI for `<text>`).
- Removed: `keys.ts`, `editor.ts`, `screen.ts`, `menu.ts`, `interrupt.ts` + their tests. Kept:
  `repl.ts`, `render.ts`, `complete.ts`, `roles.ts`, `stub-agent.ts`, `transcript.ts`.
- Deps: `@opentui/core`, `@opentui/react`, `react`, `@types/react`. tsconfig `jsx: react-jsx`; each
  `.tsx` carries a `/** @jsxImportSource @opentui/react */` pragma (the binding augments JSX there,
  not globally).

## Why OpenTUI / React

Real flexbox + `scrollbox` + `input`/`select` with built-in focus/keyboard handling beat bespoke
ANSI bookkeeping. **React, not Solid**, because Bun transpiles plain JSX natively; Solid needs its
compile-time `jsx-dom-expressions` transform (extra Bun plugin plumbing). The heavier React dep is
irrelevant for a dev-only sim.

## Spike findings (the gate) — see `src/gateway/sim/tui/API-NOTES.md`

- Native lib loads and the React reconciler renders **under Bun**.
- The view is **headlessly unit-testable** via `@opentui/react/test-utils` `testRender` +
  `waitForFrame` + `mockInput` — so `app`/`picker`/`help` have real frame-assertion tests, not just
  manual smoke.
- `<text>` does **not** parse raw ANSI → strip with core `stripAnsiSequences`. Color is dropped in
  MVP; future enhancement: convert ANSI → `StyledText` to restore it.
- `<select>` inside a borderless flex box collapses to 0 rows — give it an explicit height.
- `exitOnCtrlC` may `process.exit` before `CliRenderEvents.DESTROY`, so `mountTui` also disposes the
  controller on a `process.once("exit")` fallback.

## Caveats (accepted)

- OpenTUI is pre-1.0 ("not for production") + native FFI — fine for a dev-only sim; `bun run start`
  (the Slack runtime) never imports it, so production images are unaffected. Pin the version.
- Single-line `<input>` flattens pasted newlines; multi-line authoring would need `<textarea>`
  (deferred). Color fidelity from `render.ts` is lost until the StyledText enhancement.

## Verification

- `bun test` — 736 pass (route/ansi/view tests + ReplController transcripts). `bun run typecheck` clean.
- `sim run` (CI) — 25/25 transcripts, no TUI mounted.
- Interactive TTY smoke is the remaining manual check (see checklist in the plan, Task 8).

Spec: `docs/superpowers/specs/2026-06-05-sim-tui-opentui-design.md`
Plan: `docs/superpowers/plans/2026-06-05-sim-tui-opentui.md`
