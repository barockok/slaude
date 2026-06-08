# cron-on-channel + a latent scheduler-boot crash

## Feature

Cron jobs can opt into posting their output as a fresh top-level **channel** message
(broadcast/digest) instead of replying inside the thread where `/cron-add` ran. Opt-in
per job: `/cron-add "<expr>" "<prompt>" channel`. Thread-bound posting stays the default.

Mechanism (each hop wires to the next):
- `cron_jobs.target` column (`'thread'|'channel'`, `NOT NULL DEFAULT 'thread'`) → `CronJob.target`.
- `/cron-add` parser takes an optional trailing `channel|thread` keyword (defaults thread).
- A dedicated `SlackContext.postTarget` flag — **only** the `reply` MCP tool branches on it
  (`thread_ts: postTarget === "channel" ? undefined : ctx.threadTs`). We deliberately did
  NOT blank `ctx.threadTs`, because `get_thread_history`, `upload`, approval/status/error
  paths all read it — blanking it would have had channel-wide blast radius.
- The scheduler branches explicitly on `job.target`: channel jobs key the agent session on
  the internal `cron:${job.id}` (never a real Slack thread), so each run posts a new root
  while keeping a persistent session across runs.
- Replies under a broadcast are normal fresh-thread engagement — no special wiring.

## The real find: a temporal-dead-zone crash on scheduler boot

While wiring the gateway, the test suite jumped from 0 → 37 failures, all
`ReferenceError: Cannot access 'routes' before initialization`.

Root cause was **pre-existing** in `gateway.ts`, not introduced by the feature:
`cronScheduler.start()` was called *before* `const routes = new Map(...)` was declared.
`start()` synchronously runs `#tick()` → `#execute()` up to the first `await`, and
`#execute` calls `onExecute` (which does `routes.set(...)`) *before* that await. So when a
cron job is already due at construction, `onExecute` touches `routes` in its TDZ.

Two things hid it until now:
1. Because `#execute` is `async`, the synchronous throw becomes an **unhandled promise
   rejection**, not a sync crash — so it surfaced as failures in *unrelated* test files
   (whichever was running when microtasks flushed), masking the origin.
2. It only fires when `findDue()` returns a job that passes the legacy-key guard
   (has `slackTeamId`+`slackChannelId`). The existing scheduler tests completed each job's
   lifecycle (done/error event → `next_run` advanced → no longer due), so nothing leaked. A
   new scheduler test asserted on `ensureSession`'s argument synchronously and never
   completed the lifecycle, leaving a due+keyed job in the shared sqlite DB → boot crash in
   later gateway tests.

This is a genuine production crash: a due cron job at restart would throw during
`createGateway`. Fix = move `cronScheduler.start()` to after `routes`/`sessionCtx` are
declared (it's the only late-declared binding the `onExecute` closure references). Plus a
regression test that seeds a due job, constructs the gateway with `sendMessage` stubbed,
and asserts no `unhandledRejection` mentioning "routes". Plus test isolation
(`beforeEach`/`afterEach DELETE FROM cron_jobs`) so scheduler tests can't leak due jobs.

**Lesson:** an `async` function that throws before its first `await` rejects a promise —
it does not throw synchronously. A `void`-discarded such call turns a construction-time bug
into a roaming unhandled rejection that blames innocent tests. When failures cluster in
unrelated files with a shared resource (here, the sqlite test DB), suspect cross-file state
leakage + an async-swallowed throw, not the files that report red.

## Spec / plan

- Spec: `docs/superpowers/specs/2026-06-08-cron-on-channel-design.md`
- Plan: `docs/superpowers/plans/2026-06-08-cron-on-channel.md`
