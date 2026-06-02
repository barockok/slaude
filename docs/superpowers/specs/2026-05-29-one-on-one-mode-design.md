# /1on1 Mode — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm)
**Goal:** A per-thread engagement lock. While active, slaude listens only to the
**initiator** and the **manager/backup** in that thread; everyone else is silently
dropped. Approvers can still approve (button clicks are independent of chat engagement).

---

## Problem

In a trusted/allowed channel anyone can address slaude (the channel-mode gate admits the
whole channel). Sometimes a user wants a focused, private-feeling exchange in a thread
without other members' messages being picked up. `/1on1` locks the thread to one speaker
(plus the manager as override) until released.

## Constraints / decisions (from brainstorm)

- **Allowed speakers while locked:** `{ locked_user (initiator), manager, backup_manager }`.
- **Who toggles:** the engaged speaker turns it on (they become `locked_user`); the
  initiator OR manager/backup turns it off. (A non-allowed user can't reach the slash
  handler — the gate drops them first — so they can neither hijack nor release.)
- **Lifetime:** persistent in sqlite, survives restart, released only by explicit `/1on1 off`.
- **Approvers:** unaffected — they approve via Block Kit buttons handled by `ApprovalGate`'s
  action handler, which never consults the chat-engagement gates.
- **Dropped users:** silent (metric + log), consistent with the existing engagement /
  whitelist / ignore drops.
- **Store:** dedicated table + accessor module, mirroring the existing **ignore** system
  (`db/ignores.ts` + `IgnoreGate`). Not folded into the `sessions` row.

## Architecture

### 1. Data model — dedicated store

`src/db/schema.ts` adds:

```sql
CREATE TABLE IF NOT EXISTS one_on_one_locks (
  channel_id  TEXT    NOT NULL,
  thread_ts   TEXT    NOT NULL,
  locked_user TEXT    NOT NULL,   -- initiator; sole non-manager speaker
  created_by  TEXT    NOT NULL,   -- same as locked_user for now; kept distinct for audit
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
```

`src/db/one-on-one.ts` (accessor; same shape/style as `db/ignores.ts`):

```ts
export interface OneOnOneLockRow {
  channel_id: string; thread_ts: string;
  locked_user: string; created_by: string; created_at: number;
}
export function lock(input: { channelId: string; threadTs: string; lockedUser: string; createdBy: string }): void; // INSERT OR REPLACE
export function unlock(channelId: string, threadTs: string): void;
export function find(channelId: string, threadTs: string): OneOnOneLockRow | null;
export function _wipeForTests(): void;
```

`lock` upserts (`INSERT ... ON CONFLICT(channel_id,thread_ts) DO UPDATE`). Timestamps are
passed by the caller as `Date.now()` (keeps the module pure/testable).

### 2. Slash command

`src/gateway/slack/commands.ts`:

```ts
// add to SlashHit union:
| { kind: "one-on-one"; action: "on" | "off" }
```

Parse, inside `parseSlashCommand`:

```ts
if (cmd === "1on1" || cmd === "1on1-mode") {
  return { kind: "one-on-one", action: arg === "off" ? "off" : "on" };
}
```

(`arg` is the already-lowercased remainder. Bare `/1on1` or `/1on1 on` → `on`; `/1on1 off`
→ `off`.) Add a `/help` line: `` `/1on1` / `/1on1 off` — lock this thread to you + the manager; release ``.

### 3. The gate (in `handleMessage`, `src/gateway/core/gateway.ts`)

Insert a check AFTER the existing channel-mode (whitelist) gate and BEFORE slash parsing:

```ts
// 1on1 lock: while active, only the locked user + manager/backup are heard.
{
  const lock = OneOnOne.find(channelId, threadTs);
  if (lock) {
    const soul = soulData();
    const isMgr = userId === soul.manager.userId || userId === soul.backupManager.userId;
    if (userId !== lock.locked_user && !isMgr) {
      console.log(`[slack-rx] drop ch=${channelId} user=${userId} thread=${threadTs} — 1on1 locked to ${lock.locked_user}`);
      metric.slackDropsTotal.inc({ reason: "one_on_one" });
      return;
    }
  }
}
```

Placement rationale:
- *After channel-mode:* overrides "anyone can chat" in trusted/allowed channels.
- *Before slash handling:* a non-allowed user's messages — including any `/1on1 off`
  attempt — are dropped, so they can't hijack or release someone else's lock. Allowed
  users (initiator + manager) pass through, so their `/1on1 off` is handled normally.
- The very first `/1on1 on` sees `lock === null` → passes the gate → the slash handler
  creates the lock.

### 4. Slash handling (after the gate, in `handleMessage`)

Within the existing `if (slash) { ... }` block:

```ts
if (slash.kind === "one-on-one") {
  if (slash.action === "on") {
    OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
    await reply(`:lock: *1on1 mode* — only <@${userId}> and the manager will be heard in this thread. \`/1on1 off\` to release.`);
    return;
  }
  // action === "off" — gate guarantees sender is locked_user or manager
  const existing = OneOnOne.find(channelId, threadTs);
  if (!existing) {
    await reply("No active 1on1 in this thread.");
    return;
  }
  OneOnOne.unlock(channelId, threadTs);
  await reply(":unlock: 1on1 released — the thread is open again.");
  return;
}
```

`reply` is the local helper already used by the other slash branches
(`client.chat.postMessage` to `channelId`/`threadTs`). No agent turn is started for slash
commands.

### 5. Interaction notes

- **Engagement gate:** the locked thread is already engaged (it was engaged when `/1on1`
  ran). The locked user keeps chatting without re-`@mention`. A non-allowed user who
  `@mentions` slaude passes the engagement gate but is then dropped by the 1on1 gate
  (`one_on_one`).
- **DM:** a DM is already 1:1; `/1on1` there is effectively a no-op lock (only the manager
  reaches DMs anyway). Allowed but uninteresting — no special-casing.
- **No new env, no migration tooling:** the table is created idempotently by the existing
  schema bootstrap (`CREATE TABLE IF NOT EXISTS`).

## Simulation coverage (consistency proof)

`/1on1` replies are gateway-direct (no agent turn), so the sim's existing `member-trusted`
preset + step-level `as` drives everything; no new stub behavior or preset needed. The
sim engine already captures the `one_on_one` drop reason (it wraps
`metric.slackDropsTotal.inc`).

New `src/gateway/sim/scenarios/`:

- `one-on-one-lock.yaml`
  ```yaml
  preset: member-trusted
  steps:
    - send: { as: U0ALICE, channel: C0TEAM, text: "/1on1" }
    - expect_reply: { contains: "1on1 mode" }
    - send: { as: U0BOB,   channel: C0TEAM, text: "hi slaude" }
    - expect_drop: { reason: one_on_one }
    - send: { as: U0ALICE, channel: C0TEAM, text: "still here" }
    - expect_reply: { contains: "ack" }
    - send: { as: U0MGR,   channel: C0TEAM, text: "manager check" }
    - expect_reply: { contains: "ack" }
    - send: { as: U0ALICE, channel: C0TEAM, text: "/1on1 off" }
    - expect_reply: { contains: "released" }
    - send: { as: U0BOB,   channel: C0TEAM, text: "back?" }
    - expect_reply: { contains: "ack" }
  ```
- `one-on-one-authz.yaml` — non-allowed user can't release someone else's lock:
  ```yaml
  preset: member-trusted
  steps:
    - send: { as: U0ALICE, channel: C0TEAM, text: "/1on1" }
    - expect_reply: { contains: "1on1 mode" }
    - send: { as: U0BOB,   channel: C0TEAM, text: "/1on1 off" }
    - expect_drop: { reason: one_on_one }
    - send: { as: U0ALICE, channel: C0TEAM, text: "mine" }
    - expect_reply: { contains: "ack" }
  ```
- `one-on-one-manager-release.yaml` — manager overrides:
  ```yaml
  preset: member-trusted
  steps:
    - send: { as: U0ALICE, channel: C0TEAM, text: "/1on1" }
    - expect_reply: { contains: "1on1 mode" }
    - send: { as: U0MGR,   channel: C0TEAM, text: "/1on1 off" }
    - expect_reply: { contains: "released" }
  ```

These auto-run via `tests/gateway/sim/scenarios.test.ts`.

## Testing

- **Unit:** `tests/db/one-on-one.test.ts` — `lock` insert + upsert (re-lock same thread
  replaces), `find` hit/miss, `unlock`, `_wipeForTests`. `parseSlashCommand` cases for
  `/1on1`, `/1on1 on`, `/1on1 off`.
- **Integration:** the 3 sim transcripts above (lock → drop others → manager heard →
  release → reopened; authz; manager override).

## YAGNI / deferred

- Duration / auto-expiry (`/1on1 30m`) — explicit `/1on1 off` only for v1.
- Per-user (cross-thread) 1on1 — scope is per-thread.
- A dedicated `one-on-one` sim preset — `member-trusted` + step `as` suffices; add later if
  manual REPL use warrants it.
- Notifying the dropped user — silent, matching existing drop behavior.

## File layout

```
src/db/schema.ts            # + one_on_one_locks table (CREATE TABLE IF NOT EXISTS)
src/db/one-on-one.ts        # lock / unlock / find / _wipeForTests
src/gateway/slack/commands.ts  # + SlashHit one-on-one + parse + help line
src/gateway/core/gateway.ts    # + 1on1 gate (handleMessage) + slash handler branch
src/gateway/sim/scenarios/one-on-one-lock.yaml
src/gateway/sim/scenarios/one-on-one-authz.yaml
src/gateway/sim/scenarios/one-on-one-manager-release.yaml
tests/db/one-on-one.test.ts
tests/gateway/slack/commands-1on1.test.ts   # parse cases
```

## Branch

`feat/one-on-one-mode`, stacked on `feat/contextual-mcp-connections` (PR #8) — the 1on1
gate edits `src/gateway/core/gateway.ts`, which exists only on that branch. When #8 merges,
rebase onto `main`.
