---
title: "A warm session that outlived its job token took the node worker down"
date: 2026-10-10
---

**Finding:** a node worker process died right after a session's query loop exited. The log showed `[mgr] query() exited`, then `gateway /v1 request failed: 401 {"error":"invalid job token: expired"}` thrown from `NodeClient#json`, then `script "worker" exited with code 1`. The call that threw was the session's teardown status write, `setStatus(id, "idle")`. That write goes through the node's `RestSessionStore`, which does a `PATCH /v1/sessions/:id` with the last job token bound for the session. It ran inside the manager's detached query loop, which nothing awaits. Bun treats an unhandled promise rejection as fatal, so one session's teardown ended the process and every other session on the pod. It was seen after a long voice call, but voice was not the cause. Any warm session that idles out on a node hits it.

## The mechanism

- `AgentManager.#startSession` runs the SDK query in `(async () => { ... })()` with no caller. Its `finally` block awaits `this.#store.setStatus(sessionId, "idle")` before it deletes the live entry and emits `sessionExit`. A rejection there escaped the loop as an unhandled rejection. It also skipped the rest of teardown: the session stayed in the live map, and `sessionExit` never fired, so a voice call holding that session never learned that it had ended.
- On a node the store is `RestSessionStore`. Each call presents the job token bound for the session. A job binds its token when it claims the session lock, and a voice call's token keeper binds a refreshed token before each injected turn.
- The timings guarantee an expired token at an idle exit. A job token lives 15 minutes from its mint. The mint happens at enqueue, and the token is refreshed at claim only when more than 20% of its life is spent. The idle TTL (`SLAUDE_IDLE_MINUTES`, also 15 by default) is re-armed at each send and again when a voice hold is released. That is later than the token's mint. So the session closes after the last bound token's `exp`, and the gateway's `/v1` verifier has no grace. Voice made this easy to see because `holdIdle` keeps the session warm for the whole call. When the call ends, the hold is released and the idle timer starts again from that point, after the last token the call's keeper bound.
- Other detached calls on the same loop could reject in the same way. These were `markStarted` and `clearStarted` in the resume-miss and already-in-use retry paths, the fire-and-forget `markStarted` on every assistant message, and the reboots after a reload (auto-continue and the reload prompt), which were `void this.sendMessage(...)` with no catch.

## The fix

- **Manager:** every store write from the detached loop is best effort. It is logged as `[mgr] session store <op> failed session=<id>: …`, and teardown always completes. The reboots after a reload report through `#rebootFailed`, as the resume-retry reboots already did: the failure becomes the session's `error` event. The loop also has a last-resort `.catch` that logs with the session id. Mono uses the same manager, so a database blip at teardown no longer ends the mono process either.
- **RestSessionStore:** when a call is refused with an expired-token 401, the store exchanges the token once through `/v1/jobs/:id/token-refresh` and retries. That endpoint forgives expiry for an hour and caps the token's total life. The fresh token has identical claims and is rebound only if no newer job has bound a token in the meantime. Any other refusal, including a failed refresh, fails that one call. An idle exit within the grace now writes `idle` correctly. One past the grace logs a line and the session still tears down.
- **Voice:** a session exit now always reaches `endCallsOnSessionExit`. A refused refresh inside the call's keeper was already `VoiceAuthLost`, which ends the call `auth_lost`. Nothing in `src/voice/` changed.
- **Process guard (node only):** `src/node/main.ts` installs an `unhandledRejection` handler after the boot handshake. Such a handler can hide bugs, so it is loud. It writes one `console.error` line marked `UNHANDLED REJECTION` with the session (when the error names one), the gateway's status and body, and the stack, and it counts `slaude_errors_total{kind="unhandled_rejection"}`, which you can alert on. Boot failures stay fatal through `main()`'s catch. A synchronous uncaught exception keeps Bun's default and ends the process. The voice loop child keeps its own rule (`src/voice/loop-entry.ts`), which crashes on both, because it serves a single call. Mono does not get the guard. The manager fix covers the known path there, and mono's crash convention was left alone.

## Evidence

- `tests/node/expired-token-exit.test.ts` reproduces the crash end to end with the real manager, `RestSessionStore`, `NodeClient` and the gateway's `/v1` router. Only the SDK query is fake. A session runs a turn, its bound token is replaced with one that expired 20 minutes ago, and the session exits. Before the fix, the test failed with the production trace (`#json` at `client.ts:263`, `401 invalid job token: expired`). After the fix, the status lands as `idle` and the token is rebound. With a token past the grace, there is no rejection, teardown completes, and the log line names the session.
- `tests/agent/manager-lifecycle.test.ts` ("store failures outside any caller") covers the three manager paths: a failed teardown write, a failed per-message `markStarted`, and a failed reload-prompt reboot. All three fail against the old manager.
- `tests/node/rejection-guard.test.ts` runs child processes, because `bun test` fails a test on any unhandled rejection in its own process whatever handlers are installed. With the guard, the child logs and stays alive. Without it, the same rejection ends the child.

## Not verified

- No run on the minikube cluster after the fix.
- The exact sequence in the observed incident, from "stop voice" to the query exit, was not reconstructed from cluster logs. The mechanism above holds for any exit of a session whose last bound token has expired.
