# Pinned bordered input box for the sim REPL

**Date:** 2026-06-05
**Status:** approved
**Surface:** `src/gateway/sim/` (interactive REPL only — `bun run sim`, `slaude sim`)

## Goal

Give the sim REPL a claude-code-grade input area:

- A **rounded box** enclosing the input line (top + bottom + side borders).
- **Hard-pinned to the terminal bottom** — agent output scrolls in the region *above* the box; the box never moves up off-screen.
- **Responsive** — the box spans the full terminal width and redraws on terminal resize (`SIGWINCH`).
- Multi-line input supported, **capped at 10 visible rows** (input scrolls internally beyond that).

The current REPL uses `node:readline` for the input line and a bottom-pinned spinner (`LiveTerminal` in `term.ts`). readline cannot live inside a fixed bottom region, so it is replaced by a custom raw-mode line editor.

## Non-goals

- No change to the `run`/transcript (CI) path — it is non-TTY and never renders a box.
- No alternate-screen / full TUI takeover — scrollback stays in the normal buffer (scroll-back history preserved).
- No unicode grapheme-width perfection (readline didn't guarantee it either). ASCII + common width is enough for a dev tool.

## Architecture

Three new modules, each pure where possible and unit-tested — matching the existing `term.ts`/`menu.ts`/`complete.ts` style (logic split from I/O, injected sinks).

### 1. `keys.ts` — raw input decoder (pure)

`decodeKeys(s: string): Key[]` turns a raw stdin chunk into a token list:

- `{type:"text", value}` — printable run (includes pasted text).
- Named keys: `left right up down home end backspace delete enter tab esc`.
- Control combos: `ctrl-a ctrl-e ctrl-c ctrl-d ctrl-u ctrl-w`.
- Bracketed paste markers: `paste-start` (`ESC[200~`), `paste-end` (`ESC[201~`).

Decoding rules: split on recognized escape sequences (CSI), map C0 controls, treat the rest as `text`. A chunk may yield several tokens (e.g. a paste chunk = `paste-start`, `text`, `paste-end`). Pure → fully unit-testable.

### 2. `editor.ts` — line editor reducer (pure)

`class LineEditor` owns editor state; no I/O.

State: `text: string`, `cursor: number` (index into `text`), `history: string[]` + `histIdx`, `pasting: boolean`, a saved draft for history navigation.

`handle(key: Key): EditorAction` where `EditorAction` is one of:

- `{type:"render"}` — buffer/cursor changed, repaint footer.
- `{type:"submit", text}` — Enter on a complete line (no trailing `\`); pushes to history, clears buffer.
- `{type:"complete", line}` — Tab; caller runs `complete.ts` and feeds the result back via `applyCompletion()`.
- `{type:"sigint"}` — Ctrl-C (caller decides clear-line vs warn-then-exit via existing `interrupt.ts` `sigintAction`).
- `{type:"eof"}` — Ctrl-D on empty buffer → quit.
- `{type:"none"}` — consumed, no repaint.

Editing behaviors (readline parity):

- Insert printable text at cursor; backspace deletes before, delete removes at cursor.
- Left/Right move cursor; Home/Ctrl-A → start, End/Ctrl-E → end.
- Ctrl-U clears to line start; Ctrl-W deletes the previous word.
- Up/Down recall history (saving the in-progress draft at the boundary).
- **Multi-line:** a line ending in `\` keeps the newline in `text` and stays in input mode (explicit continuation). A bracketed paste containing newlines inserts them verbatim → multi-line message. Enter submits the whole buffer unless it ends in `\`.
- **Paste:** between `paste-start`/`paste-end`, text is inserted literally (newlines kept) and Enter is *not* auto-triggered — replaces the old 8 ms burst-debounce heuristic with explicit bracketed-paste framing.

### 3. `screen.ts` — terminal chrome (I/O injected)

`class Screen` owns the scroll region + footer rendering. Constructor takes a `write(s)` sink and a `size() => {rows, cols}` getter (defaults to `process.stdout`), so layout is testable without a TTY.

Responsibilities:

- **Scroll region:** sets `ESC[1;{rows - footerH}r` so normal output scrolls only in the top region. Re-set *only* when `footerH` changes (avoids flicker).
- `print(line)`: commit a scrollback line into the top region (position at the region's last row, write text + newline so the region scrolls up), then repaint the footer (cursor returns to the input field).
- `renderFooter(model)`: draw the footer at absolute bottom rows — optional status line, box top `╭─…─╮`, the visible input rows `│ … │`, box bottom `╰─…─╯`, hint line — then place the hardware cursor at the model's `(row, col)` inside the box.
- `status(label | null)` + `tick()`: spinner line directly above the box top (claude-code placement). Idle → status slot absent (footer shrinks by 1, region recomputed).
- **Resize:** on `resize`, refresh `rows/cols`, clamp box width to `cols`, recompute region, full footer redraw.
- **Teardown** `restore()`: reset scroll region (`ESC[r`), disable bracketed paste (`ESC[?2004l`), show cursor (`ESC[?25h`), move below the footer. Called on exit and on uncaught error.

**Footer height** `footerH = (statusActive ? 1 : 0) + boxRows + 2 + 1` where `boxRows = min(10, inputLineCount)` (the **10-line cap**) and the `+2` is the box top/bottom borders, `+1` the hint. When `inputLineCount > 10`, the box shows a 10-row window around the cursor (internal scroll); a `⌃`/`⌄` affordance is out of scope — just window to keep the cursor visible.

Box width responsive: inner width = `cols - 4` (`│ ` … ` │`). Lines longer than inner width are horizontally clipped to keep the cursor visible (no soft-wrap inside the box — wrapping fights the fixed height).

### `cli.ts` rewrite (REPL branch only)

Replace the `readline` block (lines ~134–263) with:

1. Construct `Screen`; enable raw mode + bracketed paste (`ESC[?2004h`); hide cursor management to `Screen`.
2. `ReplController.onOutput → screen.print`; `onStatus → screen.status`; spinner `setInterval → screen.tick`.
3. stdin `data` → `decodeKeys` → for each key `editor.handle` → translate action:
   - `render` → `screen.renderFooter(editor.view())`.
   - `submit` → run turn (`r.handle`) with the same pause/resume + `armAbort` (Esc/Ctrl-C mid-turn → `r.abort`) flow; pickers for bare `/layer`,`/as` via existing `menu.ts` as a footer-modal.
   - `complete` → `completeArg`/`completeLine`, `editor.applyCompletion`, repaint.
   - `sigint` → existing `interrupt.ts` `sigintAction`.
   - `eof` → teardown + exit.
4. Menu pickers (`pickFrom`) adapted to draw through `screen.print`/a modal footer instead of ad-hoc cursor math.
5. Intro lines (`✻ slaude sim`, mode, hint) printed via `screen.print` before the first footer render.

### Fallout

- **Remove** `term.ts` (`LiveTerminal`) and `tests/gateway/sim/term.test.ts` — superseded by `Screen`.
- **Keep unchanged:** `repl.ts`, `render.ts`, `menu.ts`, `complete.ts`, `interrupt.ts`, `roles.ts`, `stub-agent.ts`, transcript/run path.
- New tests: `keys.test.ts` (decoder), `editor.test.ts` (reducer parity), `screen.test.ts` (footer layout + region math against an injected write sink/size).

## Testing strategy

- **Pure units** (`keys`, `editor`, `screen` layout math): deterministic unit tests, no TTY. This is where correctness lives.
- **Manual smoke** (can't unit-test a real TTY): `slaude sim --stub` — type, multi-line paste, resize the window, ↑/↓ history, Tab, open a gate (a/d/A), `/layer` picker, Ctrl-C/Ctrl-D. Confirm box stays pinned + responsive.

## Risks

- Scroll-region + absolute-cursor interplay is the one genuinely tricky piece; isolated in `Screen` with pure layout math under test.
- Custom editor loses readline polish (unicode width, kill-ring). Acceptable for a dev sim; documented as non-goal.
- Bracketed paste depends on terminal support (iTerm2, Terminal.app, most modern terminals support it); fallback is literal char insertion (still correct, just no multi-line-as-one framing on ancient terminals).
