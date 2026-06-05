# Sim REPL on OpenTUI (React)

**Date:** 2026-06-05
**Status:** approved
**Surface:** `src/gateway/sim/` — the interactive REPL only (`bun run sim` / `slaude sim`). The `sim run` (CI/transcript) path is untouched.

## Goal

Replace the hand-rolled raw-mode TUI (custom key decoder, line editor, scroll-region painter, modal panels) with **OpenTUI** using its **React** binding. OpenTUI provides production-grade primitives — flexbox layout (Yoga), a `scrollbox`, an `input`/`textarea`, a `select`, and focus/keyboard handling — so the sim REPL gets a real component model instead of bespoke ANSI bookkeeping.

`ReplController` (the transport-agnostic REPL logic) is unchanged. The OpenTUI app is a new **view** over its existing `onOutput`/`onStatus` event streams. This is a rendering-layer swap, not a logic rewrite.

## Why OpenTUI / React

- OpenTUI is Bun-native (Zig core + TS bindings over FFI) — matches our stack. Components: `box`, `text`, `scrollbox`, `input`, `textarea`, `select`, plus `useKeyboard`/`useRenderer` hooks.
- **React over Solid** specifically because React JSX is plain JSX that Bun transpiles natively (`jsx: react-jsx`). Solid needs its compile-time `jsx-dom-expressions` transform, which Bun doesn't run without extra plugin plumbing. React removes that toolchain risk. The heavier dep (`react` + reconciler) is irrelevant for a dev-only sim.

## Non-goals

- No change to `bun run start` (the Slack runtime). OpenTUI is a sim-only dependency.
- No change to the `sim run` transcript/CI path — it is headless, drives `ReplController` directly, and must never mount a TUI.
- Not porting every micro-behavior of the old editor 1:1 — OpenTUI's `input`/`textarea` own line editing now. We keep the *features* (history, multi-line, completion, gate answers, pickers, abort), not the byte-level implementation.

## Risks — gated by a spike (first implementation step)

The plan's **first task is a throwaway spike** that must pass before any rewrite:

1. **Install + run under Bun.** `bun add @opentui/core @opentui/react react`; confirm the native FFI lib loads and a trivial app renders + exits cleanly in this environment.
2. **ANSI in `<text>`.** `render.ts` emits `\x1b[…m`-styled strings (`toolLine`, `replyLine`, `gateBox`, …). The spike determines whether OpenTUI `<text>` renders ANSI passthrough or needs conversion. Outcome picks the styling strategy (see below).
3. **JSX toolchain.** Confirm `tsconfig` JSX settings compile `.tsx` under `bun run` and `bun test` with no new typecheck errors elsewhere.

**If the spike fails on toolchain or FFI**, stop and report — do not push through. The fallback (if only React-specifics are painful) is `@opentui/core` imperative; if OpenTUI itself won't run under Bun here, we abandon the migration and keep the current implementation.

## Architecture

```
src/gateway/sim/
  tui/
    mount.tsx     # render(<App/>) + ReplController wiring + teardown; the cli entrypoint calls this
    app.tsx       # root layout: scrollbox (output) + status line + input; owns top-level signals/state
    use-repl.ts    # React hook: subscribes to ReplController streams → {messages, status} state
    picker.tsx    # <select> overlay for bare /layer · /as
    help.tsx      # modal <scrollbox> overlay for /help
    text-line.tsx # renders one output line (ANSI passthrough or stripped+styled, per spike outcome)
```

### Layout (`app.tsx`)

```
<box flexDirection="column" height="100%">
  <scrollbox flexGrow={1}>            // agent output; auto-scrolls to bottom on new lines
    {messages.map(...)}
  </scrollbox>
  {status && <StatusLine label={status}/>}   // spinner frame + label, above the input
  {picker ? <Picker .../>
   : help  ? <Help .../>
   : <input onSubmit={submit} focused/>}      // bottom input; pickers/help take its place while open
</box>
```

### Data flow

- `use-repl.ts` runs `r.onOutput(l => append(l))` and `r.onStatus(setStatus)` in an effect (once), returns `{messages, status}`.
- `<input onSubmit={text}>` → `submit(text)`: bare `/layer`/`/as` → open the picker overlay; `/help` → open help overlay; gate-open + `a`/`d`/`A` and everything else → `r.handle(text)` (gate routing already lives in `ReplController.handle`).
- Picker select → `r.handle('/layer <name>')`; cancel → close overlay, refocus input.
- `useKeyboard`: `Esc` while a turn runs → `r.abort()`. Ctrl-C/Ctrl-D handled via OpenTUI (`exitOnCtrlC`) + an explicit quit that disposes the controller.
- Spinner: a frame index advanced by a `setInterval` (cleared on unmount) while `status !== null`.

### Styling strategy (decided by the spike)

`render.ts` stays the single source of line *content*. `text-line.tsx` adapts it:
- **If `<text>` renders ANSI:** pass the string through unchanged.
- **If not:** strip ANSI to plain text for the content and (optionally) map the dominant color to a `<text fg>` — acceptable to lose fine-grained color in MVP; the structure (tool tree, `⏺` replies, gate box) is in the characters, not the color.

### Completion (`complete.ts` kept)

`complete.ts` (pure slash-command completion) is **retained** — OpenTUI `<input>` has no command completion. Wire `Tab` via `useKeyboard`: on Tab, run `completeLine(value, names)`/`completeArg`, set the input value to the single hit. Frameworks-agnostic, reused as-is.

## cli.ts integration

The interactive `else` branch of `cli.ts` is reduced to: build the `ReplController`, then `await mountTui(r, { mode, shared, soulPath, verbose })`. All raw-mode stdin handling, the `Screen`, the readline-era leftovers, and the modal-panel code are deleted. The `isRun` branch is untouched.

## Removed

- `src/gateway/sim/keys.ts`, `editor.ts`, `screen.ts`, `menu.ts`, `interrupt.ts` and their tests under `tests/gateway/sim/` — superseded by OpenTUI primitives + hooks.

## Kept

- `repl.ts` (ReplController), `render.ts` (line formatters), `roles.ts`, `stub-agent.ts`, `transcript.ts`, `complete.ts`.

## Testing

- **Unit (pure, kept):** `complete.ts` tests stay. `ReplController` behavior is exercised by the `sim run` transcripts (isolated temp home + stub) — these are the regression safety net and must stay green.
- **No unit tests for the React/OpenTUI view** — native FFI render isn't unit-testable here. Verified by manual TTY smoke.
- **Manual TTY smoke checklist** (`bun run sim --stub`): output scrolls; input at bottom; Enter submits; history (↑/↓ via OpenTUI input); Tab completes a slash command; multi-line paste arrives as one message; resize reflows (flexbox); gate `a/d/A`; `/layer` → select overlay (arrows + Enter, Esc cancels); `/help` → scrollable overlay (Esc closes); Esc aborts a running turn; Ctrl-C/Ctrl-D exits cleanly with the terminal restored.

## Dependencies

Add to `package.json`: `@opentui/core`, `@opentui/react`, `react`. `tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "react"` (scoped so it doesn't disturb non-JSX files). Pin OpenTUI to the spike-validated version (it is pre-1.0; treat minor bumps as breaking).

## Open caveats (accepted)

- OpenTUI is pre-1.0, self-described "not ready for production" — acceptable for a dev-only sim; isolated from the Slack runtime.
- Native FFI prebuilt per platform (dev macOS + any container that runs the sim). The Slack server (`bun run start`) does not import OpenTUI, so production images are unaffected.
- Some color fidelity from `render.ts` may be lost if `<text>` doesn't pass ANSI (see styling strategy).
