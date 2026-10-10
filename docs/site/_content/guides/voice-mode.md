# Voice Mode

Voice mode lets the agent take part in a live call. It joins a meeting in a browser tab, listens, and talks back through a realtime voice model. The voice model only handles the conversation. Whenever it needs facts or tools, it hands the request to the thread's own Claude session, which does the thinking and sends the answer back to be spoken. The Slack thread stays quiet during the call, and when the call ends the agent posts a summary and the transcript.

> **Prerequisites:** The operator has set `SLAUDE_VOICE_ENABLED=1` and the settings below. A workbench (a remote browser service the agent controls through MCP) is reachable, with browser audio enabled, whose `browser_audio_start` returns capability URLs (see below). You are responsible for recording and consent law in your jurisdiction. The agent introduces itself as an AI assistant when it first speaks.

---

## 1. How a call starts

Ask the agent in a thread to join a meeting, for example "join https://meet.example.com/abc and take notes". The agent:

1. Opens the meeting in a workbench browser tab with the workbench's own browser tools.
2. Calls the workbench's `browser_audio_start` for that tab.
3. Calls `voice_start`, passing a short brief and the `browser_audio_start` result (stream URL, clear URL, route headers (X-Browser-Session is required) and sample rate; the result's `format` (`pcm_s16le`), `channels` (1), `session_id` and `restarted` are accepted too, and nothing else).

**Capability URLs.** The stream and clear URLs are ephemeral capability URLs: each carries an unguessable secret for that audio session in its path, is valid only while the audio session is open, and stops working when audio stops, the call ends or the tab closes. They are the only authorization for the audio routes. Slaude sends no `Authorization` header to them, only the route headers (for example `X-Browser-Session`). Because the URLs are the secret, slaude never shows them in full: logs, the voice process's log lines and stderr, error messages, the approval card and the panel timeline show the origin only (`https://workbench.example.com/…`). Masking is by exact match: every piece of the URLs the call received (path, segments other than route words, query values, in every URL encoding) is masked wherever it appears, whatever its shape.

The agent's voice then speaks into the call. The thread's session is held open for the duration, so it does not idle out mid-call.

**Approval.** Under the normal permission mode, `voice_start` asks for approval like any other gated tool: joining a meeting and capturing its audio is a high-impact action. The approval card is rendered from the exact input that runs and shows everything that changes behaviour: the origin of each URL (flagged if it is not the pinned workbench), the sample rate, the format and channels when given, and whether a session id was passed (never its value), the route header names (values `[hidden]`), the voice and the configured model, any ignored fields, and the whole brief. Only the URL paths and header values are hidden. Before any card, the input is checked against the tool's strict schema: an unknown field, a wrongly typed value, a URL with credentials, a brief over 500 characters or a brief that quotes a whole stream or clear URL is denied with no card. The brief is shown whole and literally, never truncated; each of its lines is prefixed with `| `, and line breaks, zero-width and other invisible characters are shown as escapes, so a brief cannot imitate the card or close its code block. The mid-call controls (`voice_say`, `voice_context`, `voice_stop`) never ask: a card during the call would break the quiet thread, and stopping a call must not wait on a click.

## Joining a call

The order matters. Jitsi asks for the microphone as soon as the page loads, and the workbench grants it inside `browser_audio_start`. A page that loaded before the grant ends up with a muted or ended microphone. A capability with nothing attached for 60 seconds is revoked. So the agent works in this order:

1. `browser_start`.
2. `browser_audio_start` on the blank tab, before any meeting page loads.
3. `voice_start`, immediately, so the stream and uplink attach.
4. `browser_navigate` to the meeting URL (for example `https://meet.example.com/room`).
5. Join.

If the meeting page was already loaded, reload it after `browser_audio_start`.

Jitsi notes:

- Append `#config.startWithVideoMuted=true` to the URL, for example `https://meet.example.com/room#config.startWithVideoMuted=true`.
- A fresh room on the public meet.jit.si service may sit in "waiting for moderator" until someone with the moderator role joins.
- If the tab lands on Jitsi's post-hangup page (`close3.html`), the call has ended. The agent calls `voice_stop` and `browser_audio_stop`.
- The workbench ends the audio stream with a reason such as `idle` or `page_left`; the thread sees it as `workbench:idle` or `workbench:page_left`.

## 2. Tools

| Tool | What it does |
|---|---|
| `voice_start` | Starts the call. Returns `{callId}`. Refuses with `VOICE_BUSY` if the thread already has a call. |
| `voice_say` | Makes the voice say something. `when: next_gap` waits for a pause, `when: now` interrupts. `reply_to` answers a request the voice delegated. A `now` that has fallen too far behind the conversation is downgraded to `next_gap`. |
| `voice_context` | Gives the voice a fact or instruction without making it speak. |
| `voice_stop` | Ends the call. Returns `{reason, durationSec}`. |

Refusals are typed: `VOICE_DISABLED` (not configured), `VOICE_AGENT_ONLY`, `VOICE_UNAVAILABLE`, `VOICE_BAD_ENDPOINT`, `VOICE_BAD_INPUT`, `VOICE_NO_CALL`, `VOICE_START_FAILED`.

## 3. The agent-only rule

Calls run as the agent, never as a person. A call is refused with `VOICE_AGENT_ONLY` in a thread that is `/1on1`-locked or pointed at a machine with `/remote`, because those threads run with a person's credentials and tools. On a node, a thread whose identity cannot be determined is also refused (`VOICE_UNAVAILABLE`); the check fails closed.

The thread's identity is re-checked:

- once more right before the voice process is spawned,
- before **every** turn the call injects into the session (delegated requests, transcript flushes, the closing summary).

If the identity changes during the call (someone runs `/1on1` or `/remote` in the thread), the next check fails and the call ends with reason `auth_lost`. If the thread's session reboots (for example because its configuration changed), the call ends with `session_rebooted`. In both cases no summary or cleanup turn runs, because the session may no longer run as the agent. The transcript file is still written, but the browser tab may stay in the meeting; leave it manually.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SLAUDE_VOICE_ENABLED` | `0` | `1`, `true` or `yes` turns voice mode on. |
| `SLAUDE_VOICE_MODEL` | `openai/gpt-realtime` | Provider-qualified voice model. Providers: `openai` (e.g. `openai/gpt-realtime`), `openai-live` (e.g. `openai-live/gpt-live-1`; client delegation, no truncate, leaving the call goes through Claude), `gemini` (e.g. `gemini/gemini-live-2.5-flash`). A bad value fails loudly. |
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

**The workbench is pinned.** The stream and clear endpoints the agent passes to `voice_start` come from a model and could be steered by prompt injection. They must resolve to the same origin (scheme, host and port) as `SLAUDE_VOICE_WORKBENCH_URL`, with no embedded credentials, or the call is refused with `VOICE_BAD_ENDPOINT`. `X-Browser-Session` is required, and it is the only route header accepted; a missing one, or any other header (including `Authorization`, `Cookie` or `Host`), makes `voice_start` refuse with `VOICE_BAD_INPUT`. Redirects are refused. This keeps the capability URLs, and the route headers sent with them, from going anywhere else.

**The thread is quiet.** While the call runs, the agent's turns that serve the call do not post status lines, reactions or replies in the Slack thread. Normal posting resumes when the call ends, with the summary.

**The transcript.** The voice process emits the transcript. It is fed to the session in batches (as suppressed turns, so the session knows what was said) and is written to `voice-call-<callId>.txt` in the session's working directory. When the call ends, the agent runs a summary turn and attaches the file.

**The voice process.** Each call runs as a separate child process. The provider key reaches it only through its environment, never through arguments or its stdin protocol. The capability URLs reach it in the start message on its stdin, and every log line it writes back has them masked. Its environment is otherwise minimal: `PATH`, `HOME`, and, so that proxied or private-CA deployments can reach the provider, the usual `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lowercase forms), `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. It does not read a `.env` file.

**How a call ends.** Normal reasons are `stopped` (the agent called `voice_stop`), `ended_by_voice`, `max_duration` and `workbench:<reason>` (the tab or meeting closed). Failures are `provider_failed`, `provider_lost` (reconnects exhausted), `audio_lost`, `auth_lost`, `session_rebooted`, `node_drain` (a node, or a `mono` process, shutting down), `parent_gone` (the process that started the voice loop went away) and `loop_crashed`.

## 6. Limits to know about

- Providers cap a connection's lifetime (Gemini around ten minutes; GPT-Live reports an expiry time when the session starts). The loop reconnects at a pause in the conversation and re-seeds the model with the last lines of the transcript. It does not re-send a summary.
- On a node, a very long, silent call can outlive the session's job token (15 minutes, refreshable for up to 60 minutes after it expires, so about 75 minutes of silence), in which case the closing summary may fail with `auth_lost`.
- If a node dies mid-call, the call ends but nothing is posted in the thread.

### GPT-Live (`openai-live`) differences

GPT-Live runs in client-delegation mode: when it needs facts or tools it hands the request to the thread's Claude session, so Claude stays the brain. The protocol is a looser fit than the other two providers:

- **No truncate, no cancel.** GPT-Live yields to a speaker on its own. An urgent `now` utterance still flushes the audio already queued in the tab, but the model's memory is not trimmed to what was heard.
- **Synthetic turn events.** GPT-Live sends no turn boundaries, so the adapter derives "participant started/stopped speaking" and "agent finished speaking" from short quiet gaps in the transcript and audio. Barge-in is detected from the transcript, so it is a little late, and a short "mm-hmm" while the agent talks can cut off its queued audio.
- **The call cannot end itself by voice.** GPT-Live calls no tools of its own, so there is no `end_call`: a request to leave reaches Claude as an ordinary delegated request, and Claude ends the call with `voice_stop` (reason `stopped`, never `ended_by_voice`). The delegated task text is the participant's recent words, since the delegation event carries none.
