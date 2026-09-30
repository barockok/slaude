---
title: "Can the real Claude CLI run a turn against a mock LLM?"
date: 2026-09-30
---

**Decision:** build on aimock. The real CLI (2.1.285, print mode, `--allowedTools Bash`) completed a two-step tool loop against an aimock instance with a dummy API key and an isolated home, exit 0, final text `spike done`, and the mock saw no request other than the chat endpoint. Two constraints follow from the probes: the mock must run on Node (Bun cannot load aimock), and fault scenarios cannot rely on the SDK retry-count header.

## What the CLI called

Only `POST /v1/messages?beta=true`, three times for the tool loop (tool call, tool call, final text) and two for the fail-once run. No `count_tokens` request appeared in these runs (the mounted `/v1/messages/count_tokens` handler was never hit). The path carries a `?beta=true` query, so a front handler matching on the path must match the pathname, not the raw URL. The CLI printed a notice that the gateway is not eligible for a billing change to auto-mode classifier requests; it is informational and the run still succeeded. Requests carry `anthropic-beta` flags, `x-claude-code-session-id`, and `x-stainless-*` headers; the body was about 63 KB because of the system prompt and tool schemas.

## What the mock saw in `messages[]`

aimock normalizes the Anthropic body to an OpenAI-style history:

- The system prompt arrives as a leading `role: "system"` message (string content, beginning with an `x-anthropic-billing-header:` line).
- The first `role: "user"` message is a `<system-reminder>` block injected by the CLI, so do not assume the first user message is the operator's prompt text.
- An assistant tool call becomes `{role: "assistant", content: "null", tool_calls: [{id, type: "function", function: {name, arguments}}]}` (note the literal string `"null"` as content).
- A tool result becomes `{role: "tool", tool_call_id, content}`. Counting `role: "tool"` messages worked as a step counter: request N saw N-1 tool messages.
- Tool call ids returned by the mock (`toolu_mock_1`) round-tripped unchanged.

## Retry header

`x-stainless-retry-count` was `"0"` on the request that followed a 529, so it is not usable as an attempt counter. The CLI absorbed the 529 (a second request, then exit 0) but the header stayed at 0. Fault scenarios must count attempts in the front handler, for example keyed by a hash of the history, as the plan's fallback describes.

## Custom header

Works. With `ANTHROPIC_CUSTOM_HEADERS="X-AIMock-Context: t1"` every journal entry showed `x-aimock-context: t1`, so a per-run context tag can be passed through the real CLI.

## Bun

Does not work. Under Bun 1.3.11 the aimock module fails to load with `SyntaxError: Invalid regular expression: range out of order in character class` in `dist/files.js` (a control-character class in the file-name sanitizer). The mock therefore stays on Node; the CLI under test runs in its own process and is unaffected.
