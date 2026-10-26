# Phase E: Proactiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent keeps its promises without being reminded, whether proactiveness is on or off. Where the operator's SOUL switches proactiveness on, it also speaks up when something is new and worth an interruption, to an audience that widens only in the spec's steps. Code enforces every restraint rule that can be checked deterministically.

**Architecture:**
- **Promises are budgeted check turns in their own thread.**
  - A due `commitment` is a synthetic turn dispatched into the thread that made the promise, through the same path a cron job uses: queue dispatch on the gateway, `sendMessage` in mono. Origin is `cron`, and a commitment made in a /1on1 runs as that person, so the check has the thread's real tools and the thread's scope.
  - The turn is wrapped in `<runtime-check kind="commitment">`. It either replies in the thread to the beneficiary or calls `pass`.
  - It is budgeted on the Phase D ledger under the new pass `commitment`, at the top of the priority list. The gateway opens the run before dispatch. The turn's own usage closes it: in mono through the manager, on a node through a generalised `/v1/background/turn/finish`. This is the skill check's attribution, generalised from "the auto-evolve input" to "an input that carries a run id".
- **The commitment index.** A small DB table mirrors each open commitment page with a machine-readable due time. It exists so the scheduler never scans brain pages on a timer. It is written wherever a typed `commitment` page is written (`kb_memoize` and the pass `memoize`). A `done`/`dropped` page that supersedes the open one closes the row.
- **Heartbeat is a locked-down pass.** It runs the Phase D pass runner and reads `agent-<id>/self/heartbeat`. It may speak only through one extra pass tool, `proactive_post`, which is executed on the gateway, so the checks and the Slack post happen where the DB, the brain and Slack live. Its checks are brain and KB reads only (open investigations, overdue commitments, team facts). Checks against external systems are out of scope for the heartbeat (my call: a pass never gets external tools).
- **Restraint in code.** One pure function, `checkProactive()`, decides every proactive post. It covers the audience ladder, quiet hours (SOUL and the recipient's profile), the per-person daily cap, cooldown, topic mutes, the DM opt-in with a cited topic, and "unchanged result posts nothing" (same text, same recipient, within 7 days). Every proactive post is recorded in `proactive_posts`.
- **The switch is SOUL text only.** `## Proactive` and `### Proactive` under `## Channel <#C…>` are parsed by a deterministic parser from the persona's SOUL text (`personaSoulText`). They are never parsed by the LLM structured extraction (a mis-extraction must never raise it), and never by the runtime overrides.

**Tech Stack:** Bun + TypeScript, the Phase D runner and scheduler (`src/background/*`), the cron dispatch path (`src/gateway/core/gateway.ts` `cronDispatchMeta`, `src/gateway/slack/cron-scheduler.ts`), Postgres migrations plus the hand-kept SQLite schema (`src/db/drivers/sqlite.ts`), `bun test`, and the fake brain (`tests/memory/fake-brain.ts`).

**Spec:** `docs/superpowers/specs/2026-10-25-teammate-agent-epic-design.md` §10, plus §8.2 (commitment and heartbeat pages), §9.3 (priority), §11.1 and §11.2 invariants 1, 2, 3 and 5. Read §10 in full before starting any task.

## Global Constraints

- **Public repo.** Use placeholder people, channels and teams only. No AI trailers. Run the CLAUDE.md leak scan before every commit.
- **Pass names (new, exact):** `commitment`, `heartbeat`. Both are added to `PassName`.

  | Pass | Floor (USD) | Max turns | Behind nightly reserve |
  |---|---|---|---|
  | `commitment` | 0.03 | — (a session turn) | no: top priority |
  | `heartbeat` | 0.03 | 8 | yes |

- **Promises are always on.** A commitment check never consults `## Proactive` or the decision gate, and never widens its audience: same thread, beneficiary mentioned.
- **Due forms** (field `due` of a commitment page):
  - An ISO-8601 instant with an offset or `Z` (e.g. `2026-11-02T09:00:00+07:00`) is a time. It is checked once at that time.
  - Anything else is an event, polled every `SLAUDE_PROMISE_POLL_MINUTES` (default `15`) from when the page was written, until it resolves or `SLAUDE_PROMISE_EXPIRE_HOURS` (default `24`) pass.
  - The last check before expiry is told it is the last. If unresolved, it says in one line that it couldn't confirm. If that last check cannot run (budget), code posts one fixed line in the thread: `<@beneficiary> I couldn't confirm this in time: <due>.`
- **When a promise check is skipped:**
  - **Budget refused.** The check is recorded `skipped-budget` and retried at the next poll. A time promise retries every poll interval until expiry.
  - **Session live.** A turn is already running in that thread (the session lock is held, as cron's `when_active=skip` checks). The check is deferred to the next tick and nothing is recorded. A background run is never merged into a human's job.
  - **Beneficiary's quiet hours.** The check is deferred to the end of their profile quiet hours. Only the beneficiary's own profile quiet hours apply, never the SOUL's: the person asked for this.
- **`## Proactive` grammar** (case-insensitive keys, one per line, `- Key: value`):
  - `Enabled: yes|no` (default `no`; anything other than `yes` is `no`);
  - `Quiet hours: HH:MM–HH:MM` (en dash or hyphen; may wrap midnight; persona timezone);
  - `Max per person per day: N` (default `1`);
  - `Cooldown: N hours` (default `4`; my call: the spec names cooldown without a value).
  - A channel block's `### Proactive` holds only `Enabled`, in either direction.
  - **Never** in `src/soul/overrides.ts` `FIELD_ALIASES`, never in `SoulDataSchema`, never in `EXTRACTION_PROMPT`. Tests assert all three.
- **Profile ping preferences** (fields on the `profile` page, all optional, all from the person's own words):

  | Field | Meaning |
  |---|---|
  | `quiet_hours` | `HH:MM-HH:MM` |
  | `timezone` | IANA; default the persona's |
  | `pings` | `yes` opts in to proactive DMs; anything else is no |
  | `topics` | comma-separated topics they want pings about |
  | `mutes` | comma-separated muted topics, or `all` |

  Code reads them through `readPingPrefs(teamId, userId)` on the gateway. A profile can only lower: `mutes: all` or quiet hours always win.
- **Audience ladder** (checked by `checkProactive`):

  | Audience | Allowed when |
  |---|---|
  | `manager` (DM to `soul.manager.userId`) | global `Enabled: yes` |
  | `person` (DM to someone else) | global enabled, and their `pings: yes`, and the post's `topic` matches one of their `topics` (case-insensitive, trimmed) |
  | `channel` | the channel resolves enabled (channel block, else global) |

  For every audience, a post is also refused when:
  - it falls in SOUL quiet hours;
  - it falls in the recipient's quiet hours (person/manager);
  - the recipient has muted the topic, or muted `all`;
  - the per-recipient daily cap is reached (a channel counts as a recipient);
  - the recipient's cooldown since the last proactive post has not passed;
  - the text is a duplicate (same normalised text to the same recipient within 7 days).

  The refusal names the rule, so the model can stop.
- **Feedback.**
  - A reply in a proactive post's thread, from the person it was addressed to (any channel member for a channel post), whose text starts with `stop`, `not this`, `mute` or `no more` (case-insensitive) writes a profile mute for that post's topic only. The reply text is the quote, so invariant 2 holds. The bot answers in one line that it will stop that topic.
  - Any reply or reaction is recorded as an `outcome` page in the agent's slice. Reactions need `reaction_added` in the app manifest's bot events.
- **Ships as RC.** It touches the agent loop, the DB schema and the dispatch path.

## Review Focus

1. **A /1on1 promise** is checked as that person, in that thread, and its outcome writes land only in their slice (invariant 1). Pinned in Tasks 5 and 9.
2. **Proactiveness cannot be raised at runtime.** No override field, no extraction field, no command, and a profile can only lower it (invariant 3). Pinned in Tasks 1 and 6.
3. **A promise check's spend is its own turn's usage,** never a human turn's: it is never merged into a human's job, and an unfinished turn is closed by the stale-run sweep at its estimate (invariant 5). Pinned in Tasks 4 and 5.
4. **Two replicas** check a due commitment once. The claim is `background_slots` keyed `<source>/<slug>@<next_check_at>`. Pinned in Task 5.
5. **Every restraint rule is enforced by `checkProactive`,** not by the prompt. A test per row and per rule. Pinned in Task 6.

---

### Task 1: The `## Proactive` switch

**Files:**
- Create: `src/soul/proactive.ts`
- Test: `tests/soul/proactive.test.ts`

**Interfaces:**
- Produces:
  - `export interface ProactiveConfig { enabled: boolean; quietHours: { start: number; end: number } | null; maxPerPersonPerDay: number; cooldownHours: number; channels: Record<string, boolean> }` (minutes since midnight).
  - `export function parseProactive(soulText: string): ProactiveConfig`. Pure. Only a top-level `## Proactive` heading counts, and `### Proactive` only inside a `## Channel <#C…>` block whose id matches `/^[CGD][A-Z0-9]+$/`. Placeholder ids are ignored.
  - `export function proactiveFor(personaId: string, channelId?: string): { enabled: boolean } & Omit<ProactiveConfig, "channels" | "enabled">`. It reads `personaSoulText(personaId)`, memoised by text hash. Any failure reads as disabled.
  - `export function parseClock(s: string): number | null` and `export function inWindow(minutes: number, w: {start: number; end: number}): boolean`, which wraps midnight. Tasks 2 and 6 use both.

- [ ] **Step 1: Write failing tests.**
  - The default (no section) is disabled, cap 1, cooldown 4.
  - `Enabled: yes` turns it on, and `Enabled: maybe` stays off.
  - Quiet hours `21:00–08:00` wrap midnight (`inWindow(23*60)` and `inWindow(7*60)` are true, `inWindow(12*60)` is false).
  - A channel block can enable while global is off, and disable while global is on. A placeholder `<#Cxxx|name>` block is ignored.
  - `## Proactive` inside a fenced code block is ignored.
  - **Invariant 3:**
    - `FIELD_ALIASES` values and the override field list contain nothing matching `/proactive/i`;
    - `SoulDataSchema.shape` has no `proactive` key;
    - `EXTRACTION_PROMPT` does not mention `proactive`;
    - `mutateOverride({field: "proactive" as never, ...})` is refused.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/soul` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(soul): deterministic ## Proactive switch, never overridable`

### Task 2: Profile ping preferences

**Files:**
- Create: `src/proactive/prefs.ts`
- Modify: `src/soul/builtin/skills/memory/SKILL.md`, the Profile section, which names the fields and their formats.
- Test: `tests/proactive/prefs.test.ts`

**Interfaces:**
- Consumes: `readPageRecord` (`src/knowledge/memory-pages.ts`), `speakerProfileSource` (`src/knowledge/scope.ts`), `getPageOrNull` (`src/knowledge/memory-trail.ts`), `parseClock` (Task 1).
- Produces:
  - `export interface PingPrefs { pings: boolean; topics: string[]; mutes: string[] | "all"; quietHours: {start: number; end: number} | null; timeZone: string | null }`
  - `export const NO_PREFS: PingPrefs`, which is no pings, no mutes, no quiet hours.
  - `export function prefsFromProfile(meta: Record<string, string>): PingPrefs`. Pure, and lenient: a malformed value is ignored, never thrown.
  - `export async function readPingPrefs(call: BrainOpCall, teamId: string | null, userId: string): Promise<PingPrefs>`. It reads `profile` from that person's profile source only. A superseded page reads as `NO_PREFS`. Any brain failure is `NO_PREFS`, which is the safe direction for opt-ins, while a mute that cannot be read cannot block anything.
  - `export function muted(prefs, topic): boolean` and `export function optedIn(prefs, topic): boolean`, both case-insensitive and trimmed.

- [ ] **Step 1: Write failing tests.**
  - The fields parse.
  - `mutes: all` mutes everything.
  - `topics: "deploys, oncall"` opts in to `Deploys`.
  - A bad `quiet_hours` is ignored.
  - A superseded profile is ignored.
  - Only `profile-<team>-<user>` is read (assert on the fake brain's call log).
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. Update the memory skill text: the field table, and that a person's "don't ping me about X" is a `mutes` entry written from their own words.
- [ ] **Step 4:** Run `tests/proactive tests/soul` (the built-in size budget test included) and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(proactive): profile ping preferences, read only from the person's own profile`

### Task 3: Commitment index

**Files:**
- Create: `src/db/commitments.ts`, plus migration `0028_commitments.sql` and the sqlite table.
- Create: `src/proactive/due.ts`
- Modify: the `kb_memoize` handler (`src/knowledge/mcp-tools.ts`, around the typed write at :517) and the pass `memoize` (`src/background/pass-tools.ts`), so a written `commitment` page calls `indexCommitment`.
- Test: `tests/proactive/due.test.ts`, `tests/db/commitments.test.ts`, `tests/knowledge/commitment-index.test.ts`

**Interfaces:**
- Produces:
  - `export function parseDue(due: string | undefined, writtenAt: Date): { kind: "time"; at: number } | { kind: "event"; firstCheckAt: number; expiresAt: number } | null`. A time with no offset is an event, never a guessed zone.
  - The table `commitments`:

    | column | |
    |---|---|
    | `agent_id` | PK part |
    | `source` | PK part |
    | `slug` | PK part |
    | `persona_id` | |
    | `team_id` | |
    | `channel_id` | |
    | `thread_ts` | |
    | `beneficiary` | |
    | `run_as` | user id or null |
    | `due_text` | |
    | `due_kind` | `time` \| `event` |
    | `next_check_at` | |
    | `expires_at` | |
    | `on_no_change` | |
    | `status` | `open` \| `done` \| `dropped` \| `expired` |
    | `checks` | INT |
    | `last_checked_at` | |
    | `created_at` | |
  - `export async function indexCommitment(i: {agentId; source; slug; personaId; teamId; meta: Record<string,string>; supersedes?: string; writtenAt: Date}): Promise<"indexed" | "closed" | "ignored">`.
    - `status: open` with a parseable `thread` (`<channel>:<threadTs>`) and `due` upserts.
    - `status: done|dropped` closes the row named by `supersedes` in the same source, and its own slug if present.
    - Anything without a thread or due is ignored, with one log line.
    - `run_as` is the user id when `source` is `user-<id>`, else null.
  - `export async function dueCommitments(agentId: string, now: number, limit = 20)`, open rows with `next_check_at <= now`.
  - `export async function reschedule(...)`, `markExpired(...)`, `markChecked(...)`.

- [ ] **Step 1: Write failing tests.**
  - `parseDue`:
    - a time with an offset;
    - `Z`;
    - no offset is an event;
    - "after the deploy" is an event with `expiresAt` = written + 24 h.
  - Index:
    - upsert is idempotent;
    - a `done` page superseding the open one closes it;
    - a page in `user-u0alice` has `run_as` `U0ALICE`;
    - a page with no `thread` is ignored.
  - `kb_memoize` of an open commitment through the mono path creates the row with the turn's team and persona. The pass `memoize` does too.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. Index after the brain write succeeds. An index failure is logged and never fails the write (the page is the truth). The nightly review's backstop is the re-index: a later `memoize` of the same page upserts it.
- [ ] **Step 4:** Run `tests/proactive tests/db tests/knowledge tests/background` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(proactive): index open commitments with a machine-readable due time`

### Task 4: Budgeted background turns

**Files:**
- Modify: `src/agent/manager.ts`.
  - `sendMessage(sessionId, text, { backgroundRun?: { budget; runId } })` marks that input. A parallel `inputRuns` queue sits next to `inputSynthetic`.
  - At the input's `result`, its usage (this result's `modelUsage` minus the previous result's) finishes the run.
  - Teardown with an open run finishes it as `error` with the usage seen so far, as `evolveRun` does.
- Modify: `src/gateway/core/dispatch.ts` (`DispatchMeta.backgroundRunId`), the job payload and claims (`src/gateway/api/auth.ts`, signed `bgRun`), and `src/node/worker.ts` (:772, passing the run to `sendMessage` with the node's REST budget).
- Modify: `src/gateway/api/background.ts`. Add `POST /v1/background/turn/finish`, which finishes an open run of pass `commitment` whose id equals the token's signed `bgRun`, priced with the gateway's table. Generalise `finishSkillCheck` into `finishTurnRun(pass, …)`. Skill-check routes are unchanged.
- Modify: `src/node/background.ts`, adding a `finishTurn` client.
- Test: `tests/agent/background-turn.test.ts`, `tests/gateway/api/background-turn.test.ts`

**Interfaces:**
- Produces:
  - `export async function openTurnRun(a: { pass: "commitment"; personaId; scope: string; model: string; now: Date }): Promise<{ ok: true; runId; estimate } | { ok: false; reason: "budget" | "unpriced" }>`, in `src/background/turn-runs.ts`, using the start rule. `commitment` is outside `BEHIND_NIGHTLY`.
  - `ledgerTurnBudget()` for mono: `finish` writes the ledger directly.

- [ ] **Step 1: Write failing tests.**
  - Mono: a `sendMessage` with a run, then a scripted result, finishes the run with that input's usage only. A user input queued before it is not counted.
  - Teardown before the result finishes it as `error`.
  - The route:
    - finishes only the token's own `bgRun`;
    - returns 409 for another run id or a `skill-check` run;
    - prices with the gateway's table.
  - The signed claim survives a round trip, and a token without `bgRun` cannot finish a turn run.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/agent tests/gateway/api tests/node tests/background` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(background): a dispatched turn can carry and close its own ledger run`

### Task 5: Promise scheduler

**Files:**
- Create: `src/proactive/promises.ts`, `src/proactive/prompts/commitment-check.md`
- Modify: `src/background/scheduler.ts`. Each tick, after the scheduled slots, run the group's due commitments (handler `commitment`).
- Modify: `src/gateway/core/gateway.ts`. Expose a `dispatchCheckTurn` built from the cron path (route registration as in `onExecute` at :788, queue dispatch with `cronDispatchMeta`-like meta plus `backgroundRunId`, `oauthUser = run_as`). Mono uses `agent.sendMessage` with the ledger budget. Pass it to the scheduler deps.
- Test: `tests/proactive/promises.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4, `claimSlot`, `readPingPrefs`, `SchedulerSlack.post`.
- Produces:
  - `export async function runDueCommitments(g: AgentGroup, now: Date, deps: PromiseDeps)`, per due row:
    1. **Beneficiary's quiet hours** (their profile): reschedule to the window's end, and stop.
    2. **Claim** `commitment` / `<source>/<slug>@<next_check_at>`, else stop.
    3. **Live session** (lock held): release by rescheduling to the next tick, and stop.
    4. **Open the run** with `openTurnRun`. If refused, record `skipped-budget` and reschedule (+poll). At expiry, post the fixed line, then `markExpired`.
    5. **Dispatch the check turn** with the envelope below. `markChecked`, and reschedule: a time promise to expiry handling (a time promise is checked once; if still open after its check and past its due, it waits until `due + SLAUDE_PROMISE_EXPIRE_HOURS`, then gets the last check), an event promise to `now + poll`, or the last check when `now + poll ≥ expires_at`.
  - Envelope (file `commitment-check.md`, substituted):
    ```
    <runtime-check kind="commitment" last="{{last}}">
    You promised <@{{beneficiary}}> in this thread: {{summary}}
    Due: {{due}}. Check: {{check}}.
    If it is resolved: tell them in one or two lines, then write the commitment as done (supersede {{slug}}).
    If nothing changed: {{on_no_change_rule}}
    {{last_rule}}
    Do not mention this check, the schedule or your memory.
    </runtime-check>
    ```
    - `on_no_change_rule` for `silent` is "call pass".
    - For `close-in-one-line` it is "say in one line that it's not there yet".
    - `last_rule` on the last check is "This is the last check. If unresolved, say in one line you couldn't confirm it, then write the commitment as dropped."

- [ ] **Step 1: Write failing tests,** with a fake dispatch, the fake brain and a fixed clock.
  - A time promise dispatches once at its time, into its own channel and thread, with `runAs` for a `user-` source.
  - Two schedulers produce one dispatch.
  - The session is live, so nothing is dispatched and the promise is retried next tick.
  - Budget is refused, so a `skipped-budget` row is recorded and the promise is retried.
  - An event promise polls every 15 min, then gets a last check, then expires.
  - The budget refuses at expiry, so the fixed line is posted once and the row is `expired`.
  - The beneficiary's quiet hours defer the check.
  - **Proactive off in the SOUL still dispatches** (§10.6).
  - The envelope never contains another person's id.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/proactive tests/background tests/gateway` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(proactive): keep promises with budgeted check turns in their own thread`

### Task 6: Restraint rules and the proactive post ledger

**Files:**
- Create: `src/proactive/restraint.ts`
- Create: `src/db/proactive-posts.ts`, plus migration `0029_proactive_posts.sql` and the sqlite table `proactive_posts(id, agent_id, audience, recipient, topic, text_hash, channel_id, message_ts, posted_at)`.
- Test: `tests/proactive/restraint.test.ts`

**Interfaces:**
- Produces:
  - `export type Audience = "manager" | "person" | "channel"`
  - `export interface ProactiveRequest { audience; recipient: string /* user id or channel id */; topic: string; text: string }`
  - `export function checkProactive(req, ctx: { config: (channelId?: string) => ReturnType<typeof proactiveFor>; managerId: string | null; prefs: PingPrefs; now: Date; timeZone: string; history: { postedAt: number; textHash: string }[] }): { ok: true } | { ok: false; rule: "disabled" | "not-manager" | "not-opted-in" | "topic-not-opted-in" | "muted" | "quiet-hours" | "daily-cap" | "cooldown" | "unchanged" | "channel-disabled" }`. Pure.
  - `export function textHash(text: string): string`: whitespace collapsed, lowercased, Slack markup stripped, sha256.
  - DB: `recordPost`, `recentFor(agentId, recipient, sinceMs)`, and `findByMessage(channel, ts)`, which Task 8 uses.

- [ ] **Step 1: Write failing tests,** one per ladder row and one per rule.
  - manager: enabled is ok, disabled is refused.
  - `audience: "manager"` with a non-manager recipient is refused (`not-manager`).
  - person: `pings: no` is refused; `pings: yes` with an unlisted topic is refused; with a listed topic it is ok.
  - channel: the channel block enabled while global is off is ok; the channel block disabled while global is on is refused.
  - SOUL quiet hours across midnight, in the persona timezone.
  - Recipient quiet hours in their own timezone.
  - `mutes: all` and a topic mute.
  - Daily cap 1: the second post in the same local day is refused, and a post after local midnight is ok.
  - Cooldown.
  - The same text within 7 days is `unchanged`; after 7 days it is ok.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/proactive tests/db` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(proactive): restraint rules enforced in code, and a proactive post ledger`

### Task 7: Heartbeat pass and `proactive_post`

**Files:**
- Create: `src/proactive/heartbeat.ts`, `src/background/prompts/heartbeat.md`
- Modify: `src/background/budget.ts`, adding `heartbeat` to `PassName`, `PASS_FLOOR`, `PASS_MAX_TURNS` and `BEHIND_NIGHTLY`, and `commitment` to `PassName`/`PASS_FLOOR`.
- Modify: `src/background/scheduler.ts`. A `heartbeat` slot every `SLAUDE_HEARTBEAT_MINUTES` (default `30`), keyed `YYYY-MM-DDTHH:MM` rounded down to the interval, only when `proactiveFor(group.personaId)` or any channel is enabled.
- Modify: `src/soul/runtime/core.md`, one line: keep `self/heartbeat` as your own checklist of recurring checks worth an interruption. The memory skill gets the page's shape.
- Test: `tests/proactive/heartbeat.test.ts`

**Interfaces:**
- Consumes: `runPass` (with `extraTools`), Task 6, `readPingPrefs`, `SchedulerSlack.post`.
- Produces:
  - `export function proactivePostTool(ctx: { agentId; personaId; teamId; managerId; post: CardPost; call: BrainOpCall; now: () => Date; timeZone: string }): PassTool`. The tool is `proactive_post({ audience, recipient, topic, text, evidence })`.
    - `evidence` is required and non-empty: a slug or link the claim rests on.
    - A text that states a hypothesis must say so. The prompt asks for this; it is not code-checked.
    - The tool runs `checkProactive` and returns the refusal rule as an error.
    - On ok it posts via `post` (a DM is `channel: <userId>`), records `proactive_posts`, and returns `{posted: true}`.
    - At most 3 posts per heartbeat run (code).
  - `export async function runHeartbeat(r: SlotRun, deps)`. It is an agent-scope pass that reads `self/heartbeat`. If the page is absent or empty, nothing runs and no ledger row is written.
  - The prompt says:
    - post only when a result is meaningfully new and worth an interruption;
    - unchanged, routine or no-op results stay silent;
    - you may update `self/heartbeat` with memoize (type `heartbeat`).

- [ ] **Step 1: Write failing tests,** with a fake `query` that calls the tool.
  - Proactive off globally and on no channel: no heartbeat slot is ever due.
  - An absent heartbeat page means no run and no row.
  - A post to the manager when enabled lands in their DM and in `proactive_posts`.
  - A post the restraint rules refuse returns the rule name and posts nothing.
  - The 4th post in one run is refused.
  - A post without evidence is refused.
  - The pass scope is `agent` (no `user-*` source readable).
  - Two schedulers claim one slot.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/proactive tests/background tests/soul` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(proactive): heartbeat pass speaks only through restraint-checked proactive_post`

### Task 8: Feedback loop

**Files:**
- Create: `src/proactive/feedback.ts`
- Modify: the Slack adapter's inbound message path, to check whether an inbound reply's `thread_ts` matches a proactive post first. Also add a `reaction_added` handler, and add `reaction_added` to the manifest bot events (`src/cli/manifest.ts`).
- Test: `tests/proactive/feedback.test.ts`

**Interfaces:**
- Produces:
  - `export function stopPhrase(text: string): boolean`. It is true when the text starts with `stop`, `not this`, `mute` or `no more` (case-insensitive, after a mention).
  - `export async function onProactiveReply(i: { channel; threadTs; userId; teamId; text }, deps): Promise<"muted" | "outcome" | "ignored">`.
    - The post is looked up by `(channel, thread_ts)`. Only the addressed person counts for a DM; any human counts for a channel post.
    - A stop phrase writes a profile `mutes` entry adding the post's topic, through a new superseding profile page. The other fields are preserved, the `quote` is the reply text, `source` is `told by <user>`, and the write goes to the replier's own profile only. It also posts one line ("Got it, I'll stop pinging you about <topic>.") and returns `muted`.
    - Any other reply writes an `outcome` page in `agent-<id>` (`outcomes/proactive-<post id>`) and returns `outcome`.
  - `export async function onProactiveReaction(...)`, which writes an `outcome` page only. A reaction never mutes.

- [ ] **Step 1: Write failing tests.**
  - "stop" from the addressed person mutes only that topic; their other topics and `pings` remain.
  - "stop" from someone else on a DM post is ignored.
  - "not this" on a channel post mutes that replier's topic only.
  - A plain reply writes an outcome.
  - A reaction writes an outcome and never mutes.
  - A reply to a non-proactive thread is `ignored` and normal handling continues.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/proactive tests/gateway` and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(proactive): replies and reactions to proactive posts become outcomes; "stop" mutes that topic`

### Task 9: Scenario, field note, phase close

**Files:**
- Create: `tests/proactive/promise-kept-scenario.test.ts`. It runs on the mono gateway with the fake brain and a fake agent turn, following `tests/background/one-on-one-nightly.test.ts`.
- Create: `docs/site/_content/field-notes/2026-10-26-proactiveness.md`
- Modify: `CLAUDE.md`, adding one Findings Log line at the top.
- Modify: the spec's Progress section: the E row and the E1–E9 ticks.

- [ ] **Step 1: Write the scenario test.**
  - The SOUL has no `## Proactive`.
  - Alice, in her /1on1, gets a promise: "I'll tell you when the deploy is out". The fake turn writes an open commitment with an event due.
  - The clock advances 15 min. The check turn is dispatched as Alice into her thread, and the fake turn passes.
  - The clock advances 15 min. The fake turn replies and writes the commitment as done.
  - Assert:
    - the reply landed in Alice's thread;
    - the row is closed;
    - the ledger has `commitment` rows with costs;
    - no heartbeat ran;
    - no proactive post exists;
    - the done page is in `user-u0alice` only.
- [ ] **Step 2:** Run it. Fix the owning code on failure.
- [ ] **Step 3:** Write the field note: the mechanism, the rulings, what review found, and what is not verified. The not-verified list must include:
  - a live model deciding "meaningfully new";
  - real Slack `reaction_added` delivery and its scope;
  - HA failover mid-check;
  - DST edge cases in quiet hours.

  Add the CLAUDE.md line, and update the Progress table and tasks.
- [ ] **Step 4:** Run the full `bun test` and typecheck. Every failure must be in the known environment-only set.
- [ ] **Step 5: Commit** `docs: phase E field note; mark phase E done in the epic`
