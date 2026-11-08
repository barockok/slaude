---
title: "Guardrails as the runtime layer: a registry the wired hooks must agree with"
date: 2026-11-08
---

# Guardrails as the runtime layer: a registry the wired hooks must agree with

**Date:** 2026-11-08
**Status:** Phase 1 shipped in `v0.46.0-rc.7` (branch `feat/guardrails-runtime-layer`).
Phase 2 (moving the soul and access settings to the agent's tabs) is planned for rc.8.

## Problem

The console's Resources > Guardrails page (rc.4) showed mostly soul and access
settings: approvers, admission and grants, memory write tiers, proactive
restraint, budgets. Those belong to an agent and to Access. When an operator
says "guardrails" they mean the runtime's own layer, the part a soul cannot
turn off:

- the baseline of the system prompt (`src/soul/runtime/core.md`, rendered by
  `runtimeBaseline()`), which sits under every persona;
- the hooks and gates that block, rewrite or stop the agent.

Most of that layer was invisible, and the page was a hand-kept description
that could drift from what runs.

## What runs (survey)

A manager session (`AgentManager.#bootSession`) gets, in this order:

| Event | Hook | Kind |
|---|---|---|
| PreCompact | compaction notice | observability |
| Stop | must reply or pass (needs a Stop guard installed) | hook |
| UserPromptSubmit | disengaged and mention-only suppression, session notes | hook |
| PreToolUse | remote local-tool deny (remote sessions only), built-in skill gate, profile write guard | hook |
| PostToolUse | skill gate loaded mark, skill usage counter, `pass` ends the turn | hook, observability, hook |

A background pass (`background/runner.ts passQueryOptions`) has one hook, a
PreToolUse lock to its own pass tools. A wake and a remote session are manager
sessions; a voice call drives the interactive session (same boot, same hooks
object), and only the synthetic-turn flag the hooks read changes.

Beside the hooks: `canUseTool` (the permission gate's `permissionPolicy`, the
wake refusal in the gateway's resolver wrapper and on the node tool plane, the
remote tool mapping), the decision gate (`SLAUDE_DECISION_CONFIG`, off by
default), deny lists (`SCHEDULER_TOOLS`, the wake allow-list, the remote deny
list, the background lockdown, built-in skill writes, `soul_override` for the
manager only), the child environment scrub, budgets and wake caps, the
outbound fetch policy and redaction.

## Decision: a registry that describes, and a test that holds it to the wiring

`src/agent/guardrails.ts` is a typed list of descriptors (id, kind, event,
effect, where it applies, a state function, a toggle, role-gated details, the
source). It builds nothing. The manager and the runner keep wiring their hooks
as before, because those hooks close over manager-private state (the stop
guard, session notes, the skill gate, the synthetic-turn check); moving the
wiring into the registry would have touched the agent loop for a page.

To stop drift without moving the wiring, `tagHook(id, cb)`
(`src/agent/hook-tags.ts`) marks each callback with its registry id in a
WeakMap and returns the same function object. Nothing about a hook changes:
same return values, same `this`, same order, same matchers.

`tests/agent/guardrails-agreement.test.ts` builds the SDK options for an
interactive session, a wake, a remote session (through the manager, with the
SDK's `query` faked to capture them) and a background pass, walks
`options.hooks`, and asserts that `[event, ordered ids]` equals the registry's
hook entries filtered by where they apply, that every registry hook appears,
once per session that has it, and that no callback is unmarked. The telemetry
hooks are registered as kind `observability`, so the test cannot pass by
ignoring hooks it does not know. Swapping one tag in the manager fails four of
its cases.

## Decision: state is computed from runtime facts, and "not wired" is a state

A descriptor's state reads env and config, and also facts the gateway injects:
whether a Stop guard is installed and whether a permission resolver is set. A
guardrail whose code exists but is not installed in this process reports
*Not wired*, never *Enforcing*.

That surfaced one real gap. The node worker (`src/node/worker.ts`) installs a
permission resolver but no Stop guard. In the gateway role, turns run on nodes,
so the must-reply hook there is a no-op: a node turn that ends without a reply
or a pass is not sent back. The page reports it as *Not wired* in that role. A
test pins the node facts to what the worker installs, so the page changes when
the worker does. Fixing the gap is outside this change.

Two designs are rows with state *Not built* and a link to their field note: the
KB-first Stop guard (today prose in the baseline only) and policy guardrails
Tier 2 and 3.

## Baseline blocks

`src/soul/runtime/blocks.ts` splits the rendered baseline by `##` headings,
skipping headings inside code fences. Every block is an exact slice, so the
blocks join back to the rendered text (tested with memory stores on and off).
The text before the first heading is a "Preamble" block; the "Built-in skills"
block comes from `renderSkillIndex()` and is absent when there are none. The
baseline is one render per deployment (only the persona and channel mandates
differ per agent), and the page says so. With memory stores off it names the
knowledge directory on disk; for display that path reads
`$SLAUDE_HOME/knowledge`.

## What the API shows, and what it does not

`GET /panel/api/guardrails?agent=` keeps its route, its name check and its 404,
and adds `promptStack`, `baseline`, `builtinSkills` and `guardrails` beside the
existing `families`. Environment values appear only as on or off, a mode or a
cap: the decision gate shows its mode through `parseDecisionConfig` (a broken
config reports the field path only), the outbound policy shows whether its host
lists are set, never the hosts. Redaction pattern values stay superadmin-only;
operators see a count, and a test checks an operator response holds no pattern
string.

## Known gaps

- Nothing in the code stops a soul from contradicting the baseline. The page
  says so.
- The remote entries read `SLAUDE_REMOTE` in the gateway's environment; a node
  started with a different value is not reflected.
- The must-reply Stop guard is not installed on nodes (above).
