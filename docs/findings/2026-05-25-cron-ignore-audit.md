# Cron & Ignore System Audit

Full audit of `CronScheduler` and ignore-gate MCP tools before refactor.

## Cron Execution — Silent Failure

**Root cause chain:**

1. `CronScheduler.#execute()` creates synthetic session: `team_id="cron"`, `channel_id="cron:${job.id}"`. `src/gateway/slack/cron-scheduler.ts:48-52`
2. No route registered in adapter's `routes` Map. `src/gateway/slack/adapter.ts:119`
3. Agent event handler: `routes.get(e.sessionId)` returns undefined → early return. `adapter.ts:158-159`
4. All agent events (`done`, `error`, `toolCall`) silently dropped for cron sessions.
5. MCP resolver returns undefined for no-route → cron session has **zero Slack tools**. `adapter.ts:142-154`
6. Agent can't call `mcp__slaude_slack__reply` → response vanishes.
7. `postResult()` dead code — zero call sites. `cron-scheduler.ts:71`
8. `next_run` updates with "dispatched" status **before** agent finishes. `cron-scheduler.ts:61`

**Impact:** Cron jobs fire, agent runs, but zero Slack output. DB looks healthy (next_run advances) but user sees nothing.

## Cron Session Reuse & Race Condition

- `ensureSession` uses deterministic thread key → same session row across all runs. `src/agent/manager.ts:112-126`
- Working dir shared across runs → files from run 1 persist for run 2.
- `#running` Set cleared in `finally` block after `sendMessage` resolves, **not** after agent completes. `cron-scheduler.ts:46-66`
- If agent turn duration > cron interval, overlapping execution possible. Second run flushes prior live turn or starts overlapping session.

## remove_cron_job MCP Tool Bugs

1. **Description lies:** says "8-char prefix" accepted, but `findById()` does exact UUID match. Prefix → "Job not found" error. `db/cron-jobs.ts:34`
2. **Soft delete only:** `deactivate()` sets `active = 0`. Row stays forever. Tool says "deactivated" not "deleted".

## ignore_thread / unignore_thread MCP Tool Bugs

1. **No auth check:** `ignore_thread` / `unignore_thread` have zero permission validation. Any agent can ignore any thread. Compare: slash command `/ignore` requires manager/approver. `mcp-tools.ts:499-538` vs `adapter.ts:372-376`
2. **Duration parsing bugs:**
   - Invalid suffix silently accepted: `"5x"` → parsed as 5 minutes.
   - Decimal silently truncated: `"1.5h"` → parsed as 1 hour.
   - No max duration limit.
3. **DM broken:** `threadTs = event.ts` for regular DM messages (no `event.thread_ts`) → unique per message. `ignore_thread` only ignores that exact message; next DM flows through. `adapter.ts:261`
4. **Silent no-op:** `unignore_thread` returns "removed" even if no active ignore existed.
5. **createdBy hardcoded:** `"agent"` instead of actual user ID. `mcp-tools.ts:526`
6. **Missing tools:** No `ignore_user` / `unignore_user` MCP tools. DB supports user-level ignore; only slash commands can create them.

## Design Decision: Cron as Regular Thread Session

**Current model:** Synthetic isolated session. Cron and human conversation are separate worlds.

**New model:** One thread = one session. Cron uses real Slack thread key.

- `/cron-add` in thread #123 → job stores real `(team_id, channel_id, thread_ts)`
- All cron runs resume same session, post to same thread
- Humans reply in same thread → same session, shared history
- Cron skips if session live (humans get priority, no interruption)

**Benefits:**
- Natural human engagement — people can refine, query, adjust cron tasks
- No synthetic session complexity
- Single conversation history

**Tradeoff:** Cron and human are mutually exclusive on same thread. If humans actively chatting, cron waits next interval.

**Migration:**
- `cron_jobs` table: store real `slack_team_id`, `slack_channel_id`, `slack_thread_ts`
- Remove synthetic key usage from `CronScheduler`
- `postResult()` becomes unnecessary — agent uses normal MCP reply
- Adapter registers route for cron sessions same as human messages

## Files to Touch

- `src/db/schema.ts` — add real Slack keys to `cron_jobs`
- `src/db/cron-jobs.ts` — read/write real keys, prefix lookup for remove
- `src/gateway/slack/cron-scheduler.ts` — use real keys, skip-if-live, remove postResult
- `src/gateway/slack/adapter.ts` — wire cron routes into normal flow
- `src/gateway/slack/mcp-tools.ts` — auth checks, duration validation, ignore_user tools
- `src/gateway/slack/ignore-gate.ts` — DM handling (if fixing)
