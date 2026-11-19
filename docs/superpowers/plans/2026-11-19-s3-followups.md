# Remote storage and skills follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven rc.37 soak findings: node-session reload, bucket cleanup, honest loss counter, failure-case tests, `.venv` ignore, accurate skills docs, skills callable by slug.

**Architecture:** Small, independent changes ordered safest first; the only deleting code (the sweeper) is last and off by default. Reload reuses the existing Redis pub/sub pattern (`publishAbort`/`onAbort`). Skill naming is fixed at the write path plus a one-time migration beside the existing agent-skill seeding.

**Tech Stack:** Bun 1.3, TypeScript, ioredis, the S3-style `ObjectStore` seam (`src/storage/object-store.ts`), bun:test.

**Spec:** `docs/superpowers/specs/2026-11-19-s3-followups-design.md`

## Global Constraints
- Public repo: no deployment names, people or channel ids in code, tests, docs or commit messages; generic fixtures only.
- No `Co-Authored-By` trailer; one logical change per commit; enable the hook once: `git config core.hooksPath .githooks`.
- Before every `git add`: scratch scan, then the leak scan from CLAUDE.md over `git diff --cached -U0`.
- Gates after every task: `bun run typecheck` and the task's tests; full `bun test` at the end.
- Redis-gated suites: `SLAUDE_REDIS_TEST_URL=redis://127.0.0.1:6390` against a throwaway `redis:7-alpine`; dynamic imports in `beforeAll`.
- No push, tag, version bump or release notes (maintainer's step). Sweeper default `off`; retention default 90 days; inbox TTL default 168 hours; durable reload flag TTL 10 minutes.

## Review Focus
- A swept unit's session resumes later: must get a fresh workspace, no crash (doc + test that `sweepUnits` never touches a unit with a needs-flush mark).
- A backend that reports no `modified` time: unit is skipped, never deleted.
- A reload published for a session live nowhere: flag expires, cannot fire at a later unrelated turn.
- Title containing quotes, colons or newlines written as frontmatter: round-trips through `parseSkillText`.
- Migration run twice, and run by two replicas: second run changes nothing.

## File Structure
- Modify `src/storage/ignore.ts`, `src/node/fs-sync.ts`, `src/queue/keys.ts`, `src/queue/pubsub.ts`, `src/gateway/core/dispatch.ts`, `src/agent/manager.ts`, `src/node/worker.ts`, `src/gateway/core/gateway.ts`, `src/gateway/slack/mcp-tools.ts`, `src/skills/loader.ts`, `src/skills/mcp-tools.ts`, `src/skills/remote-sync.ts`, `src/agent/skill-allow.ts`, `src/tools/contracts/skills.ts`, `src/storage/config.ts`, `src/storage/gc.ts`, `src/storage/index.ts`, `docs/site/_content/deploy/remote-storage.md`, `CLAUDE.md` (one findings line).
- Create `src/storage/sweep.ts` (pure sweep functions), `src/gateway/core/storage-sweeper.ts` (timer + lock), `docs/site/_content/field-notes/2026-11-19-rc37-soak-followups.md`.
- Tests: `tests/storage/ignore.test.ts`, `tests/storage/sweep.test.ts`, `tests/node/fs-sync.test.ts` (extend), `tests/queue/pubsub-real.test.ts` and `tests/queue/locks-real.test.ts` (extend), `tests/agent/reload-after-turn.test.ts`, `tests/gateway/reload-routing.test.ts`, `tests/skills/title-name.test.ts`, `tests/skills/name-migration.test.ts`.

---

### Task 1: Ignore virtualenvs by default (item 5)
**Files:** Modify `src/storage/ignore.ts:7`; Create `tests/storage/ignore.test.ts`; Modify `docs/site/_content/deploy/remote-storage.md` (the `SLAUDE_SYNC_IGNORE` default).
**Interfaces:** Produces `DEFAULT_IGNORE: readonly string[]` now `["node_modules", ".cache", "__pycache__", ".venv"]`.
- [ ] **Step 1:** Test `default ignore list names .venv but not .git`: `expect(DEFAULT_IGNORE).toContain(".venv")`; `expect(DEFAULT_IGNORE).not.toContain(".git")`. Test `SLAUDE_SYNC_IGNORE overrides the default` using the module's existing parser (read `ignore.ts` for its export).
- [ ] **Step 2:** Run `bun test tests/storage/ignore.test.ts`; expect the `.venv` test to FAIL.
- [ ] **Step 3:** Add `".venv"` to `DEFAULT_IGNORE`; update the doc sentence listing the defaults.
- [ ] **Step 4:** Re-run; PASS. **Step 5:** commit `storage: ignore .venv in remote sync by default`.

### Task 2: Skills visibility wording (item 6)
**Files:** Modify `docs/site/_content/deploy/remote-storage.md:103`.
- [ ] **Step 1:** Replace "so the new text is visible to the next tool call" with: the file is current on every node at the next tool call; the agent SDK reads plugins when a query starts, so the `Skill` tool sees a skill written mid-session in the agent's next session.
- [ ] **Step 2:** commit `docs(storage): say when the Skill tool sees a new skill`.

### Task 3: Loss counter counts only real loss (item 3)
**Files:** Modify `src/node/fs-sync.ts` (`#prepare`, dead-owner branch near line 233); Test `tests/node/fs-sync.test.ts`.
**Interfaces:** Consumes `latestManifest(store, unitId): Promise<{id: string; manifest: Manifest} | null>` and the unit's `markerPath`; marker file is `{"id": "<manifest id>"}` (`src/storage/tree-sync.ts`).
- [ ] **Step 1:** Tests (use `memRedis`, two `FsSync` instances with different `nodeId`, same state dir and workspace): (a) `recreate with matching marker does not count a loss`: node A flushes, writes a mark `{node: "A", since}` for the unit, node B (A not alive) prepares the same session; assert `metrics.storageUnflushedLossTotal` unchanged, the mark is deleted, the local file edit is still on disk. (b) `dead owner with a stale marker still counts a loss`: bump the stored manifest so marker != latest; assert the counter increments by 1. (c) `unreadable latest manifest takes the loss path`: store whose `list` throws; counter increments.
- [ ] **Step 2:** Run `bun test tests/node/fs-sync.test.ts`; (a) FAILS.
- [ ] **Step 3:** In the dead-owner branch, before incrementing: read the marker file and `latestManifest`; if both succeed and `marker.id === latest.id`, `console.log("[fs-sync] recovered local copy unit=...")` and skip the increment and the error log; any failure or mismatch keeps today's behavior. Still delete the mark.
- [ ] **Step 4:** Re-run; PASS. **Step 5:** commit `fs-sync: a recreated node recovering its own copy is not a loss`.

### Task 4: Reload reaches the node (item 1, queue and node side)
**Files:** Modify `src/queue/keys.ts`, `src/queue/pubsub.ts`, `src/gateway/core/dispatch.ts`, `src/agent/manager.ts` (`reloadAfterTurn`), `src/node/worker.ts` (turn wiring near line 860); Tests: `tests/queue/pubsub-real.test.ts`, `tests/agent/reload-after-turn.test.ts`.
**Interfaces:**
- Produces keys: `sessionReloadChannel(sessionId: string): string`, `sessionReloadFlag(sessionId: string): string` (same `${prefix}:` scheme as `abortChannel`/`abortFlag`).
- Produces pubsub: `publishSessionReload(sessionId: string, prompt?: string): Promise<number>` (sets the flag with value = `JSON.stringify({prompt})` and `PX` 600000, then publishes the same JSON); `onSessionReload(sessionId: string, cb: (prompt?: string) => void): Promise<() => Promise<void>>`; `consumeSessionReloadFlag(sessionId: string): Promise<{prompt?: string} | null>` (GETDEL).
- Produces dispatch: `reload(sessionId: string, prompt?: string): Promise<void>` calling `publishSessionReload`.
- Produces manager: `reloadAfterTurn(sessionId: string, prompt?: string): boolean` (sets the reload prompt before deferring or reloading, as `reload` does).
- [ ] **Step 1:** Real-Redis tests: `publishSessionReload reaches a subscribed node with its prompt`; `flag is consumed once and returned to a node that was not listening`; `flag expires` (publish, set the PX short via a test override or read `PTTL <= 600000`); `unsubscribed node gets nothing from the channel`. Manager test (no Redis): `reloadAfterTurn(id, "p") records the prompt and defers while a turn is pending` using the manager's existing test doubles for a live session.
- [ ] **Step 2:** Start `sudo docker run -d --rm --name slaude-test-redis -p 127.0.0.1:6390:6379 redis:7-alpine`; run the suites; FAIL.
- [ ] **Step 3:** Implement keys, pubsub and dispatch as above; in `manager.ts` set `#reloadPrompt` when a prompt is given. In `worker.ts`: next to `onAbort`, subscribe `onSessionReload(sessionId, p => agent.reloadAfterTurn(sessionId, p))` for the turn and unsubscribe in the `finally`; at turn start, consume the flag and call `agent.reloadAfterTurn(sessionId, prompt)` if present.
- [ ] **Step 4:** Re-run; PASS. **Step 5:** commit `queue: per-session reload for sessions that run on a node`.

### Task 5: Gateway routes every reload (item 1, gateway side)
**Files:** Modify `src/gateway/core/gateway.ts` (helper near `createGateway` top; replace `agent.reload(...)` at the sites listed by `grep -n 'agent.reload' src/gateway/core/gateway.ts`, including the four `ctx.reloadSession =` assignments and `:5432`); Modify `src/gateway/slack/mcp-tools.ts` (`reloadSession` text); Test `tests/gateway/reload-routing.test.ts`.
**Interfaces:** Consumes `queueDispatch.reload(sessionId, prompt?)`. Produces, inside `createGateway`, `const reloadSession = (id: string, prompt?: string): boolean` = `agent.reload(id, prompt) || (queueDispatch ? (void queueDispatch.reload(id, prompt).catch(logError), true) : false)`.
- [ ] **Step 1:** Test: build the helper's logic through the smallest seam the file exposes (extract it as an exported pure function `routeReload(local: (id, p?) => boolean, remote: ((id, p?) => Promise<void>) | null, id, prompt?)` in a new `src/gateway/core/reload-route.ts` if `createGateway` is not unit-reachable). Assertions: local true -> remote not called, returns true; local false + remote -> remote called once with `(id, prompt)`, returns true; local false + no remote -> false; remote rejects -> still true, error logged once. Tool test: `reloadSession` returns `Reload requested: the next message starts fresh with newly-resolved MCPs, plugins, and skills.` when the ctx callback returns true (update the existing assertion in `tests/slack-mcp-tools-coverage.test.ts` if it pins the old text).
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement `routeReload`, use it in the gateway helper, replace the call sites, change the tool text. **Step 4:** run the new test, `tests/slack-mcp-tools-coverage.test.ts`, `tests/surface-coverage.test.ts`; PASS. **Step 5:** commit `gateway: reload requests reach sessions on nodes`.

### Task 6: Skills are callable by slug (item 7)
**Files:** Modify `src/skills/mcp-tools.ts` (`write`, `buildSkillMd`), `src/skills/loader.ts` (`Skill.title`, `parseSkillText`), `src/skills/remote-sync.ts` (migration beside the seeding at ~line 259/350), `src/agent/skill-allow.ts` (`allowedSkillNames`), `src/tools/contracts/skills.ts:32`; Tests `tests/skills/title-name.test.ts`, `tests/skills/name-migration.test.ts`.
**Interfaces:**
- `Skill` gains `title?: string`. `parseSkillText` returns `title` from frontmatter `title`.
- `skillOps.write(slug, name, description, body, personaName?, now?)` keeps its signature; frontmatter `name` is always `slug`; when `name !== slug` also writes `title: <name>` (JSON-quoted like the other fields).
- `normaliseSkillNames(roots?: ...): Promise<string[]>` in `remote-sync.ts` returns the slugs rewritten; rewrites only skills with provenance agent and `name !== slug`, through `skillOps.write(slug, slug, description, body, personaName)` with the old name preserved as `title`.
- `allowedSkillNames` also adds `cliSkillName(title)` for each listed skill that has a title.
- [ ] **Step 1:** Tests: `write with a human name stores name=slug and title`; title with `"`, `:` and a newline round-trips through `parseSkillText`; `write with name equal to slug writes no title`; `migration rewrites a titled agent skill and keeps the title`; `migration leaves installed and bundled skills alone`; `migration is idempotent` (second run returns `[]`); `migration covers a persona overlay`; `agent.yaml list entry by slug still allows a migrated skill and by old title too`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement per the interfaces; call `normaliseSkillNames()` from the gateway start-up path that already calls the agent-skill seeding (find the caller of the function at `remote-sync.ts:350`); update the `name` contract text to `Short title. The skill is always called by its slug.` **Step 4:** run `tests/skills tests/skills-mcp.test.ts tests/skills.test.ts tests/skills-layout.test.ts`; PASS. **Step 5:** commit `skills: write_skill names a skill by its slug and keeps the title`.

### Task 7: Storage sweeper, off by default (item 2)
**Files:** Create `src/storage/sweep.ts`, `src/gateway/core/storage-sweeper.ts`; Modify `src/storage/config.ts`, `src/storage/gc.ts` (delete `removeSession`), `src/storage/index.ts`, `src/queue/keys.ts` (`storageSweepLock(): string`), `src/server.ts` or the gateway start-up (start the sweeper), `docs/site/_content/deploy/remote-storage.md`; Test `tests/storage/sweep.test.ts`.
**Interfaces:**
- `sweepUnits(store: ObjectStore, o: {retainMs: number; now?: number; dryRun?: boolean; skip?: (unitId: string) => Promise<boolean>}): Promise<{unitsDeleted: string[]; unitsKept: number; objectsDeleted: number}>`: lists `sessions/`, groups by the first path segment, newest `modified` per unit; skips a unit if any object lacks `modified`, if newest is within `retainMs`, or if `skip(unit)` is true.
- `sweepInbox(store, o: {ttlMs: number; now?: number; dryRun?: boolean}): Promise<{objectsDeleted: number}>`: deletes `inbox/` objects older than `ttlMs`; objects without `modified` are kept.
- `storageSweepConfig(env?): {mode: "off" | "dry-run" | "on"; retainMs: number; inboxTtlMs: number}` (`SLAUDE_STORAGE_SWEEP`, `SLAUDE_STORAGE_RETAIN_DAYS`=90, `SLAUDE_STORAGE_INBOX_TTL_HOURS`=168; invalid values fall back to the defaults and `off`).
- `startStorageSweeper(d: {store: ObjectStore; redis: Redis; keys: Keys; cfg: ReturnType<typeof storageSweepConfig>; intervalMs?: number}): () => void` (returns a stop function): every `intervalMs` (default 24 h) takes `acquireLock(redis, keys.storageSweepLock(), owner, intervalMs)`; runs `sweepUnits` with `skip = unit => redis.get(keys.needsFlush(unit)) !== null`, then `sweepInbox`; does nothing when mode is `off`.
- [ ] **Step 1:** Tests on `LocalObjectStore` with injected `now`: old unit deleted whole (manifests and blobs); young unit kept; unit with one object lacking `modified` kept (fake store wrapper); `dryRun` deletes nothing and reports the same list; `skip` honored; shared name prefixes do not cross units (`ws-a` vs `ws-ab`); inbox TTL boundary (exactly at ttl is kept, older deleted); `storageSweepConfig` defaults and invalid input. Sweeper test with `memRedis`-style stub: mode `off` never lists; a held lock means no sweep.
- [ ] **Step 2:** Run `bun test tests/storage/sweep.test.ts`; FAIL.
- [ ] **Step 3:** Implement; start the sweeper where the gateway holds Redis and `objectStore()` (grep for the gateway's `skills-changed` subscription start for the right spot); remove `removeSession` and its export; document the three env vars, the default `off`, and that a swept session resumes with a fresh workspace.
- [ ] **Step 4:** Re-run; PASS. **Step 5:** commit `storage: age-based sweeper for abandoned units and uncollected inbox objects (off by default)`.

### Task 8: Failure-case tests (item 4)
**Files:** Modify `tests/queue/locks-real.test.ts`; Modify `tests/node/fs-sync.test.ts`.
- [ ] **Step 1:** Real-Redis tests: `a lock held by a node that died is acquirable after its TTL` (acquire with a 300 ms TTL as owner A, never release; B fails immediately, succeeds after ~400 ms); `two nodes racing for one session lock: exactly one wins` (`Promise.all` of 20 `acquireLock` calls with distinct owners, count trues = 1); and, if `withSessionLock` is exported, `second caller gets HELD_BY_OTHER`. fs-sync: `a flush from a node whose epoch was superseded is refused` if not already covered (read the file first; skip with a note if present).
- [ ] **Step 2:** Run against the throwaway Redis; PASS (these pin existing behavior; a FAIL means a real bug, stop and investigate). **Step 3:** commit `tests: lock expiry of a dead node and racing nodes`.

### Task 9: Findings note, full verification
**Files:** Create `docs/site/_content/field-notes/2026-11-19-rc37-soak-followups.md`; Modify `CLAUDE.md` (one Findings Log line, newest first).
- [ ] **Step 1:** Write the note (mechanism only, generic): per-session reload on nodes, title-named skills and the CLI's name matching, sweeper design and defaults, loss counter semantics. Add the index line.
- [ ] **Step 2:** `bun run typecheck`; `SLAUDE_REDIS_TEST_URL=redis://127.0.0.1:6390 bun test` (full); expect 0 failures (compare any failures with a `git stash` baseline before blaming this work).
- [ ] **Step 3:** Leak scan over `git diff main..HEAD -U0`; stop the test Redis (`sudo docker stop slaude-test-redis`); commit the note; report the branch name, commit list and test counts. Do not push.

## Self-review
Spec coverage: items 1 (T4, T5), 2 (T7), 3 (T3), 4 (T8), 5 (T1), 6 (T2), 7 (T6); settled-after-check points: allowlist title alias (T6), migration scope/idempotence (T6), reload TTL and tool text (T4, T5), sweeper skips (T7), loss-counter error path (T3 test c). Names are consistent across tasks (`publishSessionReload`/`onSessionReload`/`consumeSessionReloadFlag`, `reloadAfterTurn(id, prompt?)`, `sweepUnits`, `normaliseSkillNames`).
