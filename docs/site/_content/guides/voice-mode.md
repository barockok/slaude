# Voice Mode

Voice mode lets the agent take part in a live call. It joins a meeting in a browser tab, listens, and talks back through a realtime voice model. The voice model only handles the conversation. Whenever it needs facts or tools, it hands the request to the thread's own Claude session, which does the thinking and sends the answer back to be spoken. The Slack thread stays quiet during the call, and when the call ends the agent posts a summary and the transcript.

> **Prerequisites:** The operator has set `SLAUDE_VOICE_ENABLED=1`, the provider key, and an audio-origin allowlist (`SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS`; see [configuration](#4-configuration)). The agent can drive a browser through MCP, and that browser has an **audio provider**: a browser audio pipe that speaks the [audio contract](#the-audio-contract) below and hands out capability URLs on an allowlisted origin. One example implementation is workbench, a remote browser service whose `browser_audio_start` tool starts the pipe; any service that speaks the contract works. You are responsible for recording and consent law in your jurisdiction. The agent introduces itself as an AI assistant when it first speaks.

---

## 1. How a call starts

Ask the agent in a thread to join a meeting, for example "join https://meet.example.com/abc and take notes". The agent:

1. Opens a browser tab with its browser tools.
2. Starts the browser audio pipe for that tab (for example workbench's `browser_audio_start`).
3. Calls `voice_start`, passing a short brief and the pipe's start result: stream URL and clear URL (both absolute, on an allowlisted origin), route headers (by default `X-Browser-Session` is required) and sample rate. The result's `format` (`pcm_s16le`), `channels` (1), `session_id` and `restarted` are accepted too, and nothing else.

**Capability URLs.** The stream and clear URLs are ephemeral capability URLs: each carries an unguessable secret for that audio session in its path, is valid only while the audio session is open, and stops working when audio stops, the call ends or the tab closes. They are the only authorization for the audio routes. Slaude sends no `Authorization` header to them, only the allowed route headers (for example `X-Browser-Session`). Because the URLs are the secret, slaude never shows them in full: logs, the voice process's log lines and stderr, error messages, the approval card and the panel timeline show the URL's own origin only (`https://audio.example.com/…`). Masking is by exact match: every piece of the URLs the call received (path, segments other than route words, query values, in every URL encoding) is masked wherever it appears, whatever its shape.

The agent's voice then speaks into the call. The thread's session is held open for the duration, so it does not idle out mid-call.

**Approval.** Under the normal permission mode, `voice_start` asks for approval like any other gated tool: joining a meeting and capturing its audio is a high-impact action. The approval card is rendered from the exact input that runs and shows everything that changes behaviour: the origin of each URL (flagged if no allowlist entry matches it), the allowlist itself, the sample rate, the format and channels when given, and whether a session id was passed (never its value), the route header names (values `[hidden]`; flagged if not allowed, and a missing required header is named), the voice and the configured model, any ignored fields, and the whole brief. Only the URL paths and header values are hidden. Before any card, the input is checked against the tool's strict schema and the deployment's audio policy: an unknown field, a wrongly typed value, a relative URL, a URL with credentials, an endpoint off the allowlist, a route header that is not allowed or a missing required one, a brief over 500 characters or a brief that quotes a whole stream or clear URL is denied with no card. The brief is shown whole and literally, never truncated; each of its lines is prefixed with `| `, and line breaks, zero-width and other invisible characters are shown as escapes, so a brief cannot imitate the card or close its code block. The mid-call controls (`voice_say`, `voice_context`, `voice_stop`) never ask: a card during the call would break the quiet thread, and stopping a call must not wait on a click.

## Joining a call

The order matters. Jitsi asks for the microphone as soon as the page loads, and the audio provider grants it when the audio pipe starts. A page that loaded before the grant ends up with a muted or ended microphone. An audio provider may revoke a capability that has nothing attached for a short time (workbench does after 60 seconds). So the agent works in this order:

1. Open a blank browser tab (for example workbench's `browser_start`).
2. Start the browser audio pipe on that tab, before any meeting page loads (for example `browser_audio_start`).
3. Call `voice_start`, immediately, so the stream and uplink attach.
4. Navigate the tab to the meeting URL (for example `https://meet.example.com/room`).
5. Join.

If the meeting page was already loaded, reload it after starting the audio pipe.

Jitsi notes:

- Append `#config.startWithVideoMuted=true` to the URL, for example `https://meet.example.com/room#config.startWithVideoMuted=true`.
- A fresh room on the public meet.jit.si service may sit in "waiting for moderator" until someone with the moderator role joins.
- If the tab lands on Jitsi's post-hangup page (`close3.html`), the call has ended. The agent calls `voice_stop` and stops the audio pipe (for example `browser_audio_stop`).
- The audio provider ends the audio stream with a reason such as `idle` or `page_left`; the thread sees it as `audio:idle` or `audio:page_left`.

## The audio contract

slaude talks to the audio provider over plain HTTP. Any service that implements this contract can be listed in the allowlist; workbench is one example.

| Request | Meaning |
|---|---|
| `GET stream_url` with `Accept: text/event-stream` | Server-sent events carrying the call's audio. Event `audio`, data `{"pcm": "<base64>"}`: signed 16-bit little-endian mono PCM at the agreed sample rate. Event `ended`, data `{"reason": "<word>"}`: the provider ended the stream (the call ends `audio:<reason>`). |
| `POST stream_url`, chunked body, `Content-Type: audio/pcm` | The agent's audio, as one long-lived streaming request for the whole call (same PCM format). The request settling while the call is open means the agent can no longer be heard. |
| `POST clear_url` | Drop the agent audio queued but not yet played (barge-in). Returns JSON `{"played_ms": <n>, "cleared_ms": <n>}`; `played_ms` lets the voice model forget what the room never heard. |
| `404` on any route | The capability is revoked or unknown: the call ends `audio_lost`. |
| `409` on the stream or uplink | Busy: the previous reader or uplink is still attached. slaude retries with backoff for up to about 15 seconds, replaying the newest buffered agent audio, then gives up with `audio_lost`. |

Every request carries the allowed route headers and nothing else (never `Authorization`, `Cookie` or `Host`). Redirects are refused. The capability URL's path holds the secret, so slaude never logs it.

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
| `SLAUDE_VOICE_API_KEY` | (none) | The provider key. Required, together with the audio allowlist, or voice stays off. |
| `SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS` | (unset: deny) | The audio-origin allowlist. Required. Comma-separated entries, each an exact origin (`https://audio.example.com`, optional port) or a scheme plus a host wildcard (`https://*.example.com`). Unset or empty turns voice off; set but empty (`SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS=`) is a deliberate deny that the deprecated alias below cannot override. See below. |
| `SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS` | `X-Browser-Session` | Route header names `voice_start` may pass, comma-separated, matched case-insensitively. `Authorization`, `Cookie` and `Host` can never be listed: such a list is invalid and turns voice off. |
| `SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS` | `X-Browser-Session` | Route headers that must be present and non-empty. Must be a subset of the allowed headers. Set it empty to require none. |
| `SLAUDE_VOICE_WORKBENCH_URL` | (none) | **Deprecated.** If set while `SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS` is unset, its origin seeds the allowlist, with a warning. If the allowlist is set (even to empty), the allowlist wins and a warning says the old variable is ignored. |
| `SLAUDE_VOICE_MAX_MINUTES` | `120` | Hard cap on one call; it ends with `max_duration`. |
| `SLAUDE_VOICE_STALE_SEQ` | `6` | A `now` utterance is downgraded to `next_gap` when the conversation has moved more than this many transcript lines since the request. |
| `SLAUDE_VOICE_TENANTS` | (empty) | Gateway only. Comma-separated tenant ids, or `*`. See below. |

### The audio-origin allowlist

The allowlist is the security boundary for the call's audio: the stream and clear URLs come from a model, and the call's audio and route headers go wherever they point. So the list is deny by default and strict:

- An entry is `scheme://host[:port]` or `scheme://*.domain[:port]`, with `http` or `https`. No path (a lone trailing `/` is tolerated), query, fragment, userinfo, bare `*`, empty labels or `%` (hosts are taken literally, so `https://%2A.example.com` is refused rather than decoded into a wildcard). A wildcard is only the whole first label, and its domain needs at least two labels (`https://*.com` is refused).
- A wildcard over a public suffix is refused (`https://*.co.uk`, `https://*.com.au`, `https://*.github.io`), because it would match every domain registered under it. slaude checks a short built-in list of common suffixes, not the full Public Suffix List, so review wildcards over unusual suffixes yourself.
- `https://*.example.com` matches `audio.example.com` and `a.b.example.com`, never `example.com` itself and never a lookalike such as `evilexample.com`.
- Scheme and port must match exactly; default ports are normalised (`https://audio.example.com:443` is `https://audio.example.com`). Hosts compare case-insensitively, and internationalised names in their punycode form. A host ending in a dot, or with an empty label, never matches. A URL is checked as written: one with a tab, newline or backslash anywhere, `%` in its host, or `https:host` without the two slashes never matches.
- One malformed entry makes the whole configuration invalid: slaude logs a loud error at boot and voice stays off. An unset or empty list logs one line saying voice is off and why.

For example, `SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS=https://audio.example.com,https://*.media.example.net:8443`.

### Topologies

**Single process (`mono`).** Set the `SLAUDE_VOICE_*` variables on the process. The `SLAUDE_VOICE_TENANTS` variable is not used.

**Gateway plus nodes.** Only the **gateway** sets these variables. Nodes never read voice variables from their own environment. They receive the voice block (model, voice name, key, the audio allowlist and route header lists, max minutes and stale threshold) in their runtime bundle, and validate the allowlist again before using it. If the gateway's allowlist is unset or invalid, the bundle carries no voice block at all.

**Mixed versions.** The bundle's audio fields changed in `v0.45.0-rc.4` (the allowlist replaced the workbench URL), so gateway and nodes must both run rc.4 or later for voice:

- *Old gateway, new node.* The bundle still carries `workbenchUrl` and no allowlist. The node refuses that voice block, so it never registers the voice tools for the session: the agent has no `voice_start` to call. The reason appears only in the node's warning log: `[voice] config unavailable session=…: the gateway's voice bundle carries no audio allowlist (gateway older than rc.4?)`.
- *New gateway, old node.* The bundle carries the allowlist and no `workbenchUrl`. The old node has no origin to compare against, so every `voice_start` is refused with `VOICE_BAD_ENDPOINT`.

In both cases no call starts and nothing leaves the node. Upgrade the gateway and nodes together.

`SLAUDE_VOICE_TENANTS` decides which tenants get that block. Unset or empty means **no tenant gets voice**. This is deliberate: the voice key is one gateway-wide credential, and shipping it in every bundle would hand it to nodes serving tenants that never opted in, undoing the per-tenant credential isolation the rest of the gateway keeps. List the tenant ids that should have voice, or use `*` to allow all.

## 5. What happens during a call

**The audio origin is allowlisted.** The stream and clear endpoints the agent passes to `voice_start` come from a model and could be steered by prompt injection. Both must be absolute URLs whose origin matches an allowlist entry, with no embedded credentials, or the call is refused with `VOICE_BAD_ENDPOINT`; a relative URL is refused the same way. Only the allowed route headers are accepted and the required ones must be present; anything else makes `voice_start` refuse with `VOICE_BAD_INPUT`, and `Authorization`, `Cookie` or `Host` are refused whatever the configuration. Redirects are refused. The check runs at the approval gate, again in `voice_start`, and once more in the voice process before it opens a connection. This keeps the capability URLs, and the route headers sent with them, from going anywhere else.

**The thread is quiet.** While the call runs, the agent's turns that serve the call do not post status lines, reactions or replies in the Slack thread. Normal posting resumes when the call ends, with the summary.

**The transcript.** The voice process emits the transcript. It is fed to the session in batches (as suppressed turns, so the session knows what was said) and is written to `voice-call-<callId>.txt` in the session's working directory. When the call ends, the agent runs a summary turn and attaches the file.

**The voice process.** Each call runs as a separate child process. The provider key reaches it only through its environment, never through arguments or its stdin protocol. The capability URLs reach it in the start message on its stdin, and every log line it writes back has them masked. Its environment is otherwise minimal: `PATH`, `HOME`, and, so that proxied or private-CA deployments can reach the provider, the usual `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lowercase forms), `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. It does not read a `.env` file.

**How a call ends.** Normal reasons are `stopped` (the agent called `voice_stop`), `ended_by_voice`, `max_duration` and `audio:<reason>` (the audio provider ended the stream, for example because the tab or meeting closed). Failures are `provider_failed`, `provider_lost` (reconnects exhausted), `audio_lost`, `auth_lost`, `session_rebooted`, `node_drain` (a node, or a `mono` process, shutting down), `parent_gone` (the process that started the voice loop went away) and `loop_crashed`.

## 6. Limits to know about

- Providers cap a connection's lifetime (Gemini around ten minutes; GPT-Live reports an expiry time when the session starts). The loop reconnects at a pause in the conversation and re-seeds the model with the last lines of the transcript. It does not re-send a summary.
- On a node, a very long, silent call can outlive the session's job token (15 minutes, refreshable for up to 60 minutes after it expires, so about 75 minutes of silence), in which case the closing summary may fail with `auth_lost`.
- If a node dies mid-call, the call ends but nothing is posted in the thread.

### GPT-Live (`openai-live`) differences

GPT-Live runs in client-delegation mode: when it needs facts or tools it hands the request to the thread's Claude session, so Claude stays the brain. The protocol is a looser fit than the other two providers:

- **No truncate, no cancel.** GPT-Live yields to a speaker on its own. An urgent `now` utterance still flushes the audio already queued in the tab, but the model's memory is not trimmed to what was heard.
- **Synthetic turn events.** GPT-Live sends no turn boundaries, so the adapter derives "participant started/stopped speaking" and "agent finished speaking" from short quiet gaps in the transcript and audio. Barge-in is detected from the transcript, so it is a little late, and a short "mm-hmm" while the agent talks can cut off its queued audio.
- **The call cannot end itself by voice.** GPT-Live calls no tools of its own, so there is no `end_call`: a request to leave reaches Claude as an ordinary delegated request, and Claude ends the call with `voice_stop` (reason `stopped`, never `ended_by_voice`). The delegated task text is the participant's recent words, since the delegation event carries none.
