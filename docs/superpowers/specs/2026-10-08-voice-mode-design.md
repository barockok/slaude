# Voice mode: a realtime voice loop driven by the thread's Claude session

**Date:** 2026-10-08
**Status:** approved in chat, awaiting spec review
**Depends on:** workbench browser audio pipeline (workbench repo,
`2026-10-07-browser-audio-pipeline-design.md`): a headless Chromium tab with per-user
PulseAudio devices, exposed as an SSE audio-out stream, a chunked PCM uplink, and a `clear`
call that reports `played_ms`.
**Ships as:** release candidate (touches the agent loop and the node worker)

## 1. Intent

An agent in a Slack thread can join a call (a Slack huddle, or any meeting that runs in a
browser tab) and talk in it. The conversation itself is carried by a full-duplex realtime voice
model (OpenAI Realtime first). The thread's Claude session stays the brain: it starts the call,
receives the call transcript, does the heavy work (knowledge base, tools, MCP) when the voice
model delegates, and steers what the voice says.

Decisions that drive this spec:

- **Slack-only, slim.** slaude runs no browser and no media server. Audio enters and leaves
  through workbench's Chromium tab; slaude only speaks HTTP to workbench and a WebSocket to the
  voice provider.
- **The Claude session starts the call.** It joins the meeting with workbench's existing
  browser tools, then calls `voice_start`. There is no slash command.
- **The voice loop (VL) is a subprocess of the warm Claude session's process** (the node in the
  gateway topology, the mono process otherwise). It is a plain Bun program, not the Claude
  Agent SDK.
- **Two brains, both duplex.** The VL owns conversational flow (turn-taking, phrasing, filler).
  The Claude session owns substance and can steer or override what is said.
- **The transcript reaches Claude passively.** Every utterance is recorded into the session,
  but Claude only *thinks* (runs a model turn) when the voice model delegates.
- **Injection is node-local.** The VL talks to its parent over stdio. Injected turns run
  directly on the warm session, serialized by the existing session lock, with no queue hop.
- **Calls run as the agent identity only.** A call is refused in a `/1on1`-locked or `/remote`
  thread.
- **Quiet thread.** During a call the thread shows a status line only; at the end, Claude
  posts a summary and the transcript as a file.
- **Provider-agnostic.** The VL speaks to the voice model through a normalized adapter
  interface. OpenAI Realtime ships first; Gemini Live is the second adapter that proves the
  interface.

Rejected:

- **A browser page the human opens via a signed link.** It would make slaude host a media
  endpoint, and it would not put the agent in the meeting the humans are already in.
- **Voice loop on the gateway, injecting through the turn queue.** Steering would need pubsub
  across replicas, and every utterance would round-trip through Redis for no benefit.
- **The VL running as a separate deployment.** Overkill until many concurrent calls exist.
- **Waking Claude on every human turn-end** (a supervisor turn per utterance). Expensive, and
  Claude's serialized queue would lag behind live speech. Claude reacts when delegated to.
- **Claude speaking directly through TTS, bypassing the voice model.** Two writers on one
  uplink, inconsistent voice, and broken interruption accounting.
- **Pipecat / LiveKit Agents.** Python stacks; they break the Bun/TS slim core.
- **A gateway-side call record ("pin") and voice token endpoint.** Not needed: warm routing
  already keeps the session on its node while the warm-idle TTL is suspended, and the existing
  job-token refresh endpoint covers the call's length (see §6).
- **VL-side barge-in policy.** The provider decides interruptions. The VL only flushes audio
  it already buffered (see §5.4).

## 2. Architecture

```
Slack huddle (humans)
   ⇅  one mixed audio stream
workbench Chromium tab ── PulseAudio devices
   ⇅  GET  /api/browser/tabs/:tab/audio/stream   (SSE, call audio out)
   ⇅  POST /api/browser/tabs/:tab/audio/stream   (chunked PCM in)
   ⇅  POST /api/browser/tabs/:tab/audio/clear    (interrupt → played_ms)
NODE (or mono process)
  AgentManager ── warm Claude session
    ├ voice-mcp (in-process MCP): voice_start / voice_say / voice_context / voice_stop
    └ VoiceInjector ── withSessionLock → turn on the warm session
          ⇅ stdio JSON lines
  voice-loop child (`slaude voice-loop`)
    ├ AudioLink      — workbench audio API
    ├ VoiceProvider  — adapter (openai-realtime, gemini-live)
    └ Conductor      — pure state machine: steer queue, delegates, flush, reconnect
GATEWAY
  unchanged on the hot path; renders `origin: "voice"` turn events as status only
```

### 2.1 Units

| unit | job | knows about |
|---|---|---|
| `src/voice/provider/types.ts` | `VoiceProvider` interface and caps | nothing vendor-specific |
| `src/voice/provider/openai-realtime.ts` | OpenAI Realtime WebSocket adapter | OpenAI wire protocol only |
| `src/voice/provider/gemini-live.ts` | Gemini Live adapter (second) | Gemini wire protocol only |
| `src/voice/audio-link.ts` | workbench SSE, uplink, `clear`, reconnect | workbench audio API only |
| `src/voice/resample.ts` | s16le mono rate conversion | nothing else |
| `src/voice/conductor.ts` | conversation glue; no I/O | the interfaces above |
| `src/voice/ipc.ts` | message types for the stdio protocol | — |
| `src/voice/loop-main.ts` | `slaude voice-loop` entry; wires the above | — |
| `src/agent/voice-mcp.ts` | tools for Claude; spawns and owns the child | AgentManager, ipc |
| `src/agent/voice-injector.ts` | runs injected turns on the warm session | session lock, token refresh |
| gateway event rendering | `origin: "voice"` → status line, no final text | — |

Each unit is testable in isolation; the Conductor is pure and driven by scripted events.

## 3. Claude-facing tools (`voice-mcp`)

Registered only when `SLAUDE_VOICE_ENABLED` is on and the persona has a `voice` block.

`voice_start`

```json
{ "tab": "<workbench tab session_id>", "brief": "what this call is about", "voice": "optional voice name" }
```

Checks, in order: no call active for this session (`VOICE_BUSY`); thread not `/1on1`-locked
and not `/remote` (`VOICE_AGENT_ONLY`); node not draining (`VOICE_UNAVAILABLE`). Then it
remembers the current turn's job id (for token refresh, §6), suspends the session's warm-idle
TTL, spawns the VL, and waits for `started` or a startup error. Returns `{ callId }`. Posts
"in call" as the thread status line.

`voice_say`

```json
{ "text": "...", "when": "next_gap" | "now", "reply_to": "optional delegate id" }
```

Makes the voice speak. `next_gap` waits until no one is speaking and no response is active.
`now` cancels the current response, flushes buffered audio, and speaks. Delegate results come
back through this tool with `reply_to`.

`voice_context`

```json
{ "text": "..." }
```

Adds a fact or instruction to the voice model's context without making it speak.

`voice_stop` → `{ reason, durationSec }`. Ends the call (see §7).

## 4. IPC protocol (stdio, JSON lines)

Parent → child:

| type | fields |
|---|---|
| `init` | `tab`, `brief`, `instructions` (soul voice excerpt + speaking rules), `provider`, `model`, `voice`, `maxMinutes` |
| `say` | `text`, `when`, `replyTo?`, `asOf` |
| `context` | `text` |
| `stop` | `reason` |

Child → parent:

| type | fields |
|---|---|
| `started` | `callId`, `sampleRate` |
| `transcript` | `seq`, `role` (`user` \| `assistant`), `text` |
| `delegate` | `id`, `task`, `asOf` (transcript seq when asked) |
| `ended` | `reason`, `transcriptPath` |
| `log` | `level`, `message` (never audio, never transcript text) |

Secrets (provider API key, workbench access token) are passed in the child's environment at
spawn, never in argv or on the pipe. stdin EOF means the parent died: the child ends the call
and exits.

## 5. Voice loop

### 5.1 VoiceProvider interface

```ts
interface VoiceProviderCaps {
  inputRate: 16000 | 24000;   // PCM s16le mono the provider accepts
  outputRate: 16000 | 24000;  // PCM it emits
  truncate: boolean;          // can cut an assistant item at a ms offset
  maxSessionSec?: number;     // provider session limit → planned reconnect
}

interface VoiceProvider {
  readonly caps: VoiceProviderCaps;
  connect(init: { instructions: string; tools: ToolSpec[]; voice?: string; seed?: string }): Promise<void>;
  sendAudio(pcm: Int16Array): void;
  addContext(text: string): void;   // silent
  respond(hint?: string): void;     // speak now
  cancel(): void;                   // used by voice_say "now" only
  truncate(itemId: string, ms: number): void;
  toolResult(callId: string, output: unknown): void;
  close(): Promise<void>;
  on(e: "audio", cb: (pcm: Int16Array, itemId: string) => void): void;
  on(e: "transcript", cb: (t: { role: "user" | "assistant"; text: string; itemId: string }) => void): void;
  on(e: "speechStarted" | "speechStopped" | "responseDone", cb: () => void): void;
  on(e: "toolCall", cb: (c: { callId: string; name: string; args: unknown }) => void): void;
  on(e: "error", cb: (e: { fatal: boolean; message: string }) => void): void;
}
```

Adapter mapping:

| slaude | OpenAI Realtime | Gemini Live |
|---|---|---|
| `sendAudio` | `input_audio_buffer.append` | `realtimeInput.audio` |
| `addContext` | `conversation.item.create` | `clientContent`, `turnComplete: false` |
| `respond` | `response.create` | `clientContent`, `turnComplete: true` |
| `cancel` | `response.cancel` | not needed (server interrupts) |
| `truncate` | `conversation.item.truncate` | unsupported (`caps.truncate = false`) |
| `speechStarted` | `input_audio_buffer.speech_started` | `serverContent.interrupted` |
| `transcript` | input transcription completed / output audio transcript done | `inputTranscription` / `outputTranscription` |
| `maxSessionSec` | provider's session limit | provider's session limit (uses resumption handle when present) |

Provider event names are pinned in the adapter and its fixtures; a vendor rename touches one
file.

### 5.2 Audio rates

The workbench session is opened at the provider's `outputRate` (24 kHz for both v1 adapters).
If `inputRate` differs (Gemini Live takes 16 kHz), the VL resamples the downlink with
`resample.ts`. No external DSP dependency.

### 5.3 Tools exposed to the voice model

- `delegate({ task })` — returns `{ id, status: "working" }` immediately; the Conductor emits
  IPC `delegate`. The voice model is instructed to say a short holding line first.
- `end_call({ reason })` — the voice model may end the call (for example when told to leave).

### 5.4 Conductor

Pure state machine. Owns:

- **Item offsets.** For each assistant item, the uplink byte offset where it started.
- **Flush on interruption.** The provider decides and cancels interruptions itself. But a
  realtime model emits audio faster than real time and, over a WebSocket, does not know what
  has played; the remainder sits in workbench's uplink queue. On `speechStarted`, the
  Conductor calls AudioLink `clear` (→ `played_ms`) and, when `caps.truncate`, calls
  `truncate(itemId, played_ms − itemStartMs)` so the model's memory matches what was heard. It
  makes no interruption decisions.
- **Steer queue.** `next_gap` items wait for `!userSpeaking && !responseActive`, then
  `addContext(text)` + `respond()`. `now` items call `cancel()`, flush as above, then speak. A
  `now` whose `asOf` is more than `SLAUDE_VOICE_STALE_SEQ` (default 6) transcript items old is
  downgraded to `next_gap`.
- **Delegates in flight.** A delegate unanswered after 60 s gets one spoken "still working on
  it". No timeout kill. A `say` with `replyTo` closes the delegate.
- **Planned reconnect.** Before `caps.maxSessionSec`, at a gap, reconnect with
  `seed` = instructions + summary of earlier talk + last N turns verbatim.
- **Call cap.** Spoken warning two minutes before `maxMinutes`, then end `max_duration`.

### 5.5 AudioLink

Workbench client. Opens the SSE stream and a single long-lived chunked uplink, exposes
`clear()`, re-GETs the SSE stream on a network blip (workbench replaces the reader), maps
`ended{reason}` events, and calls workbench's audio stop on shutdown. It sends workbench's
routing header on every request. The VL calls workbench's `browser_audio_start` and
`browser_audio_stop` tools itself, through a minimal MCP client to workbench's MCP endpoint,
authenticated with the workbench access token; Claude only passes the tab id.

## 6. Turn injection (VoiceInjector)

Runs on the node next to AgentManager. Mono uses the same component with the in-process
session serialization mono already uses for Slack turns, and no token step.

- **Transcript lane.** `transcript` messages are buffered. The buffer is flushed as one
  suppressed turn (recorded, no model run, via the existing suppress mechanism) after 30 s with
  no delegate, or prepended to the next delegate turn's messages.
- **Delegate lane.** For each `delegate`: refresh the job token (below), take
  `lock:session:<id>` with `withSessionLock`, run a turn on the warm session whose messages are
  the buffered transcript followed by:

  > Voice call request #<id>: <task>. Answer with voice_say(reply_to="<id>"). Speakable:
  > short sentences, no markdown, no URLs or code read aloud.

  Claude may use any tool, then calls `voice_say`. A Slack turn holding the lock makes the
  injector wait; a Slack turn arriving during a voice turn requeues as today.
- **Token.** The turn's tool calls hit the gateway with the session's job token. The injector
  refreshes the token of the turn that called `voice_start` through the existing
  `POST /v1/jobs/:id/token-refresh` before each injected turn. That endpoint re-checks the
  live label and caps total life at `SLAUDE_JOB_TOKEN_MAX_AGE` (default 6 h), which exceeds
  the call cap. A refusal ends the call with `auth_lost`.
- **Output.** Injected turns tag their events `origin: "voice"`. The gateway shows the status
  line and does not post the turn's final text.
- **Identity drift.** If the thread is `/1on1`-locked or switched to `/remote` mid-call, the
  next Slack turn carries a new `sessionConfigFp`, and the node reboots the warm session. A
  warm-session reboot ends the call first (`session_rebooted`).
- **Warm-idle TTL** is suspended while a call is active and restored at the end, so the session
  stays registered warm on this node and warm routing keeps Slack turns here.

## 7. Lifecycle

Start: Claude joins the meeting with workbench browser tools → `voice_start` → checks →
spawn VL → VL starts workbench audio and connects the provider with instructions (soul voice
excerpt, `brief`, speaking rules) → `started` → status line.

End (any of `voice_stop`, `end_call`, workbench `ended`, cap, provider fatal, auth lost, session
reboot, node drain, VL crash): VL closes the provider and the uplink, stops workbench audio,
emits `ended{reason, transcriptPath}`. The injector flushes the transcript and runs one
summary turn with normal origin: Claude posts a summary (decisions, action items, the end
reason when abnormal) and attaches the transcript file. The warm-idle TTL is restored.

End reasons: `stopped | ended_by_voice | tab_closed | max_duration | provider_lost |
provider_failed | audio_lost | auth_lost | session_rebooted | node_drain | loop_crashed`, plus
workbench's own `ended` reasons passed through.

## 8. Failure handling

| failure | behaviour |
|---|---|
| Provider connection drops | Reconnect up to 3 times with backoff, re-seeded; uplink pads silence. Then end `provider_lost`. |
| Provider fatal (auth, quota, model) | End `provider_failed`. |
| Provider session limit near | Planned reconnect at a gap. |
| Workbench SSE blip | Re-GET; 3 failures → end `audio_lost`. |
| Workbench `ended{reason}` | End with that reason. |
| Uplink 404 `audio_not_started` | End `audio_lost`. |
| Delegate turn errors | `addContext("#id failed: …")` + `respond`; call continues. |
| Delegate slow | One "still working" line at 60 s; no kill. |
| Token refresh refused | End `auth_lost`. |
| Warm session reboot | End `session_rebooted` before the reboot proceeds. |
| VL crashes | Flush transcript, best-effort workbench stop, summary notes the crash. |
| Node dies | VL dies with it. No thread notice in v1. |
| Node drain | One spoken closing line, end `node_drain` within the drain grace. |
| Second `voice_start` | `VOICE_BUSY`. |
| `/1on1`-locked or `/remote` thread | `VOICE_AGENT_ONLY`. |

## 9. Configuration

Per persona:

```yaml
voice:
  model: openai/gpt-realtime    # provider-qualified, like SLAUDE_MODEL
  voice: marin
  apiKey: vault://...           # resolved into the runtime bundle like provider credentials
```

The workbench access token comes from the agent's existing workbench credential (the gateway
remains its only refresher; the node receives an access token).

| env | default | meaning |
|---|---|---|
| `SLAUDE_VOICE_ENABLED` | `false` | register voice tools; off → tools absent |
| `SLAUDE_VOICE_MAX_MINUTES` | `120` | call cap |
| `SLAUDE_VOICE_STALE_SEQ` | `6` | `now` steers older than this many transcript items downgrade to `next_gap` |

Workbench must run with `BROWSER_AUDIO_ENABLED`.

## 10. Security

- Calls run as the agent identity only. Anyone in a meeting can speak and speakers cannot be
  told apart (one mixed stream), so a call must never drive a person's credentials or remote
  shell.
- Speech is untrusted input, like any Slack message. Delegated tasks pass through the same
  approval and permission gates as typed requests.
- Audio is never logged. Transcript text goes to the session transcript and the end-of-call
  file only, never to application logs or the `log` IPC message.
- Secrets reach the VL through its environment only.
- The docs tell operators the agent should identify itself to participants. Recording and
  consent law is the operator's responsibility.

## 11. Testing

Unit (no network):

- **Conductor:** scripted event sequences — offset map and truncate math; flush on
  `speechStarted`, truncate skipped without the capability; `next_gap` waits; `now` preempts;
  stale `asOf` downgrade; 60 s "still working"; cap warning; planned reconnect at a gap.
- **Adapters:** fake WebSocket server replaying recorded fixtures per vendor; each interface
  method maps to the right frames and each vendor event to the right slaude event.
- **AudioLink:** fake workbench (SSE, chunked POST, clear) — reconnect, `ended` mapping, 404.
- **resample.ts:** a tone at 24 kHz keeps its dominant frequency at 16 kHz.
- **VoiceInjector:** fake AgentManager with the real `withSessionLock` on a test Redis —
  buffering and 30 s flush, delegate prepends the buffer, waits on a held lock, refreshes the
  token before each turn, refusal ends `auth_lost`, events tagged `origin: "voice"`.
- **voice-mcp:** `VOICE_BUSY`, `VOICE_AGENT_ONLY` (locked and remote), secrets absent from
  argv, warm-idle TTL suspended and restored.
- **Gateway rendering:** `origin: "voice"` posts status only; the summary turn posts normally.

Integration (in-process, CI): mono + sim gateway + fake workbench + scripted fake provider +
the existing mock LLM. A scripted user utterance makes the voice model delegate; the delegate
turn sees the transcript; Claude's `voice_say` reaches the provider; nothing is posted to the
thread mid-call; the summary and transcript file land at the end. A second case kills the VL
mid-call and checks the crash path.

Opt-in live (`VOICE_E2E=1`): real OpenAI Realtime + real workbench on a local test page;
speech played into the tab triggers a delegate and audio comes back. Manual soak in a real
huddle before promoting the RC.

## 12. Release

- Ships as `vX.Y.Z-rc.N`; notes under the stable name.
- Field note covering what was measured: flush latency, `played_ms` accuracy as seen by the
  VL, delegate round trip, reconnect gap.
- Docs page: the persona `voice` block, the workbench prerequisite, how Claude starts a call,
  the consent note.

## 13. Out of scope

Speaker identification, more than one call per session, calls under a person's identity,
cascaded STT→LLM→TTS providers (a later adapter behind the same interface), a slash command to
start or stop calls, a thread notice when the node dies mid-call, telephony.
