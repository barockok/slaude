# Phase R — Runtime Prompt as Built-in Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the runtime system prompt out of TypeScript strings into read-only files shipped with the release. These are a small always-on core, runtime-injected state modules, and built-in `slaude:` skills that the core names explicitly. A hook blocks any tool a built-in skill governs until that skill has been loaded in the session. Phase R adds no new rules.

**Architecture:**
- `src/soul/runtime/` holds markdown files (`core.md`, `modules/*.md`) and a small loader that renders them with `{{NAME}}` substitution.
- `src/soul/builtin/` is a read-only Claude Code plugin named `slaude`. The agent manager mounts it next to the existing `~/.slaude` plugin, so its skills appear as `slaude:<name>`.
- Each built-in `SKILL.md` declares, in its frontmatter, the tools it governs and its trigger. The loader builds the core's skill index from that frontmatter, and a PreToolUse/PostToolUse hook pair enforces loading.
- The first built-in skill is `slaude:skill-authoring`. It holds the baseline's current "Skill evolution" section, moved verbatim.

**Tech Stack:** Bun + TypeScript, `bun test`, `@anthropic-ai/claude-agent-sdk` hooks (`PreToolUse`, `PostToolUse`), Claude Code local plugins.

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §7a (Phase R), with §2 rows "Growing system prompt", "How the model finds a built-in skill", "Enforcement for tool-bound built-in skills" and "Can built-ins change at runtime?", and §11.2 invariants 7–9.

## Global Constraints

- **Public repo:** generic placeholders only. Run the leak-scan grep over `git diff --cached -U0` before every commit. No `Co-Authored-By` or "Generated with" trailers; never commit under an AI identity.
- **Ships as an RC** (agent loop and system prompt change): `vX.Y.Z-rc.N`. Release work is out of scope here.
- **No new rules (spec §7a.2).** For every state, the rendered prompt equals today's text, with exactly two exceptions: the "Skill evolution" section moves verbatim into `slaude:skill-authoring`, and a skill index takes its place. Golden tests prove it.
- **Every-turn rules stay always-on (invariant 7).** Output discipline, reply-or-pass, approval discipline, channel trust, harness overrides, the voice rules and the KB-first rule remain in `core.md`. Only procedures move into skills.
- **Skill tool contract** (verified in the bundled CLI): the tool is named `Skill`, and its input is `{ skill: string, args?: string }`. Plugin skills are named `plugin:skill`. The plugin name comes from `.claude-plugin/plugin.json` `name`, which is `"slaude"`.
- **Shipping:** `scripts/package-release.sh` and the `Dockerfile` copy `src/` whole, so files under `src/soul/runtime/` and `src/soul/builtin/` ship with no change to the dist layout. Locate them with `import.meta.dir`, never with `$SLAUDE_HOME` or the cwd.
- **Built-in frontmatter** (exact keys):
  - `name`: the bare name, without the `slaude:` prefix;
  - `description`;
  - `trigger`: one line, rendered into the index;
  - `governs`: a list of full tool names; may be empty;
  - `version`: from `package.json` at load time, written as the literal `{{SLAUDE_VERSION}}` in the file.
- **Enforcement (invariant 8):**
  - A governed tool is blocked until the session has loaded its skill. "Loaded" means a `PostToolUse` of `Skill` with `skill === "slaude:<name>"` that did not error.
  - The loaded set is kept per session id and cleared whenever the manager starts or reboots that session.
  - Block reason (exact): ``Load `slaude:<name>` first (call the Skill tool with skill "slaude:<name>"), then retry.``
  - `<runtime-check>` turns are not exempt.
- **Immutability (invariant 9):** `write_skill` and `delete_skill` refuse any slug equal to a built-in's bare name, for both the base skills root and a persona overlay. Error (exact): `` `<slug>` is a built-in skill and cannot be changed at runtime ``.
- **Progress:** each task's commit ticks its R<n> line under "Progress → Phase R tasks" in the epic spec.

## Review Focus

1. **A session already running when this release boots** has no built-in plugin mounted until its next boot. The hook must not block governed tools for a session whose boot options did not include the built-in plugin. Task 3 test: `no plugin mounted → no enforcement`.
2. **The `Skill` call fails** (unknown name, or a tool error). That must not count as loaded. Task 3 test: `failed Skill call does not mark loaded`.
3. **A remote session already has a PreToolUse hook** (`denyLocalBuiltins`). Both hooks must run: composing them must neither drop the remote deny nor skip enforcement. Task 3 test: `remote deny and skill gate both apply`.
4. **The auto-evolve check** calls `write_skill` in a `<runtime-check>` turn. With enforcement on and the skill not yet loaded, the block reason must tell the model exactly how to proceed, and a follow-up `write_skill` after the `Skill` call must succeed. Task 3 test: `evolve turn: blocked, load, then write succeeds`.
5. **Snapshot drift:** a later edit to `core.md` must fail the golden test loudly, naming the differing section, rather than silently changing the prompt. Task 1 test asserts the full string, with a readable diff on failure.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/soul/runtime/core.md` (create) | Today's `RUNTIME_BASELINE` text, minus the Skill evolution section, plus a `{{SKILL_INDEX}}` placeholder where that section was. Keeps the `{{KB_FALLBACK}}`/`{{KB_READ}}`/`{{KB_TOOLS}}` placeholders. |
| `src/soul/runtime/modules/one-on-one-locked.md`, `one-on-one-open.md`, `remote.md` (create) | Today's `sessionModeBlock` texts with `{{…}}` variables. |
| `src/soul/runtime/render.ts` (create) | `renderRuntimeFile(rel, vars)`: reads once, caches, substitutes, and throws on an unknown or missing variable. |
| `src/soul/builtin/.claude-plugin/plugin.json` (create) | `{ "name": "slaude", "description": "slaude built-in skills (read-only, shipped with the release)" }`. |
| `src/soul/builtin/skills/skill-authoring/SKILL.md` (create) | The moved Skill evolution section, plus frontmatter. |
| `src/soul/builtin/index.ts` (create) | `BUILTIN_PLUGIN_DIR`, `listBuiltinSkills()`, `builtinGoverning(tool)`, `isBuiltinSkillName(slug)`, `renderSkillIndex()`. |
| `src/agent/skill-gate.ts` (create) | The enforcement hook pair and the per-session loaded set. |
| `src/soul/loader.ts`, `src/agent/session-mode.ts`, `src/agent/manager.ts`, `src/skills/mcp-tools.ts` (modify) | Wiring. |
| `tests/soul/runtime-golden.test.ts`, `tests/soul/builtin.test.ts`, `tests/agent/skill-gate.test.ts`, `tests/skills/builtin-immutable.test.ts` (create) | Tests. |

---

### Task 1: Prompt text into files, byte-identical

**Files:**
- Create: `src/soul/runtime/core.md` (full baseline including the Skill evolution section **for now**), `src/soul/runtime/modules/{one-on-one-locked,one-on-one-open,remote}.md`, `src/soul/runtime/render.ts`, `tests/soul/runtime-golden.test.ts`, `tests/soul/__golden__/*.txt`
- Modify: `src/soul/loader.ts` (`RUNTIME_BASELINE` becomes the rendered `core.md`), `src/agent/session-mode.ts` (`lockBlock` and `remoteBlock` render modules)

**Interfaces:**
- Produces: `renderRuntimeFile(rel: string, vars: Record<string, string>): string`. Unknown `{{X}}` in a file, or a var never used, throws `RuntimeTemplateError` naming the file and the variable. `runtimeBaseline(brain)` and `sessionModeBlock(lock, remote)` keep their signatures and outputs.

- [ ] **Step 1: Capture the goldens from today's code, before any change.** Write a one-off script, `bun run scripts/capture-runtime-goldens.ts` (delete it before committing), that writes `tests/soul/__golden__/`:
  - `baseline-brain.txt` = `runtimeBaseline(true)`;
  - `baseline-nobrain.txt` = `runtimeBaseline(false)`;
  - `mode-locked.txt`, `mode-open-scope.txt`, `mode-open-noscope.txt`, `mode-remote-personal.txt`, `mode-remote-provisioned.txt` and `mode-locked-remote.txt` = `sessionModeBlock(...)` for fixed placeholder inputs (user `U0TESTUSR`, env `dev-box`, kind `ssh`/`sandbox`, dir `/work`).
  Commit the goldens in this task's commit.
- [ ] **Step 2: Write the golden test.** For each golden, assert `expect(actual).toBe(readFileSync(golden))`. On mismatch, the message names the first differing line number. Run `bun test tests/soul/runtime-golden.test.ts`. Expected: PASS (it guards the refactor).
- [ ] **Step 3: Move the text.**
  - Copy the template-literal contents into `core.md`, unescaping the backtick escapes so the rendered output is identical.
  - Move the session-mode strings into modules with `{{LOCKED_USER}}`, `{{SCOPE_LINE}}`, `{{WHERE}}` and so on. Conditional pieces are computed in TS and passed in as vars.
  - `render.ts` reads with `readFileSync(join(import.meta.dir, rel))`.
- [ ] **Step 4: Run the golden test, the soul tests and typecheck.** `bun test tests/soul/ tests/soul-extract.test.ts tests/agent/node-session-mode.test.ts && bun run typecheck`. Expected: PASS, byte-identical.
- [ ] **Step 5: Tick R1 and commit.** Message: `refactor(soul): runtime prompt text lives in files, byte-identical`.

---

### Task 2: The built-in plugin, the first built-in skill, and the skill index

**Files:**
- Create: `src/soul/builtin/.claude-plugin/plugin.json`, `src/soul/builtin/skills/skill-authoring/SKILL.md`, `src/soul/builtin/index.ts`, `tests/soul/builtin.test.ts`
- Modify:
  - `src/soul/runtime/core.md`: remove the Skill evolution section and put `{{SKILL_INDEX}}` in its place;
  - `src/soul/loader.ts`: supply `SKILL_INDEX`;
  - `src/agent/manager.ts`: add `{ type: "local", path: BUILTIN_PLUGIN_DIR, skipMcpDiscovery: true }` to `allPlugins`, next to `slaudeHomePlugin`;
  - the goldens: regenerate `baseline-*.txt`; the test now checks the two allowed differences below.

**Interfaces:**
- Produces:
```ts
export const BUILTIN_PLUGIN_DIR: string;                  // join(import.meta.dir) — src/soul/builtin
export interface BuiltinSkill { name: string; qualified: string /* "slaude:<name>" */; description: string; trigger: string; governs: string[]; body: string }
export function listBuiltinSkills(): BuiltinSkill[];      // sorted by name; parsed once
export function builtinGoverning(tool: string): BuiltinSkill | null;
export function isBuiltinSkillName(slug: string): boolean;
export function renderSkillIndex(): string;               // "" when there are no built-ins
```
- `slaude:skill-authoring` frontmatter:
  - `name: skill-authoring`
  - `description: How to create, refine and retire your own skills.`
  - `trigger: Before write_skill or delete_skill`
  - `governs: [mcp__slaude_skills__write_skill, mcp__slaude_skills__delete_skill]`
  - `version: {{SLAUDE_VERSION}}`
- The body is today's "## Skill evolution (grow over time)" section, verbatim. `${SLAUDE_SKILL_ARGS}` and the other variables stay literal.
- Index format, exact, placed where the section was:
```
## Built-in skills (read-only, shipped with slaude)
Load the named skill with the Skill tool before the matching action; the runtime blocks the action until you do.
- Before write_skill or delete_skill → load `slaude:skill-authoring`
```

- [ ] **Step 1: Write the failing tests.**

```ts
it("lists skill-authoring with its governed tools", () => {
  const s = listBuiltinSkills();
  expect(s.map((x) => x.qualified)).toEqual(["slaude:skill-authoring"]);
  expect(builtinGoverning("mcp__slaude_skills__write_skill")?.name).toBe("skill-authoring");
  expect(builtinGoverning("Read")).toBeNull();
});
it("skill body is the pre-R Skill evolution section verbatim", () => {
  /* extract "## Skill evolution" … up to the next "## " heading from the Task 1 golden at git rev R1 (committed file
     tests/soul/__golden__/skill-evolution-section.txt, captured in this task's Step 1 before editing core.md) */
});
it("baseline = pre-R golden with the section replaced by the index", () => {
  /* golden.replace(section, renderSkillIndex()) === runtimeBaseline(true); same for false */
});
it("index lists exactly the built-ins present", ...);
it("plugin.json names the plugin slaude", ...);
it("manager mounts the built-in plugin", async () => { /* __systemPromptForTests is not enough: spy on the options the manager passes to the SDK (pattern in tests/agent/manager-lifecycle.test.ts) and assert plugins include BUILTIN_PLUGIN_DIR */ });
```

- [ ] **Step 2: Run them and confirm they fail.** Before editing `core.md`, capture `skill-evolution-section.txt` from the current golden. Then `bun test tests/soul/builtin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Parse the frontmatter with the same `yaml` parser `src/skills/loader.ts` uses.
  - `{{SLAUDE_VERSION}}` comes from `package.json` `version`, read once.
  - The plugin directory is **read-only by convention**: nothing in slaude writes to it.
- [ ] **Step 4: Run the tests.** `bun test tests/soul/ tests/agent/manager-lifecycle.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick R2 and commit.** Message: `feat(soul): built-in slaude plugin; skill authoring moves into slaude:skill-authoring`.

---

### Task 3: Enforcement hook

**Files:**
- Create: `src/agent/skill-gate.ts`, `tests/agent/skill-gate.test.ts`
- Modify:
  - `src/agent/manager.ts`: the hook setup (around line 1226) composes `PreToolUse: [denyLocalBuiltins? , skillGatePre]` and adds `PostToolUse: [skillGatePost]`;
  - every place a session (re)boots: call `skillGate.reset(sessionId)`;
  - `AUTO_EVOLVE_PROMPT`: step 1 becomes "Load `slaude:skill-authoring` with the Skill tool (skip if already loaded this session), then call `mcp__slaude_skills__list_skills`…". This is the one wording change, needed so the evolve turn isn't blocked.

**Interfaces:**
- Consumes: `builtinGoverning`, `BUILTIN_PLUGIN_DIR` (Task 2).
- Produces:
```ts
export class SkillGate {
  reset(sessionId: string): void;
  markMounted(sessionId: string, mounted: boolean): void;   // set at boot from whether BUILTIN_PLUGIN_DIR was in the plugins
  pre(sessionId: string): HookCallback;                      // PreToolUse: governed & mounted & !loaded → { decision: "block", reason }
  post(sessionId: string): HookCallback;                     // PostToolUse on Skill with skill "slaude:<n>" and no error → loaded
  isLoaded(sessionId: string, qualified: string): boolean;
}
```
- `pre` and `post` must read the hook input's `tool_name` and `tool_input` fields as the SDK passes them; follow the existing `denyLocalBuiltins` hook for the input shape. The success signal for `post` is the absence of an error in `tool_response`. Handle both a string response and an object with `is_error`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("blocks a governed tool until its skill is loaded, then allows it", ...);   // reason equals the exact Global Constraints string
it("non-governed tools are never blocked", ...);
it("failed Skill call does not mark loaded", ...);
it("reset (reboot) requires loading again", ...);
it("no plugin mounted → no enforcement", ...);
it("remote deny and skill gate both apply", ...);   // manager options with a remote handle carry both PreToolUse hooks
it("evolve turn: blocked, load, then write succeeds", ...);   // manager-level, using the lifecycle test's fake SDK stream
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/agent/skill-gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the per-session state in a `Map` in the manager-owned `SkillGate` instance. Delete the session's entry when the live session ends, so the map cannot grow without bound.
- [ ] **Step 4: Run the agent tests.** `bun test tests/agent/ tests/node/ tests/voice/ && bun run typecheck`. Expected: PASS, except the known environment-only failures.
- [ ] **Step 5: Tick R3 and commit.** Message: `feat(agent): block governed tools until their built-in skill is loaded`.

---

### Task 4: Built-ins are immutable at runtime

**Files:**
- Modify: `src/skills/mcp-tools.ts` (`write_skill`, `delete_skill` and the `skillOps` they use)
- Test: `tests/skills/builtin-immutable.test.ts`

**Interfaces:**
- Consumes: `isBuiltinSkillName` (Task 2).

- [ ] **Step 1: Write the failing tests.**

```ts
it("write_skill refuses a built-in name", ...);        // slug "skill-authoring" → error text exactly per Global Constraints; nothing written
it("delete_skill refuses a built-in name", ...);
it("persona overlay cannot shadow a built-in", ...);   // personaName set → same refusal
it("other slugs still work", ...);
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test tests/skills/builtin-immutable.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check right after slug validation, before any filesystem access.
- [ ] **Step 4: Run the skill tests.** `bun test tests/skills/ tests/skills-layout.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Tick R4 and commit.** Message: `feat(skills): built-in skills cannot be written, shadowed or deleted at runtime`.

---

### Task 5: Size budget, field note, close-out

**Files:**
- Create: `docs/site/_content/field-notes/2026-10-25-builtin-skills.md`
- Modify: `tests/soul/runtime-golden.test.ts` (size budget), `CLAUDE.md` (Findings Log), the epic spec Progress section

- [ ] **Step 1: Add the core size budget.** The rendered `runtimeBaseline(true)` must be ≤ its R2 length plus 5% (record the number in the test as a constant with a comment). The test message: "core grew past its budget — move procedures into a built-in skill".
- [ ] **Step 2: Write the field note.**
  - **Mechanism:** the three tiers, the skill index named by the core, the hook pair, immutability, and shipping under `src/`.
  - **What moved:** only the Skill evolution section.
  - **Decision:** state modules are templated files rendered by TS builders, which keep the conditional logic.
  - **Not verified:** a live CLI run showing `slaude:skill-authoring` in the skills list and the hook blocking a real `write_skill`; whether a session booted before the upgrade behaves until its next reboot.
- [ ] **Step 3: Index it in `CLAUDE.md`.**
- [ ] **Step 4: Run the full suite and typecheck.** `bun test && bun run typecheck`. Expected: only the known environment-only failures (gbrain module missing, kubectl, proxy, hook-template and voice-spawn tests). Check any other failure on the base commit.
- [ ] **Step 5: Mark Phase R done and commit.** Tick R5 and set Phase R to "done (unreleased — ships as RC)". Message: `docs: phase R field note; mark phase R done in the epic`.
