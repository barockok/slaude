# Pinned bordered input box (sim REPL)

**Date:** 2026-06-05

Replaced the sim REPL's `node:readline` input with a claude-code-style rounded box
pinned to the terminal bottom via a DECSTBM scroll region. Output scrolls in the
region above; the box (and a status spinner above it) stay fixed at the bottom and
track terminal width on resize.

## What shipped

- `keys.ts` — `decodeKeys(s)` decodes a raw stdin chunk → key tokens (printable runs,
  arrows/home/end/delete, C0 controls, lone ESC, bracketed-paste markers). Pure + stateless.
- `editor.ts` — `LineEditor`, a pure reducer (no I/O) with readline parity: insert/erase,
  cursor movement, Ctrl-A/E/U/W, ↑/↓ history with draft stash, trailing-`\` multiline
  continuation, bracketed-paste (newlines inserted literally, no auto-submit), Tab → complete.
  State is private; `view()` is the only read path.
- `screen.ts` — pure `layoutFooter(model)` (footer lines + absolute cursor position) plus the
  `Screen` class (scroll region + footer painting, I/O injected for tests).
- `cli.ts` — REPL branch rewritten as a raw-mode loop driving the three modules.
- Removed `term.ts` (`LiveTerminal`) + its test — superseded by `Screen`.

## Why readline had to go

readline owns a single line at the cursor and can't live inside a fixed bottom region.
A pinned box needs absolute-positioned redraws on every keystroke, so the line editor is custom.

## Decisions / limits

- **Bottom-anchored footer:** `regionBottom = rows − height`, footer occupies the last `height`
  rows. A status line slots in *above* the box without moving the box/cursor. The first naive
  attempt anchored to a "core height" so the box moved when status toggled — that overflowed the
  footer below the last row. Bottom-anchoring is the invariant: `regionBottom + height === rows`.
- **Region reset on resize:** the region must be re-set whenever `regionBottom` moves — not only
  on height change. A terminal resize changes `rows` (hence `regionBottom`) at constant height; a
  height-only guard left a stale region and corrupted scrollback.
- **Multi-line cap:** input box capped at 10 visible rows (windowed to keep the cursor line
  visible); no soft-wrap — long lines clip horizontally around the cursor.
- **↑/↓ = history recall** (not in-buffer line navigation) — simpler, matches the old REPL.
- **Bracketed paste** (`ESC[?2004h`) frames pastes, replacing the old 8 ms burst-debounce; ancient
  terminals fall back to literal char insertion.
- **Picker is modal:** while a `/layer`·`/as` picker is open, a `modal` flag stops the main editor
  handler from also consuming the arrow keys (they would otherwise drive menu *and* buffer at once).
- **Terminal restore on any exit:** `process.on("exit")` runs an idempotent `cleanup()` so a crash
  never leaves the user in raw mode with a stuck scroll region.

## Tests

Pure units cover the correctness surface: `keys.test.ts` (decoder), `editor.test.ts` (reducer
parity), `screen.test.ts` (`layoutFooter` math + `Screen` region/footer emission, incl. resize and
status-clear ghost). The raw-mode `cli.ts` loop has no unit test (real TTY); verified by a headless
boot smoke and the interactive checklist below.

## Interactive smoke checklist (real TTY — `bun run sim --stub` or `slaude sim`)

- Box pinned at bottom, full width, rounded corners; output scrolls above it.
- Editing: L/R/Home/End/Ctrl-A/E move; Backspace/Delete/Ctrl-U/Ctrl-W erase.
- ↑/↓ recall history; Tab completes `/lay` → `/layer `.
- Trailing `\` + Enter → second line (box grows, capped at 10); Enter submits the multi-line.
- Multi-line paste arrives as one message (not N submits).
- Resize the window → box redraws at the new width, stays pinned, scrollback intact.
- Open a gate → `a`/`d`/`A` answers it. `/layer` (no arg) → picker; arrows + Enter select, Esc cancels.
- Ctrl-C clears a typed line; Ctrl-C twice on empty → exit; Ctrl-D on empty → clean exit (cursor
  restored, no stuck scroll region).

Spec: `docs/superpowers/specs/2026-06-05-pinned-input-box-design.md`
Plan: `docs/superpowers/plans/2026-06-05-pinned-input-box.md`
