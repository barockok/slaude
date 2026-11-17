# Guardrails as the runtime layer (design)

Status: approved after review 2. Phase 1 = v0.46.0-rc.7 (registry, page), phase 2 = rc.8 (moves).

## Problem

The console's Resources > Guardrails page shows mostly soul and access settings (approvers, admission, grants,
memory write tiers, proactive settings) plus deployment config. Those belong to the agent and to Access. The
operator's meaning of "guardrails" is the runtime's own layer: the non-overridable baseline of the system
prompt that sits under the soul, and the code (hooks and gates) that blocks, rewrites or stops the agent. Most
of that layer is invisible today, and the page is a hand-kept description that can drift from what runs.

## What exists (survey, file:line)

System prompt (`src/agent/manager.ts:1605`, `#buildSystemAppend` at 1247-1290), in order:
0. SDK `claude_code` preset (append only).
1. `<runtime-baseline>` from `src/soul/runtime/core.md` via `runtimeBaseline()` (`src/soul/loader.ts:201`),
   blocks: Slack output discipline, Slack formatting, How you write, Approval discipline, Engagement, Channel
   trust, Memory, Built-in skills (index from `renderSkillIndex()`), Progress visibility, Harness overrides.
   Variables change with brain on/off.
2. `<persona>` (soul).
3. `<channel-mandate>` (replaces the soul's Mandate for that channel).
4. `<session-mode>` / `<remote-mode>`.
5. `<mcp-servers>`.
6. `<memory-context>`.
Per-turn: UserPromptSubmit session notes, `<runtime-check>` kinds, `<proactive-context>`, channel trust envelope.

Hooks (`manager.ts:1598-1604`, all enforcing): Stop must-reply guard; UserPromptSubmit disengage and
mention-only suppression; PreToolUse remote local-tool deny, SkillGate (built-in skill must be loaded before a
governed tool), profile write guard; PostToolUse SkillGate mark, `pass` ends the turn, skill usage counter (not
a guardrail); background-pass `onlyPassTools`; canUseTool wake refusal plus permission gate, remote canUseTool.

Other enforcement: permission gate policy (auto-allow, MCP authenticate always denied), scheduler tool deny
(`SCHEDULER_TOOLS`), wake tool allow-list, remote deny list, background pass lockdown, built-in skill write
refusal, `soul_override` manager-only, child env scrub and telemetry kill flags, outbound SSRF policy, secret
redaction (replies and status line), budgets (background, proactive, wake, skill-check), decision gate
(`off|shadow|on`, default off).

Designed, not built: KB-first Stop guard (prose only in the baseline), policy guardrails Tier 2/3.

## Design

### 1. Guardrail registry (`src/agent/guardrails.ts`), describe only

A typed list of descriptors. It describes; it does not build hooks. `manager.ts` keeps wiring its hooks as
today (they close over manager-private state: stop guard, session notes, SkillGate instance, synthetic-turn
check), and the background runner keeps its own `query()` options.

```ts
type GuardrailKind = "prompt" | "hook" | "gate" | "deny-list" | "limit" | "redaction" | "observability";
type GuardrailState = "enforcing" | "shadow" | "off" | "not-built" | "not-wired";
interface GuardrailDescriptor {
  id: string;                      // stable, e.g. "hook.stop.must-reply"
  kind: GuardrailKind;
  title: string;
  summary: string;
  event?: "Stop" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact" | "canUseTool" | "dispatch";
  effect: string;
  appliesTo: Array<"interactive" | "wake" | "remote" | "voice" | "background" | "deployment">;
  state: (ctx: GuardrailCtx) => GuardrailState;
  toggle?: { source: "env" | "config" | "thread" | "none"; key?: string; default?: string };
  details?: (ctx: GuardrailCtx, viewer: { role: "superadmin" | "operator" }) => unknown;
  source: string;                  // file:area for operators reading code
}
```

No drift without moving wiring: a `tagHook(id, cb)` helper marks each hook callback with its registry id
(WeakMap). `manager.ts` wraps each hook at construction; the background runner tags `onlyPassTools`. An
agreement test builds the SDK options for interactive, wake, remote and voice sessions through existing seams
(plus the runner's lockdown options), walks `options.hooks`, and asserts `[event, ordered ids]` equals the
registry filtered by `appliesTo`, that every registry hook id appears exactly once, and that no untagged hook
exists. Telemetry hooks (PreCompact, skill usage) are registered as kind `observability`, so the test cannot
pass by ignoring unknown hooks; the page hides observability entries by default.

`GuardrailCtx` carries injected runtime facts, not only env and config: whether the gateway installed the
stop guard (`#stopGuard` is optional, absent is a no-op) and whether a permission resolver is set. A guardrail
whose code exists but is not wired in this process reports `not-wired`, never `enforcing`.

Non-hook enforcement (deny lists, limits, redaction, gates) is described by reading the existing constants
(`SCHEDULER_TOOLS`, `WAKE_TOOL_ALLOWLIST`, `REMOTE_DENIED_LOCAL_TOOLS`, budget config, `parseDecisionConfig`
mode only, field path only on error). Correct sources: wake refusal lives in the gateway resolver wrapper
(`src/gateway/core/gateway.ts` near 1194) and the node tool plane (`src/gateway/api/tools/index.ts` near 65);
`permissionPolicy` auto-allows skill introspection beside the MCP authenticate deny.

"Not built" entries (KB-first Stop guard, policy Tier 2/3) are rows with state `not-built` and a link to their
field note.

### 2. Baseline blocks

A small parser next to `src/soul/runtime/render.ts` splits the rendered `runtimeBaseline()` by `##` headings
into `{ id, title, markdown }`, skipping headings inside code fences; the "Built-in skills" block comes from
`renderSkillIndex()` and is absent when there are none. The baseline is deployment-wide (one render for all
agents; only `<persona>` and `<channel-mandate>` vary per agent), and the page says so. With the brain off it
embeds the absolute knowledge path; for display it is replaced with `$SLAUDE_HOME/knowledge`.

### 3. API

`GET /panel/api/guardrails?agent=<id>` (existing route and `PERSONA_NAME_RE` check, 404 for unknown agents) adds,
alongside the existing `families` in phase 1:
- `promptStack`: ordered layers with `{ id, title, overridable: boolean, source, present: boolean }`
  (preset, runtime baseline, persona, channel mandate (count), session mode, MCP list, memory context), plus
  per-turn injections as a separate short list.
- `baseline`: the parsed blocks (markdown).
- `builtinSkills`: from `listBuiltinSkills()` with `governs`.
- `guardrails`: registry entries with computed `state`, `toggle`, `details`, grouped by kind.
Read-only, superadmin and operator. `details` receives the viewer role: redaction pattern values stay
superadmin-only (operators see counts), as today. No env values beyond on/off, mode and caps.

### 4. Console page (Resources > Guardrails)

Agent picker, then three sections:
- **System prompt**: the layer stack as an ordered list with a "fixed by the runtime" / "from the soul" tag;
  the soul and channel mandate rows link to the agent's Mandates tab. Each baseline block is a collapsible
  card rendered with the shared Markdown component (Rendered / Raw / Copy). Built-in skills listed with the
  tools they govern. A note: the soul follows the baseline; nothing enforces non-contradiction in code.
- **Hooks and gates**: table of event, guardrail, what it does, applies to, state chip (Enforcing, Shadow,
  Off, Not wired, Not built; observability entries hidden behind the kind filter) and toggle (env key and default, or "always on"). Decision gate shows its real mode.
- **Limits and deny lists**: scheduler deny, wake allow-list, remote deny, background lockdown, budgets,
  redaction (secret masking incl. status line), SSRF policy, built-in skill write refusal, soul_override
  manager-only.

### 5. Moving the access families (phase 2, rc.8)

- Approvers, admission/grants: the agent's Access tab (already shows effective grants; add approvers with
  scope words and the approval timeout).
- Memory write tiers: the Memory page (a "Write rules" section).
- Proactive settings and caps: the agent's Mandates tab, next to Heartbeat.
- Tool permission mode and card deciders: Access tab ("Permission cards").
- Learned rules: Mandates tab.
- Permission mode counts (`modeCounts`, sessions per mode): Access tab under "Permission cards".
The Guardrails API drops `families` only in phase 2; the moved views reuse the existing view-model functions.
Learned rules keep their own lazy endpoint (brain call with a 3 s timeout), not folded into the agent detail.

## Testing

- Agreement: tagged hooks per session kind (interactive, wake, remote, background) match the registry; voice
  is the interactive build plus a synthetic-turn flag (same hooks object, different hook behaviour),
  each id once, no untagged hook. State per toggle, `not-wired` when the stop guard or resolver is absent.
- Baseline parser: headings, brain on/off variants, no block lost (concatenation round-trips).
- API: shape, `agent=` scoping and 404, operator response has no redaction pattern strings.
- Web (Playwright, stubs): phase 1 adds the three sections above the old cards (additive fixtures); phase 2
  moves the families and updates fixtures and `console.spec.ts`.

## Out of scope

Building the KB-first Stop guard or policy Tier 2/3; editing guardrails from the console (read-only); a code
check that the soul does not contradict the baseline (noted on the page as a known gap).

## Risks

- Phase 1 touches the agent loop only by tagging hook callbacks (identity-preserving wrapper); the agreement
  test proves the hooks object is unchanged per session kind.
- Name drift between registry titles and docs: titles live only in the registry; docs link to the page.
