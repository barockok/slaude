---
title: "Voice mode: a realtime voice in front, the thread's session behind it"
date: 2026-10-08
---

Voice mode puts the agent in a live call. A realtime voice model (OpenAI Realtime
or Gemini Live) handles the audio and the turn-taking; whenever it needs facts or
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

## Orphan children

The child holds the provider key and stream token, so a child left running is a
credential left running. Paths closed in review: a missing process `error`
handler crashed the host; the stream-error close path never killed the child; a
throw after spawn (runner or call construction) leaked it; a detached promise
rejection in the child killed it without an `ended` message (the entry now
installs handlers, emits one `ended`, and exits); an exit without `ended` after
a requested stop is reported as the requested reason, not a crash.

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
  refreshed while the call is silent; a call past the token's maximum age may
  fail its closing summary with `auth_lost`.
- **A tab may stay in the meeting** after a call ended by a session reboot,
  because no cleanup turn runs on a session whose identity is unknown. Someone
  has to leave the meeting by hand.
- **No thread notice when a node dies mid-call.** The call ends; nothing is
  posted.
- **Auto-evolve after a delegate** runs outside the injected-turn flags and the
  session lock, as it does after Slack jobs.
- **Gemini context lands up to a turn late** (above); a provider error during a
  request that never produced a response can leave the conductor's active flag
  set.
- **Not run against real infrastructure:** a live call against either provider
  is covered only by the opt-in test, which needs a workbench tab and a key.
