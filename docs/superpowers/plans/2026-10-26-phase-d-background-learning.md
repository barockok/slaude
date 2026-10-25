# Phase D: Background Learning and Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Between conversations the agent distils what happened into its typed memory, keeps its own operating lessons, and retires skills that don't help. All of it runs under a daily dollar budget it can never silently exceed.

**Architecture:**
- **Passes.** A background pass is a locked-down one-shot SDK `query()` on the gateway (mono: in process), modelled on the brain synthesis child (`src/knowledge/brain-think.ts:53-66`). It gets an in-process MCP server with a pass-specific tool set: reads scoped to the pass scope, writes only to slices that auto-pass, and a `propose` tool for anything that would need a card.
- **Ledger and budget.** A `background_runs` ledger prices every run from a price table. A budget gate decides whether a pass may start and stops it after the turn that crosses the limit.
- **Scheduling.** Passes are scheduled by a gateway leader loop (`leaderLoop`, `src/queue/locks.ts:131`); mono starts the loop directly.
- **Skill check.** The existing post-turn skill check stays a synthetic turn in the user's session. It is budgeted through the same ledger, via a /v1 route on nodes.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` `query()`, Postgres migrations (`src/db/migrations/NNNN_*.sql`) plus the hand-kept SQLite schema (`src/db/drivers/sqlite.ts`), Redis leader locks, Slack Block Kit, `bun test`, and the fake brain (`tests/memory/fake-brain.ts`).

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §9, plus §8.3a (a nightly profile write quoting the person), §11.1 and §11.2 invariants 1, 2 and 5. Read §9 in full before starting any task.

## Global Constraints

- **Public repo.** Use placeholder people, channels and teams only. No AI trailers or AI author identity. Run the CLAUDE.md leak scan before every commit.
- **Pass names (exact):** `nightly-review`, `lessons-upkeep`, `skill-check`, `skill-review`, `quiet-moment`, `digest`.
- **Ledger outcomes (exact):** `ok`, `skipped-budget`, `stopped-budget`, `error`.
- **Budget.**
  - `SLAUDE_BACKGROUND_BUDGET_USD` defaults to `1`.
  - It can be overridden per persona through bundle field `background.budgetUsd`.
  - The day runs from midnight to midnight in the persona's `background.timezone` (IANA). Default `UTC`.
  - Budget covers background passes and the skill check only. User turns are never counted.
- **Cost.** `cost = Σ tokens(kind) × price(model, kind)` over `input`, `output`, `cache_read`, `cache_write`. Never use the SDK's cost figure. An unknown model refuses to start and logs; never price it at zero.
- **Price table.**
  - `SLAUDE_PRICE_TABLE` is inline JSON, or a path when the value does not start with `{`.
  - It is keyed by model id, with values `{ input, output, cache_read, cache_write }` in USD per million tokens.
  - The built-in default holds Anthropic list prices for the current models. Take the numbers from the `claude-api` skill's pricing reference and cite the date in a comment.
- **Start rule.**
  - A pass starts only if `remaining ≥ estimate`, where `estimate` = that pass's last ok run cost, or its floor.
  - It checks after every turn and stops once over, so it may overshoot by at most one turn.
  - Each pass has a max-turns cap.
- **Floors and caps:**

  | Pass | Floor (USD) | Max turns |
  |---|---|---|
  | `nightly-review` | 0.10 | 20 |
  | `lessons-upkeep` | 0.03 | 6 |
  | `quiet-moment` | 0.05 | 10 |
  | `skill-review` | 0.05 | 12 |
  | `skill-check` | 0.02 | — (existing turn) |
  | `digest` | 0 | — (no model) |

- **Priority when short:** `nightly-review` → `quiet-moment` → `skill-review` → `skill-check`. Before today's nightly review has run, `quiet-moment`, `skill-review` and `skill-check` start only if `remaining − nightlyEstimate ≥ their estimate`. Skipped passes are recorded (`skipped-budget`) and listed in the digest, never messaged.
- **Schedule** (persona-local time):
  - nightly review at `02:30`, then lessons upkeep;
  - skill review Sunday `04:00`;
  - digest Monday `09:00` to the manager's DM.
- **Quiet-moment thresholds:**
  - `SLAUDE_QUIET_MIN_TURNS` default `8` (N);
  - `SLAUDE_QUIET_MINUTES` default `30` (M);
  - `SLAUDE_QUIET_MAX_PER_DAY` default `5` (K).
- **Scope rule (invariant 1).**
  - A pass over a `user-<id>` conversation runs as that person. It reads and writes only `user-<id>` and that person's profile, and proposes only to that person.
  - An agent-scope pass sees only `agent-<id>`, `shared`, `public` and `kb-*`.
  - A pass never sees two people's private slices at once.
- **No direct mutations.** Pass tools are read-only plus auto-pass writes (`agent-<id>`, the run-as `user-<id>`). Everything else becomes a `propose` row. Nothing is written until its card is approved. Unanswered proposals expire after 14 days.
- **Profile writes from a pass (invariant 2, §8.3a).** Only in a run-as pass, only `profile`/`correction` pages, and only with a `quote` that appears verbatim in one of that person's own turns in the transcripts the pass was given.
- **Lessons.** `agent-<id>/self/lessons`, at most 40 lines. A write that would exceed 40 lines is refused.
- **Skill retirement.** Soft delete only: the skill moves to `<skills>/.retired/<slug>-<UTC timestamp>/` and can be restored. Only agent-authored skills can be retired. Installed (`slaude.lock`) or bundled skills can only be proposed for removal to the operator.
- **Metrics:** `slaude_background_cost_usd_total{agent,pass}`, `slaude_background_runs_total{agent,pass,outcome}`.
- **Ships as RC.** It touches the agent loop and the DB schema.

## Review Focus

1. **A pass that crosses the budget mid-run** stops after that turn, records `stopped-budget` with the true cost, and leaves no half-written page (its writes are per tool call). Pinned in Task 4.
2. **An unknown model id** (a provider-qualified `SLAUDE_MODEL`, or a model missing from the table) means the pass refuses and records `error` with cost 0. It never runs at zero cost. Pinned in Tasks 1 and 4.
3. **Day boundaries in a non-UTC timezone.** Spend just before and after local midnight counts toward the right day, including on DST change days. Pinned in Task 2.
4. **Two gateway replicas.** A pass runs once per due slot, never twice, and survives the leader dying mid-pass without a double charge. Pinned in Tasks 6 and 7.
5. **A run-as pass over Alice's /1on1** cannot read, write or propose into anyone else's slice or profile, and a profile write whose quote isn't Alice's own words is refused. Pinned in Tasks 4 and 10.

---

### Task 1: Price table and cost

**Files:**
- Create: `src/background/prices.ts`
- Modify: `src/config/env.ts` (accessors `priceTableRaw()` and `backgroundBudgetUsd()`)
- Test: `tests/background/prices.test.ts`

**Interfaces:**
- Produces:
  - `export type TokenKind = "input" | "output" | "cache_read" | "cache_write"`
  - `export type TokenCounts = Record<TokenKind, number>`
  - `export type PriceTable = Record<string, Record<TokenKind, number>>` (USD per million tokens)
  - `export function loadPriceTable(raw: string | undefined): { table: PriceTable; errors: string[] }`. Inline JSON or a file path. On error: the default table plus errors, with error paths only and no values (like `parseDecisionConfig`, `src/decision/config.ts:32`).
  - `export function costUsd(table: PriceTable, model: string, t: TokenCounts): number | null`. Returns null for an unknown model.
  - `export function tokensFromUsage(u: ResultUsage): TokenCounts`. Maps `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` (types in `src/agent/token-budget.ts:9`).
  - `export const DEFAULT_PRICE_TABLE: PriceTable`

- [ ] **Step 1: Write failing tests.**
  - With a fixed table `{ "m": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } }`, `costUsd(t, "m", {input: 1_000_000, output: 100_000, cache_read: 2_000_000, cache_write: 0})` returns `3 + 1.5 + 0.6`, compared within `1e-9`.
  - An unknown model returns `null`.
  - Inline JSON and a temp-file path both load.
  - Bad JSON gives `errors` naming the path but not the content, and the default table is returned.
  - `tokensFromUsage` maps every field and missing fields count as 0.
  - Every model in `DEFAULT_PRICE_TABLE` has all four kinds, each a positive number.
- [ ] **Step 2:** Run `bun test tests/background/prices.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Take the default prices from the `claude-api` skill's pricing reference (load it with the Skill tool) and record the date taken in a comment. Also cover the provider-qualified form of the model ids the repo uses: check how `SLAUDE_MODEL` is written in `docs/` and `src/config/env.ts`. Strip a known provider prefix before lookup, but never fuzzy-match.
- [ ] **Step 4:** Run the tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): price table and per-run cost from token counts`

### Task 2: `background_runs` ledger, budget gate, metrics

**Files:**
- Create: `src/db/migrations/0019_background_runs.sql`
- Modify: `src/db/drivers/sqlite.ts`, adding the same table to `SCHEMA`.
- Create: `src/db/background-runs.ts`, the repo module, following `src/db/cron-jobs.ts`.
- Create: `src/background/budget.ts`
- Modify: `src/metrics.ts`, adding the two metrics.
- Test: `tests/background/budget.test.ts`, `tests/db/background-runs.test.ts`. `tests/db/schema-drift.test.ts` must stay green.

**Interfaces:**
- Consumes: `costUsd`, `TokenCounts` (Task 1).
- Produces:
  - Table `background_runs(id TEXT PK, agent_id TEXT, pass TEXT, scope TEXT, model TEXT, tokens_input INT, tokens_output INT, tokens_cache_read INT, tokens_cache_write INT, cost_usd REAL/DOUBLE, started_at TEXT/TIMESTAMPTZ, finished_at, outcome TEXT, day TEXT)`.
    - `day` is the persona-local `YYYY-MM-DD` at `started_at`.
    - `scope` is `agent` or `user:<id>`, never content.
    - Index on `(agent_id, day)`.
  - Repo:
    - `start(row) → id`
    - `finish(id, {tokens, costUsd, outcome})`
    - `spentOn(agentId, day): number` (sum of `cost_usd`)
    - `lastOkCost(agentId, pass): number | null`
    - `ranOn(agentId, pass, day): boolean`
    - `listBetween(agentId, fromDay, toDay)`
  - `export function localDay(at: Date, timeZone: string): string`
  - `export interface BudgetConfig { limitUsd: number; timeZone: string }`
  - `export function canStart(cfg: BudgetConfig, agentId: string, pass: PassName, now: Date): { ok: true; estimate: number } | { ok: false; reason: "budget" }`. It implements the start and priority rules exactly as in Global Constraints.
  - `export const PASS_FLOOR: Record<PassName, number>`
  - `export const PASS_MAX_TURNS`
  - `export type PassName = "nightly-review" | "lessons-upkeep" | "skill-check" | "skill-review" | "quiet-moment" | "digest"`

- [ ] **Step 1: Write failing tests.**
  - Repo round-trip, on sqlite always and on pg when `SLAUDE_DB=pg`.
  - `spentOn` sums only that day and that agent.
  - `localDay`:
    - `2026-03-29T00:30:00Z` in `Europe/Berlin` (DST day) gives `2026-03-29`;
    - `2026-03-28T23:30:00Z` in `Europe/Berlin` gives `2026-03-29`;
    - `2026-03-28T22:30:00Z` gives `2026-03-28`;
    - in `UTC` it is the date part.
  - `canStart`:
    - with limit 1 and spent 0.95, nightly (floor 0.10) refuses;
    - with spent 0.85 it is ok with estimate 0.10;
    - `lastOkCost` replaces the floor;
    - before today's nightly has run, with spent 0.85, a `skill-check` (0.02) refuses because 1 − 0.85 − 0.10 < 0.02;
    - after the nightly ran it is ok.
  - The metrics are registered with exactly the names and labels from Global Constraints.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. `localDay` uses `Intl.DateTimeFormat` with `timeZone`. Keep both dialects in step (see the schema-drift test).
- [ ] **Step 4:** Run the tests, `tests/db/schema-drift.test.ts` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): background_runs ledger and the daily budget gate`

### Task 3: Persona `background` config

**Files:**
- Modify:
  - `src/persona/sync/payload.ts`: `personaSpec` gains `background?: { budgetUsd?: number (>0, ≤100); timezone?: string (valid IANA) }`; add it to `PERSONA_FIELD_VERSION` and bump `SUPPORTED_PAYLOAD_VERSION` (:44, :64).
  - `src/persona/types.ts`
  - wherever the persona row is stored and loaded (a migration `0020_persona_background.sql` adds a JSONB column, plus the sqlite column).
- Create: `src/background/config.ts`
- Test: `tests/background/config.test.ts`, plus extensions to the persona sync payload tests.

**Interfaces:**
- Consumes: `BudgetConfig` (Task 2), `backgroundBudgetUsd()` (Task 1).
- Produces: `export function budgetConfigFor(personaId: string): BudgetConfig`. Persona values win over env, which wins over the defaults (1 USD, UTC). An invalid timezone falls back to UTC with a logged warning.

- [ ] **Step 1: Write failing tests.**
  - Payload validation accepts the new field.
  - It rejects a bad timezone and a negative budget.
  - An old payload version without the field still syncs.
  - `budgetConfigFor` precedence is persona over env over default.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement, following how `kbSources` was added in migration 0017 and payload v3.
- [ ] **Step 4:** Run `tests/background tests/persona` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(persona): per-persona background budget and timezone`

### Task 4: Pass runner

**Files:**
- Create: `src/background/runner.ts`
- Create: `src/background/pass-tools.ts`
- Create: `src/db/proposals.ts`, plus migration `0021_proposals.sql` and the sqlite table.
- Test: `tests/background/runner.test.ts`, `tests/background/pass-tools.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; the brain call path with an explicit `BrainScope` (as `src/memory/turn-context.ts` uses it); `composePage`/`parseFrontmatter` (`src/knowledge/memory-pages.ts`); `profileSourceId`, `userSourceId`, `agentSourceId` (`src/knowledge/scope.ts`); the child lockdown from `src/knowledge/brain-think.ts:53-66` and `TOOLS_SURVIVING_EMPTY_SET` (`src/agent/child-env.ts:79`).
- Produces:
  - `export type PassScope = { kind: "agent" } | { kind: "user"; userId: string; teamId: string }`
  - `export interface PassSpec { pass: PassName; personaId: string; agentId: string; scope: PassScope; prompt: string; transcripts?: TranscriptTurn[]; extraTools?: PassTool[] }`
  - `export async function runPass(spec: PassSpec, deps: RunnerDeps): Promise<{ outcome: Outcome; costUsd: number; runId: string }>`
    - checks `canStart` and records `skipped-budget` when it refuses;
    - resolves the persona's model and refuses with `error` for an unknown price;
    - runs `query()` with the lockdown and `maxTurns = PASS_MAX_TURNS[pass]`;
    - prices each `result`/`assistant` usage as it arrives;
    - aborts via `AbortController` after the turn that pushes the day's spend over the limit (`stopped-budget`);
    - writes the ledger row and the metrics.
  - `RunnerDeps = { query: typeof sdkQuery; brainCall; now: () => Date }`, injectable for tests with a fake `query`.
  - Pass tools (in-process MCP server `slaude_pass`, for model calls `mcp__slaude_pass__*`):
    - `read_pages({slugs})`, `list_pages({type})` and `search({query})` over the pass scope's read sources only: for `agent`, agent/shared/public/kb; for `user`, that user's `user-` and profile sources plus agent/shared/public/kb read-only;
    - `memoize({pages})` over typed pages via `composePage`. It writes to the agent slice (agent scope) or `user-<id>` (user scope). Profile/correction pages are allowed only in user scope and only with `quote` (Global Constraints). Anything targeting `shared` is refused with a hint to `propose`;
    - `propose({kind: "team-fact" | "promote" | "skill-removal" | "lesson-promotion", payload, to: "manager" | "person"})` inserts a `proposals` row with `expires_at = now + 14d`. In user scope `to` is forced to `person`.
  - Table `proposals(id, agent_id, kind, to_kind, to_user, scope, payload JSON, created_at, expires_at, status: open|approved|rejected|expired, decided_by, decided_at)`.

- [ ] **Step 1: Write failing tests.** Use a fake `query` that yields scripted assistant/result messages with usage.
  - Budget refuses: `skipped-budget`, `query` never called.
  - Unknown model: `error`, cost 0, `query` never called.
  - A scripted 3-turn run that crosses the limit on turn 2: aborted after turn 2, `stopped-budget`, the cost includes turn 2.
  - The lockdown options are passed: `tools: []`, the disallowed list, `permissionMode: "dontAsk"`, `strictMcpConfig`, `settingSources: []`, `maxTurns`, and a scrubbed env.
  - Pass tools in user scope U0ALICE:
    - reading `user-u0bob` or Bob's profile is refused;
    - a memoize to `shared` is refused;
    - a profile page with a quote present in Alice's own turn is written to Alice's profile;
    - the same quote attributed to Bob's turn, or absent, is refused (`refused: a profile entry must quote that person's own words`);
    - `propose` with `to: "manager"` is stored as `person`.
  - In agent scope, a profile write is refused.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. The pass's tool results never include raw secrets: reuse the credential refusal.
- [ ] **Step 4:** Run `tests/background tests/knowledge` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): budgeted, locked-down pass runner with scoped pass tools and proposals`

### Task 5: Budget the post-turn skill check

**Files:**
- Modify: `src/agent/manager.ts`. Around `#shouldAutoEvolve` (:1745), the trigger (:1710-1713) and the `result` token block (:1652) where `live.inAutoEvolve` is still true.
- Modify: `src/node/worker.ts` (:705-714) and a new /v1 route `src/gateway/api/background.ts` (`POST /v1/background/skill-check/start`, `POST /v1/background/skill-check/finish`), job-token authenticated like the other /v1 routes.
- Test: `tests/agent/skill-check-budget.test.ts`, `tests/gateway/api/background.test.ts`

**Interfaces:**
- Consumes: `canStart`, the ledger repo, `costUsd`, `tokensFromUsage`.
- Produces:
  - `AgentManager` option `backgroundBudget?: { start(sessionId, personaId): Promise<{ok: boolean; runId?: string}>; finish(runId, usage, model): Promise<void> }`. Mono wires it to the DB. A node wires it to the /v1 route.
  - When `start` refuses, auto-evolve is skipped. When `start` fails (network), auto-evolve is skipped and logged: fail closed, it never runs unbudgeted.
  - The usage of the auto-evolve turn's `result` is attributed to that run.

- [ ] **Step 1: Write failing tests.**
  - A qualifying turn with budget available: start called, the auto-evolve turn runs, and finish receives that turn's usage only (not the user turn's).
  - Budget refused: no auto-evolve prompt pushed, and a `skipped-budget` row exists.
  - `start` throws: no auto-evolve.
  - The /v1 route checks the job token's persona and agent, prices with the gateway's table, and rejects a `finish` for a run id that isn't open.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/agent tests/gateway/api tests/node` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): the post-turn skill check is budgeted and recorded`

### Task 6: Scheduler, nightly review and lessons upkeep

**Files:**
- Create: `src/background/scheduler.ts`. A leader loop on the gateway (`leaderLoop`, `src/queue/locks.ts:131`, as `startCronLeader` does), started directly in mono. Wire it in `src/gateway/core/gateway.ts` next to the cron leader (:869).
- Create: `src/background/passes/nightly-review.ts`, `src/background/passes/lessons-upkeep.ts`, `src/background/prompts/*.md` (prompt text in files, like phase R).
- Create: `src/db/background-slots.ts`, plus migration `0022_background_slots.sql` and the sqlite table `background_slots(agent_id, pass, slot TEXT, claimed_at, PRIMARY KEY(agent_id, pass, slot))`.
- Test: `tests/background/scheduler.test.ts`, `tests/background/nightly-review.test.ts`

**Interfaces:**
- Consumes: `runPass` (Task 4), `budgetConfigFor` (Task 3), conversation pages (`conversationSlug`, `orderTimeline` from `src/memory/brain-provider.ts`).
- Produces:
  - `export function dueSlots(now: Date, tz: string, last: …): Array<{pass: PassName; slot: string}>`, following the schedule in Global Constraints. The slot is e.g. `2026-10-26` or `2026-W44`.
  - `claimSlot(agentId, pass, slot): boolean`: INSERT, where a conflict returns false, so two replicas run a slot once.
  - Nightly review:
    1. Collect the day's conversation pages, grouped by source.
       - Pages in `user-<id>` run as that user (one `runPass` per user, `scope: user`).
       - Pages in the agent slice run in one agent-scope pass.
    2. Hand each pass its transcripts (the timeline entries from that local day).
    3. The prompt asks for person-notes, commitments, investigations, corrections and outcomes, using the phase C page types, plus lesson proposals written to `agent-<id>/self/lesson-proposals` (agent scope only).
  - Lessons upkeep: after the nightly review, one agent-scope pass that merges proposals into `self/lessons` under the lesson rules. The `memoize` tool refuses a `lessons` page over 40 lines.

- [ ] **Step 1: Write failing tests.**
  - `dueSlots` around 02:30 in a non-UTC zone.
  - `claimSlot` twice: the second returns false (two schedulers, one run).
  - Nightly with a fake `query`:
    - two users' /1on1 pages plus agent pages give three passes;
    - each user pass sees only that user's transcript (assert on the prompt and the tool scope);
    - lessons upkeep runs after.
  - A 41-line lessons write is refused.
  - Budget refusal mid-schedule: later passes are recorded `skipped-budget` and the scheduler keeps running.
  - A leader dying mid-pass doesn't re-run the claimed slot.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/background` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): nightly review and lessons upkeep on a leader-claimed schedule`

### Task 7: Quiet-moment pass and thread summary

**Files:**
- Create: `src/db/thread-activity.ts`, plus migration `0023_thread_activity.sql` and the sqlite table `thread_activity(session_id PK, agent_id, turns INT, last_turn_at, summarized_at, scope TEXT)`. It is updated at turn end where the gateway already sees it (memory sync route `src/gateway/api/memory.ts:115`, and mono's turn-end).
- Create: `src/background/passes/quiet-moment.ts`
- Modify: `src/background/scheduler.ts`, to scan each tick.
- Test: `tests/background/quiet-moment.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 6.
- Produces:
  - Selection: a thread is due when `turns ≥ N`, `now − last_turn_at ≥ M` and `summarized_at < last_turn_at`, at most K per agent per local day.
  - The pass reviews that one thread, in its scope, and writes the summary to `conversations/<session>/summary` in the same slice as the conversation page. The conversation page itself is never rewritten.
  - It sets `summarized_at`.
  - The claim is the slot `<session>@<last_turn_at>`, so two replicas never both run it.

- [ ] **Step 1: Write failing tests.**
  - The N/M/K thresholds from env.
  - A /1on1 thread's summary lands in `user-<id>` and the pass runs as that user.
  - Running twice for the same `last_turn_at` happens once.
  - The K+1th candidate that day is skipped.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/background tests/gateway/api` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): quiet-moment pass writes a thread summary`

### Task 8: Skill provenance, usage, soft delete and weekly review

**Files:**
- Modify: `src/skills/mcp-tools.ts`. `write_skill` records provenance as frontmatter `authored_by: agent` plus `authored_at`. `skillOps.retire(slug)` moves to `.retired/`, `skillOps.restore(id)` moves back. `delete_skill` keeps its current behaviour.
- Modify: `src/skills/loader.ts`, which ignores `.retired/`.
- Usage: count `Skill` tool calls per skill via a PostToolUse hook in `src/agent/manager.ts`. Add the `skill_usage` table to Postgres (migration `0024_skill_usage.sql`), make it agent-scoped, and add readers and writers in `src/db/skill-usage.ts`. On nodes, record through a /v1 route alongside Task 5's.
- Create: `src/background/passes/skill-review.ts`
- Test: `tests/skills/retire.test.ts`, `tests/background/skill-review.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 6. `isBuiltinSkillName` (`src/soul/builtin/index.ts`): built-ins are never retired or proposed.
- Produces:
  - Pass tools for this pass only: `list_skills()` (slug, provenance: `agent` | `installed` | `bundled`, uses, last_used_at), `retire_skill({slug, reason})` (refused unless provenance is `agent`) and `propose` (`skill-removal` to the manager for the others).
  - Provenance rule: `installed` when present in `slaude.lock` skills, `bundled` when it matches a seeded bundled slug, `agent` when its frontmatter says so. Otherwise `installed`, which fails safe.

- [ ] **Step 1: Write failing tests.**
  - `write_skill` stamps provenance.
  - `retire` then `restore` round-trips the files.
  - A retired skill is not loaded.
  - The retire tool on an installed skill is refused and a proposal is suggested.
  - Built-ins are never listed for retirement.
  - Usage increments on a Skill call.
  - The weekly review with a fake `query` retires an agent skill that has 0 uses in 30 days, and only proposes for an installed one.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/skills tests/background tests/soul` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(skills): provenance, usage counts, soft retire/restore and the weekly skill review`

### Task 9: Proposal cards and the weekly digest

**Files:**
- Create: `src/background/digest.ts`, `src/background/proposal-cards.ts`
- Modify: the Slack interaction handler for the new action ids. Follow how the approval card actions are handled (`src/gateway/slack/approval-gate.ts`), but proposals are stored rows, not a blocking gate.
- Test: `tests/background/digest.test.ts`, `tests/background/proposal-cards.test.ts`

**Interfaces:**
- Consumes: the ledger (Task 2), proposals (Task 4), skill retire events (Task 8), and lesson page changes (diff the `self/lessons` page against the previous digest's snapshot, stored with the digest's ledger row).
- Produces:
  - `export function renderDigest(input): { text: string; blocks: Block[] }`, from the ledger and proposals:
    - spend vs budget per day for the week;
    - runs by pass and outcome;
    - skipped passes;
    - lessons added and dropped;
    - skills added and retired;
    - open manager proposals, each with Approve/Reject buttons.
  - Delivery: `chat.postMessage({ channel: <managerUserId> })` via `outClientForPersona` (gateway.ts:769). The manager is `soulData().manager.userId`.
  - Person proposals: posted to `channel: <userId>` (their DM), only for `to_kind = person`, at the time the nightly or quiet pass creates them, batched once per pass.
  - Approve applies the stored write through the normal gated path with the approver as the actor:
    - a `team-fact` writes `shared`;
    - a `promote` writes the target slice, and only the person can approve it;
    - `skill-removal` and `lesson-promotion` only record the decision; the operator acts in git.
  - Reject marks the row `rejected`.
  - Expiry runs in the scheduler tick: open rows past `expires_at` become `expired`.
  - Only the manager or backup can decide manager proposals, and only the person can decide person proposals. The click identity is checked as approval cards do.

- [ ] **Step 1: Write failing tests.**
  - `renderDigest` from a fixed ledger shows exact spend numbers, the skipped list, and buttons only for open manager proposals.
  - A digest slot runs once a week (claimSlot).
  - Approving a team-fact writes shared once, and a second click is a no-op.
  - Someone other than the person clicking a promote proposal is refused.
  - Expiry after 14 days.
  - The digest is never sent to anyone but the manager.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/background tests/gateway` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): proposal cards and the weekly digest`

### Task 10: /1on1 nightly scenario, field note, phase close

**Files:**
- Create: `tests/background/one-on-one-nightly.test.ts`, on the mono gateway with the fake brain and a fake `query`, following `tests/memory/one-on-one-containment.test.ts`.
- Create: `docs/site/_content/field-notes/2026-10-26-background-learning.md`
- Modify: `CLAUDE.md`, adding one Findings Log line at the top.
- Modify: the spec's Progress section: the D row, D1–D10 ticks, and the C row marked merged (#155).

- [ ] **Step 1: Write the scenario test.**
  - Alice's /1on1 and a channel thread happen on the same day.
  - The nightly review runs. The fake model writes a person-note and a profile entry quoting Alice, and proposes a team fact.
  - Assert:
    - Alice's writes land only in `user-u0alice` and her profile;
    - the proposal is addressed to Alice;
    - the channel pass's writes land in the agent slice;
    - Bob's later channel turn sees none of Alice's /1on1-derived pages;
    - the ledger has one row per pass with correct costs;
    - the digest renders them.
- [ ] **Step 2:** Run it. It should pass against Tasks 1–9. If it doesn't, fix the owning code.
- [ ] **Step 3:** Write the field note: the mechanism, the rulings from the ledger, what review found, and what is not verified. The not-verified list must include:
  - a live model running the passes;
  - real gbrain op shapes;
  - real Anthropic price drift;
  - HA leader failover under load;
  - DST edge cases beyond the tested zone.

  Add the CLAUDE.md line. Update the Progress table.
- [ ] **Step 4:** Run the full `bun test` and typecheck. Every failure must be in the known environment-only set.
- [ ] **Step 5: Commit** `docs: phase D field note; mark phase D done in the epic`
