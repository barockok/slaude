# Ignore Gate + Cron Routing — Design Spec

## Goal

Add two independent features to slaude's Slack gateway:

1. **Ignore Gate** — temporary or permanent ignore of a user or thread when conversation drifts out of mandate. Prevents infinite loops and token waste.
2. **Cron Routing** — scheduled agent tasks set by manager/approver, with manager approval when approver-initiated. Results post to the initiating channel.

---

## Feature 1: Ignore Gate

### Why

When a user or thread goes off-mandate, the agent can get stuck in an infinite loop of unproductive back-and-forth. A gate-level drop (before any token spend) is the cheapest defense. Both manual (manager/approver) and automatic (agent self-reported) triggers are needed.

### Architecture

New `ignores` SQLite table + `IgnoreGate` class integrated into the Slack adapter's existing drop-point chain.

### Schema

```sql
CREATE TABLE IF NOT EXISTS ignores (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('user','thread')),
  user_id TEXT,           -- filled when target_type='user'
  channel_id TEXT,        -- filled when target_type='thread'
  thread_ts TEXT,         -- filled when target_type='thread'
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,     -- null = permanent
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_ignores_user
  ON ignores (target_type, user_id) WHERE target_type = 'user';

CREATE INDEX IF NOT EXISTS idx_ignores_thread
  ON ignores (target_type, channel_id, thread_ts) WHERE target_type = 'thread';

CREATE INDEX IF NOT EXISTS idx_ignores_expires
  ON ignores (expires_at) WHERE expires_at IS NOT NULL;
```

### Components

| File | Responsibility |
|------|----------------|
| `src/db/ignores.ts` | CRUD: `create`, `findActiveForUser`, `findActiveForThread`, `remove`, `list`, `cleanupExpired` |
| `src/gateway/slack/ignore-gate.ts` | `IgnoreGate` class — encapsulates all ignore logic, provides `shouldDrop(userId, channelId, threadTs)` boolean |
| `src/gateway/slack/adapter.ts` | Wire `IgnoreGate.shouldDrop()` into `handleMessage()` after dedup, before channel gate |
| `src/gateway/slack/commands.ts` | New slash commands: `/ignore @user [duration]`, `/ignore-thread [duration]`, `/unignore @user` |
| `src/gateway/slack/mcp-tools.ts` | New MCP tool: `mcp__slaude_slack__ignore_thread` for agent self-report |

### Drop Point Integration

Order in `handleMessage()` after dedup (line 266):

1. Dedup check (existing)
2. **NEW: Ignore gate** — if user or thread is actively ignored, drop with metric `reason: "ignored"`
3. Blocked users (existing)
4. Channel/manager gate (existing)

This ordering ensures ignored users/threads are dropped silently before any token spend.

### Slash Commands

- `/ignore @user 10m` — ignore user for 10 minutes. Duration format: `5m`, `10m`, `1h`, ` permanent`.
- `/ignore @user` — shorthand for permanent ignore.
- `/ignore-thread 5m` — ignore current thread for 5 minutes.
- `/ignore-thread` — permanent thread ignore.
- `/unignore @user` — remove user ignore.
- `/unignore-thread` — remove thread ignore.

Authorization: manager or approver only.

### Agent Self-Report

New MCP tool `mcp__slaude_slack__ignore_thread`:

```typescript
{
  name: "ignore_thread",
  description: "Temporarily ignore this thread when conversation drifts out of mandate. Use to prevent infinite loops.",
  parameters: {
    duration: "string — e.g. '5m', '10m', '1h'. Use 'permanent' only as last resort.",
    reason: "string — why the thread is being ignored"
  }
}
```

When agent calls this, the adapter creates an ignore record with `created_by = agent`.

### Escalation

Temporary ignores can be escalated to permanent:
- Manager types `/ignore-thread permanent` on an already-temp-ignored thread
- Agent calls `ignore_thread` with `duration: "permanent"`
- The existing temp record is updated or replaced

### Metrics

- `slaude_slack_drops_total{reason="ignored"}` — ignore gate drops
- `slaude_ignores_active{target_type="user|thread"}` — gauge of active ignores

---

## Feature 2: Cron Routing

### Why

Managers want the agent to perform recurring tasks (standup summaries, daily reports, scheduled checks) without manual prompting. The scheduler must respect the approval hierarchy.

### Architecture

`cron_jobs` SQLite table + `CronScheduler` class that polls the DB every 60s. Jobs fire by creating an ephemeral agent session, sending the stored prompt, and posting the reply to the originating channel.

### Schema

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,              -- null = post to channel, not thread
  created_by TEXT NOT NULL,
  cron_expr TEXT NOT NULL,     -- standard 5-field cron
  prompt TEXT NOT NULL,        -- sent to agent when job fires
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_result TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
  ON cron_jobs (next_run_at) WHERE active = 1;
```

### Components

| File | Responsibility |
|------|----------------|
| `src/db/cron-jobs.ts` | CRUD: `create`, `findDue`, `updateNextRun`, `deactivate`, `listActive` |
| `src/gateway/slack/cron-scheduler.ts` | `CronScheduler` class — 60s polling loop, executes due jobs via agent session |
| `src/gateway/slack/adapter.ts` | Wire scheduler startup, slash commands |
| `src/gateway/slack/commands.ts` | `/cron-add`, `/cron-list`, `/cron-remove` |

### Slash Commands

- `/cron-add "0 9 * * 1-5" "Summarize yesterday's activity in #general"` — add job
- `/cron-list` — list active jobs (manager/approver only)
- `/cron-remove <id>` — remove job by ID (manager/approver only)

Authorization:
- Manager: can add/remove directly
- Approver: can add, but triggers `ApprovalGate` to manager before storing

### Execution Flow

1. `CronScheduler` polls every 60s: `SELECT * FROM cron_jobs WHERE active = 1 AND next_run_at <= ?`
2. For each due job:
   a. Create ephemeral session (no DB persistence — use `agent.ensureSession` with a synthetic thread key like `cron:${jobId}`)
   b. Send prompt: `[scheduled] ${job.prompt}`
   c. Wait for agent completion
   d. Post result to `job.channel_id` (thread if `thread_ts` set)
   e. Update `last_run_at`, `last_result`, compute new `next_run_at` from cron expression
3. If execution fails, update `last_result` with error, retry next scheduled time

### Cron Expression

Standard 5-field cron: `min hour dom mon dow`
Examples:
- `0 9 * * 1-5` — weekdays at 9am
- `0 */6 * * *` — every 6 hours
- `0 0 * * 0` — Sundays at midnight

Parsing via lightweight library or simple split — no complex cron needed for MVP.

### Approval Flow (Approver-Initiated)

When approver runs `/cron-add`:
1. Parse command
2. Check if initiator is manager — if yes, store directly
3. If approver (not manager), create `ApprovalGate` request:
   - Summary: `Cron job: "${prompt}" at "${cron_expr}"`
   - Category: `cron`
   - Tools: scheduled agent execution
4. On approval: store job
5. On deny: reply with denial

### Safety

- Jobs run in ephemeral sessions — no long-lived session bloat
- Each job has its own thread key `cron:${jobId}` so concurrent jobs don't collide
- Max execution time: 5 minutes (hard cutoff, update last_result with timeout error)
- Only one instance of a job runs at a time (lock via `last_run_at` check)

---

## Testing

### Ignore Gate

- `test/ignore-gate.test.ts`:
  - `should drop message from ignored user`
  - `should drop message in ignored thread`
  - `should not drop after ignore expires`
  - `should allow manager to ignore/unignore`
  - `should reject non-manager ignore attempt`
  - `should create ignore from MCP tool call`

### Cron Routing

- `test/cron-scheduler.test.ts`:
  - `should store cron job on manager add`
  - `should require approval for approver-initiated job`
  - `should find due jobs`
  - `should compute next run from cron expression`
  - `should execute due job and post result`

---

## Open Questions (Resolved)

1. **Ignore trigger**: Combination — manager can manually trigger via slash command, agent can self-report via MCP tool.
2. **Cron purpose**: Scheduled agent prompts that execute and post results to the initiating channel.
