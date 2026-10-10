---
title: "Voice mode: a realtime voice in front, the thread's session behind it"
date: 2026-10-08
---

Voice mode puts the agent in a live call. A realtime voice model (OpenAI Realtime,
OpenAI GPT-Live or Gemini Live) handles the audio and the turn-taking; whenever it needs facts or
tools it delegates a request to the thread's own Claude session and speaks the
answer. This note records the mechanisms and, mostly, what review found.

## Mechanism

- **The loop is a child process.** Each call runs one voice-loop child. Parent and
  child speak JSON lines over stdio. The provider key and the workbench stream
  token go in the child's environment only; the environment is otherwise a short
  allowlist (plus proxy and CA variables), and the child is started so Bun does
  not load a `.env`.
- **No call state on the gateway.** The child lives next to the session it serves
  (a node, or `mono`). The gateway only ships configuration, in the runtime
  bundle's `voice` block, including max minutes and the stale threshold: nodes
  never read voice variables from their own environment.
- **Delegation is a turn on the warm session.** A delegated request becomes an
  injected turn on the thread's session, run under the session lock on a node.
  The result goes back to the child as a spoken reply. Transcript lines are fed
  to the session in batches as suppressed turns, and a closing summary turn
  attaches the transcript file.
- **Quiet thread.** Turns that serve the call run through a wrapped surface that
  drops status lines, reactions and replies. This covers the tool-call status
  line, the completion mark, the deprecated Slack-reply tools, and the cron and
  `/compact` routes. On nodes, injected turns are also kept out of the event
  stream so the gateway does not credit a voice `done` to a queued Slack job.
- **Flush, not barge.** An urgent utterance cancels the current response and
  flushes queued audio instead of cutting the speaker; context given with
  `voice_context` never interrupts. A `now` request that is more than
  `SLAUDE_VOICE_STALE_SEQ` transcript lines old is downgraded to the next pause.
- **Session lifetime.** `AgentManager.holdIdle` keeps the session alive during
  the call and emits `sessionExit` on every exit path (reload timeout and abort
  included) so a call cannot outlive its session. `holdIdle` returns false
  rather than holding a session that is not live.

## Provider protocol pins

These were checked against each provider's documentation during review and
shaped the adapters:

- **OpenAI.** Fatal errors arrive in `error.code`, not `error.type`; matching on
  type missed them. A cancelled response still emits its own `response.done`,
  which the conductor now counts and ignores.
- **Gemini.** `clientContent` interrupts generation, so context given mid-turn
  is buffered and sent when the turn completes (it lands up to a turn late, by
  design: context must not cut the agent off). Connections live about ten
  minutes, so the adapter reports a session limit below that and the loop's
  planned reconnect at a pause fires first. Gemini emits no speech-stopped
  event, so the adapter synthesizes one when the user's turn ends (first model
  audio after an interruption, or turn completion); without it the conductor
  stayed in "user speaking" after the first barge-in forever.

## GPT-Live adapter (`openai-live`)

GPT-Live's client delegation sends a delegation event to the application
instead of calling a tool, so Claude stays the brain; its alternative, tools on
a hosted Responses backend, would put an OpenAI model in front of Claude and was
rejected. The mapping onto the provider interface is lossy:

- **One tool.** Every client delegation becomes a `delegate` call. The event
  carries no task text, so the task is the participant transcript since the
  previous delegation, emitted after the transcript line so the session sees the
  words first. `end_call` cannot happen; leaving goes through Claude's
  `voice_stop`.
- **No truncate, no cancel.** The model yields on its own; an urgent utterance
  still flushes queued audio. Context goes out as silent `thinking`; a spoken
  utterance (context immediately followed by respond, in the same tick) goes out
  as one `commentary`, not a silent note plus a nudge.
- **Synthetic events.** There are no item ids, speech-start/stop or
  response-done events. Agent turns end after 600 ms of quiet output,
  participant turns after 800 ms of quiet input transcript; ids count these
  turns. Without the synthetic response-done the conductor's active-response
  flag latched after the first audio and the steer queue never drained again.
- **Ids follow the conductor's model.** Wiring the adapter to the real conductor
  showed two ways to go silent: after a flush the conductor drops late audio of
  the flushed item, and GPT-Live answering a barge-in or a spoken steer without
  a quiet gap kept the old id, so the answer was dropped. Participant speech
  and respond() now end the open output turn. A respond() that produces no
  audio still gets a response-done after a timeout, so a steer the model
  ignores cannot latch the queue.
- **Session limit** comes from `expires_at` at start; there is no fixed
  duration and the model compacts its own context, so a planned reconnect
  happens only near expiry.
- **Long answers are chunked**, not clipped: an append is capped at 500
  tokens, so text is split at sentences (then words) into several appends of
  the same type and delegation id, sized by a conservative estimate (about 3.5
  ASCII characters per token, one token per non-ASCII character).
- **To measure live:**
  - output-audio pacing against real time (it decides how much a
    false-positive barge-in flushes);
  - transcript lag behind speech (how late barge-in is detected, and whether a
    backchannel cuts the agent off);
  - `expires_at` at start;
  - whether a commentary with no delegation id is spoken while a delegation is
    open: answers carry `delegation_id: null`, so confirm the model accepts
    and speaks them;
  - whether a `now` utterance replays the tail of the old one: with no cancel,
    the model may finish its previous sentence after the flush.

  The opt-in live test prints the audio pacing and `expires_at`; the rest needs
  a real call.

## Conductor races found in review

- A stale `done` from a response the conductor itself cancelled cleared the
  active-response flag of the next response. The conductor now counts the dones
  its own cancels will cause (an adapter capability) and ignores them.
- After a `now` flush, late audio deltas for the flushed item were replayed. The
  flushed item id is remembered and its deltas dropped.
- Both providers auto-respond to user speech. Draining queued steers at
  speech-stop raced that auto-response; the conductor now expects it, waits for
  the first audio (or a timeout), then drains.
- The "user is speaking" flag survived a reconnect and wedged the Gemini path.

## Credential and SSRF paths

- **Model-supplied endpoints.** The stream and clear URLs come from the agent's
  `voice_start` arguments, so a prompt injection could aim them anywhere, and
  the audio link sends a bearer token. Resolution against the base URL allowed
  absolute and protocol-relative URLs. Endpoints are now resolved and required
  to be same-origin with the configured workbench, with no userinfo; `voice_start`
  rejects before spawning and the link itself throws as defence in depth. Route
  headers cannot set `Authorization`, `Cookie` or `Host`. The call brief is
  fenced in a block with a note that the speaking rules take precedence.
- **Tenant key isolation.** The voice key is one gateway-wide value, and the
  first version shipped it in every tenant's runtime bundle, defeating the
  per-tenant credential isolation the gateway otherwise keeps. Voice is now
  shipped only to tenants listed in `SLAUDE_VOICE_TENANTS`; unset means none.
  A bad voice model is logged and yields no voice block rather than failing
  every bundle request.

## Identity: check-then-act

The agent-only rule is only as good as the moment it is checked.

- A node first checked the token bound to the session but chained the token of
  the current job, which could be person-scoped. The chain now starts from the
  exact token whose claims passed the check.
- Claims were optional in the first version, so a missing field passed. Node
  and mono now fail closed: only an explicit agent identity with an explicit
  lock key (null meaning unlocked) and no remote target is allowed.
- A slash-only `/1on1` or `/remote` change does not reboot a node's session, so
  nothing would end the call. The job-token refresh response now returns the
  thread's current identity, computed fresh, and the keeper ends the call
  (`auth_lost`) when it is no longer the agent. The runner re-checks before
  every injected turn, not just at start, and once more right before the child
  is spawned.
- When a session reboots, queued turns and the in-flight delegate are cancelled
  immediately, before the child acknowledges the stop, and nothing is flushed
  into the rebooted session (the transcript goes to the file only).
- A reload mid-turn used to leave the injected-turn flags set and the node lock
  held for the lock's lifetime, which would silence the thread. Waiting for a
  turn now rejects on the session's exit and a timed-out voice turn aborts the
  session turn.

## Final whole-branch review

- **The voice tools hit the approval gate.** The static permission policy
  allowed slaude's own servers but not the voice server, and sessions run in the
  default permission mode, so `voice_say`, `voice_context` and `voice_stop`
  posted an approval card mid-call, and `voice_start`'s card printed its input,
  stream token included, into the thread. The mid-call controls are now allowed
  without a card; `voice_start` keeps its approval (joining a meeting and
  capturing its audio is a high-impact action), and every approval card redacts
  secret-named keys at any depth and all route-header values.
- **The voice key reached agent children.** The child-env scrub strips only
  gateway-only names; `SLAUDE_VOICE_API_KEY` was not one, so in `mono` the agent
  child (which runs Bash on requests that came from speech) and the brain-think
  child could read it. It is gateway-only now: scrubbed from every child, and a
  node holding it refuses to boot. The voice loop still gets the key, under its
  own variable.
- **The stale downgrade never fired.** A reply was stamped with the newest
  sequence number the child had sent at tool-call time, so it was never behind.
  A reply now carries the sequence its delegate was asked at, and a plain
  `voice_say` the newest one handed to the session.
- **A failed or hung workbench clear ended or froze the call.** The clear is
  now bounded and a failure skips the truncate (a failed clear used to truncate
  to 0 ms and reset the uplink clock). Say and context run on their own chain,
  so a slow say no longer holds up a stop, and during a provider reconnect they
  wait for the new provider instead of going to the closed one.
- **Audio link lifecycle.** An uplink that settled while the call was open
  (any status) left the agent mute for the rest of the call; it now ends the
  call `audio_lost`. Closing is bounded and closes the provider at the same
  time, and no workbench request follows a redirect.
- **Node event stream.** Only an injected turn's done/error was kept off the
  stream, so a gateway follower replaying a voice turn's tool events put status
  lines, reactions and task lists into the quiet thread. A voice turn's events
  now stay off entirely.
- **A turn sent after its session lock was lost.** The node runner now refuses
  before the send when the lock signal already fired.
- `mono` shutdown now ends live calls before the transport stops.

## Orphan children

The child holds the provider key (and, after rc.2, the capability URLs; it held a
stream token before), so a child left running is a credential left running. Paths closed in review: a missing process `error`
handler crashed the host; the stream-error close path never killed the child; a
throw after spawn (runner or call construction) leaked it; a detached promise
rejection in the child killed it without an `ended` message (the entry now
installs handlers, emits one `ended`, and exits); an exit without `ended` after
a requested stop is reported as the requested reason, not a crash.

## Changed after rc.2: capability URLs replace the stream token

Workbench's `browser_audio_start` no longer returns a `stream_token`. It returns
ephemeral capability URLs: an unguessable per-audio-session secret sits in the
`stream_url` and `clear_url` paths, and each URL works only while that audio
session is open (it dies on stop, call end or tab close). Why: a URL bound to one
audio session cannot outlive it, and a separate bearer added a second secret
with its own lifetime for no extra protection. Slaude now sends no
`Authorization` header to the audio routes, only the route headers minus
`Authorization`/`Cookie`/`Host`; the child gets only the provider key. Because
the URL itself is now the secret, same-origin pinning and `redirect: "error"`
matter more, and the URLs are masked to their origin in application logs, the
child's `log` lines, `voice_start` failure text and the approval card. A
`stream_token` the model still passes is stripped by the schema.

## Measured

Not yet. To fill during the release-candidate soak: flush latency, the accuracy
of the played-milliseconds figure the voice model sees, delegate round trip and
the reconnect gap.

## Not verified / known gaps

- **Reconnect seed.** After a planned or unplanned reconnect the voice model is
  seeded with the last lines of the transcript only: no summary, and no silence
  pad before the first audio.
- **Test scope is narrower than designed.** There is no real Redis lock test, no
  simulated-gateway test and no rendering test. The in-process end-to-end and
  node/mono host tests use fakes for those layers.
- **Post-init exit paths of the real child are not tested in a real process**
  (stdin EOF, provider failure after init). Adding a provider-URL seam would let
  a compromised environment redirect the key and audio, so the in-process loop
  tests cover those paths instead, and the exit-code wiring after init is
  untested.
- **Long silent calls versus job-token age.** The session's job token is not
  refreshed while the call is silent. A job token lives 15 minutes and can be
  refreshed until 60 minutes after it expires, so after about 75 minutes with
  no injected turn the closing summary may fail with `auth_lost`.
- **A tab may stay in the meeting** after a call ended by a session reboot or
  a lost identity (`auth_lost`), because no summary or cleanup turn runs on a
  session that may no longer run as the agent. Someone
  has to leave the meeting by hand.
- **No thread notice when a node dies mid-call.** The call ends; nothing is
  posted.
- **Auto-evolve after a delegate** runs outside the injected-turn flags and the
  session lock, as it does after Slack jobs.
- **Gemini context lands up to a turn late** (above); a provider error during a
  request that never produced a response can leave the conductor's active flag
  set.
- **Not run against real infrastructure:** a live call against any provider
  is covered only by the opt-in tests, which need a key (and, for the full
  loop, a workbench tab). The GPT-Live adapter has been run only against a fake
  server built from the documented protocol.
