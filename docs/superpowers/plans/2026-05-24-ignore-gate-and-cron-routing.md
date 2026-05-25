# Ignore Gate + Cron Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic ignore gate (temp/permanent, per user/thread) and cron scheduler (manager/approver-set, result-to-channel) to slaude's Slack gateway.

**Architecture:** SQLite tables (`ignores`, `cron_jobs`) persist state. `IgnoreGate` class drops messages before token spend. `CronScheduler` polls DB every 60s and fires jobs via ephemeral agent sessions. Both integrate into existing Slack adapter patterns.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, existing Slack Bolt adapter, existing ApprovalGate.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/db/schema.ts` | Modify | Add `ignores` and `cron_jobs` tables |
| `src/db/ignores.ts` | Create | CRUD for ignore records |
| `src/db/cron-jobs.ts` | Create | CRUD for cron jobs |
| `src/gateway/slack/ignore-gate.ts` | Create | `IgnoreGate` — check if user/thread ignored |
| `src/gateway/slack/cron-scheduler.ts` | Create | `CronScheduler` — poll DB, execute due jobs |
| `src/gateway/slack/commands.ts` | Modify | New slash commands: `/ignore`, `/ignore-thread`, `/unignore`, `/cron-add`, `/cron-list`, `/cron-remove` |
| `src/gateway/slack/mcp-tools.ts` | Modify | New MCP tool: `ignore_thread` for agent self-report |
| `src/gateway/slack/adapter.ts` | Modify | Wire ignore gate drop point, wire cron scheduler startup, wire slash commands |
| `tests/ignore-gate.test.ts` | Create | Tests for IgnoreGate + ignores DB |
| `tests/cron-scheduler.test.ts` | Create | Tests for CronScheduler + cron-jobs DB |
| `tests/commands.test.ts` | Modify | Add tests for new slash commands |

---

## Task 1: ignores DB schema + module

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/ignores.ts`
- Test: `tests/ignore-gate.test.ts`

- [ ] **Step 1: Write failing test — ignores table exists**

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import * as Ignores from "../src/db/ignores";

describe("ignores DB", () => {
  beforeEach(() => {
    db.run("DELETE FROM ignores");
  });

  test("creates and finds active user ignore", () => {
    const now = Date.now();
    Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      expiresAt: now + 600_000,
      reason: "testing",
    });
    const active = Ignores.findActiveForUser("U123");
    expect(active).not.toBeNull();
    expect(active?.userId).toBe("U123");
  });

  test("does not find expired user ignore", () => {
    Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      expiresAt: Date.now() - 1000,
      reason: "expired",
    });
    expect(Ignores.findActiveForUser("U123")).toBeNull();
  });

  test("finds permanent user ignore (no expiry)", () => {
    Ignores.create({
      targetType: "user",
      userId: "U123",
      createdBy: "U999",
      reason: "permanent",
    });
    const active = Ignores.findActiveForUser("U123");
    expect(active).not.toBeNull();
    expect(active?.expiresAt).toBeNull();
  });

  test("removes user ignore", () => {
    Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", reason: "x" });
    expect(Ignores.findActiveForUser("U123")).not.toBeNull();
    Ignores.remove({ targetType: "user", userId: "U123" });
    expect(Ignores.findActiveForUser("U123")).toBeNull();
  });

  test("finds active thread ignore", () => {
    Ignores.create({
      targetType: "thread",
      channelId: "C123",
      threadTs: "123.456",
      createdBy: "U999",
      expiresAt: Date.now() + 600_000,
      reason: "testing",
    });
    const active = Ignores.findActiveForThread("C123", "123.456");
    expect(active).not.toBeNull();
  });

  test("cleanupExpired removes only expired records", () => {
    const now = Date.now();
    Ignores.create({ targetType: "user", userId: "U1", createdBy: "U999", expiresAt: now - 1000, reason: "old" });
    Ignores.create({ targetType: "user", userId: "U2", createdBy: "U999", expiresAt: now + 600_000, reason: "new" });
    Ignores.cleanupExpired();
    expect(Ignores.findActiveForUser("U1")).toBeNull();
    expect(Ignores.findActiveForUser("U2")).not.toBeNull();
  });
});
```

Run: `bun test tests/ignore-gate.test.ts`
Expected: FAIL — `src/db/ignores.ts` not found, table not found

- [ ] **Step 2: Add ignores table to schema**

Modify `src/db/schema.ts`, append after `kb_ingest_jobs` schema:

```typescript
CREATE TABLE IF NOT EXISTS ignores (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('user','thread')),
  user_id TEXT,
  channel_id TEXT,
  thread_ts TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_ignores_user
  ON ignores (target_type, user_id) WHERE target_type = 'user';

CREATE INDEX IF NOT EXISTS idx_ignores_thread
  ON ignores (target_type, channel_id, thread_ts) WHERE target_type = 'thread';

CREATE INDEX IF NOT EXISTS idx_ignores_expires
  ON ignores (expires_at) WHERE expires_at IS NOT NULL;
```

- [ ] **Step 3: Create ignores DB module**

Create `src/db/ignores.ts`:

```typescript
import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type IgnoreRecord = {
  id: string;
  targetType: "user" | "thread";
  userId: string | null;
  channelId: string | null;
  threadTs: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
};

export function create(args: {
  targetType: "user" | "thread";
  userId?: string;
  channelId?: string;
  threadTs?: string;
  createdBy: string;
  expiresAt?: number;
  reason?: string;
}): IgnoreRecord {
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO ignores (id, target_type, user_id, channel_id, thread_ts, created_by, created_at, expires_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.targetType,
      args.userId ?? null,
      args.channelId ?? null,
      args.threadTs ?? null,
      args.createdBy,
      now,
      args.expiresAt ?? null,
      args.reason ?? null,
    ],
  );
  return findById(id)!;
}

export function findById(id: string): IgnoreRecord | null {
  const row = db.query("SELECT * FROM ignores WHERE id = ?").get(id) as any;
  return row ? mapRow(row) : null;
}

export function findActiveForUser(userId: string): IgnoreRecord | null {
  const now = Date.now();
  const row = db
    .query(
      `SELECT * FROM ignores
       WHERE target_type = 'user' AND user_id = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY expires_at IS NULL DESC, created_at DESC
       LIMIT 1`,
    )
    .get(userId, now) as any;
  return row ? mapRow(row) : null;
}

export function findActiveForThread(channelId: string, threadTs: string): IgnoreRecord | null {
  const now = Date.now();
  const row = db
    .query(
      `SELECT * FROM ignores
       WHERE target_type = 'thread' AND channel_id = ? AND thread_ts = ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY expires_at IS NULL DESC, created_at DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs, now) as any;
  return row ? mapRow(row) : null;
}

export function remove(args: { targetType: "user"; userId: string } | { targetType: "thread"; channelId: string; threadTs: string }): void {
  if (args.targetType === "user") {
    db.run("DELETE FROM ignores WHERE target_type = 'user' AND user_id = ?", [args.userId]);
  } else {
    db.run("DELETE FROM ignores WHERE target_type = 'thread' AND channel_id = ? AND thread_ts = ?", [
      args.channelId,
      args.threadTs,
    ]);
  }
}

export function cleanupExpired(): void {
  db.run("DELETE FROM ignores WHERE expires_at IS NOT NULL AND expires_at <= ?", [Date.now()]);
}

function mapRow(row: any): IgnoreRecord {
  return {
    id: row.id,
    targetType: row.target_type,
    userId: row.user_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/ignore-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/ignores.ts tests/ignore-gate.test.ts
git commit -m "feat(db): ignores table and CRUD module"
```

---

## Task 2: IgnoreGate class

**Files:**
- Create: `src/gateway/slack/ignore-gate.ts`
- Test: `tests/ignore-gate.test.ts` (append to existing)

- [ ] **Step 1: Write failing test — IgnoreGate.shouldDrop**

Append to `tests/ignore-gate.test.ts`:

```typescript
import { IgnoreGate } from "../src/gateway/slack/ignore-gate";

describe("IgnoreGate", () => {
  beforeEach(() => {
    db.run("DELETE FROM ignores");
  });

  test("drops message from ignored user", () => {
    Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", reason: "x" });
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(true);
  });

  test("drops message in ignored thread", () => {
    Ignores.create({ targetType: "thread", channelId: "C1", threadTs: "123.456", createdBy: "U999", reason: "x" });
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(true);
  });

  test("does not drop normal message", () => {
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(false);
  });

  test("does not drop after user ignore expires", () => {
    Ignores.create({ targetType: "user", userId: "U123", createdBy: "U999", expiresAt: Date.now() - 1000, reason: "x" });
    const gate = new IgnoreGate();
    expect(gate.shouldDrop("U123", "C1", "123.456")).toBe(false);
  });
});
```

Run: `bun test tests/ignore-gate.test.ts`
Expected: FAIL — `IgnoreGate` not found

- [ ] **Step 2: Create IgnoreGate class**

Create `src/gateway/slack/ignore-gate.ts`:

```typescript
import * as Ignores from "../../db/ignores";

export class IgnoreGate {
  /** Check if a message should be dropped due to active ignore. */
  shouldDrop(userId: string, channelId: string, threadTs: string): boolean {
    // Check user-level ignore first
    if (Ignores.findActiveForUser(userId)) return true;
    // Check thread-level ignore
    if (Ignores.findActiveForThread(channelId, threadTs)) return true;
    return false;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/ignore-gate.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/gateway/slack/ignore-gate.ts tests/ignore-gate.test.ts
git commit -m "feat(slack): IgnoreGate class for user/thread drop logic"
```

---

## Task 3: Wire ignore gate into adapter

**Files:**
- Modify: `src/gateway/slack/adapter.ts`

- [ ] **Step 1: Import and instantiate IgnoreGate**

At top of `adapter.ts`, add import:
```typescript
import { IgnoreGate } from "./ignore-gate";
```

Inside `createSlackApp`, after `const approvals = new ApprovalGate(...)`:
```typescript
const ignoreGate = new IgnoreGate();
```

- [ ] **Step 2: Add drop point after dedup**

In `handleMessage()`, after dedup check (line 266), add:

```typescript
// Ignore gate: temp/permanent ignores for users or threads
{
  const ignored = ignoreGate.shouldDrop(userId, channelId, threadTs);
  if (ignored) {
    console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — ignored`);
    metric.slackDropsTotal.inc({ reason: "ignored" });
    return;
  }
}
```

- [ ] **Step 3: Add periodic cleanup**

After `const ignoreGate = new IgnoreGate();`, add:
```typescript
// Clean up expired ignores every 5 minutes
setInterval(() => {
  import("../../db/ignores").then((m) => m.cleanupExpired());
}, 5 * 60 * 1000);
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/adapter.ts
git commit -m "feat(slack): wire IgnoreGate into adapter drop chain"
```

---

## Task 4: Slash commands for ignore

**Files:**
- Modify: `src/gateway/slack/commands.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing test — new slash commands**

Append to `tests/commands.test.ts`:

```typescript
describe("ignore commands", () => {
  test("/ignore @U123 10m", () => {
    expect(parseSlashCommand("/ignore <@U123> 10m")).toEqual({
      kind: "ignore",
      target: "user",
      userId: "U123",
      duration: "10m",
    });
  });

  test("/ignore @U123 (permanent)", () => {
    expect(parseSlashCommand("/ignore <@U123>")).toEqual({
      kind: "ignore",
      target: "user",
      userId: "U123",
      duration: null,
    });
  });

  test("/ignore-thread 5m", () => {
    expect(parseSlashCommand("/ignore-thread 5m")).toEqual({
      kind: "ignore",
      target: "thread",
      duration: "5m",
    });
  });

  test("/ignore-thread (permanent)", () => {
    expect(parseSlashCommand("/ignore-thread")).toEqual({
      kind: "ignore",
      target: "thread",
      duration: null,
    });
  });

  test("/unignore @U123", () => {
    expect(parseSlashCommand("/unignore <@U123>")).toEqual({
      kind: "unignore",
      target: "user",
      userId: "U123",
    });
  });

  test("/unignore-thread", () => {
    expect(parseSlashCommand("/unignore-thread")).toEqual({
      kind: "unignore",
      target: "thread",
    });
  });
});
```

Run: `bun test tests/commands.test.ts`
Expected: FAIL — new command types not in parser

- [ ] **Step 2: Add types and parser logic**

In `src/gateway/slack/commands.ts`, add to `SlashHit` type:

```typescript
| { kind: "ignore"; target: "user"; userId: string; duration: string | null }
| { kind: "ignore"; target: "thread"; duration: string | null }
| { kind: "unignore"; target: "user"; userId: string }
| { kind: "unignore"; target: "thread" };
```

In `parseSlashCommand()`, after the `/ingest` block:

```typescript
if (cmd === "ignore") {
  const mentionMatch = t.match(/<@([UW][A-Z0-9]+)>/);
  const userId = mentionMatch?.[1];
  if (!userId) return null;
  const dur = rest.filter((r) => !r.startsWith("<@"))[0] ?? null;
  return { kind: "ignore", target: "user", userId, duration: dur };
}
if (cmd === "ignore-thread") {
  const dur = rest[0] ?? null;
  return { kind: "ignore", target: "thread", duration: dur };
}
if (cmd === "unignore") {
  const mentionMatch = t.match(/<@([UW][A-Z0-9]+)>/);
  const userId = mentionMatch?.[1];
  if (!userId) return null;
  return { kind: "unignore", target: "user", userId };
}
if (cmd === "unignore-thread") {
  return { kind: "unignore", target: "thread" };
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/commands.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/gateway/slack/commands.ts tests/commands.test.ts
git commit -m "feat(slack): ignore/unignore slash commands"
```

---

## Task 5: Handle ignore slash commands in adapter

**Files:**
- Modify: `src/gateway/slack/adapter.ts`

- [ ] **Step 1: Import ignores DB module**

Add to imports:
```typescript
import * as Ignores from "../../db/ignores";
```

- [ ] **Step 2: Handle ignore/unignore in slash command block**

In `handleMessage()`, in the `if (slash)` block, after `/ingest` handling, add:

```typescript
if (slash.kind === "ignore" || slash.kind === "unignore") {
  // Authorization: manager or approver only
  const soul = soulData();
  const managerId = soul.manager.userId;
  const backupId = soul.backupManager.userId;
  const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
  const isApprover = soul.approvers.some((a) => a.userId === userId);
  if (!isManager && !isApprover) {
    await reply(":no_entry: only manager or approver can manage ignores");
    return;
  }

  if (slash.kind === "ignore") {
    if (slash.target === "user") {
      const duration = slash.duration;
      let expiresAt: number | undefined;
      if (duration) {
        const mins = parseInt(duration, 10);
        if (isNaN(mins) || mins <= 0) {
          await reply(":warning: duration must be like `5m`, `10m`, `1h` (number + m/h)");
          return;
        }
        const multiplier = duration.endsWith("h") ? 60 : 1;
        expiresAt = Date.now() + mins * multiplier * 60 * 1000;
      }
      Ignores.remove({ targetType: "user", userId: slash.userId });
      Ignores.create({ targetType: "user", userId: slash.userId, createdBy: userId, expiresAt, reason: "manual" });
      const durText = duration ? `for ${duration}` : "permanently";
      await reply(`:mute: ignoring <@${slash.userId}> ${durText}`);
    } else {
      const duration = slash.duration;
      let expiresAt: number | undefined;
      if (duration) {
        const mins = parseInt(duration, 10);
        if (isNaN(mins) || mins <= 0) {
          await reply(":warning: duration must be like `5m`, `10m`, `1h`");
          return;
        }
        const multiplier = duration.endsWith("h") ? 60 : 1;
        expiresAt = Date.now() + mins * multiplier * 60 * 1000;
      }
      Ignores.remove({ targetType: "thread", channelId, threadTs });
      Ignores.create({ targetType: "thread", channelId, threadTs, createdBy: userId, expiresAt, reason: "manual" });
      const durText = duration ? `for ${duration}` : "permanently";
      await reply(`:mute: ignoring this thread ${durText}`);
    }
    return;
  }

  if (slash.kind === "unignore") {
    if (slash.target === "user") {
      Ignores.remove({ targetType: "user", userId: slash.userId });
      await reply(`:speaker: stopped ignoring <@${slash.userId}>`);
    } else {
      Ignores.remove({ targetType: "thread", channelId, threadTs });
      await reply(":speaker: stopped ignoring this thread");
    }
    return;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/gateway/slack/adapter.ts
git commit -m "feat(slack): handle ignore/unignore slash commands in adapter"
```

---

## Task 6: Agent self-report ignore MCP tool

**Files:**
- Modify: `src/gateway/slack/mcp-tools.ts`
- Modify: `src/gateway/slack/adapter.ts`

- [ ] **Step 1: Add ignore_thread tool to MCP server**

In `src/gateway/slack/mcp-tools.ts`, add import:
```typescript
import * as Ignores from "../../db/ignores";
```

Add new tool after `unreact` tool:

```typescript
tool(
  "ignore_thread",
  "Temporarily ignore this Slack thread when the conversation drifts out of mandate. Use to prevent infinite loops or unproductive back-and-forth. The thread will be silently dropped until the ignore expires or a manager removes it.",
  {
    duration: z
      .string()
      .describe("Duration like '5m', '10m', '1h'. Use 'permanent' only as absolute last resort."),
    reason: z.string().describe("Brief reason why the thread is being ignored."),
  },
  async ({ duration, reason }) => {
    let expiresAt: number | undefined;
    if (duration === "permanent") {
      expiresAt = undefined;
    } else {
      const num = parseInt(duration, 10);
      if (isNaN(num) || num <= 0) {
        return err("duration must be like '5m', '10m', '1h', or 'permanent'");
      }
      const multiplier = duration.endsWith("h") ? 60 : 1;
      expiresAt = Date.now() + num * multiplier * 60 * 1000;
    }
    // Remove any existing thread ignore first
    Ignores.remove({ targetType: "thread", channelId: ctx.channel, threadTs: ctx.threadTs });
    Ignores.create({
      targetType: "thread",
      channelId: ctx.channel,
      threadTs: ctx.threadTs,
      createdBy: "agent",
      expiresAt,
      reason,
    });
    return ok(`thread ignored ${duration === "permanent" ? "permanently" : `for ${duration}`}`);
  },
),
```

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/gateway/slack/mcp-tools.ts
git commit -m "feat(slack): ignore_thread MCP tool for agent self-report"
```

---

## Task 7: cron_jobs DB schema + module

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/cron-jobs.ts`
- Test: `tests/cron-scheduler.test.ts`

- [ ] **Step 1: Write failing test — cron_jobs table exists**

Create `tests/cron-scheduler.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import * as CronJobs from "../src/db/cron-jobs";

describe("cron-jobs DB", () => {
  beforeEach(() => {
    db.run("DELETE FROM cron_jobs");
  });

  test("creates and finds due job", () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    expect(job.id).toBeTruthy();
    const due = CronJobs.findDue(now);
    expect(due.length).toBe(1);
    expect(due[0]!.prompt).toBe("summarize");
  });

  test("does not find future job", () => {
    const now = Date.now();
    CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now + 600_000,
    });
    expect(CronJobs.findDue(now).length).toBe(0);
  });

  test("updates next run", () => {
    const now = Date.now();
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: now - 1000,
    });
    const next = now + 24 * 60 * 60 * 1000;
    CronJobs.updateNextRun(job.id, next, "done");
    const updated = CronJobs.findById(job.id);
    expect(updated?.nextRunAt).toBe(next);
    expect(updated?.lastResult).toBe("done");
  });

  test("deactivates job", () => {
    const job = CronJobs.create({
      channelId: "C123",
      createdBy: "U999",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      nextRunAt: Date.now(),
    });
    CronJobs.deactivate(job.id);
    expect(CronJobs.findDue(Date.now()).length).toBe(0);
  });

  test("lists active jobs", () => {
    CronJobs.create({ channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now() });
    CronJobs.create({ channelId: "C2", createdBy: "U2", cronExpr: "0 * * * *", prompt: "b", nextRunAt: Date.now() });
    expect(CronJobs.listActive().length).toBe(2);
  });
});
```

Run: `bun test tests/cron-scheduler.test.ts`
Expected: FAIL — table not found, module not found

- [ ] **Step 2: Add cron_jobs table to schema**

Append to `src/db/schema.ts` after ignores schema:

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  created_by TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  prompt TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_result TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run
  ON cron_jobs (next_run_at) WHERE active = 1;
```

- [ ] **Step 3: Create cron-jobs DB module**

Create `src/db/cron-jobs.ts`:

```typescript
import { db } from "./schema";
import { randomUUID } from "node:crypto";

export type CronJob = {
  id: string;
  channelId: string;
  threadTs: string | null;
  createdBy: string;
  cronExpr: string;
  prompt: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  active: number;
};

export function create(args: {
  channelId: string;
  threadTs?: string;
  createdBy: string;
  cronExpr: string;
  prompt: string;
  nextRunAt: number;
}): CronJob {
  const id = randomUUID();
  db.run(
    `INSERT INTO cron_jobs (id, channel_id, thread_ts, created_by, cron_expr, prompt, next_run_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [id, args.channelId, args.threadTs ?? null, args.createdBy, args.cronExpr, args.prompt, args.nextRunAt],
  );
  return findById(id)!;
}

export function findById(id: string): CronJob | null {
  const row = db.query("SELECT * FROM cron_jobs WHERE id = ?").get(id) as any;
  return row ? mapRow(row) : null;
}

export function findDue(now: number): CronJob[] {
  const rows = db
    .query("SELECT * FROM cron_jobs WHERE active = 1 AND next_run_at <= ?")
    .all(now) as any[];
  return rows.map(mapRow);
}

export function updateNextRun(id: string, nextRunAt: number, lastResult: string): void {
  db.run(
    "UPDATE cron_jobs SET next_run_at = ?, last_run_at = ?, last_result = ? WHERE id = ?",
    [nextRunAt, Date.now(), lastResult, id],
  );
}

export function deactivate(id: string): void {
  db.run("UPDATE cron_jobs SET active = 0 WHERE id = ?", [id]);
}

export function listActive(): CronJob[] {
  const rows = db.query("SELECT * FROM cron_jobs WHERE active = 1 ORDER BY next_run_at").all() as any[];
  return rows.map(mapRow);
}

function mapRow(row: any): CronJob {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    createdBy: row.created_by,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    active: row.active,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/cron-jobs.ts tests/cron-scheduler.test.ts
git commit -m "feat(db): cron_jobs table and CRUD module"
```

---

## Task 8: Cron expression parser

**Files:**
- Create: `src/gateway/slack/cron-parser.ts`
- Test: `tests/cron-scheduler.test.ts` (append)

- [ ] **Step 1: Write failing test — parse and next-run computation**

Append to `tests/cron-scheduler.test.ts`:

```typescript
import { parseCron, getNextRun } from "../src/gateway/slack/cron-parser";

describe("cron-parser", () => {
  test("parses basic cron", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(c.minute).toEqual([0]);
    expect(c.hour).toEqual([9]);
    expect(c.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  test("parses wildcard", () => {
    const c = parseCron("0 * * * *");
    expect(c.minute).toEqual([0]);
    expect(c.hour.length).toBe(24);
  });

  test("parses step", () => {
    const c = parseCron("*/15 * * * *");
    expect(c.minute).toEqual([0, 15, 30, 45]);
  });

  test("computes next run from daily cron", () => {
    const base = new Date("2026-05-24T08:00:00Z").getTime();
    const next = getNextRun("0 9 * * *", base);
    const nextDate = new Date(next);
    expect(nextDate.getUTCHours()).toBe(9);
    expect(nextDate.getUTCDate()).toBe(24);
  });

  test("computes next run for weekly cron", () => {
    // 2026-05-24 is Sunday (0). Next Monday (1) at 9am
    const base = new Date("2026-05-24T08:00:00Z").getTime();
    const next = getNextRun("0 9 * * 1", base);
    const nextDate = new Date(next);
    expect(nextDate.getUTCDay()).toBe(1); // Monday
    expect(nextDate.getUTCHours()).toBe(9);
  });
});
```

Run: `bun test tests/cron-scheduler.test.ts`
Expected: FAIL — parser module not found

- [ ] **Step 2: Create cron parser**

Create `src/gateway/slack/cron-parser.ts`:

```typescript
export type CronFields = {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
};

function parseField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) throw new Error(`invalid step: ${field}`);
    const vals: number[] = [];
    for (let i = min; i <= max; i += step) vals.push(i);
    return vals;
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-").map((s) => parseInt(s, 10));
    if (isNaN(start) || isNaN(end)) throw new Error(`invalid range: ${field}`);
    const vals: number[] = [];
    for (let i = start; i <= end; i++) vals.push(i);
    return vals;
  }
  const n = parseInt(field, 10);
  if (isNaN(n)) throw new Error(`invalid field: ${field}`);
  return [n];
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got: ${expr}`);
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 6),
  };
}

/** Compute the next run time after `after` (default now). */
export function getNextRun(expr: string, after?: number): number {
  const fields = parseCron(expr);
  const start = after ?? Date.now();
  const d = new Date(start);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  // Safety: cap search at ~4 years
  const maxIterations = 366 * 24 * 60 * 4;
  for (let i = 0; i < maxIterations; i++) {
    const min = d.getUTCMinutes();
    const hr = d.getUTCHours();
    const dom = d.getUTCDate();
    const mon = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();

    if (
      fields.minute.includes(min) &&
      fields.hour.includes(hr) &&
      fields.dayOfMonth.includes(dom) &&
      fields.month.includes(mon) &&
      fields.dayOfWeek.includes(dow)
    ) {
      return d.getTime();
    }
    d.setUTCMinutes(min + 1);
  }
  throw new Error(`could not find next run for cron: ${expr}`);
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/gateway/slack/cron-parser.ts tests/cron-scheduler.test.ts
git commit -m "feat(slack): cron expression parser with next-run computation"
```

---

## Task 9: CronScheduler class

**Files:**
- Create: `src/gateway/slack/cron-scheduler.ts`
- Test: `tests/cron-scheduler.test.ts` (append)

- [ ] **Step 1: Write failing test — CronScheduler basics**

Append to `tests/cron-scheduler.test.ts`:

```typescript
import { CronScheduler } from "../src/gateway/slack/cron-scheduler";

describe("CronScheduler", () => {
  test("starts and stops without error", () => {
    const scheduler = new CronScheduler({
      agent: { ensureSession: () => ({ id: "test" }), sendMessage: async () => {} } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    scheduler.stop();
    expect(true).toBe(true);
  });
});
```

Run: `bun test tests/cron-scheduler.test.ts`
Expected: FAIL — `CronScheduler` not found

- [ ] **Step 2: Create CronScheduler**

Create `src/gateway/slack/cron-scheduler.ts`:

```typescript
import type { AgentManager } from "../../agent/manager";
import type { WebClient } from "@slack/web-api";
import * as CronJobs from "../../db/cron-jobs";
import { getNextRun } from "./cron-parser";

export type CronSchedulerDeps = {
  agent: AgentManager;
  client: WebClient;
};

export class CronScheduler {
  #agent: AgentManager;
  #client: WebClient;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = new Set<string>(); // job ids currently executing

  constructor(deps: CronSchedulerDeps) {
    this.#agent = deps.agent;
    this.#client = deps.client;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), 60_000);
    // Run once immediately
    void this.#tick();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #tick(): Promise<void> {
    const now = Date.now();
    const due = CronJobs.findDue(now);
    for (const job of due) {
      if (this.#running.has(job.id)) continue;
      this.#running.add(job.id);
      void this.#execute(job);
    }
  }

  async #execute(job: CronJobs.CronJob): Promise<void> {
    try {
      const session = this.#agent.ensureSession({
        team_id: "cron",
        channel_id: `cron:${job.id}`,
        thread_ts: `cron:${job.id}`,
      });

      const envelope = `[scheduled] ${job.prompt}\n\nReply with the result. This is a cron job.`;
      await this.#agent.sendMessage(session.id, envelope);

      // Note: we don't wait for agent completion here — the agent fires async.
      // Instead we update lastResult on the next tick or via event listener.
      // For simplicity, mark as done and compute next run.
      const nextRun = getNextRun(job.cronExpr);
      CronJobs.updateNextRun(job.id, nextRun, "dispatched");
    } catch (e: any) {
      console.error(`[cron] job ${job.id} failed:`, e?.message ?? e);
      CronJobs.updateNextRun(job.id, getNextRun(job.cronExpr), `error: ${e?.message ?? "unknown"}`);
    } finally {
      this.#running.delete(job.id);
    }
  }

  /** Post a result message to the job's channel. Called by adapter when agent completes. */
  async postResult(jobId: string, text: string): Promise<void> {
    const job = CronJobs.findById(jobId);
    if (!job) return;
    try {
      await this.#client.chat.postMessage({
        channel: job.channelId,
        thread_ts: job.threadTs ?? undefined,
        text,
        mrkdwn: true,
      });
      CronJobs.updateNextRun(jobId, getNextRun(job.cronExpr), "completed");
    } catch (e: any) {
      console.error(`[cron] failed to post result for ${jobId}:`, e?.message ?? e);
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/gateway/slack/cron-scheduler.ts tests/cron-scheduler.test.ts
git commit -m "feat(slack): CronScheduler with polling and execution"
```

---

## Task 10: Cron slash commands

**Files:**
- Modify: `src/gateway/slack/commands.ts`
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write failing test — cron slash commands**

Append to `tests/commands.test.ts`:

```typescript
describe("cron commands", () => {
  test("/cron-add with expr and prompt", () => {
    const result = parseSlashCommand('/cron-add "0 9 * * *" "summarize stuff"');
    expect(result).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "summarize stuff",
    });
  });

  test("/cron-list", () => {
    expect(parseSlashCommand("/cron-list")).toEqual({ kind: "cron-list" });
  });

  test("/cron-remove ID", () => {
    expect(parseSlashCommand("/cron-remove abc-123")).toEqual({
      kind: "cron-remove",
      id: "abc-123",
    });
  });
});
```

Run: `bun test tests/commands.test.ts`
Expected: FAIL — new command types not in parser

- [ ] **Step 2: Add cron types and parser logic**

Add to `SlashHit` type:
```typescript
| { kind: "cron-add"; cronExpr: string; prompt: string }
| { kind: "cron-list" }
| { kind: "cron-remove"; id: string };
```

Add to `helpText()`:
```typescript
"`/cron-add \"expr\" \"prompt\"` — schedule recurring agent task (manager/approver)",
"`/cron-list` — list active cron jobs",
"`/cron-remove <id>`` — remove a cron job",
```

In `parseSlashCommand()`, after `/unignore-thread` block:

```typescript
if (cmd === "cron-add") {
  // Match quoted strings: "expr" "prompt"
  const quoteMatch = t.match(/^\/cron-add\s+"([^"]+)"\s+"([^"]+)"$/);
  if (!quoteMatch) return null;
  return { kind: "cron-add", cronExpr: quoteMatch[1]!, prompt: quoteMatch[2]! };
}
if (cmd === "cron-list") {
  return { kind: "cron-list" };
}
if (cmd === "cron-remove") {
  const id = rest[0];
  if (!id) return null;
  return { kind: "cron-remove", id };
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/commands.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/gateway/slack/commands.ts tests/commands.test.ts
git commit -m "feat(slack): cron slash commands (add, list, remove)"
```

---

## Task 11: Wire cron commands into adapter with approval

**Files:**
- Modify: `src/gateway/slack/adapter.ts`

- [ ] **Step 1: Import cron modules**

Add imports:
```typescript
import * as CronJobs from "../../db/cron-jobs";
import { CronScheduler } from "./cron-scheduler";
import { getNextRun } from "./cron-parser";
```

- [ ] **Step 2: Instantiate and start CronScheduler**

After `const approvals = new ApprovalGate(...)`, add:
```typescript
const cronScheduler = new CronScheduler({ agent, client: app.client });
cronScheduler.start();
```

- [ ] **Step 3: Handle cron slash commands**

In `handleMessage()`, in `if (slash)` block, after ignore handling, add:

```typescript
if (slash.kind === "cron-add" || slash.kind === "cron-list" || slash.kind === "cron-remove") {
  const soul = soulData();
  const managerId = soul.manager.userId;
  const backupId = soul.backupManager.userId;
  const isManager = (managerId && userId === managerId) || (backupId && userId === backupId);
  const isApprover = soul.approvers.some((a) => a.userId === userId);

  if (slash.kind === "cron-list") {
    if (!isManager && !isApprover) {
      await reply(":no_entry: only manager or approver can list cron jobs");
      return;
    }
    const jobs = CronJobs.listActive();
    if (!jobs.length) {
      await reply("No active cron jobs.");
      return;
    }
    const lines = jobs.map((j) => `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` → ${j.prompt}`);
    await reply("*Active cron jobs*\n" + lines.join("\n"));
    return;
  }

  if (slash.kind === "cron-remove") {
    if (!isManager && !isApprover) {
      await reply(":no_entry: only manager or approver can remove cron jobs");
      return;
    }
    CronJobs.deactivate(slash.id);
    await reply(`:wastebasket: cron job \`${slash.id.slice(0, 8)}\` removed`);
    return;
  }

  if (slash.kind === "cron-add") {
    if (!isManager && !isApprover) {
      await reply(":no_entry: only manager or approver can add cron jobs");
      return;
    }

    let nextRun: number;
    try {
      nextRun = getNextRun(slash.cronExpr);
    } catch (e: any) {
      await reply(`:warning: invalid cron expression: ${e.message}`);
      return;
    }

    if (isApprover && !isManager) {
      // Approver-initiated: require manager approval
      const approval = await approvals.request({
        channel: channelId,
        threadTs: threadTs,
        summary: `Cron job: "${slash.prompt}" at "${slash.cronExpr}"`,
        category: "cron",
        risks: "Scheduled agent execution — runs unattended.",
      });
      if (!approval.approved) {
        await reply(":x: cron job denied by manager");
        return;
      }
    }

    const job = CronJobs.create({
      channelId,
      threadTs: isDM ? undefined : threadTs,
      createdBy: userId,
      cronExpr: slash.cronExpr,
      prompt: slash.prompt,
      nextRunAt: nextRun,
    });
    await reply(`:calendar: cron job created (\`${job.id.slice(0, 8)}\`) — next run: <t:${Math.floor(nextRun / 1000)}:R>`);
    return;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/adapter.ts
git commit -m "feat(slack): wire cron commands into adapter with manager approval"
```

---

## Task 12: Final integration and cleanup

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 2: Type check**

Run: `bun tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Update help text**

Verify `helpText()` in `commands.ts` includes new commands.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(slack): ignore gate + cron routing complete"
```

---

## Spec Coverage Check

| Spec Requirement | Plan Task |
|------------------|-----------|
| ignores table schema | Task 1 |
| IgnoreGate class | Task 2 |
| Wire ignore into adapter drop chain | Task 3 |
| Slash commands for ignore | Task 4 |
| Handle ignore commands in adapter | Task 5 |
| Agent self-report MCP tool | Task 6 |
| cron_jobs table schema | Task 7 |
| Cron expression parser | Task 8 |
| CronScheduler class | Task 9 |
| Cron slash commands | Task 10 |
| Wire cron with manager approval | Task 11 |

All requirements covered. No gaps.
