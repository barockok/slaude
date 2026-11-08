---
title: "Guardrails as the runtime layer: a registry the wired hooks must agree with"
date: 2026-11-08
---

# Guardrails as the runtime layer: a registry the wired hooks must agree with

**Date:** 2026-11-08
**Status:** Phase 1 shipped in `v0.46.0-rc.7` (branch `feat/guardrails-runtime-layer`). The two node behaviour gaps it found are fixed in `v0.46.0-rc.8`.
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

That surfaced the first of two real gaps (listed below). The node worker (`src/node/worker.ts`) installs a
permission resolver but no Stop guard. In the gateway role, turns run on nodes,
so the must-reply hook there is a no-op: a node turn that ends without a reply
or a pass is not sent back. The page reports it as *Not wired* in that role. A
test pins the node facts to what the worker installs, so the page changes when
the worker does. Fixing the gap was outside this change; v0.46.0-rc.8 installs
the guard on nodes (see below), and the row now reads *Enforcing* there.

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

## Behaviour gaps found (fixed in v0.46.0-rc.8)

This change only described; it did not change what runs. Two gaps in what
runs came out of the survey. Both are fixed in v0.46.0-rc.8:

1. **Node workers installed no Stop guard.** `src/node/worker.ts` set a
   permission resolver but never called `setStopGuard`, so on a node the Stop
   hook returned `continue: true` for every stop. A node turn that ended with
   no reply and no `pass` was not sent back, and the page showed the
   must-reply row as *Not wired* in the gateway role.
   **Fix:** the worker installs `makeNodeStopGuard` (`src/node/stop-guard.ts`).
   It tracks spoke and passed per session from the node manager's own
   `toolCall` events, resets them when a job's turn starts, and returns the
   same instruction as mono. The tool-name rule and the instruction live in
   `src/agent/must-reply.ts`, used by both the gateway and the node, so they
   cannot drift. It forces only the turns mono forces: mono guards a route
   that is not silent, and every cron-origin route is silent (a cron run, and
   every `dispatchThreadTurn`: promise checks, heartbeat turns, wakes). The
   node reads the same facts from the job: only a turn whose signed `origin`
   is `slack` or `panel`, with no `bgRun` or `wake` in the claims or the job,
   is guarded. Voice turns are skipped, as in mono.
2. **A wake on a node could run tools the node's local policy auto-allows.**
   In mono the gateway wraps the permission resolver and denies every
   `canUseTool` call during a wake before any policy runs. A node's resolver
   (`makeNodePermissionResolver`, `src/node/shims/permission.ts`) ran
   `permissionPolicy` locally first, with the node's own
   `SLAUDE_AUTO_ALLOW_TOOLS`; a tool it allowed (a built-in such as `Bash`, if
   listed there) never reached the gateway's `can_use_tool` route, where the
   wake refusal lives. The tool plane's `wakeAllows` check covers only slaude's
   own contract tools, so it did not catch a built-in either.
   **Fix:** the node resolver denies with `wakeRefusal(toolName)` before
   `permissionPolicy` when the session's current turn is a wake. The signed
   `wake` claim of the session's bound job token decides (the job's `wake`
   field only when the token cannot be read). Each job binds its own token, so
   the next normal turn on the same session keeps the node's auto-allow list.

## Other known gaps

- Nothing in the code stops a soul from contradicting the baseline. The page
  says so.
- The remote entries read `SLAUDE_REMOTE` in the gateway's environment; a node
  follows the remote target signed into its job claim instead. The rows say so.
