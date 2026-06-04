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

## Closing the claude-code-parity gaps

A follow-up sweep closed the bucket-A REPL-UX gaps:

- **Thinking text** — `thinking` events now print as a dim `✻ …` line (`render.thinkingLine`),
  not just a spinner label.
- **Token/context usage** — on `done`, a dim `1.2k in · 340 out · 8% ctx` line from
  `AgentManager.getTokenSnapshot` (`render.usageLine`, surfaced via `SimSession.usage`).
- **Mid-turn interrupt** — while a turn runs the TTY goes raw and Esc / Ctrl-C call
  `ReplController.abort()` → `SimSession.abort` → `AgentManager.abort(sessionId)`. The sim
  captures the live sessionId from the event stream.
- **Ctrl-C at the prompt** (shell-style, `interrupt.sigintAction`) — a non-empty line is
  cleared; an empty line warns `(press Ctrl-C again to exit)` and a second consecutive press
  exits. Any submitted line disarms the warn. Distinct from mid-turn Ctrl-C (raw-mode abort).
- **Tab autocomplete** — readline `completer` over `replCommandNames()` (sim-native commands +
  `AGENT_COMMANDS` heads — same single source as `/help`). Pure `completeLine` (complete.ts).
- **Multi-line input** — a trailing `\` continues onto a `…` line; the joined text sends as one
  message.

Left open on purpose:
- **Token streaming** (type-in token-by-token) — the agent SDK path emits one `assistantText`
  per *content block*, not per token (`manager.#fanout`). True streaming needs SDK partial
  deltas; faking it would lie about timing. Documented, not implemented.
- **Reverse-search / queued-message panel** — low value for a chat-agent sim; skipped.

Live end-to-end for thinking/usage/abort needs working LLM creds (same gap as manager
extraction); the pure formatters + reducers are unit-tested and the wiring is typecheck-clean.

## Scenario = layer × role, inspection, and the verification path

A second batch reworked the sim model + tooling:

- **Layer × role** (`roles.ts`) — instead of fixed presets, compose the authz matrix:
  `/layer <dm|trusted|allowed|restricted>` picks the engagement zone; `/as
  <manager|approver|backup|member|outsider>` resolves a role to a user id via the active soul
  (works in shared mode — never writes SOUL.md). Bare `/layer` / `/as` open arrow pickers
  (the `pickFrom` generalization of the scenario picker).
- **Autocomplete** — Tab now completes first-argument values (layers, roles, scenario names,
  behaviors) via `complete.completeArg`, not just command heads.
- **Inspection** — `/budget` (context + token breakdown, `render.budgetView`), `/memory`
  (`memory.prefetch(sessionId)` — what the agent actually sees), `/sessions` (live count).
- **Per-tool elapsed + ctx%** — `⎿ … (1.2s)` timing per tool (FIFO start-time queue) and the
  last-known context % in the spinner label. The SDK only reports tokens at turn-end, so there
  is no live mid-turn token delta — ctx% reflects the previous completed turn.
- **Paste coalescing** — Bun's readline strips bracketed-paste markers but emits one `line`
  event per pasted line; an 8ms debounce joins a burst into one message (a human can't Enter
  twice that fast). Coexists with `\`-continuation.
- **`--real` creds preflight** (`preflight.missingCredsWarning`) — a real turn drives the
  claude CLI subprocess, which needs a provider credential; we warn early + actionably instead
  of letting it 401 mid-turn. A fake-LLM at `ANTHROPIC_BASE_URL` was rejected as a path — it
  would have to satisfy the real CLI's full protocol. True live `--real` verification is
  gated on a provider key in `~/.slaude/.env`.

Two requested-but-not-built items, with reasons: **token streaming** (SDK emits per
content-block, not per token) and a **fake LLM server** (would reimplement Anthropic's API for
the real CLI — large/brittle).

## Named scenarios removed — layer × role × behavior only

A "scenario" bundled three now-independent axes, so the named presets were deleted entirely:

- `presets.ts` + `presets.test.ts` gone. The default world is `soul-fixture.WORLD`.
- A fixture session is `SimSession.create({ layer?, as?, behavior?, soul? })` — defaults to
  WORLD soul, `dm` layer, `manager` role, `reply` behavior. `bun run sim --fixture` now
  **auto-starts** that session (`ReplController.startDefault`) — no `/scenario` step; compose
  with `/layer · /as · /behavior`.
- `/scenario` / `/scenarios` / the scenario picker are gone; `pickScenario` removed (the
  generalized `pickFrom` still backs the layer/role pickers).
- The 23 preset-based transcripts + 2 fixtures migrated to top-level `layer:` / `as:` /
  `agent_behavior:` (mechanical map: manager-dm→dm/manager, member-trusted→trusted/member,
  restricted-blocked→restricted/outsider, approval-flow→trusted/member+request_approval,
  borrow-grant→trusted/outsider+connect_borrow). Transcript schema dropped `preset`.
- `/behavior` autocompletes from `stub-agent.BEHAVIORS`; the DM layer channel is `D0SIM`
  (was the preset's `D0MGR` — no transcript asserts on channel ids, so it's transparent).

742 tests + 25/25 transcripts stay green.

## Gotchas

- The gate appearing "twice" in a quick smoke is correct authz: a non-approver (U0ALICE)
  answering `a` is rejected and the gate stays open. Approve as the approver (`/as U0APP`).
- When eyeballing raw sim output, strip `\r`/`\x1b[2K` *and apply* them — the spinner line is
  overwritten in a real terminal, so naive `sed` makes reply text look concatenated onto a
  `Thinking…` line when it isn't.
