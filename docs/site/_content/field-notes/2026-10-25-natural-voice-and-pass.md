---
title: "Natural voice and `pass`: a check that said 'stay silent' lost to a must-reply rule"
date: 2026-10-25
---

# Natural voice and `pass`: a check that said "stay silent" lost to a must-reply rule

**Date:** 2026-10-25
**Status:** Shipped on the epic branch, unreleased (agent-loop change, so it goes out as a release candidate first). Not verified against a live model.

The agent sounded like a machine in two ways: it announced its own housekeeping
("saved /some-skill"), and it answered messages that were not for it. Both came
from one conflict between instructions.

## The mechanism

The runtime baseline carried a general rule: every turn must end in a reply. The
auto-evolve check, a synthetic user message injected after substantial turns,
said the opposite: if nothing is worth saving, end the turn without a reply.
The model treated the check as a user message and the baseline as law, so the
general rule won. No-op skill checks produced a visible message.

The same rule explains the second symptom. A mention that was *about* the agent
rather than *to* it (someone discussing it in the third person) had no way to
end quietly. The turn had to reply, and replying re-engaged the thread, so the
agent kept answering a conversation it had only been named in.

## The fix

- **Writing-style section** in the runtime baseline: plain language, no internal
  vocabulary in user-facing text. The rule to consult stored knowledge first now
  governs what the agent does, not how it words the answer.
- **`pass` surface tool.** An explicit, silent end of turn with an optional
  reaction. The baseline rule became reply-or-pass: a turn ends in one of the two.
  A passed turn gets no done reaction, and the received reaction is removed
  unless the pass reacted with that same emoji, so a pass with a reaction
  leaves only that reaction.
- **The other prompt surfaces offer pass too.** The per-turn envelope on every
  inbound message and the stop guard's block text both used to order a reply;
  they now offer `reply` or `pass`. An imperative in the user turn outweighs the
  baseline, so leaving them as "reply" would have undone the rule.
- **`<runtime-check kind="auto-evolve">` wrapper** around the check, so the
  model can tell a runtime check from a person. The announcement step was
  removed, and the check fires only at four or more substantive tools including
  a mutating one (`SLAUDE_AUTO_EVOLVE_MIN_TOOLS`, default 4). A no-op check ends
  with no tool call at all.
- **Engagement revert.** A mention that ends in `pass` returns the thread to
  its prior engagement state instead of engaging it.
- **Voice lint** in the simulator, an `expect_natural_voice` step, and a live
  scenario, so regressions in wording are caught by a test rather than by a reader.

## Discovery: the stop guard would have blocked every pass

An in-process Stop hook forces a reply when a turn ended without one. Nothing
in the first design counted `pass`, so the guard would have pushed the model to
reply right after it had chosen not to, blocking every pass. The guard now
accepts a pass as a valid ending. Nodes (remote workers) do not run that hook;
there the reply-or-pass rule exists only as prompt text, so on a node the
behaviour depends on the model following it, with no enforcement behind it.

## Node-mode voice reaction leak

In a voice call the thread is meant to stay quiet. `pass` with a reaction would
have put an emoji in the thread from a node during a voice turn. The node shim
now drops the reaction when the turn is a voice turn.

## Duplicate delivery and the engagement revert

A mention arrives twice: once as the mention event and once as a plain
`message` event for the same post. Reverting engagement after a pass handles the
first copy, but the second copy also contains the mention, so it took the
mention branch of the router, which wrote `engaged=true` again and undid the
revert. The fix checks the seen-events
store (`SeenEvents.has()`) before treating the second copy as new. The revert
write itself is guarded, so a failing store write cannot escape the turn-done
handler and wedge the turn.

## Known narrow races

- **The revert and a follow-up already dispatched.** A follow-up can be routed
  as engaged just before the revert write lands. The agent answers it, and the
  thread is then disengaged under that conversation. The window is the time
  between the follow-up's routing and the end of the passing turn.
- **The revert and the next auto-evolve check.** If a passing turn met the
  auto-evolve bar, the revert can land before the injected check runs. The
  disengaged thread's prompt hook then records the check without running it.
  The effect is a skipped check, which is seen again on re-engage; the same
  race already existed for any disengage.

## Not verified

- Live-model behaviour. Every test uses stubbed turns; whether a real model
  chooses `pass` when it should, and stays quiet on a no-op check, is unmeasured.
- The live natural-voice scenario has not been run.
- Whether that scenario's seeding turn produces an approval card, which would
  stall it, is unknown.
- Node-mode enforcement of reply-or-pass, as described above, is prompt-only.
