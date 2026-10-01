---
title: "A fake Slack for the HA suite, and what running the real gateway against it found"
date: 2026-10-01
---

**Decision:** the HA end-to-end suite talks to a small purpose-built fake Slack (`e2e/fake-slack`), not a real workspace and not an existing mock. Its fidelity is established by running the real gateway, in one process, against it. Four product defects surfaced while building and running that fidelity test, none fixed in the change that introduced the fake; the harness work around it found three constraints worth recording.

## Why a fake and not a real workspace

A real workspace cannot be driven end to end by a test. There is no API for a user to press a Block Kit button, so an approval card could be posted and observed but never decided. Sending a message as a human needs a user token that a bot cannot mint. A real workspace also brings rate limits and, for HTTP mode, a public tunnel for Slack to call back into the cluster, all for a test whose subject is gateways, nodes and a queue, not Slack. The fake plays both roles: it is the Web API the gateway calls and the signing sender of events and interactions the gateway receives, including Slack's retry behaviour and the way one message can arrive as two events.

## Why not an existing tool

The tools considered intercept inside the client process (so the gateway's real HTTP transport and signature check are bypassed), do not sign requests, or cover only the App Home surface. The properties under test (signed delivery to a specific replica, exactly-once handling under redelivery, a click landing on a replica that did not post the card) all live on the wire, so the fake is a real HTTP server on both sides.

## Fidelity: the real gateway against the fake

The fake is only trustworthy if the thing it imitates is exercised for real. The test starts the real `createGateway` on the real HTTP transport with the simulation agent and points it at the fake in the same process. That run answers two questions: does every Web API method the gateway calls exist in the fake (an unknown method answers `unknown_method` and is flagged in the call log, and the test asserts none was), and does every call match Slack's published schema (a guard derived from the archived OpenAPI spec records unknown or missing parameters and unknown top-level response properties without changing any response; its limits are in the fake's README). `assistant.threads.setStatus` is outside the archived spec, so it is unjudged.

Four defects surfaced while building and running it, described by mechanism:

1. **HTTP mode reads the bot token on every message.** The gateway reads `SLACK_BOT_TOKEN` per inbound message, around the attachment download, even for a message with no attachments. A scale deployment that registers its tokens in the `slack_apps` table and sets no such variable drops every turn. The docs say webhook mode does not read it. Every gateway test sets the variable, which hid it. The e2e overlay therefore sets a non-token-shaped placeholder in its ConfigMap.
2. **With several apps in one HTTP-mode gateway, calls through the transport's shared client go out as the oldest registered app.** The shared client (what the agent's surface and tools use when a persona has no user token of its own) is built lazily and forwards every post, reaction and status call to the oldest registered app, whichever app received the message; a persona with its own user token gets its own client. The multi-persona scenario therefore cannot assert identity until this is fixed. Pointers: `src/gateway/slack/http-transport.ts` and `src/gateway/core/gateway.ts`.
3. **That same lazy client lacks several methods.** `chat.postEphemeral`, `chat.delete`, `files.*`, `pins.*`, `conversations.setTopic` and `setPurpose`, and `canvases.edit` are missing, so the portal onboarding link (the `/link` command and the `/1on1` nudge) is never delivered in HTTP mode. The failure is only logged.
4. **A second click on an already-decided approval card replaces the card text.** The replacement ("approval already decided") removes the buttons, which is the intent, but it also removes the record of what was decided.

## Harness findings

- **Seeding after boot needs a restart.** The soul is memoized at pod start and a gateway loads the registered apps once, so seeding a persona into a running cluster is invisible to it. The suite driver fingerprints the state the pods read at boot, records it on each Deployment, and restarts gateway and node only when it changed (about 28 s); a second run restarts nothing. The seed itself is guarded by an environment variable inside the pod, and the persona cache is seeded directly because the mock LLM cannot answer the soul-extraction call.
- **The mock LLM never reaches Slack with plain text.** slaude speaks only through its surface reply tool, so an assistant message of plain text is never posted. The `echo` scenario therefore answers by calling that tool, and the turn ends once the tool result is in. The retry-count header staying at 0 is covered in [the mock-LLM spike](2026-09-30-e2e-mock-llm-spike.md).
- **Each case leaves a process behind.** A case leaves its `claude` CLI process (about 150 to 200 MB) alive on a node. Free memory in a 3.5 GB node fell from about 1550 to about 1200 MB over three cases, so the number of cases per run, and a second running minikube profile on the same Docker VM, are real limits. `scripts/e2e-ha.sh` refuses to start while another profile is running, prints the free VM memory, and never stops anything on the user's behalf.

## What this proves and does not

It proves gateway, node and queue behaviour against a faithful wire peer. It does not prove that real Slack accepts a given payload or renders it as intended; a canary against real Slack, planned with the HA scenarios, samples that.
