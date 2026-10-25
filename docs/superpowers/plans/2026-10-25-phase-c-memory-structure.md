# Phase C: Memory Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent typed, person-safe memory: a person-owned `profile` source shared by every agent in a workspace, typed `kb_memoize` pages with an audit trail, a per-turn core memory context, a "what do you know about me" view, and a readable thread history.

**Architecture:**
- **Profile source.** A new brain source `profile-<team>-<user>` joins the scope resolver (`src/knowledge/scope.ts`). It is read on every turn whose speaker is that person and written only from that person's own interactive turn.
- **Typed `kb_memoize`.** The handler composes frontmatter from typed fields and validates them against a table. A built-in skill, `slaude:memory`, carries the page-type procedure, and the phase R gate enforces loading it before `kb_memoize` runs.
- **Turn memory block.** The gateway builds a bounded `<memory-context>` block for each turn from the turn's own read scope and puts it inside the turn envelope. Nodes and mono both receive it unchanged.

**Tech Stack:** Bun + TypeScript, `bun test`, zod contracts (`src/tools/contracts/`), gbrain ops via `call(op, params, scope)`, the fake brain at `tests/memory/fake-brain.ts`.

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §8 (plus §11.2 invariants 1, 2, 7, 8). Read §8 in full before starting any task.

## Global Constraints

- **Public repo.** Use placeholder people, channels and teams only (`U0ALICE`-style ids are fine in tests, as in existing tests). No trailers or AI authorship in commits. Run the CLAUDE.md leak scan before every commit.
- **Profile source id.**
  - Format: `profile-` + `sourceSafe(teamId)` with dashes removed + `-` + `sourceSafe(userId)` with dashes removed.
  - When that is longer than 32 chars, use `profile-` + the first 24 hex chars of `sha256(teamId + ":" + userId)` instead.
  - gbrain ids must match `[a-z0-9-]{1,32}`.
  - It must never equal any `user-`, `agent-`, `kb-`, `shared` or `public` id.
- **Page types**, exact strings: `profile`, `person-note`, `commitment`, `investigation`, `correction`, `outcome`, `lessons`, `heartbeat`, `team-fact`.
- **Common frontmatter keys**, exact: `type`, `as_of` (YYYY-MM-DD), `source`, `confidence` (`told` | `inferred`), `supersedes` (optional slug). A superseded page gets `superseded_by: <slug>`.
- **Commitment frontmatter:** `promiser`, `beneficiary`, `thread` (`<channel>:<threadTs>`), `due`, `check`, `on_no_change` (`close-in-one-line` | `silent`), `status` (`open` | `done` | `dropped`).
- **Invariant 1.** Nothing written during a /1on1 reaches another person's turn, a channel, `agent-<id>` or `shared` without that person's approval.
- **Invariant 2.** A profile is written only from that person's own words, on their own interactive turn. Cron and background turns never write a profile.
- **Invariant 7.** Every-turn rules (live capture, never repeat a profile, never record secrets) live in `src/soul/runtime/core.md`, not only in the skill.
- **Per-turn context limit:** 8000 chars total (about 2k tokens). Truncate by recency. Leave the block out when it would be empty.
- **Non-goals:** no new embedding or engine, no LLM calls in this phase (summaries belong to phase D), no SOUL edits.

## Review Focus

1. **Long Slack ids.** A team or user id long enough to pass 32 chars must hash. Two different (team, user) pairs must never get the same profile id. Pinned in Task 1.
2. **A cron turn created by the person** (cron sets `userId = createdBy`) must not write that person's profile. Pinned in Task 2.
3. **The speaker in someone else's locked thread** reads only their own profile, never the lock owner's, and can still correct their own profile there (spec §8.3: "from any thread"). Pinned in Tasks 1 and 2.
4. **A `supersedes` that names a slug in another source, or no page at all,** is refused and nothing is written. Pinned in Task 2.
5. **A slow or failing brain while building the per-turn block** never delays the turn past 1500 ms and never fails it. The turn runs without the block. Pinned in Task 5.

---

### Task 1: Profile source in the scope model

**Files:**
- Modify: `src/knowledge/scope.ts`
- Modify: `src/knowledge/gated-dispatch.ts`, where `GateInput` gains `teamId` and `interactive`.
- Modify: `src/gateway/core/gateway.ts`, at `brainGateFor` (about line 906) and `slackCtx` (about line 3565). Mono takes `ctx.teamId`; nodes take `claims.team`.
- Modify: the source-prefix checks in `src/brain-migrate/remap.ts:19-25`, `src/brain-migrate/client.ts:29`, `src/brain-migrate/export.ts:17` and `src/gateway/brain-import/api.ts:178`. Treat `profile-` exactly like `user-`: a person's source passes through unchanged.
- Test: `tests/brain-scope.test.ts`, `tests/brain-migrate/*` (whichever covers remap), `tests/gateway/core/mono-memory-scope.test.ts`

**Interfaces:**
- Produces:
  - `export function profileSourceId(teamId: string, userId: string): string`
  - `export const PROFILE_PREFIX = "profile-"`
  - `ScopeInput.teamId: string | null`
  - `BrainScope.profileSource?: string`, the speaker's profile id when it is in `allowedSources`.
  - `GateInput.teamId: string | null`
  - `GateInput.interactive: boolean`, which is true only for a turn started by a human Slack message (or the panel).

- [ ] **Step 1: Write failing tests** in `tests/brain-scope.test.ts`:
  - `profileSourceId("T0TEAM", "U0ALICE") === "profile-t0team-u0alice"`.
  - With a 20-char team id and a 20-char user id, the result has length 32 or less, starts with `profile-`, matches `/^profile-[0-9a-f]{24}$/`, and differs when either input changes.
  - `profileSourceId(t, u) !== userSourceId(u)`.
  - New `describe("resolveBrainScope profile rows")`, one case per §4.4 row. Each asserts that `allowedSources` contains `profileSourceId(team, speaker)` exactly when `userId` and `teamId` are both non-null, and that `profileSource` is set to it. The rows:
    - trusted channel
    - manager
    - own /1on1
    - someone else's /1on1, non-manager: reads `[PUBLIC_SOURCE, speakerProfile]` and never `profileSourceId(team, lockOwner)`
    - someone else's /1on1, manager
    - public channel
    - `userId` null: no profile
    - `teamId` null: no profile
  - The write target `sourceId` is unchanged in every row.
- [ ] **Step 2:** Run `bun test tests/brain-scope.test.ts`. Expect it to FAIL: `profileSourceId` is not exported.
- [ ] **Step 3:** Implement. Add the speaker's profile to every non-null-speaker row's `allowedSources`, right after the row's own sources. Thread `teamId` and `interactive` through `brainGateFor` and `slackCtx`:
  - Mono: interactive comes from the route's origin.
  - Nodes: interactive comes from a new signed claim `origin: "cron" | "slack" | "panel"`, set at dispatch from the cron path (`gateway.ts` about line 700, where `userId: job.createdBy`).
  - A missing claim reads as non-interactive (fail closed).
  - Add `origin` wherever `JobClaims` is built and verified (`src/gateway/api/auth.ts:25`).
- [ ] **Step 4:** Add the migration prefix cases. Add a test that a `profile-…` source survives `remapSource` and `allowedTarget` unchanged.
- [ ] **Step 5:** Run `bun test tests/brain-scope.test.ts tests/brain-migrate tests/gateway/core/mono-memory-scope.test.ts tests/gateway/api` and `bun run typecheck`. Expect both to PASS.
- [ ] **Step 6: Commit** `feat(brain): person-owned profile source in every speaker's read scope`

### Task 2: Typed `kb_memoize`, profile target, supersede, containment

**Files:**
- Modify: `src/tools/contracts/kb.ts:52-71`, the `kb_memoize` schema.
- Modify: `src/knowledge/mcp-tools.ts:266`, the handler.
- Create: `src/knowledge/memory-pages.ts`, which composes and validates frontmatter. It is pure, with no I/O.
- Modify: `src/knowledge/gated-dispatch.ts`, the `classifyBrainOp` profile and lock branches.
- Test: create `tests/knowledge/memory-pages.test.ts` and `tests/knowledge/kb-memoize-typed.test.ts`; extend `tests/brain-gate.test.ts`.

**Interfaces:**
- Consumes (from Task 1): `profileSourceId`, `BrainScope.profileSource`, `GateInput.teamId` and `GateInput.interactive`.
- Produces:
  - Schema additions on each page: `type?: PageType`, `confidence?: "told" | "inferred"`, `source?: string`, `supersedes?: string`, `fields?: Record<string,string>` (type-specific keys, e.g. the commitment keys).
  - `target` becomes `z.enum(["mine","shared","profile"]).optional()`. A top-level `subject?: string` (Slack user id) is added.
  - `export type PageType = "profile" | "person-note" | "commitment" | "investigation" | "correction" | "outcome" | "lessons" | "heartbeat" | "team-fact"`
  - `export function composePage(p: TypedPageInput, now: Date): { content: string } | { error: string }`
  - `export function parseFrontmatter(content: string): { meta: Record<string,string>; body: string }`
  - `export function markSuperseded(oldContent: string, bySlug: string): string`
  - `export const PAGE_TYPES: readonly PageType[]`

- [ ] **Step 1: Write failing tests** in `tests/knowledge/memory-pages.test.ts`. `composePage` must:
  - Put `type`, `as_of` (from `now`, YYYY-MM-DD) and `confidence` first, then `source`, `supersedes` and `fields`, in that order, then the body.
  - Error on each of these:
    - `profile` with `confidence: "inferred"`
    - `person-note` with `confidence: "told"`
    - `commitment` missing `status` or `beneficiary`
    - `on_no_change` outside `close-in-one-line|silent`
    - an unknown type
    - content that `redactSecrets` (`src/gateway/core/status-text.ts:52`) changes, with error text `refused: page contains a credential-like value`
  - Content without `type` passes through unchanged, so old untyped calls keep working.
  - `parseFrontmatter` round-trips `composePage`.
  - `markSuperseded` adds `superseded_by` and keeps the body.
- [ ] **Step 2: Write failing handler tests** in `tests/knowledge/kb-memoize-typed.test.ts`, using `tests/memory/fake-brain.ts` and the existing handler test setup in `tests/` for kb tools.
  - `target:"profile"` on an interactive turn writes to the speaker's `profileSource` with slug `profile` and needs no card.
  - The same call is refused in these cases:
    - a cron turn (`interactive:false`): `refused: a profile is written only on that person's own turn`
    - `subject` ≠ speaker: same text
    - `teamId` null
  - `target:"profile"` in someone else's /1on1 by the speaker writes the speaker's profile. It never writes the lock owner's.
  - `supersedes:"x"`:
    - when `x` exists in the write source: the new page is written, then `x` is rewritten via `markSuperseded`
    - when `x` is missing in the write source, or exists only in another readable source: `refused: supersedes must name a page in the same memory`, and no write
  - In a /1on1 (own lock), `target:"shared"` is refused. Error: `refused: in a /1on1, memory stays with this person; ask them before sharing it`. Today it cards to the managers, which skips the person.
  - In a /1on1, `target:"mine"` still lands in `user-<id>`.
- [ ] **Step 3:** Extend `tests/brain-gate.test.ts` for `classifyBrainOp`:
  - `put_page` into `profileSourceId(team, user)` → `auto` when `interactive && userId === user`.
  - The same → `deny` when `!interactive`.
  - Writing into another person's profile id → `deny`.
- [ ] **Step 4:** Run the three test files. Expect them to FAIL.
- [ ] **Step 5:** Implement `memory-pages.ts`. Then the handler: resolve the target, run `composePage` per page, run the supersede check (`get_page` in the write source) before any write, then `put_page`, then rewrite the superseded page. Add the `classifyBrainOp` profile branch (above the shared branch) and the lock refusal. Update the `kb_memoize` description text in the contract to name `type` and `target:"profile"` in one sentence each.
- [ ] **Step 6:** Run `bun test tests/knowledge tests/brain-gate.test.ts tests/gateway/api/kb-scope.test.ts` and `bun run typecheck`. Expect PASS.
- [ ] **Step 7: Commit** `feat(brain): typed kb_memoize pages, profile target, supersede trail, /1on1 containment`

### Task 3: `slaude:memory` built-in skill and every-turn rules in the core

**Files:**
- Create: `src/soul/builtin/skills/memory/SKILL.md`
- Modify: `src/soul/runtime/core.md`, the Knowledge bases section (about line 90).
- Modify: `tests/soul/builtin.test.ts:72`. The pinned list becomes `["slaude:memory", "slaude:skill-authoring"]`, in sorted order.
- Modify: `tests/soul/__golden__/*` and `tests/soul/runtime-golden.test.ts:59`. Re-pin `BUDGET` to the new core size and say why in a comment.
- Test: `tests/agent/skill-gate.test.ts`, which gets one case: `mcp__slaude_kb__kb_memoize` is denied until `slaude:memory` has loaded.

**Interfaces:**
- Consumes: phase R's `listBuiltinSkills`, `renderSkillIndex` and `SkillGate` (no change).
- Produces: built-in skill `slaude:memory` with frontmatter:
  - `trigger: Before kb_memoize`
  - `governs: [mcp__slaude_kb__kb_memoize]`
  - `version: "{{SLAUDE_VERSION}}"`

- [ ] **Step 1:** Write the failing test in `skill-gate.test.ts` and update the pinned list in `builtin.test.ts`. Add a test in `tests/soul/runtime-golden.test.ts` that the rendered core contains the never-repeat rule (spec §8.3b says phase C adds this test). Run them. Expect FAIL.
- [ ] **Step 2: Write `SKILL.md`.** The body covers:
  - the page-type table from spec §8.2 (where each lives as `target` + slug: `people/<userId>`, `commitments/<short-slug>`, `investigations/<slug>`, `self/lessons`, `self/heartbeat`, `shared/people/<userId>`, `shared/services/<name>`);
  - the commitment fields;
  - told vs inferred, which never share an entry;
  - the supersede procedure (write the new page with `supersedes`, never edit the old one);
  - /1on1 containment;
  - the "what do you know about me" flow (call `memory_about`, list each entry labelled told or inferred, with dates, and offer to correct or delete own-profile entries);
  - the never-record list from §8.3.

  No incident specifics. Keep it under 120 lines.
- [ ] **Step 3: Add these bullets to `core.md`'s Knowledge bases section** (they apply every turn, per invariant 7):
  - When you promise something, a person corrects you, or someone tells you how they want to be treated, save it before the turn ends. Load `slaude:memory` first.
  - Act on what a person's profile says, but never repeat it, or anything you noted about them, to someone else.
  - Never save credentials, government ids, payment data, health details, performance judgements or private life.

  The skill index line comes from the generated index, so don't hand-write it.
- [ ] **Step 4:** Regenerate the goldens with the project's golden update path (see `tests/soul/runtime-golden.test.ts`). Re-pin `BUDGET`. Run `bun test tests/soul tests/agent/skill-gate.test.ts` and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(soul): slaude:memory built-in skill; every-turn memory rules in the core`

### Task 4: `memory_about` tool

**Files:**
- Modify: `src/tools/contracts/kb.ts`, adding `memory_about: { userId: string }`.
- Modify: `src/knowledge/mcp-tools.ts`, adding the handler.
- Modify: `src/soul/loader.ts:168`, so the brain tool list includes it.
- Test: `tests/knowledge/memory-about.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` (Task 2), `BrainScope.profileSource` (Task 1).
- Produces:
  - tool `mcp__slaude_kb__memory_about({ userId })`
  - `export function formatMemoryAbout(entries: MemoryEntry[]): string`
  - `interface MemoryEntry { where: "profile" | "agent" | "user" | "shared"; slug: string; type: string; confidence: string; as_of: string; body: string }`

- [ ] **Step 1: Write failing tests.**
  - When `userId` equals the speaker, the result includes:
    - the profile page
    - `people/<userId>` from each readable source in the turn's `allowedSources` (agent slice; own `user-` slice only in their own /1on1)
    - `shared/people/<userId>`
  - Each entry is labelled `told` or `inferred` and carries `as_of`.
  - Superseded pages are left out.
  - `userId` ≠ speaker → `refused: memory_about only answers for the person asking`.
  - In a channel turn, a note written into `user-<id>` during that user's /1on1 is NOT included.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement using `get_page` per candidate slug within `allowedSources` only, so no new read path bypasses the scope.
- [ ] **Step 4:** Run `bun test tests/knowledge/memory-about.test.ts tests/soul` and typecheck. Expect PASS. If the loader's tool list feeds the goldens, regenerate them and re-check the size budget.
- [ ] **Step 5: Commit** `feat(brain): memory_about shows a person what the agent holds about them`

### Task 5: Per-turn `<memory-context>` in the turn envelope

**Files:**
- Create: `src/memory/turn-context.ts`
- Modify: `src/gateway/core/gateway.ts`, at the Slack envelope (about line 2757). Insert the block after `</channel>` and before the reply instruction. Skip it when `suppress` is set. The panel envelope (about line 3660) stays unchanged.
- Test: `tests/memory/turn-context.test.ts`; extend `tests/gateway/core/mono-memory-scope.test.ts`.

**Interfaces:**
- Consumes: `resolveBrainScope` and `profileSource` (Task 1), `parseFrontmatter` (Task 2).
- Produces:
  - `export async function buildTurnMemoryContext(deps: { call: (op: string, params: object, scope: BrainScope) => Promise<unknown>; scope: BrainScope; agentSource: string; speaker: string; threadKey: string; channelId: string; timeoutMs?: number; now?: () => Date }): Promise<string | null>`. It returns the inner text, without the tags.
  - `export const TURN_CONTEXT_LIMITS = { total: 8000, profile: 2000, lessons: 2500, channel: 1500 }`
  - `export const TURN_CONTEXT_TIMEOUT_MS = 1500`

- [ ] **Step 1: Write failing tests.**
  - Sections, in order: `<profile>`, `<lessons>`, `<open-commitments>`, `<channel-notes>`.
    - Profile: the speaker's profile page.
    - Lessons: `self/lessons` from `agentSource`, only if it is in `allowedSources`.
    - Open commitments: `list_pages` with `type: "commitment"` across `allowedSources`, then for each page `get_page` and `parseFrontmatter`. Keep `status: open` where `beneficiary`, `promiser` or `thread` matches the speaker or `threadKey`, newest `as_of` first, at most 10.
    - Channel notes: `shared/channels/<channelId>` if readable.
  - Superseded pages are excluded.
  - Each section is cut to its limit. Total ≤ 8000 chars, dropping the oldest commitments first.
  - With all four empty, the result is `null`.
  - A `call` that never resolves → `null` within `timeoutMs`, using a fake clock or `timeoutMs: 20`.
  - A `call` that throws → `null` and a single `console.warn` with no page content.
  - Scope test in `mono-memory-scope.test.ts`: someone else's /1on1 turn gets only the speaker's profile section. Lessons and commitments are not in its scope.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. In `gateway.ts`, compute the block with the same scope the KB tools get for this turn (reuse the `brainGateFor` and `resolveBrainScope` path). Wrap it as `<memory-context>\n…\n</memory-context>\n\n`. Add a gateway test that the envelope sent through `agent.sendMessage` (mono) and `queueDispatch.dispatch` (gateway role) both contain the block, and that a suppressed turn has none.
- [ ] **Step 4:** Run `bun test tests/memory tests/gateway/core` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(memory): bounded per-turn memory context in the turn envelope`

### Task 6: Readable thread history

**Files:**
- Modify: `src/tools/contracts/kb.ts`, adding `kb_thread_history: { limit?: number (1..50, default 20); before?: string }`.
- Modify: `src/knowledge/mcp-tools.ts` and `src/soul/loader.ts`.
- Test: `tests/knowledge/thread-history.test.ts`

**Interfaces:**
- Consumes: `memoryScopeFor` (`src/memory/scope.ts:154`); the conversation slug `conversations/<sessionId lowercased>` (`src/memory/brain-provider.ts:39`); `SlackContext.sessionId`.
- Produces: tool `mcp__slaude_kb__kb_thread_history`. It returns this thread's timeline entries, oldest-first, as `[<date>] <who>: <text>` lines.

- [ ] **Step 1: Write failing tests.**
  - With 30 seeded timeline entries, `limit:20` returns the 20 newest, printed oldest-first.
  - `before` pages backwards.
  - It reads only this session's page, through the memory read scope. In someone else's /1on1, where `memoryScopeFor` returns no read sources, the result is `refused: no thread history is readable here`.
  - It refuses when `sessionId` is unknown.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement with `get_timeline`, which is already in `READ_OPS`.
- [ ] **Step 4:** Run the tests and typecheck. Expect PASS. Regenerate the goldens if the tool list feeds them.
- [ ] **Step 5: Commit** `feat(memory): kb_thread_history reads a thread's turns beyond the recall window`

Ruling recorded for §8.5 / §12: gbrain is not installed in this environment, so whether timeline entries are chunk-indexed can't be checked here (`src/knowledge/brain-backfill.ts:50` says they are not). On-demand history fixes "thin shells" without an LLM. Phase D's quiet-moment summary handles search recall.

### Task 7: Containment scenario, field note, phase close

**Files:**
- Create: `tests/memory/one-on-one-containment.test.ts`, using `tests/gateway/core/mono-memory-scope.test.ts:154` as the template.
- Create: `docs/site/_content/field-notes/2026-10-25-memory-structure.md`
- Modify: `CLAUDE.md`, adding the Findings Log index line, newest first.
- Modify: the spec's Progress section, setting the C row and adding C1–C7 ticks.

- [ ] **Step 1: Write the scenario test.** In it:
  - Alice's /1on1: an inferred note `people/u0bob` (`target:"mine"`) and a told profile entry.
  - Then Bob's turn in a trusted channel: Bob's `<memory-context>`, `memory_about(bob)` and `kb_search` results contain none of Alice's /1on1 note.
  - Then Alice's own channel turn: her profile appears in her block, but the /1on1 note does not.
  - Then Bob speaking inside Alice's locked thread: only Bob's profile is read.

  This pins invariants 1 and 2 end to end.
- [ ] **Step 2:** Run it. It should pass against Tasks 1–6. If it fails, fix the owning code, not the test.
- [ ] **Step 3:** Write the field note: the mechanism, the rulings from the ledger, what review found, and what wasn't verified. Not verified: a live model capturing memory, gbrain timeline chunking, Postgres engines, and turn-context latency under load. Add the index line to `CLAUDE.md`. Set the Progress row to `done (unreleased — ships as RC)` and tick C1–C7.
- [ ] **Step 4:** Run the full `bun test` and `bun run typecheck`. Every failure must belong to the known environment-only classes (gbrain module missing, kubectl `tests/deploy`, safeFetch proxy, template push hooks, voice child env).
- [ ] **Step 5: Commit** `docs: phase C field note; mark phase C done in the epic`
