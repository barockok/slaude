# Remote storage and skills follow-ups (rc.37 soak findings)

Status: design, written by the implementer on the operator's instruction to proceed without a question round. Every
decision below is the implementer's call unless marked otherwise; the operator can overrule any of them in review.

## Intent and why
rc.34 to rc.37 moved session files and runtime skills into an S3-compatible bucket (`SLAUDE_STORAGE=s3`) and made a named
agent's own skills loadable through the `Skill` tool. Running that on a one-machine deployment (gateway, one worker,
Postgres, Redis, RustFS) surfaced seven loose ends. None is an outage; together they are the difference between "works" and
"safe to leave running unattended".

## Goals
1. A reload requested from inside a turn on a node (`reload_session`, and every other gateway-side `agent.reload`) reaches
   the node that runs the session.
2. The bucket stops growing without bound, without ever deleting data a session can still resume from.
3. `slaude_storage_unflushed_loss_total` means "edits were actually discarded", so an alert on it is trustworthy.
4. The failure cases the docs describe (lock expiry of a dead node, two nodes racing for one session) have tests.
5. A virtualenv in a workspace is not uploaded by default.
6. The skills section of `remote-storage.md` states what is true.
7. A skill written by `write_skill` can always be called by its slug.

## Non-goals and anti-goals
- No change to flush ordering, epochs or fencing. Item 3 changes only what is counted and logged.
- No automatic deletion on by default. A sweeper that is on by default and wrong destroys user data.
- No change to installed, bundled or operator skills (they already satisfy item 7).
- No hook that rewrites tool input (see Approaches, item 7).
- No release candidate, tag or version bump here; that is the maintainer's step.

## Constraints
- Public repo: no deployment names, people, channel ids in code, tests or docs. Tests use generic fixtures.
- Bun 1.3, TypeScript. `bun run typecheck` and `bun test` stay green. New behaviour gets tests; Redis-gated suites follow
  `tests/queue/real.ts` (dynamic imports inside `beforeAll`, `SLAUDE_REDIS_TEST_URL`).
- No `Co-Authored-By` trailer; one logical change per commit.
- The agent loop is touched (item 1 reaches the worker), so the maintainer cuts an RC for it; not part of this work.

## Approaches and decisions

### 1. Reload reaches node sessions
Cause (verified): `ctx.reloadSession` at `src/gateway/core/gateway.ts:5432` and ~15 other sites call the gateway process's
own `AgentManager.reload`. That manager's `#live` map only holds sessions it booted; a node session is live in the
worker's manager, so the call returns false ("session not live").
- A. Publish a per-session reload on Redis, mirroring `publishAbort`/`onAbort` (durable flag plus channel). The worker
  subscribes for the duration of a turn, next to the abort subscription, and calls `reloadAfterTurn`.
- B. Reuse the tenant-wide `publishReload`. Rejected: it reloads every session of the tenant for one request.
- C. Make the worker poll a reload flag. Rejected: latency and load for no gain over A.
Decision: A. Gateway gets one helper `reloadSession(id, prompt?)` = local `agent.reload` else publish, and every call site
uses it. The durable flag (consumed at the next turn start, like the abort flag) covers a reload requested while the
session is idle. `reloadAfterTurn` gains an optional prompt so the reload prompt behaves as for a local reload.
Tool text: "reload requested" when it was routed to a node, not "reloaded".

### 2. Bucket cleanup
Facts (verified): the bucket stores directories ("units"), `sessions/<ws|tx>-<hash>/` and `inbox/<ws-hash>/`, not sessions;
a unit can be shared by several sessions (channel and proactive folders). `removeSession(store, sessionId)` therefore
matches no real key and has no caller. The gateway cannot compute a transcript unit id (it depends on a node-side path).
- A. Map session rows to unit ids and delete units of closed sessions. Rejected: needs node-side path logic on the gateway
  and is wrong for shared units.
- B. Sweep by age: delete a whole unit only when its newest object is older than a retention window.
- C. Do nothing. Rejected: the prefix grows forever.
Decision: B. `sweepUnits(store, {retainMs, now, dryRun})` and `sweepInbox(store, {ttlMs, now, dryRun})` as pure functions over
`ObjectStore`, tested against the local store. A periodic task on the gateway (one replica at a time through a Redis lock)
runs them. Settings: `SLAUDE_STORAGE_SWEEP` = `off` (default) | `dry-run` | `on`; `SLAUDE_STORAGE_RETAIN_DAYS` (default 90);
`SLAUDE_STORAGE_INBOX_TTL_HOURS` (default 168); interval fixed at 24 h. Dry-run logs what would go. A swept session that
resumes later gets a fresh workspace and the existing resume-miss path starts a new transcript; this is documented.
Skill version history is left alone (small, and the head pointers matter for tombstones).
`removeSession` is deleted as dead and misleading.

### 3. Loss counter
Facts (verified): after a worker recreate the new process has a new node id and an empty in-memory pending set, so
`#prepare` takes the dead-owner branch, counts a loss and deletes the mark. When the node's local marker still equals the
latest manifest, `hydrateTree` is a warm no-op (`tree-sync.ts:264`), the local edits stay on disk and the next flush uploads
them. The counter fires with nothing lost.
Decision: in the dead-owner branch, read the local marker first. Marker equals the latest stored manifest id: log
"recovered local copy", delete the mark, do not count a loss. Otherwise behave as today. No change to what is flushed.

### 4. Tests for the documented failure cases
Add: (a) a node dies holding the session lock, a second node waits out the TTL and then acquires it; (b) two nodes race for
one session, exactly one holds it; (c) the item 3 recreate scenario at `FsSync` level; (d) a flush from a node whose lock
expired is refused (exists? extend if so). Real-Redis suites, gated like the others.

### 5. Default sync ignore
Add `.venv` to `DEFAULT_IGNORE`. Not `.git` (agents clone repositories into workspaces; ignoring it breaks them).
`SLAUDE_SYNC_IGNORE` still overrides the list. Release note line, doc line.

### 6. Documentation
`remote-storage.md` says a new skill "is visible to the next tool call". That is true of the file on every node; the agent
SDK scans plugins when a query starts, so the `Skill` tool sees it in the agent's next session. State both.

### 7. Skills are callable by slug
Cause (verified in the bundled CLI and by test): the CLI matches a skill by its command name (`<plugin>:<slug>`) or its
frontmatter `name`. `write_skill` takes a "human-readable" `name` and writes it as the frontmatter `name`, so a skill titled
"Clone a repo by name" cannot be called as `clone-repo`. 14 of 68 skills on one deployment are like this; installed and
bundled skills already use the slug.
- A. Rewrite the input in the `PreToolUse` skill gate (`updatedInput`). The SDK types allow it, but whether the CLI applies
  `updatedInput` without a permission decision cannot be confirmed without a live model call; wrong either way is silent.
- B. Make the frontmatter `name` the slug at write time, keep the human name as `title`, migrate existing agent-authored
  skills once.
- C. Only change the tool description. Rejected: relies on the model.
Decision: B. `write` always writes `name: <slug>` and, when the given name differs, `title: <given name>`; the loader exposes
`Skill.title` (display uses `title ?? name`). A one-time, idempotent migration at gateway start rewrites agent-authored skills
whose frontmatter name is not their slug (through the normal write path, so the bucket gets the new version). The tool
contract text changes to "Short title; the skill is always called by its slug."

## Settled after the builder check (implementer's calls)
- **Allowlists (item 7).** `allowedSkillNames` (`src/agent/skill-allow.ts`) already matches an `agent.yaml` `skills` entry by
  slug and adds the CLI name of each listed skill. After the rewrite the CLI name is the slug, so slug entries keep working.
  An entry that spelled the old title (never the documented form) would stop matching, so `allowedSkillNames` also adds
  the sanitised `title` of each listed skill. `skill-allow.ts` and its test are in scope for that one line.
- **Which skills migrate (item 7).** Only skills whose provenance is agent (the `authored_by: agent` stamp, with
  `slaude.lock` and the bundled seed winning, as `provenance.ts` defines). Both roots: the shared base and every persona
  overlay. It runs at gateway start next to the existing seeding of agent-written skills in `src/skills/remote-sync.ts`, in
  every storage mode, through the normal write path (version log, announcement, bucket version). It is idempotent (it acts
  only when `name != slug`), so two gateway replicas or a replica and a mirroring node writing the same result is harmless.
- **Reload result (item 1).** The boolean stays. `true` means "reloaded here, or a reload was published to the node".
  Callers that ignore the result are unchanged; the tool text becomes "Reload requested: the next message starts fresh with
  newly-resolved MCPs, plugins, and skills." (true for both). The durable flag has a TTL (10 minutes), so a flag set for a
  session that is live nowhere cannot fire at an unrelated later turn.
- **What the sweeper may delete (item 2).** Whole units under `sessions/` and individual objects under `inbox/`, nothing
  else. A unit is skipped when any of its objects has no `modified` time (the age is then unknown), when it has a needs-flush
  mark, or when its newest object is younger than retention. Age comes from object `modified` only; reads do not count, which
  is why retention defaults to 90 days. The lock key is `keys.storageSweepLock()` in the existing queue key namespace.
- **Loss counter (item 3).** If the latest manifest cannot be listed or none exists, the old path runs (count a loss).
  Only a successful read that equals the local marker takes the new "recovered" path.

## Order of work
5, 6, 3, 1, 7, 2, 4 (small and certain first; the sweeper last because it is the only part that deletes data).

## Left to the builder
Names of helpers and env parsing details; exact log wording; whether the sweeper lives in `src/storage/` or `src/gateway/`.

## Checks before calling it done
`bun run typecheck`; `bun test` (including the Redis-gated suites against a throwaway Redis); a leak scan of every staged diff.
