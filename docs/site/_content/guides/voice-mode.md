# Voice Mode

Voice mode lets the agent take part in a live call. It joins a meeting in a browser tab, listens, and talks back through a realtime voice model. The voice model only handles the conversation. Whenever it needs facts or tools, it hands the request to the thread's own Claude session, which does the thinking and sends the answer back to be spoken. The Slack thread stays quiet during the call, and when the call ends the agent posts a summary and the transcript.

> **Prerequisites:** The operator has set `SLAUDE_VOICE_ENABLED=1` and the settings below. A workbench (a remote browser service the agent controls through MCP) is reachable, with browser audio enabled and the `stream_token` capability. You are responsible for recording and consent law in your jurisdiction. The agent introduces itself as an AI assistant when it first speaks.

---

## 1. How a call starts

Ask the agent in a thread to join a meeting, for example "join https://meet.example.com/abc and take notes". The agent:

1. Opens the meeting in a workbench browser tab with the workbench's own browser tools.
2. Calls the workbench's `browser_audio_start` for that tab.
3. Calls `voice_start`, passing a short brief and the `browser_audio_start` result (stream URL, clear URL, route headers, sample rate and stream token).

The agent's voice then speaks into the call. The thread's session is held open for the duration, so it does not idle out mid-call.

## 2. Tools

| Tool | What it does |
|---|---|
| `voice_start` | Starts the call. Returns `{callId}`. Refuses with `VOICE_BUSY` if the thread already has a call. |
| `voice_say` | Makes the voice say something. `when: next_gap` waits for a pause, `when: now` interrupts. `reply_to` answers a request the voice delegated. A `now` that has fallen too far behind the conversation is downgraded to `next_gap`. |
| `voice_context` | Gives the voice a fact or instruction without making it speak. |
| `voice_stop` | Ends the call. Returns `{reason, durationSec}`. |

Refusals are typed: `VOICE_DISABLED` (not configured), `VOICE_AGENT_ONLY`, `VOICE_UNAVAILABLE`, `VOICE_BAD_ENDPOINT`, `VOICE_NO_CALL`, `VOICE_START_FAILED`.

## 3. The agent-only rule

Calls run as the agent, never as a person. A call is refused with `VOICE_AGENT_ONLY` in a thread that is `/1on1`-locked or pointed at a machine with `/remote`, because those threads run with a person's credentials and tools. On a node, a thread whose identity cannot be determined is also refused (`VOICE_UNAVAILABLE`); the check fails closed.

The thread's identity is re-checked:

- once more right before the voice process is spawned,
- before **every** turn the call injects into the session (delegated requests, transcript flushes, the closing summary).

If the identity changes during the call (someone runs `/1on1` or `/remote` in the thread), the next check fails and the call ends with reason `auth_lost`. If the thread's session reboots (for example because its configuration changed), the call ends with `session_rebooted`. No cleanup turn runs in that case, because the rebooted session may no longer be agent-only. The transcript file is still written, but the browser tab may stay in the meeting; leave it manually.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SLAUDE_VOICE_ENABLED` | `0` | `1`, `true` or `yes` turns voice mode on. |
| `SLAUDE_VOICE_MODEL` | `openai/gpt-realtime` | Provider-qualified voice model. Providers: `openai`, `gemini`. A bad value fails loudly. |
| `SLAUDE_VOICE_NAME` | provider default | Voice name passed to the provider. `voice_start` may override it per call. |
| `SLAUDE_VOICE_API_KEY` | (none) | The provider key. Required, together with the workbench URL, or voice stays off. |
| `SLAUDE_VOICE_WORKBENCH_URL` | (none) | The workbench base URL. Required. |
| `SLAUDE_VOICE_MAX_MINUTES` | `120` | Hard cap on one call; it ends with `max_duration`. |
| `SLAUDE_VOICE_STALE_SEQ` | `6` | A `now` utterance is downgraded to `next_gap` when the conversation has moved more than this many transcript lines since the request. |
| `SLAUDE_VOICE_TENANTS` | (empty) | Gateway only. Comma-separated tenant ids, or `*`. See below. |

### Topologies

**Single process (`mono`).** Set the `SLAUDE_VOICE_*` variables on the process. The `SLAUDE_VOICE_TENANTS` variable is not used.

**Gateway plus nodes.** Only the **gateway** sets these variables. Nodes never read voice variables from their own environment. They receive the voice block (model, voice name, key, workbench URL, max minutes and stale threshold) in their runtime bundle.

`SLAUDE_VOICE_TENANTS` decides which tenants get that block. Unset or empty means **no tenant gets voice**. This is deliberate: the voice key is one gateway-wide credential, and shipping it in every bundle would hand it to nodes serving tenants that never opted in, undoing the per-tenant credential isolation the rest of the gateway keeps. List the tenant ids that should have voice, or use `*` to allow all.

## 5. What happens during a call

**The workbench is pinned.** The stream and clear endpoints the agent passes to `voice_start` come from a model and could be steered by prompt injection. They must resolve to the same origin (scheme, host and port) as `SLAUDE_VOICE_WORKBENCH_URL`, with no embedded credentials, or the call is refused with `VOICE_BAD_ENDPOINT`. Route headers cannot set `Authorization`, `Cookie` or `Host`. This keeps the stream token from being sent anywhere else.

**The thread is quiet.** While the call runs, the agent's turns that serve the call do not post status lines, reactions or replies in the Slack thread. Normal posting resumes when the call ends, with the summary.

**The transcript.** The voice process emits the transcript. It is fed to the session in batches (as suppressed turns, so the session knows what was said) and is written to `voice-call-<callId>.txt` in the session's working directory. When the call ends, the agent runs a summary turn and attaches the file.

**The voice process.** Each call runs as a separate child process. The provider key and the stream token reach it only through its environment, never through arguments or its stdin protocol. Its environment is otherwise minimal: `PATH`, `HOME`, and, so that proxied or private-CA deployments can reach the provider, the usual `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lowercase forms), `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. It does not read a `.env` file.

**How a call ends.** Normal reasons are `stopped` (the agent called `voice_stop`), `ended_by_voice`, `max_duration` and `workbench:<reason>` (the tab or meeting closed). Failures are `provider_failed`, `provider_lost` (reconnects exhausted), `audio_lost`, `auth_lost`, `session_rebooted`, `node_drain` (a node shutting down) and `loop_crashed`.

## 6. Limits to know about

- Providers cap a connection's lifetime (Gemini around ten minutes). The loop reconnects at a pause in the conversation and re-seeds the model with the last lines of the transcript. It does not re-send a summary.
- A very long, silent call can outlive the session's job token, in which case the closing summary may fail with `auth_lost`.
- If a node dies mid-call, the call ends but nothing is posted in the thread.
