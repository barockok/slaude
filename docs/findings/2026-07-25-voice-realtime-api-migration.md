# Voice bridge: Realtime API GA migration findings

**Date:** 2026-07-25  
**Branch:** feat/voice

## What changed

Migrated the voice bridge from the old Realtime beta API to the GA API during a live VPS field test.

## Discoveries

### 1. Auth: ephemeral token required (`/v1/realtime/client_secrets`)

Project-scoped keys (`sk-proj-*`) cannot connect to the WebSocket directly with `Authorization: Bearer`. Instead:

1. POST to `https://api.openai.com/v1/realtime/client_secrets` with the permanent key and a session config body
2. Extract `response.value` (the ephemeral `ek_*` key — NOT `response.client_secret.value` as OpenAI docs elsewhere suggest)
3. Connect to `wss://api.openai.com/v1/realtime?model=<model>` with `Authorization: Bearer <ephemeral-key>`

The session is pre-configured in the client_secrets call (voice, instructions, tools, turn detection, audio format). No `session.update` needed after connecting.

### 2. Model name: `gpt-realtime-1.5`

The model must be specified as the `?model=` query param on the WS URL even when using an ephemeral token (server returns close code 4000 otherwise). The correct name is `gpt-realtime-1.5`. The old `gpt-4o-realtime-preview` and `gpt-4o-realtime-preview-2024-12-17` return 4004 "model not found".

### 3. Audio event rename: `response.output_audio.delta`

The GA API renamed the audio output event:
- Old (beta): `response.audio.delta`
- New (GA): `response.output_audio.delta`

The field name and base64-encoded payload format are unchanged. Both event names are now handled for backwards compatibility.

### 4. Session config schema change

The session body for `/v1/realtime/client_secrets` uses a new nested format:

```json
{
  "session": {
    "type": "realtime",
    "instructions": "...",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "turn_detection": { "type": "server_vad", ... }
      },
      "output": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "voice": "shimmer"
      }
    },
    "output_modalities": ["audio"],
    "tools": [...],
    "max_output_tokens": "inf"
  }
}
```

### 5. Echo suppression: suppress capture while speaking

The bridge captures call audio via `parec` from `call_out.monitor`. When the bot speaks (via `paplay → bot_mic → virtmic → browser → Jitsi`), Jitsi can reflect that audio back to the browser's speaker (`call_out`), which `parec` then captures and sends to Realtime. This creates a feedback loop.

Fix: set `suppressCaptureUntil = Date.now() + 400` each time an audio chunk is played. Parec data is not sent to Realtime until `suppressCaptureUntil` elapses.

### 6. Double-delegate: dedup by question text

When the model's response is interrupted mid-stream (barge-in) and restarts, it may invoke `ask_big_brain` with the same question twice. Both invocations emit delegates, causing the main session to receive the same question twice.

Fix: a `pendingByQuestion` map keyed on question text. If the same question arrives while a delegate is already pending, the second call_id is added to `extraCallIds` and `submitToolResult` is called for both when the answer arrives.

### 7. `response.created` / `response.done` track active state

The barge-in handler was calling `response.cancel` even with no active response, generating noise errors. Fixed by tracking `responseActive` (true on `response.created`, false on `response.done`) and guarding `cancel()`.
