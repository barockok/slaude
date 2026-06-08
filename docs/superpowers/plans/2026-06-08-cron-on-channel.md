# cron-on-channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cron job post its output as a fresh top-level channel message (broadcast/digest) instead of replying inside the thread where `/cron-add` ran, opt-in per job via a trailing `channel` keyword.

**Architecture:** Add a `target` column (`'thread'|'channel'`) to `cron_jobs`. The `/cron-add` parser accepts an optional trailing target keyword. A new `SlackContext.postTarget` flag tells the `reply` MCP tool to omit `thread_ts` (posting to channel root) — only that one tool branches; every other path keeps reading `ctx.threadTs` unchanged. The scheduler branches explicitly on `job.target` to choose the session key.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun:test`, `@slack/web-api`.

**Spec:** `docs/superpowers/specs/2026-06-08-cron-on-channel-design.md`

---

## File Structure

- `src/db/schema.ts` — add migration block for the `target` column (mirrors the existing cron migration).
- `src/db/cron-jobs.ts` — `CronJob.target` field, `create()` arg, `mapRow` read.
- `src/gateway/slack/commands.ts` — `cron-add` SlashHit gains `target`; parser accepts optional keyword.
- `src/gateway/slack/mcp-tools.ts` — `SlackContext.postTarget`; `reply` branch; `addCronJob` passes `target: "thread"`; `listCronJobs` `[target]` tag.
- `src/gateway/slack/cron-scheduler.ts` — branch on `job.target` for the session key.
- `src/gateway/core/gateway.ts` — pass `target` (+ `slackThreadTs: null` for channel) to `create()`; set `ctx.postTarget` in `onExecute`; `[target]` tag in `/cron-list`.
- `src/gateway/sim/scenarios/cron-channel.yaml` — new sim scenario.
- Tests: `tests/cron-scheduler.test.ts`, `tests/commands.test.ts`, `tests/slack-mcp-tools.test.ts`.

Each task is independently committable. Order respects dependencies: DB → parser → reply → scheduler → gateway wiring → renderers → sim.

---

## Task 1: DB column + `CronJob.target`

**Files:**
- Modify: `src/db/schema.ts` (after line 182, end of the cron migration block)
- Modify: `src/db/cron-jobs.ts` (type at 4-18, `create` at 20-49, `mapRow` at 93-109)
- Test: `tests/cron-scheduler.test.ts` (the `cron-jobs DB` describe block)

- [ ] **Step 1: Write the failing test**

Add inside the `describe("cron-jobs DB", ...)` block in `tests/cron-scheduler.test.ts`:

```typescript
  test("defaults target to thread", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
    });
    expect(job.target).toBe("thread");
  });

  test("persists channel target", () => {
    const job = CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 * * * *", prompt: "a", nextRunAt: Date.now(),
      target: "channel",
    });
    expect(job.target).toBe("channel");
    expect(CronJobs.findById(job.id)!.target).toBe("channel");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: FAIL — `create` rejects the `target` arg / `job.target` is `undefined`.

- [ ] **Step 3: Add the migration**

In `src/db/schema.ts`, immediately after the existing cron backfill block (after line 182), add:

```typescript
// Migration: add channel-vs-thread posting target to cron_jobs.
if (!cronCols.some((c) => c.name === "target")) {
  db.run(`ALTER TABLE cron_jobs ADD COLUMN target TEXT NOT NULL DEFAULT 'thread'`);
}
```

- [ ] **Step 4: Add `target` to the type, `create`, and `mapRow`**

In `src/db/cron-jobs.ts`:

Add to the `CronJob` type (after `active: number;`):
```typescript
  target: "thread" | "channel";
```

Add to the `create` args object type (after `nextRunAt: number;`):
```typescript
  target?: "thread" | "channel";
```

Change the `INSERT` to include the column and value. Replace the `db.run(...)` call in `create` with:
```typescript
  db.run(
    `INSERT INTO cron_jobs (id, slack_team_id, slack_channel_id, slack_thread_ts, channel_id, thread_ts, created_by, cron_expr, prompt, next_run_at, target, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      args.slackTeamId ?? null,
      args.slackChannelId ?? null,
      args.slackThreadTs ?? null,
      args.channelId,
      args.threadTs ?? null,
      args.createdBy,
      args.cronExpr,
      args.prompt,
      args.nextRunAt,
      args.target ?? "thread",
    ],
  );
```

Add to `mapRow` return object (after `active: row.active,`):
```typescript
    target: (row.target ?? "thread") as "thread" | "channel",
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/cron-jobs.ts tests/cron-scheduler.test.ts
git commit -m "feat(cron): add target column (thread|channel) to cron_jobs"
```

---

## Task 2: Parser accepts optional target keyword

**Files:**
- Modify: `src/gateway/slack/commands.ts` (SlashHit union line 36; parser branch lines 100-105)
- Test: `tests/commands.test.ts` (the `cron commands` describe block, existing assertion at 154-160)

- [ ] **Step 1: Update the existing test + add new cases**

In `tests/commands.test.ts`, replace the `"/cron-add with quoted args"` test (lines 154-160) with:

```typescript
  test("/cron-add with quoted args defaults to thread", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "daily summary"')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "daily summary",
      target: "thread",
    });
  });

  test("/cron-add with channel target", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" channel')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "digest",
      target: "channel",
    });
  });

  test("/cron-add with explicit thread target", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" thread')).toEqual({
      kind: "cron-add",
      cronExpr: "0 9 * * *",
      prompt: "digest",
      target: "thread",
    });
  });

  test("/cron-add with garbage trailing token → null", () => {
    expect(parseSlashCommand('/cron-add "0 9 * * *" "digest" bogus')).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts`
Expected: FAIL — result lacks `target`; channel/thread/garbage cases not handled.

- [ ] **Step 3: Update the SlashHit union**

In `src/gateway/slack/commands.ts`, change line 36 from:
```typescript
  | { kind: "cron-add"; cronExpr: string; prompt: string }
```
to:
```typescript
  | { kind: "cron-add"; cronExpr: string; prompt: string; target: "thread" | "channel" }
```

- [ ] **Step 4: Update the parser branch**

Replace the `cron-add` branch (lines 100-105) with:
```typescript
  if (cmd === "cron-add") {
    // Match: "expr" "prompt" [channel|thread]   (target optional, defaults to thread)
    const quoteMatch = t.match(/^\/cron-add\s+"([^"]+)"\s+"([^"]+)"(?:\s+(channel|thread))?$/);
    if (!quoteMatch) return null;
    const target = quoteMatch[3] === "channel" ? "channel" : "thread";
    return { kind: "cron-add", cronExpr: quoteMatch[1]!, prompt: quoteMatch[2]!, target };
  }
```

- [ ] **Step 5: Update the help usage string**

Change line 53 from:
```typescript
  { usage: `/cron-add "<expr>" "<prompt>"`, summary: "schedule a prompt on a cron expression" },
```
to:
```typescript
  { usage: `/cron-add "<expr>" "<prompt>" [channel]`, summary: "schedule a prompt; add `channel` to post to channel root" },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/commands.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/slack/commands.ts tests/commands.test.ts
git commit -m "feat(cron): parse optional channel|thread target on /cron-add"
```

---

## Task 3: `reply` posts to channel root via `postTarget`

**Files:**
- Modify: `src/gateway/slack/mcp-tools.ts` (`SlackContext` type 37-57; `reply` handler 62-74)
- Test: `tests/slack-mcp-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("slackHandlers", ...)` in `tests/slack-mcp-tools.test.ts` (use a custom ctx that records the postMessage args, since `fakeCtx` drops them):

```typescript
  test("reply omits thread_ts when postTarget is channel", async () => {
    let captured: any = null;
    const ctx = {
      client: { chat: { postMessage: async (a: any) => { captured = a; return { ts: "1.0" }; } } },
      channel: "C1", threadTs: "123.456", inboundTs: "789.0", postTarget: "channel",
    } as unknown as SlackContext;
    await slackHandlers.reply(ctx, { text: "hi" });
    expect(captured.thread_ts).toBeUndefined();
    expect(captured.channel).toBe("C1");
  });

  test("reply keeps thread_ts when postTarget is thread/absent", async () => {
    let captured: any = null;
    const ctx = {
      client: { chat: { postMessage: async (a: any) => { captured = a; return { ts: "1.0" }; } } },
      channel: "C1", threadTs: "123.456", inboundTs: "789.0",
    } as unknown as SlackContext;
    await slackHandlers.reply(ctx, { text: "hi" });
    expect(captured.thread_ts).toBe("123.456");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/slack-mcp-tools.test.ts`
Expected: FAIL — first test: `thread_ts` is `"123.456"`, not undefined.

- [ ] **Step 3: Add `postTarget` to `SlackContext`**

In `src/gateway/slack/mcp-tools.ts`, add to the `SlackContext` type (after `inboundTs: string;` and its comment, around line 42):
```typescript
  /** When "channel", `reply` posts at channel root (omits thread_ts). Default: thread. */
  postTarget?: "thread" | "channel";
```

- [ ] **Step 4: Branch in `reply`**

In the `reply` handler, change the `chat.postMessage` call (lines 64-69) from:
```typescript
      const r = await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: format(text),
        mrkdwn: true,
      });
```
to:
```typescript
      const r = await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.postTarget === "channel" ? undefined : ctx.threadTs,
        text: format(text),
        mrkdwn: true,
      });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/slack-mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/slack/mcp-tools.ts tests/slack-mcp-tools.test.ts
git commit -m "feat(cron): reply posts to channel root when postTarget=channel"
```

---

## Task 4: Scheduler keys channel jobs on `cron:${job.id}`

**Files:**
- Modify: `src/gateway/slack/cron-scheduler.ts` (`#execute`, threadKey at 60-64)
- Test: `tests/cron-scheduler.test.ts` (the `CronScheduler` describe block)

Current behavior: `thread_ts: job.slackThreadTs ?? "cron:${job.id}"`. We make channel jobs ALWAYS use `cron:${job.id}` regardless of `slackThreadTs`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("CronScheduler", ...)` in `tests/cron-scheduler.test.ts`:

```typescript
  test("channel-target job keys session on cron:id even with slackThreadTs set", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1", slackChannelId: "C123", slackThreadTs: "999.999",
      channelId: "C123", createdBy: "U999", cronExpr: "0 9 * * *",
      prompt: "digest", nextRunAt: now - 1000, target: "channel",
    });
    let capturedKey: any = null;
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: (key: any) => { capturedKey = key; return { id: "sess-1" }; },
        sendMessage: async () => {}, isLive: () => false, on: () => {}, off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(capturedKey.thread_ts).toBe(`cron:${job.id}`);
  });

  test("thread-target job keys session on slackThreadTs", async () => {
    const now = Date.now();
    const job = CronJobs.create({
      slackTeamId: "T1", slackChannelId: "C123", slackThreadTs: "888.888",
      channelId: "C123", createdBy: "U999", cronExpr: "0 9 * * *",
      prompt: "watch", nextRunAt: now - 1000, target: "thread",
    });
    let capturedKey: any = null;
    const scheduler = new CronScheduler({
      agent: {
        ensureSession: (key: any) => { capturedKey = key; return { id: "sess-2" }; },
        sendMessage: async () => {}, isLive: () => false, on: () => {}, off: () => {},
      } as any,
      client: { chat: { postMessage: async () => ({}) } } as any,
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(capturedKey.thread_ts).toBe("888.888");
    void job;
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: FAIL — channel job's `capturedKey.thread_ts` is `"999.999"`, not `cron:${job.id}`.

- [ ] **Step 3: Branch on `job.target`**

In `src/gateway/slack/cron-scheduler.ts`, replace the `threadKey` block (lines 60-64) with:
```typescript
    // Channel-target jobs broadcast to channel root — never bind a real thread, so
    // the session key is always the internal cron id (persistent across runs).
    const threadTs =
      job.target === "channel" ? `cron:${job.id}` : job.slackThreadTs ?? `cron:${job.id}`;
    const threadKey = {
      team_id: job.slackTeamId,
      channel_id: job.slackChannelId,
      thread_ts: threadTs,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cron-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/cron-scheduler.ts tests/cron-scheduler.test.ts
git commit -m "feat(cron): scheduler keys channel jobs on internal cron session id"
```

---

## Task 5: Gateway wiring — create with target, onExecute postTarget, /cron-list tag

**Files:**
- Modify: `src/gateway/core/gateway.ts` (onExecute 168-186; `/cron-list` render ~591; `cron-add` create ~635-646)

No unit test here (gateway is integration-wired); the sim scenario in Task 7 covers it. Verify with `typecheck` + sim.

- [ ] **Step 1: Pass `target` and null thread to `create()`**

In `src/gateway/core/gateway.ts`, in the `cron-add` handler, replace the `CronJobs.create({...})` call (lines 635-645) with:
```typescript
          const job = CronJobs.create({
            slackTeamId: teamId,
            slackChannelId: channelId,
            slackThreadTs: slash.target === "channel" ? undefined : (isDM ? undefined : threadTs),
            channelId,
            threadTs: isDM ? undefined : threadTs,
            createdBy: userId,
            cronExpr: slash.cronExpr,
            prompt: slash.prompt,
            nextRunAt: nextRun,
            target: slash.target,
          });
```

- [ ] **Step 2: Reflect target in the create confirmation**

Replace the confirmation reply (line 646) with:
```typescript
          const where = slash.target === "channel" ? "channel root" : "this thread";
          await reply(`:calendar: cron job created (\`${job.id.slice(0, 8)}\`, posts to ${where}) — next run: <t:${Math.floor(nextRun / 1000)}:R>`);
```

- [ ] **Step 3: Set `postTarget` in `onExecute`**

In the `onExecute` callback, in the `ctx` object literal (lines 170-177), add the `postTarget` field. Replace the `ctx` construction:
```typescript
      const ctx: SlackContext = {
        client: t.client as any,
        channel: job.slackChannelId!,
        threadTs: job.slackThreadTs ?? job.channelId,
        inboundTs: String(Date.now()), // synthetic — no real inbound msg for cron
        userId: job.createdBy,
        teamId: job.slackTeamId ?? undefined,
        postTarget: job.target,
      };
```

- [ ] **Step 4: Add `[target]` tag to `/cron-list`**

Replace the `lines` map in the `cron-list` handler (line 591) with:
```typescript
          const lines = jobs.map((j) => `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` [${j.target}] → ${j.prompt}`);
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/core/gateway.ts
git commit -m "feat(cron): wire target through /cron-add, onExecute, and /cron-list"
```

---

## Task 6: `list_cron_jobs` MCP renderer shows target

**Files:**
- Modify: `src/gateway/slack/mcp-tools.ts` (`listCronJobs` at 339-347)
- Test: `tests/slack-mcp-tools.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/gateway/slack/mcp-tools.ts` change `const adminHandlers = {` (line 338) to `export const adminHandlers = {`.

Then, at the **top of** `tests/slack-mcp-tools.test.ts`, add these imports alongside the existing import line (imports must be top-of-file, not inside a describe block):
```typescript
import { slackHandlers, adminHandlers, type SlackContext } from "../src/gateway/slack/mcp-tools";
import * as CronJobs from "../src/db/cron-jobs";
import { db } from "../src/db/schema";
```
(Replace the existing `import { slackHandlers, type SlackContext } ...` line with the first line above.)

Then add the test describe block at the end of the file:
```typescript
describe("listCronJobs target tag", () => {
  test("renders [channel] tag", async () => {
    db.run("DELETE FROM cron_jobs");
    CronJobs.create({
      channelId: "C1", createdBy: "U1", cronExpr: "0 9 * * *",
      prompt: "digest", nextRunAt: Date.now(), target: "channel",
    });
    const res = await adminHandlers.listCronJobs();
    expect(res.content[0]!.text).toContain("[channel]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/slack-mcp-tools.test.ts`
Expected: FAIL — output has no `[channel]` tag (and/or `adminHandlers` not exported).

- [ ] **Step 3: Add the tag + export**

In `src/gateway/slack/mcp-tools.ts`:
- Ensure `export const adminHandlers = {` (line 338).
- Replace the `lines` map in `listCronJobs` (lines 342-345) with:
```typescript
    const lines = jobs.map(
      (j) =>
        `• \`${j.id.slice(0, 8)}\` \`${j.cronExpr}\` [${j.target}] → ${j.prompt} (next: ${new Date(j.nextRunAt).toISOString()})`,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/slack-mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/mcp-tools.ts tests/slack-mcp-tools.test.ts
git commit -m "feat(cron): list_cron_jobs MCP tool shows [target] tag"
```

---

## Task 7: Sim scenario for channel cron

**Files:**
- Create: `src/gateway/sim/scenarios/cron-channel.yaml`

- [ ] **Step 1: Write the scenario**

Create `src/gateway/sim/scenarios/cron-channel.yaml`:
```yaml
layer: dm
as: manager
steps:
  - send: { text: '/cron-add "0 9 * * 1" "weekly digest" channel' }
  - expect_reply: { contains: "channel root" }
  - send: { text: "/cron-list" }
  - expect_reply: { contains: "[channel]" }
```

- [ ] **Step 2: Run the scenario**

Run: `bun run sim src/gateway/sim/scenarios/cron-channel.yaml`
Expected: scenario passes (both `expect_reply` assertions match).

If the sim CLI takes a different argument form, check an existing run:
`bun run sim --help` or inspect `src/gateway/sim/cli.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/gateway/sim/scenarios/cron-channel.yaml
git commit -m "test(cron): sim scenario for channel-target cron"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `bun test`
Expected: all pass, 0 failures.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Run all cron sim scenarios**

Run each and confirm pass:
```bash
bun run sim src/gateway/sim/scenarios/cron-channel.yaml
bun run sim src/gateway/sim/scenarios/cron-cmds.yaml
bun run sim src/gateway/sim/scenarios/cron-authz.yaml
```
Expected: all pass — the new `target` field did not regress existing cron flows.

- [ ] **Step 4: Final commit (if any stragglers)**

```bash
git status
# commit anything outstanding with a descriptive message
```

---

## Spec Coverage Check

- Data model (`target` column + migration) → Task 1
- Command syntax (optional keyword, corrected regex) → Task 2
- Posting target (`postTarget` flag, `reply` branch only) → Task 3
- Scheduler explicit `job.target` branch → Task 4
- Gateway create (target + `slackThreadTs: null`), onExecute `postTarget`, `/cron-list` tag → Task 5
- Second renderer (`list_cron_jobs` MCP) tag → Task 6
- Existing `commands.test.ts` assertion updated → Task 2 Step 1
- Sim scenario → Task 7
- `add_cron_job` stays thread-only (create default applies) → no code change needed; verified by Task 8 typecheck (existing call compiles unchanged)
