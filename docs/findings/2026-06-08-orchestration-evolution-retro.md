# 2026-06-08 — Retro: orchestration, gating & continuous evolution

External AI-engineer review of slaude as a "team-member agent" runtime on top of
`claude-agent-sdk`. Four axes audited: **gating**, **engine**, **evolution/learning**,
**architecture seams**. This is a snapshot retro — findings reflect the codebase at
commit `027a263` (sim REPL / surface abstraction merged).

## TL;DR

Engineering quality is high, test discipline is real (666 tests, 25 sim transcripts),
gating is thoughtfully layered. **But there is a premise mismatch.** The north star
("skills grow over time, episodic+semantic memory, runs unattended, evolves like
hermes-agent / OpenClaw") is the *least-built* part of the system. Today slaude is a
well-managed Claude Code instance in Slack — not a self-improving, long-running agent.

The two things that *define* the premise — **autonomous evolution** and **unattended
longevity** — are the two weakest areas. Close the reflection loop and the
context-survival gap, or restate the north star.

---

## 1. Gating — strongest area, but the floor is soft

Six gates stack in `handleMessage`: channel-mode → blocked-user → ignore → 1on1-lock →
engagement → permission (SDK `canUseTool`) → approval (agent-initiated). Genuine
defense-in-depth. Output is MCP-tool-only (no raw assistant text leaks to Slack),
approver identity is resolved server-side, channel allowlist is SOUL-grounded.

### Problems

- **Gating is advisory, not enforced.** `request_approval` is an *agent-initiated* MCP
  tool (`approval-gate.ts`), not an SDK hook. The agent decides *when* a checkpoint
  fires. `RUNTIME_BASELINE` (`soul/loader.ts`) *mandates* it, but nothing in code forces
  it. A misaligned agent in `/mode bypass` can skip every checkpoint. The boundary is
  model alignment, not code.
- **Timeout auto-denies, but the agent must honor it.** On timeout the decision resolves
  `approved=false` — the agent is trusted to check it and stop. No hard gate. An
  implementation bug (or willful agent) proceeds unapproved.
- **Approver selection is manipulable.** Approvers are keyword-matched against the
  agent-authored `summary` (`approval-gate.ts:131`). The agent writes the summary *and*
  triggers the selection — rewording widens scope. No adversarial test covers this.
- **`mcp__slaude_slack__*` is blanket auto-allowed** (`permission-gate.ts:145`). Fine
  today (output-only) but large blast radius if any of those tools become stateful.
- **No audit log anywhere.** The only record of approve/deny decisions is mutable Slack
  messages. Not compliance-ready.

### Recommendations

1. Move the high-risk gate into an SDK `PreToolUse` hook (deterministic, code-side)
   instead of an agent-called MCP tool. The Tier-3 policy-service design already exists
   in `docs/findings/2026-05-21-policy-guardrails.md` — ship it.
2. Add an append-only decision log table to sqlite (who/what/when/verdict).
3. Add an adversarial test: reworded summary must not widen approver scope.

---

## 2. Engine — clean wrap, no long-run survival

`AgentManager` over SDK `query()`: push-based async-generator prompt, per-session
fire-and-forget loop, event fanout (`assistantText|thinking|toolCall|toolResult|done`).
Idiomatic and clean. `manager.ts` is the core.

### Fatal gaps vs the "runs unattended" premise

- **Context exhaustion is tracked but unmanaged.** `TokenBudget` fires warn/critical
  edge-triggered alerts, then does *nothing*. No auto-summarize, no turn-drop, no
  rollback. SDK compaction is opaque (`PreCompact` only emits a UI event;
  `manager.ts:263`). A long-running agent hits the wall with no recovery path.
- **No cross-restart recovery.** Resume is best-effort: provider drops the session →
  one retry → fresh session, history gone (`manager.ts:386`). A crash mid-turn loses the
  turn. No conversation journal to replay. Disqualifying for a 24/7 agent.
- **Unbounded concurrency.** 100 threads → 100 parallel `query()` loops, no backpressure,
  no fairness, no queue. A runaway thread starves the rest. The connect-broker child pool
  leases are unbounded too (vendor rate-limit risk).
- **No cost tracking.** Tokens counted; dollars not. Cost drift is invisible.

### Recommendations (priority order)

1. Context-management strategy: an agent-invokable compaction/summarize tool **and** an
   automatic summarize-at-threshold fallback.
2. Durable per-turn journal → replay-resume after crash/restart.
3. Per-session concurrency cap + a simple scheduler / backpressure.
4. Track model cost alongside tokens.

---

## 3. Evolution — the biggest gap vs the premise

North star: skills grow, memory is episodic+semantic, the agent reflects like hermes.

### Reality

- **Skills:** the agent *can* `write_skill`, and an auto-evolve prompt is injected after
  ≥2 substantive tools (`manager.ts` `AUTO_EVOLVE_PROMPT`). But writes are
  **approval-gated** — a human must click. Not autonomous. The trigger is a crude
  tool-count heuristic; silent turns that taught a lesson never reflect.
- **Memory:** write-only per turn + read-only prefetch (last 5 turns, 50 facts;
  `sqlite-provider.ts`). **No retrieval tool** — the agent cannot query its own memory
  mid-turn. **No embeddings** — flat SQL, no semantic recall. This is a chat log, not
  hermes memory.
- **Soul:** static, operator-owned, immutable at runtime. The agent cannot propose
  identity/mandate refinement.
- **Knowledge:** the agent stages `raw/`, but `/ingest` is **operator-only**. The agent
  cannot grow its own KB.
- **No reflection loop at all.** No "what did I learn" pass, no outcome measurement, no
  feedback. `skill_usage` is collected but never used to refine.

### What it takes to match the premise

1. A memory **retrieval tool** (agent-invoked) + embeddings for semantic recall.
2. A **reflection pass** every N turns / at session-end — not tool-count gated.
3. Agent-triggered ingest (gated by approval, not operator-only).
4. A skill-outcome feedback loop — wire `skill_usage` into refinement.
5. Let the agent *propose* soul deltas for operator review (PR-style).

Without these, "evolution" is the operator editing markdown.

---

## 4. Architecture — honest seams, Slack still leaks

Surface abstraction is good (≈7/10). The `Surface` port is clean, MCP tools are
capability-gated, and the sim runs the **real** `SlackSurface` over a fake transport —
a genuine verification harness, not a toy.

But the premise ("multi-agent, each = own Slack identity"; scope hints at multi-surface)
is not reflected in the core:

- `gateway.ts` is a 931-line god-object; `handleMessage` (~410 lines) is deeply
  Slack-specific (engagement, command parse, redaction). A new surface means rewriting it.
- DB schema hardcodes `slack_team_id/channel_id/thread_ts` — no `platform_id`/`source_id`.
- `SlackContext` leaks through `SessionMcpCtx`; approval rendering is Block-Kit-hardcoded,
  not in the `Surface` contract.

The spec honestly defers "gateway neutralization." Fair. Know that the current
abstraction decouples *agent↔surface*, not *core↔Slack*. Ready to ship; expensive for a
second surface.

---

## Priority stack

| P  | Item | Why |
|----|------|-----|
| P0 | Context-window management (self-compact + journal-resume) | Premise = unattended; today dies at the context wall and on crash |
| P0 | Move high-risk gate to an SDK hook, not an agent-called MCP tool | Gating is bypassable by design |
| P1 | Memory retrieval tool + embeddings + reflection pass | "Evolution" is currently aspirational |
| P1 | Append-only audit log | No compliance trail |
| P2 | Concurrency cap + backpressure | Unbounded parallel loops |
| P2 | Skill-outcome feedback loop | `skill_usage` collected, unused |
| P3 | Generalize session identity (`platform_id`) | Multi-surface future |

## Highest-leverage next steps

The **reflection loop** (axis 3) and **context-survival** (axis 2) are the two changes
that move slaude from "managed Claude Code in Slack" toward the stated hermes/OpenClaw
north star. Everything else is hardening.
