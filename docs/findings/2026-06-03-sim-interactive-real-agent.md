# 2026-06-03 — Interactive sim against the live agent (`--real`)

**What:** The sim REPL can now drive the real `AgentManager` (live LLM) and renders a
claude-code-style feed instead of raw infra logs. Goal: chat with the agent through the
full gateway (gates, soul, MCP) without a Slack workspace.

## Touchpoints

- **`config/env.ts`** — exported `loadDotenv(path)` (was private). The sim forces an
  isolated temp `$SLAUDE_HOME`, so its `.env` never loads the operator's creds; `--real`
  now pulls a project-cwd `.env` explicitly (no override of already-set process env).
- **`gateway/sim/cli.ts`** — `--real` (live agent) and `--verbose`/`-v` (restore infra
  logs) flags. Default quiet: mutes `console.log`/`console.error` **and raw
  `process.stderr.write`** for `[mgr]`/`[agent-evt]`/`[slack-rx]`/`[stop-guard]`… tagged
  lines (stop-guard writes straight to stderr, bypassing console). `process.exit(0)` after
  dispose — the REPL otherwise hangs on stdin EOF because SDK child / MCP handles keep the
  loop alive.
- **`gateway/sim/transport.ts`** — `onCard(cb)` fires per outbound card (live render + gate
  detection).
- **`gateway/sim/engine.ts`** — real agent uses `AgentManager`. `#armTurn()` arms a
  `done`/`error` listener **before** feeding (the turn is async — feedMessage returns before
  the reply lands), and **also resolves when a permission/approval gate opens**: a gate
  pauses the SDK turn awaiting a human click, so control returns to the REPL.
  `pendingGate()` + `resolveGate(verb)` click the open gate and await the continuation
  (which may stop at the next gate or finish).
- **`gateway/sim/repl.ts`** — live feed: `🤖` replies (assistantText / reply-tool, deduped),
  `⏺ Tool(input)` + `⎿ result` tool activity, `⚠️` errors, `🔒` inline gate prompt. Bare
  `a`/`d`/`A` (or allow/deny/always) answers an open gate. Reaction/message cards hidden
  (covered by the event stream). Stub path stays card-dump simple.

## Real-behavior facts

- **OAuth tokens are short-lived.** A `CLAUDE_CODE_OAUTH_TOKEN` minted via `claude
  setup-token` worked, then 401'd (`Invalid authentication credentials · Please run /login`)
  ~10 min later. The DeepSeek key in `../deploy-hermes/.env.vault` is a dead placeholder
  (401 auth-fail). Sim wiring is cred-agnostic; supply a fresh token/key in `slaude/.env`.
- **Agent may stop without calling `reply`.** When it does, the Stop hook's stop-guard
  fires and an `err=success` event surfaces as a `:warning:` card — a pre-existing
  real-agent quirk, not sim wiring.

## Deferred

- Token-level streaming (events are per-block, not per-token).
- A real-mode transcript format (current `*.yaml` scenarios assert stub-deterministic output;
  they mismatch under `--real`). Use the REPL for live interactive runs.
