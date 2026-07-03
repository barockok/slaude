# Voice bridge: two-tier call agent, first live field tests

**Date:** 2026-07-04 · **Branch:** `feat/voice`

## What was built

An agent that joins real video calls as a human-like participant and converses,
structured as two tiers:

- **Bridge subprocess** (`src/voice/`): Playwright-driven headful Chromium under
  Xvfb joins the call's web client; PulseAudio null-sinks wire call audio out
  (`call_out.monitor` → Deepgram Flux STT) and synthetic speech in (Aura TTS →
  `bot_mic` → remapped `virtmic` source = the browser's microphone).
- **MAL (Minimal Agentic Loop)** inside the bridge: a small fast model on any
  Anthropic-compatible endpoint (credentials deliberately namespaced `MAL_*`,
  never shared with the agent-sdk session). Plain-text protocol per human turn:
  short spoken answer | `<delegate>question</delegate>` + spoken filler |
  `<skip/>`. Delegations surface as JSONL events on stdout; the parent Claude
  session answers via `{"cmd":"say","id":…}` on stdin, and the answer folds back
  into MAL's rolling context.

Flux was chosen over Deepgram's Voice Agent API precisely to keep this loop
ours: model-native turn events (`StartOfTurn`/`EagerEndOfTurn`/`TurnResumed`/
`EndOfTurn`) drive barge-in and response timing without VAD heuristics, while
the conversational brain stays swappable.

## Field-test findings (two live calls)

1. **Platform walls, verified empirically:** Google Meet rejects anonymous
   guests outright on consumer-account meetings ("You can't join this video
   call") — no lobby knock ever fires; a signed-in profile is required.
   meet.jit.si admits anonymous guests but parks everyone until an
   authenticated user claims moderator. Jitsi is therefore the zero-friction
   test bed; Meet needs the login-bootstrap phase.
2. **Chromium ignores PulseAudio `.monitor` sources as microphones.** A
   `module-remap-source` wrapper (`virtmic`) makes the same stream enumerable.
   Symptom without it: "Mic not found" and join buttons downgraded to
   "without microphone".
3. **Geo-derived UI locale breaks selectors.** Meet/Jitsi render in the VPS
   region's language; force `--lang=en-US`, `locale: en-US`, and `?hl=en`.
4. **Pipes are the bridge's weakest joint.** First duplex session crashed on an
   unhandled `EPIPE`: paplay's stdin closed mid-write during a barge-in kill.
   Every child-process stream and the Flux websocket `send` now swallow/report
   instead of throwing — a voice bridge must never die mid-call.
5. **Turn fragmentation is the real conversational failure mode.** Think-aloud
   pauses ("can you, like, …") split one request across four `EndOfTurn`
   events at the default `eot_threshold`; MAL answered each fragment and
   replies queued into an unnatural monologue. Raised to 0.85; `eot_timeout_ms`
   remains the next knob if long pauses still fragment.
6. **The two-tier latency split works as designed:** reflex answers ~1.4–2s
   from end-of-turn to decision (thinking-enabled model, unoptimized); manual
   big-brain relays during the test ran 20–30s, which the delegate-with-filler
   pattern absorbed naturally — callers accepted "give me a second to check"
   followed by silence far better than dead air.

## Still open

- `in-call` detection can false-positive in Jitsi's "waiting for moderator"
  lobby (hangup button exists there too).
- MAL fillers repeat when a delegate answer is slow; needs one-filler-then-wait
  plus a delegate-timeout apology.
- VoiceSurface: spawn/manage the bridge from the session runtime (a `Surface`
  implementation) instead of an operator-driven shell; transcript batching into
  the session as context rather than poll-and-relay.
- Slack Huddles path: requires the agent's own Slack web login in the
  persistent profile.
