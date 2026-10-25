# Phase A — Natural Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent writes like a teammate, never narrates its own machinery, can end a turn silently on purpose, and stops announcing skill saves after trivial work.

**Architecture:**
- Prompt changes in `RUNTIME_BASELINE` (`src/soul/loader.ts`).
- A new `pass` surface tool that the gateway treats as a deliberate, logged ending (the stop guard accepts it).
- A stricter, system-tagged auto-evolve check in `AgentManager`.
- A gateway rule that a mention ending in a pass does not leave the thread engaged.
- A pure voice-lint helper wired into the sim transcript runner.

**Tech Stack:** Bun + TypeScript, `bun test`, `@anthropic-ai/claude-agent-sdk`, zod contracts in `src/tools/contracts/`.

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §6 (Phase A), §4.1–4.3 (current state), §8.3b (no-repeat rule lands here).

## Global Constraints

- **Public repo:** tests, fixtures, prompts and commit messages use placeholder people, channels and services only (CLAUDE.md "Working Rules").
- **Before every commit:** run the CLAUDE.md pre-commit leak-scan grep over `git diff --cached -U0`. No `Co-Authored-By` trailer; the `.githooks/commit-msg` hook enforces this (`git config core.hooksPath .githooks`).
- **Ships as an RC:** this phase changes the agent loop, so the release is `vX.Y.Z-rc.N`. Release notes are written under the stable name later, via `.claude/skills/release-prep/SKILL.md`; that's not part of this plan.
- **Progress tracking:** each task's commit also ticks that task's line under "Progress → Phase A" in the epic spec, in the same commit.
- **Values fixed by the spec:**
  - the tool is named `pass`;
  - the auto-evolve wrapper is `<runtime-check kind="auto-evolve">`;
  - the trigger defaults to `SLAUDE_AUTO_EVOLVE_MIN_TOOLS` = `4`, and at least one mutating tool must be among them;
  - the lint patterns are `/\b(my|the) (KB|brain|memory)\b/i`, `saved /`, and the word `skill` in a non-skill turn.

## Review Focus

1. **A turn that calls `pass` and then also `reply`.** The reply must still post and count as spoken, and the engagement revert must NOT run (Task 4 test `pass then reply keeps engagement`).
2. **A first-ever mention in a new thread that ends in `pass`.** There is no prior row, so "engaged before" is false and the thread must end disengaged (Task 4 test `first mention + pass leaves thread disengaged`).
3. **`pass` with an unknown emoji name.** A failed reaction must not make the pass fail; the turn still ends silently and the failure is logged (Task 2 test `pass survives a failed reaction`).
4. **The auto-evolve turn ending in neither a reply nor a pass.** That is a valid silent no-op. The stop guard must not fire and no warning may be posted, as today (Task 3 test keeps `dones[1].autoEvolve === true` with no reply).
5. **A turn that ends with neither a reply nor a pass outside auto-evolve.** It still triggers the stop guard once (Task 2 test `stop guard still blocks a silent stop without pass`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/soul/loader.ts` (modify) | `RUNTIME_BASELINE`: new `## How you write` section, reworded KB-first rule, reply-or-pass rule, runtime-check carve-out. |
| `src/tools/contracts/surface.ts` (modify) | `pass` tool contract. |
| `src/gateway/core/surface-mcp.ts` (modify) | `pass` handler (optional reaction, log line, posts nothing). |
| `src/gateway/core/gateway.ts` (modify) | `SessionRoute.passed` / `engagedBefore`; toolCall marks passed; stop guard accepts passed; done reverts engagement after pass. |
| `src/agent/manager.ts` (modify) | `AUTO_EVOLVE_PROMPT` wording + wrapper; `#shouldAutoEvolve` threshold + mutating-tool rule. |
| `src/config/env.ts` (modify) | `autoEvolveMinTools()`. |
| `src/gateway/sim/voice-lint.ts` (create) | `voiceLint(text, opts)` pure check. |
| `src/gateway/sim/transcript.ts` (modify) | `expect_natural_voice` step. |
| `src/gateway/sim/scenarios-real/voice-natural.yaml` (create) | Live-model scenario using it. |
| `tests/soul/runtime-baseline-voice.test.ts` (create) | Baseline text assertions. |
| `tests/gateway/core/surface-pass.test.ts` (create) | `pass` tool + stop guard. |
| `tests/gateway/core/pass-engagement.test.ts` (create) | Engagement revert. |
| `tests/agent/manager-lifecycle.test.ts` (modify) | Auto-evolve threshold + wrapper. |
| `tests/gateway/sim/voice-lint.test.ts` (create) | Lint unit tests. |

---

### Task 1: Writing-style section and reworded KB-first rule

**Files:**
- Modify: `src/soul/loader.ts` (`RUNTIME_BASELINE`, the "Knowledge bases" block and a new section after "Slack formatting")
- Test: `tests/soul/runtime-baseline-voice.test.ts`

**Interfaces:**
- Consumes: `runtimeBaseline(brain: boolean): string` (existing export, `src/soul/loader.ts:353`)
- Produces: baseline text containing the section heading `## How you write`. Task 2 edits the same constant.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { runtimeBaseline } from "../../src/soul/loader";

describe("runtime baseline — voice", () => {
  const b = runtimeBaseline(true);
  it("has a writing-style section", () => expect(b).toContain("## How you write"));
  it("forbids narrating machinery", () => {
    expect(b).toContain("Never narrate machinery");
    expect(b).toMatch(/from my KB/); // named as a forbidden example
  });
  it("KB-first governs action, not wording", () => expect(b).toContain("Do not mention that you checked"));
  it("never repeats a person's stated preferences to others", () =>
    expect(b).toContain("Never repeat what someone told you about how they want to be treated"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/soul/runtime-baseline-voice.test.ts`
Expected: FAIL on every `toContain`.

- [ ] **Step 3: Add the `## How you write` section and reword KB-first**

- Insert `## How you write` after `## Slack formatting` with the bullets of spec §6.1, in this order:
  1. teammate register;
  2. "Never narrate machinery", with the examples "from my KB", tool or skill names, page slugs, "the cron is set";
  3. sources only when they help the reader;
  4. plain-word errors;
  5. a reaction for long tasks;
  6. engage when someone is sharing;
  7. match the reader's register;
  8. "Never repeat what someone told you about how they want to be treated to anyone else; act on it silently" (spec §8.3b).
- In the "Knowledge bases" block, keep the mandate to consult and append: "This rule governs what you do, not what you say. Do not mention that you checked."

- [ ] **Step 4: Run the test and the existing soul tests**

Run: `bun test tests/soul/runtime-baseline-voice.test.ts tests/soul-extract.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Tick the progress line and commit**

Tick "A1" in the epic spec's Progress section.

```bash
git add src/soul/loader.ts tests/soul/runtime-baseline-voice.test.ts docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md
git commit -m "feat(soul): writing-style section; KB-first governs action, not wording"
```

---

### Task 2: `pass` surface tool and reply-or-pass rule

**Files:**
- Modify: `src/tools/contracts/surface.ts` (add `pass` to `surfaceContract.tools`)
- Modify: `src/gateway/core/surface-mcp.ts` (core tool; always mounted)
- Modify: `src/gateway/core/gateway.ts`:
  - `SessionRoute` (around line 191): add `passed?: boolean`;
  - the toolCall user-visible branch (around line 1553);
  - the stop guard (around line 818);
  - every place that resets `spoke = false` (lines ~685, ~2573, ~2593, ~2742, ~2770), which must also reset `passed`.
- Modify: `src/soul/loader.ts` (replace the must-reply bullet)
- Test: `tests/gateway/core/surface-pass.test.ts`

**Interfaces:**
- Consumes: `Surface.react?({ name, ref })`, `surfaceTools(surface, opts)`
- Produces:
  - the contract `pass: { name: "pass", schema: { reason: z.string(), react: z.string().optional() } }`;
  - the tool id `mcp__slaude_surface__pass`;
  - `SessionRoute.passed?: boolean`, which Task 4 reads.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/gateway/core/surface-pass.test.ts
it("pass is always mounted, reacts when asked, posts nothing", async () => {
  const calls: string[] = [];
  const surface = fakeSurface({ react: async ({ name }) => { calls.push(`react:${name}`); }, reply: async () => { calls.push("reply"); return { ref: "r" }; } });
  const pass = surfaceTools(surface).find((d) => d.name === "pass")!;
  const r = await pass.handler({ reason: "talking about me, not to me", react: "eyes" });
  expect(calls).toEqual(["react:eyes"]);
  expect(r.content[0].text).toBe("passed");
});
it("pass survives a failed reaction", async () => {
  const surface = fakeSurface({ react: async () => { throw new Error("invalid_name"); } });
  const r = await surfaceTools(surface).find((d) => d.name === "pass")!.handler({ reason: "x", react: "nope" });
  expect((r as any).isError).toBeUndefined();
  expect(r.content[0].text).toBe("passed (reaction failed)");
});
it("stop guard accepts a pass", async () => { /* gateway-branches pattern: emit toolCall mcp__slaude_surface__pass, expect guard(id) === null */ });
it("stop guard still blocks a silent stop without pass", async () => { /* no reply, no pass → typeof guard(id) === "string" */ });
it("baseline says reply or pass", () => {
  const b = runtimeBaseline(true);
  expect(b).not.toContain("Every user message must result in at least one user-visible Slack tool call");
  expect(b).toContain("mcp__slaude_surface__pass");
});
```
`fakeSurface` builds a `Surface` whose `capabilities` set has `react`, with the given overrides. For the two stop-guard tests, copy the setup from `tests/gateway/core/gateway-branches.test.ts:255` (`makeGw`, `dmArgs`, the `setStopGuard` capture).

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/gateway/core/surface-pass.test.ts`
Expected: FAIL. `pass` is not found and the guard returns a string after the pass.

- [ ] **Step 3: Implement**

- **Contract:**
  - description: "End this turn deliberately WITHOUT replying, when the message isn't for you or needs nothing from you. Optionally react (e.g. `eyes`). Logged. Never use it to dodge a question addressed to you."
  - schema: `reason: z.string().describe("Why you are not replying (logged, never shown).")`, plus `react` as optional.
- **Handler:** if `react` is set and the surface supports it, try `surface.react`. Then return `ok("passed")`, or `ok("passed (reaction failed)")` if the reaction threw. Always `console.log("[pass] reason=" + JSON.stringify(reason))`.
- **Gateway toolCall:** when `e.tool === \`mcp__${SURFACE_MCP_NAME}__pass\``, set `route.passed = true`. Do not set `spoke`, and do not set the working reaction.
- **Stop guard:** `if (route.passed) return null;` placed next to `if (route.spoke) return null;`.
- **Resets:** reset `passed = false` (or omit it on a new route) everywhere `spoke = false` is set.
- **Baseline:** replace "Every user message must result in at least one user-visible Slack tool call before the turn ends." with "Every turn ends in either a reply (`mcp__slaude_surface__reply` / `edit` / `upload`) or an explicit `mcp__slaude_surface__pass`. Pass when a message is about you rather than to you, or needs nothing from you."

- [ ] **Step 4: Run tests**

Run: `bun test tests/gateway/core/surface-pass.test.ts tests/gateway/core/gateway-branches.test.ts tests/gateway/api/v1.test.ts && bun run typecheck`
Expected: PASS. `v1.test.ts` covers the REST tool plane, which picks up `pass` through `surfaceTools()`.

- [ ] **Step 5: Tick "A2" and commit**

```bash
git add src/tools/contracts/surface.ts src/gateway/core/surface-mcp.ts src/gateway/core/gateway.ts src/soul/loader.ts tests/gateway/core/surface-pass.test.ts docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md
git commit -m "feat(surface): explicit pass ends a turn silently; stop guard accepts it"
```

---

### Task 3: Auto-evolve: no announcement, system-tagged, higher bar

**Files:**
- Modify: `src/agent/manager.ts`:
  - `AUTO_EVOLVE_PROMPT` (around line 1673);
  - `#shouldAutoEvolve` (around line 1635);
  - a new `MUTATING_TOOLS` set next to `AUTO_EVOLVE_IGNORE`.
- Modify: `src/config/env.ts` (next to `autoEvolve`, around line 518)
- Modify: `src/soul/loader.ts` ("Skill evolution" block: runtime-check carve-out)
- Test: `tests/agent/manager-lifecycle.test.ts`. Update the fixtures at ~569, ~603, ~640, ~675 and ~1137 to emit enough tools, and add the cases below.

**Interfaces:**
- Produces:
  - `env.autoEvolveMinTools(): number`, which reads `SLAUDE_AUTO_EVOLVE_MIN_TOOLS` with default `4` and falls back to `4` on a non-integer or a value below 1;
  - the prompt text starts with `<runtime-check kind="auto-evolve">` and still contains `<auto-evolve>`, so existing `includes("<auto-evolve>")` checks keep working.

- [ ] **Step 1: Write the failing tests**

```ts
it("does not inject auto-evolve after 3 substantive tools", async () => {
  /* plan(): agent emits tool("Bash"), tool("Write"), tool("Grep"→ignored) … total substantive = 3 */
  await Bun.sleep(60);
  expect(fs.users.length).toBe(1);
});
it("does not inject auto-evolve after 4 read-only external tools (no mutating tool)", async () => {
  /* 4 × tool("WebFetch") */ expect(fs.users.length).toBe(1);
});
it("injects a system-tagged, announcement-free check after 4 substantive incl. a mutating tool", async () => {
  /* tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch") */
  const text = String(fs.users[1].message.content);
  expect(text.startsWith('<runtime-check kind="auto-evolve">')).toBe(true);
  expect(text).not.toContain("mcp__slaude_surface__reply");
  expect(text).not.toContain("saved /");
});
it("SLAUDE_AUTO_EVOLVE_MIN_TOOLS overrides the bar", async () => { /* set "2", Bash+Write → injected */ });
```
Update the existing auto-evolve fixtures so each user turn emits `Bash, Write, WebFetch, WebSearch`. Their assertions are otherwise unchanged, including `dones[1].autoEvolve === true` with the evolve turn ending silently (Review Focus 4).

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/agent/manager-lifecycle.test.ts -t "auto-evolve"`
Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

- `MUTATING_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"])`. Any `mcp__` tool outside the `mcp__slaude_` namespaces also counts as mutating.
- `#shouldAutoEvolve`: keep the existing exclusions. Return true only when `substantive >= env.autoEvolveMinTools()` and at least one counted tool is mutating.
- `AUTO_EVOLVE_PROMPT`:
  - wrap it in `<runtime-check kind="auto-evolve">` … `</runtime-check>`;
  - replace step 4 with "4. Do not tell the user. Skill changes are reported to the manager separately.";
  - replace the "If NO" text with "End the turn immediately: no tool call, no reply, no pass.";
  - add "Only save a procedure that took several steps and that you would plausibly repeat."
- Baseline "Skill evolution" block: add "Messages wrapped in `<runtime-check …>` come from the runtime, not a person. They never require a reply." Replace "reply only if the save is worth the user knowing" with "do not announce skill saves unless the user asked for the skill."
- Update the JSDoc of `env.autoEvolve` to mention the wrapper.

- [ ] **Step 4: Run tests**

Run: `bun test tests/agent/ tests/node/expired-token-exit.test.ts tests/voice/ && bun run typecheck`
Expected: PASS. The voice and node tests depend on `autoEvolve` `done` events.

- [ ] **Step 5: Tick "A3" and commit**

```bash
git add src/agent/manager.ts src/config/env.ts src/soul/loader.ts tests/agent/manager-lifecycle.test.ts docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md
git commit -m "feat(agent): auto-evolve is a silent runtime check with a higher bar"
```

---

### Task 4: A mention that ends in a pass does not re-engage

**Files:**
- Modify: `src/gateway/core/gateway.ts`:
  - `handleMessage(args, dispatch?)` (line ~1750): extend `dispatch` with `engagedBefore?: boolean` and store it on the route;
  - the `mentionsBot` and `mentionedPersona` branches (~3074, ~3089): read the prior value before `persistEngaged(..., true)`;
  - the `done` handler (~1661): revert.
- Test: `tests/gateway/core/pass-engagement.test.ts`

**Interfaces:**
- Consumes: `SessionRoute.passed` (Task 2), `Sessions.findByThread({ team_id, channel_id, thread_ts, persona_id })`, `persistEngaged(teamId, channelId, threadTs, value, personaId)`
- Produces: `SessionRoute.engagedBefore?: boolean`.

- [ ] **Step 1: Write the failing tests**

Use the `makeGw` / `mention` / `msg` helpers from `tests/gateway/core/durable-gates.test.ts:63-91`. Make `agent.sendMessage` emit the stub tool events and then `done` for the session.

```ts
it("first mention + pass leaves thread disengaged", async () => {
  // turn: toolCall mcp__slaude_surface__pass, then done
  await mention(g, thread, "<@USLAUDEBOT> was great at that yesterday");
  await g.emit("message", msg(g.t.client, "plain follow-up", nextTs(), { thread }));
  expect(g.sends.at(-1)).toContain("do NOT reply"); // recorded-suppressed
});
it("mention + reply keeps thread engaged", async () => { /* toolCall reply, done → follow-up dispatched normally (no "do NOT reply") */ });
it("pass then reply keeps engagement", async () => { /* toolCall pass, toolCall reply, done → engaged */ });
it("pass in an already-engaged thread keeps it engaged", async () => { /* mention+reply, then mention+pass → still engaged */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/gateway/core/pass-engagement.test.ts`
Expected: the first case FAILS (the follow-up is dispatched as engaged).

- [ ] **Step 3: Implement**

- In both mention branches:
  - before setting engaged, read `prior = await Sessions.findByThread(...)`;
  - `engagedBefore = !!prior && !!prior.engaged`, so with no row it is `false`;
  - pass `{ engagedBefore }` (and `personaId` where present) to `handleMessage`.
- `handleMessage` copies `dispatch.engagedBefore` onto the route for this turn, at the places where it resets `spoke`.
- In `done`, after the voice, suppress and autoEvolve early returns: if `route.passed && !route.spoke && route.engagedBefore === false`, call `persistEngaged(teamId, channel, threadTs, false, personaId)`. Take `teamId`, the thread and the persona from `route.ctx`.
- Log `[pass] disengage ch=… ts=…`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/gateway/core/pass-engagement.test.ts tests/gateway/core/durable-gates.test.ts tests/gateway/core/multi-app-self.test.ts tests/gateway/core/tombstoned-persona.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Tick "A4" and commit**

```bash
git add src/gateway/core/gateway.ts tests/gateway/core/pass-engagement.test.ts docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md
git commit -m "feat(gateway): a mention that ends in pass does not re-engage the thread"
```

---

### Task 5: Voice lint for sim transcripts

**Files:**
- Create: `src/gateway/sim/voice-lint.ts`
- Modify: `src/gateway/sim/transcript.ts` (next to `expect_reply`, ~line 47)
- Create: `src/gateway/sim/scenarios-real/voice-natural.yaml`
- Test: `tests/gateway/sim/voice-lint.test.ts`

**Interfaces:**
- Produces: `voiceLint(text: string, opts?: { skillTurn?: boolean }): string[]` (the list of rule ids hit: `"machinery-kb"`, `"skill-saved"`, `"skill-mention"`), and a transcript step `expect_natural_voice: {}` that fails when any agent card has hits.

- [ ] **Step 1: Write the failing test**

```ts
expect(voiceLint("From my KB, deploys ship Thursday")).toEqual(["machinery-kb"]);
expect(voiceLint("checked the brain: yes")).toEqual(["machinery-kb"]);
expect(voiceLint("saved /deploy-check")).toEqual(["skill-saved"]);
expect(voiceLint("I saved a skill for this")).toEqual(["skill-mention"]);
expect(voiceLint("I saved a skill for this", { skillTurn: true })).toEqual([]);
expect(voiceLint("Deploys ship every Thursday.")).toEqual([]);
expect(voiceLint("memory usage is at 80%")).toEqual([]); // "memory" alone is fine
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/gateway/sim/voice-lint.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

- `voiceLint`:
  - `machinery-kb` = `/\b(my|the) (KB|brain|memory)\b/i`;
  - `skill-saved` = the literal `saved /`;
  - `skill-mention` = `/\bskill\b/i`, only when `!opts.skillTurn` and `skill-saved` didn't fire.
- `transcript.ts`: the `expect_natural_voice` step collects `voiceLint` hits over `s.cards()` authored by the agent. On any hit it throws `expect_natural_voice failed: <rule> in <text>`.
- `voice-natural.yaml` (layer `trusted`, as `member`), with two sends:
  1. a question answerable from a seeded KB page;
  2. a trivial "list the files in your workspace" request.
  Each is followed by `expect_natural_voice: {}`. This scenario runs only with the live-model sim (`--real`).

- [ ] **Step 4: Run tests**

Run: `bun test tests/gateway/sim/ && bun run typecheck`
Expected: PASS. The existing stub scenarios are unaffected because none uses the new step.

- [ ] **Step 5: Tick "A5" and commit**

```bash
git add src/gateway/sim/voice-lint.ts src/gateway/sim/transcript.ts src/gateway/sim/scenarios-real/voice-natural.yaml tests/gateway/sim/voice-lint.test.ts docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md
git commit -m "test(sim): voice lint and a live natural-voice scenario"
```

---

### Task 6: Field note, full suite, phase close-out

**Files:**
- Create: `docs/site/_content/field-notes/2026-10-25-natural-voice-and-pass.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)
- Modify: the epic spec's Progress section (mark Phase A done, add the release tag once cut)

- [ ] **Step 1: Write the field note**

- **Mechanism:** a general must-reply rule plus a check delivered as a user message overrode the check's "stay silent". That conflict is why no-op skill checks posted, and why a mention *about* the agent re-engaged it.
- **The fix:** `pass`, the `<runtime-check>` wrapper, and the engagement revert.
- **What is not verified:** live-model behaviour beyond the sim scenario.
- Generic placeholders only.

- [ ] **Step 2: Index it in `CLAUDE.md`'s Findings Log, at the top**

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: 0 failures, no type errors.

- [ ] **Step 4: Mark Phase A done in the epic Progress section and commit**

```bash
git add docs/site/_content/field-notes/2026-10-25-natural-voice-and-pass.md CLAUDE.md docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md
git commit -m "docs: phase A field note; mark phase A done in the epic"
```
