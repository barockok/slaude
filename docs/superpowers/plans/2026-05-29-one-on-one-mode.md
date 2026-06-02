# /1on1 Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-thread engagement lock — while active, slaude listens only to the initiator + manager/backup in that thread; everyone else is silently dropped. Approvers can still approve (button clicks bypass chat gates).

**Architecture:** Dedicated sqlite store (`one_on_one_locks`) + accessor (`db/one-on-one.ts`), mirroring the existing ignore system. A `/1on1` / `/1on1 off` slash command. A gate in `handleMessage` (after channel-mode, before slash parsing) that drops non-allowed users with reason `one_on_one`. 3 simulation transcripts prove the behavior.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`.

**Spec:** `docs/superpowers/specs/2026-05-29-one-on-one-mode-design.md`

---

## Shared types / names (used across tasks)

- Table: `one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at)`, PK `(channel_id, thread_ts)`.
- Accessor `src/db/one-on-one.ts`: `OneOnOneLockRow`, `lock(input)`, `unlock(channelId, threadTs)`, `find(channelId, threadTs)`, `_wipeForTests()`.
- Slash hit: `{ kind: "one-on-one"; action: "on" | "off" }`.
- Drop reason label: `one_on_one`.
- Reply strings: lock → contains `1on1 mode`; release → contains `released`; no-active → `No active 1on1`.

---

## Task 1: `one_on_one_locks` table + accessor

**Files:**
- Modify: `src/db/schema.ts` (add table to the `SCHEMA` string, before the closing backtick at the end of the `connection_audit` block, ~line 143)
- Create: `src/db/one-on-one.ts`
- Test: `tests/db/one-on-one.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/one-on-one.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import * as OneOnOne from "../../src/db/one-on-one";

beforeEach(() => OneOnOne._wipeForTests());

describe("one_on_one store", () => {
  it("lock then find returns the row", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    const row = OneOnOne.find("C1", "1.0");
    expect(row?.locked_user).toBe("U_A");
    expect(row?.created_by).toBe("U_A");
    expect(typeof row?.created_at).toBe("number");
  });

  it("find returns null when no lock", () => {
    expect(OneOnOne.find("C1", "nope")).toBeNull();
  });

  it("lock upserts — re-locking the same thread replaces the locked_user", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_B", createdBy: "U_B" });
    expect(OneOnOne.find("C1", "1.0")?.locked_user).toBe("U_B");
  });

  it("unlock removes the row", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    OneOnOne.unlock("C1", "1.0");
    expect(OneOnOne.find("C1", "1.0")).toBeNull();
  });

  it("locks are scoped per (channel, thread)", () => {
    OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    expect(OneOnOne.find("C2", "1.0")).toBeNull();
    expect(OneOnOne.find("C1", "2.0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/one-on-one.test.ts`
Expected: FAIL — cannot find module `../../src/db/one-on-one`.

- [ ] **Step 3: Add the table to the schema**

In `src/db/schema.ts`, inside the `const SCHEMA = \`...\`` template string, immediately
after the `connection_audit` table's closing `);` and before the closing backtick (around
line 143), add:

```sql

CREATE TABLE IF NOT EXISTS one_on_one_locks (
  channel_id  TEXT    NOT NULL,
  thread_ts   TEXT    NOT NULL,
  locked_user TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
```

(The existing `for (const stmt of SCHEMA.split(";")) { ... db.run(s) }` loop creates it
idempotently — no migration code needed.)

- [ ] **Step 4: Implement the accessor**

```ts
// src/db/one-on-one.ts
import { db } from "./schema";

export interface OneOnOneLockRow {
  channel_id: string;
  thread_ts: string;
  locked_user: string;
  created_by: string;
  created_at: number;
}

/** Lock a thread to a single speaker. Upserts: re-locking the same thread replaces. */
export function lock(input: { channelId: string; threadTs: string; lockedUser: string; createdBy: string }): void {
  db.run(
    `INSERT INTO one_on_one_locks (channel_id, thread_ts, locked_user, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET locked_user = excluded.locked_user, created_by = excluded.created_by, created_at = excluded.created_at`,
    [input.channelId, input.threadTs, input.lockedUser, input.createdBy, Date.now()],
  );
}

export function unlock(channelId: string, threadTs: string): void {
  db.run("DELETE FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export function find(channelId: string, threadTs: string): OneOnOneLockRow | null {
  const row = db
    .query("SELECT * FROM one_on_one_locks WHERE channel_id = ? AND thread_ts = ?")
    .get(channelId, threadTs) as any;
  return row ? (row as OneOnOneLockRow) : null;
}

export function _wipeForTests(): void {
  db.run("DELETE FROM one_on_one_locks");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/db/one-on-one.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/one-on-one.ts tests/db/one-on-one.test.ts
git commit -m "feat(db): one_on_one_locks table + accessor"
```

---

## Task 2: `/1on1` slash parsing

**Files:**
- Modify: `src/gateway/slack/commands.ts` (SlashHit union + parse + help line)
- Test: `tests/gateway/slack/commands-1on1.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/slack/commands-1on1.test.ts
import { describe, it, expect } from "bun:test";
import { parseSlashCommand } from "../../../src/gateway/slack/commands";

describe("/1on1 parsing", () => {
  it("bare /1on1 → on", () => {
    expect(parseSlashCommand("/1on1")).toEqual({ kind: "one-on-one", action: "on" });
  });
  it("/1on1 on → on", () => {
    expect(parseSlashCommand("/1on1 on")).toEqual({ kind: "one-on-one", action: "on" });
  });
  it("/1on1 off → off", () => {
    expect(parseSlashCommand("/1on1 off")).toEqual({ kind: "one-on-one", action: "off" });
  });
  it("non-slash is null", () => {
    expect(parseSlashCommand("1on1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/slack/commands-1on1.test.ts`
Expected: FAIL — `parseSlashCommand("/1on1")` returns `null` (no case yet).

- [ ] **Step 3: Add the SlashHit variant**

In `src/gateway/slack/commands.ts`, add to the `SlashHit` union (after the `cron-remove` line):

```ts
  | { kind: "one-on-one"; action: "on" | "off" }
```

- [ ] **Step 4: Add the parse case**

In `parseSlashCommand`, before the `if (HELP_NAMES.has(cmd))` block, add:

```ts
  if (cmd === "1on1") {
    return { kind: "one-on-one", action: arg === "off" ? "off" : "on" };
  }
```

(`arg` is already `rest.join(" ").toLowerCase()`. Bare `/1on1` → `arg === ""` → `on`.)

- [ ] **Step 5: Add a help line**

In `helpText()`, add to the returned array (after the `/ingest` line):

```ts
    "`/1on1` / `/1on1 off` — lock this thread to you + the manager (others ignored); release",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/gateway/slack/commands-1on1.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/slack/commands.ts tests/gateway/slack/commands-1on1.test.ts
git commit -m "feat(commands): /1on1 slash parsing + help line"
```

---

## Task 3: 1on1 gate + slash handler in the gateway

**Files:**
- Modify: `src/gateway/core/gateway.ts` (import; gate after channel-mode; slash handler branch)

This task has no standalone unit test — it is verified by the simulation transcripts in
Task 4 (the gateway needs the sim harness to drive it). Verify here with `typecheck` + the
full suite (no regression), then Task 4 proves behavior.

- [ ] **Step 1: Add the import**

At the top of `src/gateway/core/gateway.ts`, near the other `db` imports (e.g. after
`import * as Ignores from "../../db/ignores";`), add:

```ts
import * as OneOnOne from "../../db/one-on-one";
```

- [ ] **Step 2: Add the gate after the channel-mode (whitelist) gate**

The channel-mode gate block ends around line 384 (it closes the `{ ... }` that contains the
`reason: "whitelist"` drop). Immediately AFTER that block and BEFORE the
`const botUserId = ...` / `const stripped = ...` lines (i.e. before slash parsing), insert:

```ts
    // 1on1 lock: while active, only the locked user + manager/backup are heard in
    // this thread. Runs after channel-mode (so it overrides "anyone can chat" in
    // trusted/allowed channels) and before slash parsing (so a non-allowed user
    // cannot /1on1 off to hijack someone else's lock). Approval buttons are
    // unaffected — they go through ApprovalGate's action handler, not this path.
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

(`userId`, `channelId`, `threadTs`, `soulData`, `metric` are all already in scope at this
point in `handleMessage`.)

- [ ] **Step 3: Add the slash handler branch**

Inside the `if (slash) { ... }` block (the `reply` helper is defined at its top, ~line
399), add a branch alongside the other `slash.kind === ...` branches (e.g. after the
`help`/`mode` branches, before the `ignore` branch):

```ts
      if (slash.kind === "one-on-one") {
        if (slash.action === "on") {
          OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
          await reply(`:lock: *1on1 mode* — only <@${userId}> and the manager will be heard in this thread. \`/1on1 off\` to release.`);
          return;
        }
        // action === "off": the gate above guarantees the sender is the locked
        // user or a manager, so they are allowed to release.
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

- [ ] **Step 4: Verify typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: clean; all existing tests still green (this adds a branch + a gate, no behavior
change to existing paths). Behavior is proven in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts
git commit -m "feat(gateway): /1on1 engagement-lock gate + slash handler"
```

---

## Task 4: Simulation transcripts (consistency proof)

**Files:**
- Create: `src/gateway/sim/scenarios/one-on-one-lock.yaml`
- Create: `src/gateway/sim/scenarios/one-on-one-authz.yaml`
- Create: `src/gateway/sim/scenarios/one-on-one-manager-release.yaml`

The suite runner `tests/gateway/sim/scenarios.test.ts` auto-discovers and runs every
`*.yaml` in that directory — no test file change needed.

- [ ] **Step 1: Write the lock/drop/release transcript**

```yaml
# src/gateway/sim/scenarios/one-on-one-lock.yaml
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

- [ ] **Step 2: Write the authz transcript (non-allowed user cannot release)**

```yaml
# src/gateway/sim/scenarios/one-on-one-authz.yaml
preset: member-trusted
steps:
  - send: { as: U0ALICE, channel: C0TEAM, text: "/1on1" }
  - expect_reply: { contains: "1on1 mode" }
  - send: { as: U0BOB,   channel: C0TEAM, text: "/1on1 off" }
  - expect_drop: { reason: one_on_one }
  - send: { as: U0ALICE, channel: C0TEAM, text: "mine" }
  - expect_reply: { contains: "ack" }
```

- [ ] **Step 3: Write the manager-override transcript**

```yaml
# src/gateway/sim/scenarios/one-on-one-manager-release.yaml
preset: member-trusted
steps:
  - send: { as: U0ALICE, channel: C0TEAM, text: "/1on1" }
  - expect_reply: { contains: "1on1 mode" }
  - send: { as: U0MGR,   channel: C0TEAM, text: "/1on1 off" }
  - expect_reply: { contains: "released" }
```

- [ ] **Step 4: Run the scenarios + full suite**

Run: `bun test tests/gateway/sim/scenarios.test.ts && bun test`
Expected: the three new `one-on-one-*.yaml` scenarios PASS (alongside the existing ones);
full suite green.

Also smoke via the CLI:
Run: `bun sim run src/gateway/sim/scenarios/one-on-one-*.yaml`
Expected: `✓` for all three, exit 0.

If a token mismatch occurs (e.g. the lock reply wording), run the single failing scenario
(`bun sim run src/gateway/sim/scenarios/<file>.yaml`), read the bus dump in the thrown
error, and align the `contains:` token with the actual reply text from Task 3. Do NOT
change the gateway reply wording to match the test unless the wording is genuinely wrong.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/scenarios/one-on-one-lock.yaml src/gateway/sim/scenarios/one-on-one-authz.yaml src/gateway/sim/scenarios/one-on-one-manager-release.yaml
git commit -m "test(sim): /1on1 lock/authz/manager-release transcripts"
```

---

## Task 5: Docs

**Files:**
- Modify: `README.md` (one line under the commands/usage area)
- Create: `docs/findings/2026-05-29-one-on-one-mode.md`
- Modify: `CLAUDE.md` (Findings Log index — newest first)

- [ ] **Step 1: README**

Add a `/1on1` line wherever slaude's slash commands or Slack usage are documented (search
README for `/mode` or `/ingest` and add alongside):

```markdown
- `/1on1` (and `/1on1 off`) — lock the current thread to you + the manager; everyone else is ignored until released. Approvers can still approve.
```

- [ ] **Step 2: Finding doc**

```markdown
# 2026-05-29 — /1on1 mode (per-thread engagement lock)

**What:** `/1on1` locks a thread so slaude listens only to the initiator + manager/backup;
others are silently dropped (reason `one_on_one`). `/1on1 off` (initiator or manager)
releases. Persistent in sqlite (`one_on_one_locks`), survives restart.

**Design:** Dedicated store + accessor (`db/one-on-one.ts`), mirroring the ignore system.
The gate sits in `handleMessage` after the channel-mode gate (so it overrides "anyone can
chat" in trusted/allowed channels) and before slash parsing (so a non-allowed user can't
`/1on1 off` to hijack a lock). Approval buttons are untouched — they go through
`ApprovalGate`'s action handler, independent of chat engagement, so approvers still approve.

**Verification:** unit tests for the store + slash parser; three simulation transcripts
(`one-on-one-lock`, `one-on-one-authz`, `one-on-one-manager-release`) drive the real gate
with no Slack.

**Deferred:** duration/auto-expiry, cross-thread per-user 1on1, a dedicated sim preset.
```

- [ ] **Step 3: CLAUDE.md index**

Add to the Findings Log (newest first, above the simulation-gateway line):

```markdown
- [2026-05-29 — /1on1 mode (per-thread engagement lock)](docs/findings/2026-05-29-one-on-one-mode.md)
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/findings/2026-05-29-one-on-one-mode.md CLAUDE.md
git commit -m "docs(1on1): README usage + finding + index"
```

---

## Final verification

- [ ] `bun run typecheck && bun test` — all green.
- [ ] `bun sim run` — all scenario transcripts (including the 3 new ones) pass, exit 0.
- [ ] Complete the branch with **superpowers:finishing-a-development-branch**.

---

## Self-review notes (author)

- **Spec coverage:** data model (T1), slash command (T2), gate + handler (T3), sim
  transcripts (T4), docs (T5). All spec sections mapped.
- **Type consistency:** `OneOnOne.lock/unlock/find` + `OneOnOneLockRow.locked_user` used
  identically in T1, T3. SlashHit `{kind:"one-on-one",action}` consistent T2↔T3. Drop
  reason `one_on_one` consistent T3↔T4. Reply tokens (`1on1 mode`, `released`) consistent
  T3↔T4.
- **No new env, no migration** — `CREATE TABLE IF NOT EXISTS` via the existing schema loop.
