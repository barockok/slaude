# Sim REPL — claude-code-grade UX

Date: 2026-06-04
Branch: feat/sim-interactive-real-agent

## Goal

Make `bun run sim` feel like the claude-code REPL:

1. **Live status region** — one bottom-pinned line that repaints in place (spinner +
   current activity + elapsed). No new line per tick. Shows *what the agent is doing now*
   (Thinking… / Bash(…)… / Writing…), updating live.
2. **claude-code framing** — banner header, `> ` input prompt, tool tree (`⏺ Tool(args)`
   / `  ⎿ result`), assistant text bullets, dim/color accents.
3. **Scenario switchable anytime + group activity** — `/as /channel /dm` work mid-session
   (incl. shared mode, since they never touch SOUL.md); inline `/as <U> <text>` injects a
   message as another user to simulate a busy channel.
4. **claude-code approval** — gate rendered as a bordered box with numbered options;
   answer with `a/d/A` (or `1/2/3`).

## Non-goals

- No TUI library (no ink/blessed). Raw ANSI, zero new deps.
- No simultaneous spinner+typing. Input only happens while the spinner is stopped
  (turn-based: prompt → run+spin → gate?(stop/prompt/resume) → done → prompt). This sidesteps
  the hardest terminal problem and matches how a turn actually flows.

## Module split (testable core, thin TTY seam)

- `render.ts` (NEW, pure) — string formatters. `toolLine`, `resultLine`, `replyLine`,
  `errorLine`, `statusLabel(event)`, `gateBox(card)`, `banner()`, `SPINNER_FRAMES`.
  Unit-tested directly (pure in → string out).
- `term.ts` (NEW) — `LiveTerminal(write, {frames, now})`. Owns the bottom status region:
  `print(line)` commits scrollback (clear region → line+\n → repaint), `status(label|null)`
  sets/clears the live label, `tick()` advances spinner + repaints, `clear()` erases.
  Unit-tested with a capturing `write` sink + injected `now` — assert the `\r\x1b[2K`
  clear/repaint control sequences and composed `frame label (Ns)`.
- `repl.ts` — orchestrates. Keeps `onOutput(line)` (committed scrollback; existing tests +
  transcript mode unchanged) and adds `onStatus(label|null)` so the TTY can drive the live
  region. Drives status from the event stream; commits tool/result/reply lines. New group
  commands. `/scenario` stays blocked in shared mode; `/as /channel /dm` allowed.
- `cli.ts` — TTY seam: instantiate `LiveTerminal(process.stdout.write)`, a `setInterval`
  spinner tick while a turn runs, readline for input. `onOutput → term.print`,
  `onStatus → term.status`.

## Data flow (one turn)

```
user types ───────────────► repl.handle(text)
                                 │ onStatus("Thinking…")  ─► term.status  ─► spinner starts
  agent events ─► repl ─► onOutput(⏺ Bash…)  ─► term.print (scrolls above spinner)
                          onStatus("Bash(ls)…")
                          onOutput(  ⎿ …)
  gate opens ─► repl ─► onStatus(null)+onOutput(gateBox)  ─► spinner stops, box printed
                          (reads a/d/A)  ─► resolveGate ─► onStatus("Thinking…") resume
  done ─► onStatus(null) ─► spinner clears ─► prompt returns
```

## Testing

- `render.test.ts` — pure formatter assertions (tool/result/reply/error/status/gateBox).
- `term.test.ts` — LiveTerminal control-sequence + spinner/elapsed assertions via fake sink.
- `repl.test.ts` — extend: status labels emitted, group `/as <U> <text>`, switching allowed
  in shared mode. Existing assertions stay green.
- Full suite + 25 transcripts stay green (onOutput contract preserved).
