# Heartbeat Wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. TDD each task. One logical change per commit.

**Goal:** A persona with `Wake: yes` does its recurring checklist work in a real session turn, gated and budgeted by code, while restraint on what reaches people stays code-enforced.

**Architecture:** The background scheduler keeps its slots and ledger. For a waking persona it runs a code gate, opens a `heartbeat-wake` run, and sends a fresh session turn through the cron path (`dispatchThreadTurn`). A signed `wake` job claim makes the gateway enforce a tool allow-list on mono and nodes alike. Personas without `Wake: yes` keep today's round.

**Tech Stack:** Bun + TypeScript, `bun:test`, claude-agent-sdk (`maxBudgetUsd`, `maxTurns`), BullMQ, Postgres and sqlite through the `db` seam.

**Spec:** `docs/superpowers/specs/2026-11-02-heartbeat-wake-design.md`

## Global constraints

- Public repo: placeholders only (`C0EXAMPLE`, `U0MANAGER`). Leak-scan every staged diff (CLAUDE.md command). No AI co-author trailer.
- Nothing changes for a persona without `Wake: yes`, except the round fixes in Phase 1. `SLAUDE_PROACTIVE_BUDGET_USD` unset means today's single pool.
- Every migration also lands in the sqlite driver (`src/db/drivers/sqlite.ts`).
- Anything a tool enforces comes from signed claims on the `/v1` path and from the route on mono. Test both.
- No push, PR or release in this plan. The live checks in the spec need the owner.

## Phase 1: round fixes (F1 to F6)

### Task 1: F1, checklist evidence does not dedupe
- Modify: `src/proactive/restraint.ts` (`checkProactive`; export `SELF_EVIDENCE`)
- Test: `tests/proactive/restraint.test.ts`
- Behaviour: evidence `self/heartbeat`, `self/heartbeat-journal` or `self/wake-journal` (trimmed, any case) is not compared. Other evidence still dedupes, and the same text still dedupes.

### Task 2: F2, `unchanged` reaches the journal
- Modify: `src/proactive/heartbeat.ts` (the `sent.rule === "unchanged"` branch)
- Test: `tests/proactive/heartbeat.test.ts`
- Behaviour: the journal gets `Not sent again: <label> (unchanged)`. The source's watermark still advances (terminal, not a transient drop).

### Task 3: F5, channel `Cooldown` and `Max per day`
- Modify: `src/soul/proactive.ts` (`parseProactive`, `proactiveFor`, `ProactiveConfig`)
- Test: `tests/soul/proactive.test.ts`
- Behaviour: a channel block's values replace the global ones for that channel only. Invalid values are ignored. The header comment documents them.

### Task 4: F3, budget pools
- Modify: `src/background/budget.ts`, `src/background/config.ts`, `src/config/env.ts`, `src/db/background-runs.ts` (`spentOn` pass filter)
- Test: `tests/background/budget.test.ts`
- Behaviour: `SLAUDE_PROACTIVE_BUDGET_USD` unset: identical to today. Set: proactive passes (`heartbeat`, `heartbeat-turn`, `heartbeat-wake`, `commitment`) count and spend only their pool, and skip the nightly reserve. The learning pool counts everything else. `overAfterStart` and the runner's abort use the same pool.

### Task 5: F4, starvation notice
- Modify: `src/background/passes` or the heartbeat handler path where `skipped-budget` is decided; reuse the `tellReauth` shape in `src/proactive/heartbeat.ts`
- Test: `tests/proactive/heartbeat.test.ts`
- Behaviour: at most one DM to the manager per persona-local day when the heartbeat is refused by budget. No manager: no DM.

### Task 6: F6, voice in triage
- Modify: `src/background/prompts/heartbeat.md`, `src/proactive/heartbeat.ts`, `src/background/scheduler.ts`
- Test: `tests/proactive/heartbeat.test.ts`
- Behaviour: the persona's voice line renders on one line with no `<`, or `(not set)`.

## Phase 2: gate and state

### Task 7: `Wake` and `Read` parsing, eligibility
- Modify: `src/soul/proactive.ts`. Test: `tests/soul/proactive.test.ts`
- Behaviour: `wake` and `read` are global only. `wakeEligible(personaId)` returns `{ok}` or `{ok:false, reason}`, requiring `Wake: yes`, a manager, and `Highest: act` on an enabled destination.

### Task 8: `heartbeat_wake_state`
- Create: `src/db/migrations/0031_heartbeat_wake.sql`, `src/db/heartbeat-wake-state.ts`. Modify: `src/db/drivers/sqlite.ts`
- Test: `tests/db/heartbeat-wake-state.test.ts`
- Behaviour: get, upsert, `recordFinish` as in spec section 6, and tenant keying.

### Task 9: the gate
- Create: `src/proactive/wake-gate.ts`. Test: `tests/proactive/wake-gate.test.ts`
- Behaviour: pure `wakeDue(state, checklistHash, now, cfg)` returning `due` or `idle` with the reason, and `clampNextCheck`. No checklist: never due.

## Phase 3: the wake

### Task 10: `wake` claim and context
- Modify: `src/gateway/api/auth.ts`, `src/gateway/core/dispatch.ts`, `src/gateway/core/gateway.ts` (route and `v1SlackCtx`), `src/gateway/slack/mcp-tools.ts` (`SlackContext.wake`)
- Test: `tests/gateway/api/` token round trip; absent claim reads as not a wake.

### Task 11: tool guard
- Create: `src/proactive/wake-guard.ts`. Modify: the Slack, surface and runtime tool registration points
- Test: `tests/proactive/wake-guard.test.ts`
- Behaviour: every row of the spec's tool table. Anything new is refused by default. Permission and approval cards are refused immediately in a wake.

### Task 12: `proactive_post`, `read_channel`, `finish_round`
- Modify: `src/tools/contracts/runtime.ts`, `src/gateway/slack/mcp-tools.ts`, `src/proactive/heartbeat.ts` (export `sendProactive`), and extract the thread binding from `dispatchThreadTurn`
- Test: `tests/proactive/wake-tools.test.ts`
- Behaviour: spec section 5. `read_channel` is available in all turns, limited to `Read:`.

### Task 13: wake run: envelope, dispatch, handler
- Create: `src/background/prompts/heartbeat-wake.md`, `src/proactive/wake.ts`. Modify: `src/background/scheduler.ts`, `src/background/budget.ts`, `src/background/skill-check.ts` (`TurnPass`, carried passes, floor)
- Test: `tests/proactive/wake.test.ts`
- Behaviour: spec section 2 end to end with fakes. An ineligible persona keeps the round. With `Watch`, triage gets no checklist.

### Task 14: per-run caps and no skill check
- Modify: `src/agent/manager.ts`, `src/queue/turns.ts`, `src/node/worker.ts`, `src/config/env.ts`
- Test: `tests/agent/wake-caps.test.ts`
- Behaviour: `maxBudgetUsd`, `maxTurns` and the wall clock apply to wake sessions only; `0` disables each; `maxBudgetUsd <= pool remaining` always; a cap result posts no error; `#shouldAutoEvolve` is false for a wake.

### Task 15: outcomes and metrics
- Modify: `src/background/skill-check.ts`, `src/metrics.ts`, `src/gateway/api` turn finish
- Test: `tests/proactive/wake-outcomes.test.ts`
- Behaviour: spec section 6's table, and section 9's metrics on mono and through a node.

### Task 16: `/heartbeat status`, notices, retention sweep
- Modify: `src/gateway/slack/commands.ts`, `src/background/scheduler.ts`
- Test: `tests/gateway/` command test; sweep test
- Behaviour: manager-only status; failure and ineligible notices once per day; `wake:%` sessions older than `SLAUDE_WAKE_KEEP_DAYS` removed.

### Task 17: docs and full check
- Modify: `src/soul/runtime/core.md`, `src/soul/builtin/skills/memory/SKILL.md`. Create: a field note, and link it from the CLAUDE.md index
- Run: `bun test`, `npx tsc --noEmit`, leak scan over the branch.
