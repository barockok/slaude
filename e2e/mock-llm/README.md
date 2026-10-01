# mock-llm

A stateless, Anthropic-compatible mock LLM for slaude's end-to-end tests. It is
built on aimock; every reply is a pure function of the request, so a turn that
is killed and re-delivered to another replica gets the same answer.

## Prerequisites

bun (for the bundle), docker (for the image), node 22 (to run the bundle directly).

## Run

    scripts/build-mock-llm.sh            # image slaude-mock-llm:dev
    docker run --rm -p 8080:8080 slaude-mock-llm:dev

Point a client at it with `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` and any key.

Never restart the mock mid-case: SIGTERM cuts open streams, which the CLI sees as
a `drop`. Expose it ClusterIP-only, never behind an Ingress: it passes through
aimock's `/__aimock/*` control endpoints and accepts unauthenticated
`DELETE /__mock/journal`.

## Choosing a scenario

Put a tag in the user message: `[[mock:<name> key=value ...]]`. The most recent
user message that carries a tag decides the turn. Requests with no tag get
`mock: untagged request`.

| Scenario | Params | Reply |
|---|---|---|
| `echo` | | `[<persona>] <user text>`; persona is the `Persona-ID:` line in the system prompt. When the request offers slaude's `mcp__slaude_surface__reply` tool (slaude never shows plain assistant text), the reply goes out as that tool call, and the turn ends with `replied` once its result is in |
| `multi-tool` | `n` (default 2), `tool` (default Bash) | `n` sequential tool calls, then `done after n tools` |
| `long-stream` | `chunks` (default 20) | Many small chunks |
| `think` | | A thinking block, then `thought about it` |

## Faults (work with any scenario)

| Param | Effect |
|---|---|
| `ttft=<dur>` | Delay before the first byte (`500ms`, `2s`) |
| `interval=<dur>` | Pause between streamed events |
| `fail=<status>` `until-retry=<k>` | Error while the mock has seen fewer than `k` earlier attempts of the same request (same system prompt and history); `k` defaults to 1, so the first attempt fails and the retry succeeds |
| `drop=<k>` | Cut the stream after `k` events |
| `malformed=1` | Bad SSE |
| `hang=1` | Never answer; the case lasts the client's request timeout times its retries (SDK default: 10 minutes, 2 retries), so node pods must set a short API timeout first (Plan 2 confirms the variable) |
| `overflow=1` | 400 prompt-too-long |

Precedence: hang, overflow, fail, drop, malformed.

## Inspecting

`GET /__mock/journal` lists every request as
`{ seq, ts, method, path, retryCount, clientRetryCount, tag, tagParams, action, messages, historyHash, persona, offersReply }`
(`seq` rises per process and is never reset, so a test can take it as a mark before sending;
`tagParams` are the tag's params, so a test can add its own `case=<id>` to find its rows;
`persona` is the system prompt's `Persona-ID:`; `offersReply` says whether the surface reply tool was offered);
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
- The journal is per replica: `GET /__mock/journal` through a multi-replica
  Service returns one pod's rows. Merge per-pod journals or query pods directly.
- `DELETE /__mock/journal` also resets the attempt counters, so clearing between
  cases changes fault behaviour for any case in flight.
- A turn re-delivered after a node kill rebuilds its system prompt. If
  `<memory-context>` changed, the attempt key changes and `fail=...` fires again.
- With the default `until-retry=1`, two replicas and the SDK's default two
  retries, fail-once still converges (the third attempt lands on a replica that
  has seen the key). `until-retry` of 2 or more does not converge on 2 replicas;
  use one replica or client-IP affinity.
- aimock cannot load under Bun, so the mock runs under Node. The build script
  bundles `main.ts` with `bun build --target=node`.
- The real Claude CLI calls `POST /v1/messages?beta=true`, which is handled.
