# mock-llm

A stateless, Anthropic-compatible mock LLM for slaude's end-to-end tests. It is
built on aimock; every reply is a pure function of the request, so a turn that
is killed and re-delivered to another replica gets the same answer.

## Run

    scripts/build-mock-llm.sh            # image slaude-mock-llm:dev
    docker run --rm -p 8080:8080 slaude-mock-llm:dev

Point a client at it with `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` and any key.

## Choosing a scenario

Put a tag in the user message: `[[mock:<name> key=value ...]]`. The most recent
user message that carries a tag decides the turn. Requests with no tag get
`mock: untagged request`.

| Scenario | Params | Reply |
|---|---|---|
| `echo` | | `[<persona>] <user text>`; persona is the `Persona-ID:` line in the system prompt |
| `multi-tool` | `n` (default 2), `tool` (default Bash) | `n` sequential tool calls, then `done after n tools` |
| `long-stream` | `chunks` (default 20) | Many small chunks |
| `think` | | A thinking block, then `thought about it` |

## Faults (work with any scenario)

| Param | Effect |
|---|---|
| `ttft=<dur>` | Delay before the first byte (`500ms`, `2s`) |
| `interval=<dur>` | Pause between streamed events |
| `fail=<status>` `until-retry=<n>` | Error while the mock has seen fewer than `n` earlier attempts of the same request (same system prompt and history); `n` defaults to 1, so the first attempt fails and the retry succeeds |
| `drop=<k>` | Cut the stream after `k` events |
| `malformed=1` | Bad SSE |
| `hang=1` | Never answer |
| `overflow=1` | 400 prompt-too-long |

Precedence: hang, overflow, fail, drop, malformed.

## Inspecting

`GET /__mock/journal` lists every request as
`{ ts, method, path, retryCount, clientRetryCount, tag, action, messages, historyHash }`;
`DELETE` clears it. `retryCount` is the number of earlier attempts of the same
request that the mock counted itself; `clientRetryCount` is the client's
`x-stainless-retry-count` header and is informational only. aimock's own
journal is at `/__aimock/journal`.

## Caveats

- Attempt counting is in-process. It is the one stateful exception to the
  statelessness rule (fault-only, it never changes reply content), so fault
  scenarios that need more than one attempt require a single mock replica or
  client-IP affinity.
- Attempts are keyed by a hash of the system prompt plus the messages, so test
  prompts must be unique per case and per persona, or two cases share a counter.
- aimock cannot load under Bun, so the mock runs under Node. The build script
  bundles `main.ts` with `bun build --target=node`.
- The real Claude CLI calls `POST /v1/messages?beta=true`, which is handled.
