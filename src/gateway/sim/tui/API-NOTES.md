# OpenTUI API notes (spike, 2026-06-05)

Validated against `@opentui/core@0.3.2`, `@opentui/react@0.3.2`, `react@19.2.7` under Bun on macOS.
Native prebuilt `@opentui/core-darwin-arm64` present; **loads + renders headlessly — migration viable.**

## Render / mount
- `import { createCliRenderer } from "@opentui/core"` → `const r = await createCliRenderer(cfg)`.
- `import { createRoot } from "@opentui/react"` → `createRoot(r).render(<App/>)`.
- React commits need `act()` for tests; in production `createRoot(...).render()` is enough.
- `createCliRenderer` config of note: `exitOnCtrlC`.

## JSX elements (lowercase intrinsics)
`box`, `text`, `input`, `textarea`, `select`, `scrollbox`, `code`, `markdown`, `ascii-font`,
`tab-select`, plus text spans `span`/`b`/`i`/`u`/`a`/`br`.
- `box`: flexbox via style props (`flexDirection`, `flexGrow`, `height`, `border`, `title`).
- `text`: children string OR `content` prop. **Does NOT parse raw ANSI — escape bytes render literally.**
- `input`: props `value`, `onInput(value)`, `onChange(value)`, `onSubmit(value)`, `focused`, `placeholder`.
  Single-line: **strips newlines** (paste too). Rich built-in editing (Ctrl-A/E/W/U, word nav, undo).
- `textarea`: multi-line; `onSubmit()` fires on meta+Enter (Enter = newline); `initialValue`, `onKeyDown`,
  `onContentChange`. Use this if multi-line input is wanted; otherwise `input`.
- `select`: `options: {name, description?, value}[]`, `onChange(index, option)`, `onSelect(index, option)`,
  `focused`. Owns arrow-nav + Enter.
- `scrollbox`: scrollable container; `flexGrow`, `focused`; owns ↑/↓ when focused. (Auto-stick-to-bottom:
  verify the exact prop name during impl — candidates `stickyScroll`/`stickyStart`.)

## Hooks (`@opentui/react`)
- `useKeyboard((e: KeyEvent) => void, opts?)` — `e.name` (e.g. "escape","tab","return"), `e.ctrl/meta/shift`, `e.sequence`, `e.repeated`.
- `useRenderer(): CliRenderer` — has `.destroy()`.
- also: `usePaste`, `useResize`, `useTerminalDimensions`, `useFocus`, `useBlur`, `useSelection`.

## ANSI verdict → STRIP
`<text>` renders raw `\x1b[..m` as literal characters. Strategy: strip with core's
`import { stripAnsiSequences } from "@opentui/core"` before placing render.ts output in `<text>`.
Color is lost in MVP. Future enhancement: convert ANSI → `StyledText` (core exports `StyledText`,
`stringToStyledText`, `fg`/`bg`/`bold`/`t` tag) to restore color.

## Testing (headless — big win)
- `import { testRender } from "@opentui/react/test-utils"` → `const t = await testRender(<App/>, {width, height})`.
- `await t.waitForFrame(f => f.includes("..."), {maxPasses})` then assert on the captured char frame.
- `t.captureCharFrame()` (visible chars), `t.mockInput` (mock-keys), `t.resize(w,h)`, `t.renderer.destroy()`.
- Plain `createTestRenderer` + `createRoot` does NOT paint without `act()`; use `testRender` which wraps it.
- **Implication: app/picker/help components get real unit tests** (mount, feed keys, assert frame).

## Multi-line decision
`input` strips newlines, so a multi-line paste collapses to one line. For paste-as-one-multi-line-message,
use `textarea` (Enter=newline, meta+Enter=submit) — but that changes submit ergonomics. MVP: `input`
(Enter submits, paste flattened); revisit textarea if multi-line authoring is needed.
