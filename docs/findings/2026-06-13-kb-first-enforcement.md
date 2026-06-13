# KB-first enforcement — from prose to teeth (2026-06-13)

**Status:** Designed, NOT implemented. Captures the plan for a later look.
**Related:** PR #25 hardened the KB-first baseline wording (advisory → mandatory). This doc is the follow-up question: prose alone has no enforcement — should it, and how, without nagging on "Hi"?

## Problem

The KB-first stance lives in `RUNTIME_BASELINE` (`src/soul/loader.ts`) — non-overridable, injected every turn. PR #25 rewrote it in the imperative register the approval gate uses ("you MUST query the KB first… skipping is a breach of the runtime contract").

But it remains **prose only**. There is no runtime forcing function:

- The agent reads the rule, usually complies, but a confident-but-wrong model can answer straight from training via `mcp__slaude_surface__reply` and end the turn.
- The runtime does **nothing** — no check, no retry, no log, no metric. A skipped KB lookup is indistinguishable from a turn that genuinely didn't need one.

Contrast the two rules that DO have teeth:
- **Approval gate** — `ApprovalGate` + `PermissionGate` machinery.
- **Must-reply** — a Stop-hook guard (`gateway.ts:219`) that blocks the agent from stopping until it has called `reply`.

KB-first has no equivalent. It's an honor-system sticky note.

## The machinery that already exists

A KB forcing function would reuse, not invent:

- **`AgentManager.setStopGuard(guard)`** (`manager.ts`) — `StopGuard = (sessionId) => string | null`. On the SDK Stop hook, if the guard returns a string the SDK feeds it back and the agent **cannot stop** — it must continue. `#stopBlocked` makes it fire **at most once per turn** (block once, then allow → no deadlock). Metrics: `stopGuardBlockedTotal`, `stopGuardFailedTotal`.
- **`live.turnTools: string[]`** (`manager.ts`) — records every tool name invoked this turn, cleared on result.
- **`route.spoke`** (`gateway.ts`) — whether the agent emitted user-visible output this turn.
- **`AUTO_EVOLVE_IGNORE`** (`manager.ts`) — the existing notion of "substantive" vs trivial tools (Read/Grep/Glob/LS/TodoWrite are non-substantive; surface/runtime/skills namespaces excluded).

The must-reply guard is the template:
```js
agent.setStopGuard((sessionId) => {
  const route = routes.get(sessionId);
  if (!route || route.spoke) return null;
  return "You have not delivered a reply… Call mcp__slaude_surface__reply now, then stop.";
});
```

## The balance problem

The Stop-hook guard sees **tool names, not intent**. To it, these look identical:
- `"Hi"` → `reply`, no `kb_*` → looks like a skip
- `"what's our retry policy?"` → `reply`, no `kb_*` → actually a skip

Two failure modes on the dial:
- **Over-nag** — force `kb_search` on "Hi" / "thanks 👍": every reply slower, token waste, agent feels broken.
- **Under-catch** — a wrong training answer uses only `reply` (no tools), so any tool-activity-based guard misses it anyway.

You cannot perfectly separate "substantive question" from "Hi" at the guard layer. So don't try to catch everything — enforce where the **cost of skipping is highest**, trust prose where it's lowest.

## Design — tiered, shadow-first

### Tier 1: enforce by stakes (actions, not talk)
- **Mutations / real work** — the agent ran a substantive tool (Edit/Write/Bash-beyond-inspection, etc.) and is acting on context. Skipping KB here is the **dangerous** case (acting on thin context). **Hard-enforce.** Trigger: turn used ≥1 substantive tool (reuse `AUTO_EVOLVE_IGNORE` classification) **AND** zero `kb_*`/`search_kbs` in `turnTools`.
- **Pure conversational reply** — only `reply`, no other tools. Low stakes. **Trust the prose** (#25). A wrong factual answer can slip, but nothing irreversible happened. `"Hi"` is reply-only → guard stays silent.

Rationale: the high-cost path (doing work on unverified context) is enforced; the chatty path is left alone. `"Hi"` is never in scope.

### Tier 2 (optional, more coverage): classify the inbound, not the turn
The gateway has the inbound text (`ctx.inbound`). Gate enforcement on the inbound **looking like a question/task** (ends with `?`, task verbs, length > N and not in a greeting/ack set). Catches wrong *answers* too, but brittle — needs tuning. Defer until Tier 1 data justifies it.

### Rollout: shadow / metric mode FIRST
Do not hard-block on day one. Ship the guard in **observe-only** mode: when it *would* block, `log + stopGuardWouldBlock.inc({reason: "kb_skipped"})` — do not actually block. Watch ~1 week of real traffic:
- How often does it fire? Mostly real skips, or "Hi"-style false positives?
- Tune the trigger against real data, **then** flip to enforce.

Turns "guess the right heuristic" into "measure, then enforce" — no UX gamble.

### Composition note
There is **one** `#stopGuard` slot. The KB guard must compose with the existing must-reply guard, not replace it: must-reply takes precedence (no point enforcing KB on a turn that hasn't even replied), then the KB check. Both return at most one block per turn via `#stopBlocked`.

## Recommendation

Start with **Tier 1 + shadow mode**: a guard that would-block only on *substantive-work-without-`kb_*`*, emitting `stopGuardWouldBlock{reason="kb_skipped"}`, composed after must-reply. Read the metric, tune, then enable hard blocking. Revisit Tier 2 only if answer-quality data shows training-answer slips are a real problem.

## Open questions for the later look

- Is "substantive work without KB" the right high-stakes line, or should mutations specifically (the approval-gated set) be the trigger?
- Greeting/ack detection: rely purely on "reply-only ⇒ skip", or add a small inbound classifier?
- Per-channel calibration? (a `trusted` internal channel may want stricter KB discipline than an `allowed` public one.)
- Token cost of an extra forced `kb_search` round-trip vs the cost of a wrong answer — acceptable ratio?
