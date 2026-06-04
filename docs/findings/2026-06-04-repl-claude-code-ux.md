# Sim REPL — claude-code-grade UX

Date: 2026-06-04
Spec: [docs/superpowers/specs/2026-06-04-repl-claude-code-ux.md](../superpowers/specs/2026-06-04-repl-claude-code-ux.md)

## What changed

`bun run sim` now feels like the claude-code REPL:

- **Live bottom-pinned status line** — one line repaints in place (spinner + activity +
  elapsed): `✻ Thinking… (3s)`, `Bash… (1s)`, `Writing…`. No new line per tick. Tracks
  *what the agent is doing right now* from the event stream.
- **claude-code framing** — `✻ slaude sim` banner, dim `›` prompt, tool tree
  (`⏺ Tool(args)` / `  ⎿ result`), `⏺` reply bullets.
- **Approval as a bordered box** — `╭─ Approval needed: deploy prod ─╮` with numbered
  options; answer `a/d/A` or `1/2/3`. Same box in stub and real paths.
- **Group activity** — `/as <U> <text>` injects one message as another user without
  switching the actor, so you can stage a busy channel. `/as <U>` (no text) still switches
  permanently. `/as /channel /dm` work mid-session, incl. shared mode (they never touch
  SOUL.md — only `/scenario` does, which stays blocked in shared).

## How it's built (testable core, thin TTY seam)

- `render.ts` (pure) — formatters: `toolLine`/`resultLine`/`replyLine`/`errorLine`/
  `statusLabel(event)`/`gateBox(card)`/`SPINNER_FRAMES`. 13 unit tests.
- `term.ts` — `LiveTerminal(write, {frames, now})` owns the status region: `print` commits
  scrollback above, `status(label|null)` sets/clears the live line, `tick` advances the
  spinner. I/O injected (write sink + clock) → 7 unit tests assert the `\r\x1b[2K`
  clear/repaint sequences and `frame label (Ns)` composition, no real TTY needed.
- `repl.ts` — orchestrates: keeps `onOutput(line)` (committed scrollback; existing tests +
  transcripts unchanged) and adds `onStatus(label|null)`. Drives the status from events;
  renders only *new* cards per stub turn (a render cursor) so each turn shows just its output
  — `/cards` still dumps the full listing for inspection.
- `cli.ts` — TTY seam: `LiveTerminal(process.stdout.write)`, a 120ms `setInterval` spinner
  tick (no-op while idle, so it never clobbers typed input), banner + `›` prompt.

## Key decision: turn-based, no simultaneous spinner+typing

Input only happens while the spinner is stopped (prompt → run+spin → gate?(stop/answer/resume)
→ done → prompt). This sidesteps the hardest terminal problem (live region competing with line
input) and matches how a turn actually flows. The spinner interval runs always but `tick()` is
a no-op when no status is active, so it's safe to leave running during the input read.

## Input editing: node:readline, not the bare console iterator

Bun's `for await (const line of console)` is a dumb line reader — no cursor movement, no
history, arrow keys land as literal `\x1b[D` in the text. Switched the interactive seam to
`node:readline` (`terminal: true`): arrow keys move the cursor, ↑/↓ recall history, Home/End/
Ctrl-A/E and backspace work. The turn-based flow makes coordination trivial — `rl.pause()`
while a turn runs (so input echo never fights the spinner), then `rl.prompt()` again. The
spinner interval is harmless at the prompt because `tick()` is a no-op when idle. Verified
under a real PTY: typing `helo`, Left, `l` submits `hello`.

## Scenario picker (claude-code `/mcp`-style panel)

Bare `/scenario` on a TTY opens an arrow-select panel below the prompt (↑/↓ or j/k, Enter
loads, Esc cancels) instead of needing `/scenario <n>`. Built as `menu.ts` (pure
`renderMenu`/`decodeKey`/`menuReduce`, 9 unit tests) + a raw-mode stdin loop in cli.ts's TTY
seam. The loop sets `stdin.setRawMode(true)` + `resume()` while readline is paused (we're
mid-line-handler, between prompts, so they don't fight), redraws in place by moving the cursor
up `lines-1` rows, and erases the panel with `\x1b[<n>A\r\x1b[0J` on exit. Non-TTY (piped)
and shared mode fall through to the old text list — picker is TTY+fixture only. Verified under
a PTY: `/scenario` → ↓↓ → Enter loads scenario 3; Esc loads nothing.

## Gotchas

- The gate appearing "twice" in a quick smoke is correct authz: a non-approver (U0ALICE)
  answering `a` is rejected and the gate stays open. Approve as the approver (`/as U0APP`).
- When eyeballing raw sim output, strip `\r`/`\x1b[2K` *and apply* them — the spinner line is
  overwritten in a real terminal, so naive `sed` makes reply text look concatenated onto a
  `Thinking…` line when it isn't.
