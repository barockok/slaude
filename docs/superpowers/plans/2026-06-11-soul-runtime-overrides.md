# Soul Runtime Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manager-only runtime add/remove overrides for `trustedChannels`, `allowedChannels`, `dmAllowedUsers`, `blockedUsers` — layered over SOUL.md, effective on the next inbound message in every session.

**Architecture:** New `soul_overrides` sqlite table; pure merge function applied inside `soulData()` (the single accessor every gate calls per message → immediacy for free); `/soul` slash command + `soul_override` surface-MCP tool sharing one mutate helper, both gated to `soulData().manager.userId` via the signed inbound Slack user id.

**Tech Stack:** Bun + TypeScript, bun:sqlite, zod, existing gateway seam test harness.

**Spec:** `docs/superpowers/specs/2026-06-11-soul-runtime-overrides-design.md`

---

### Task 1: DB layer — `soul_overrides` table + access module

**Files:**
- Modify: `src/db/schema.ts` (SCHEMA string, after `one_on_one_locks`)
- Create: `src/db/soul-overrides.ts`
- Test: `tests/db/soul-overrides.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/soul-overrides.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../src/db/schema";
import * as SO from "../../src/db/soul-overrides";

describe("soul_overrides db", () => {
  beforeEach(() => db.run("DELETE FROM soul_overrides"));

  it("upserts: latest action for the same (field, value) wins", () => {
    SO.upsert({ field: "trustedChannels", value: "C0NEW", action: "add", created_by: "U0MGR" });
    SO.upsert({ field: "trustedChannels", value: "C0NEW", action: "remove", created_by: "U0MGR" });
    const rows = SO.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("remove");
    expect(rows[0]!.created_by).toBe("U0MGR");
  });

  it("clear(field) deletes only that field; clear() deletes all", () => {
    SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    SO.upsert({ field: "blockedUsers", value: "U0BAD", action: "add", created_by: "U0MGR" });
    SO.clear("trustedChannels");
    expect(SO.list().map((r) => r.field)).toEqual(["blockedUsers"]);
    SO.clear();
    expect(SO.list().length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/soul-overrides.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/soul-overrides'`

- [ ] **Step 3: Implement schema + module**

In `src/db/schema.ts`, append to the SCHEMA string after the `one_on_one_locks` table:

```sql
CREATE TABLE IF NOT EXISTS soul_overrides (
  field      TEXT    NOT NULL CHECK(field IN
              ('trustedChannels','allowedChannels','dmAllowedUsers','blockedUsers')),
  value      TEXT    NOT NULL,
  action     TEXT    NOT NULL CHECK(action IN ('add','remove')),
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (field, value)
);
```

Create `src/db/soul-overrides.ts`:

```ts
import { db } from "./schema";

export type OverrideField =
  | "trustedChannels"
  | "allowedChannels"
  | "dmAllowedUsers"
  | "blockedUsers";
export type OverrideAction = "add" | "remove";

export type OverrideRow = {
  field: OverrideField;
  value: string;
  action: OverrideAction;
  created_by: string;
  created_at: number;
};

/** One verdict per (field, value): an upsert overwrites the previous action. */
export function upsert(i: {
  field: OverrideField;
  value: string;
  action: OverrideAction;
  created_by: string;
}): void {
  db.run(
    `INSERT INTO soul_overrides (field, value, action, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(field, value) DO UPDATE SET
       action = excluded.action,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
    [i.field, i.value, i.action, i.created_by, Date.now()],
  );
}

export function list(): OverrideRow[] {
  return db
    .query(`SELECT * FROM soul_overrides ORDER BY created_at, field, value`)
    .all() as OverrideRow[];
}

export function clear(field?: OverrideField): void {
  if (field) db.run(`DELETE FROM soul_overrides WHERE field = ?`, [field]);
  else db.run(`DELETE FROM soul_overrides`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/db/soul-overrides.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/soul-overrides.ts tests/db/soul-overrides.test.ts
git commit -m "feat(db): soul_overrides table + access module"
```

---

### Task 2: Merge layer — `applyOverrides` + `mutateOverride`

**Files:**
- Create: `src/soul/overrides.ts`
- Test: `tests/soul-overrides-merge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/soul-overrides-merge.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../src/db/schema";
import { SoulDataSchema } from "../src/soul/data";
import { applyOverrides, mutateOverride, FIELD_ALIASES } from "../src/soul/overrides";
import * as SO from "../src/db/soul-overrides";

const base = SoulDataSchema.parse({
  manager: { userId: "U0MGR" },
  trustedChannels: ["C0TEAM"],
  allowedChannels: ["C0PUB"],
});

describe("applyOverrides", () => {
  it("add unions, remove shadows a SOUL.md entry", () => {
    const out = applyOverrides(base, [
      { field: "trustedChannels", value: "C0NEW", action: "add", created_by: "U0MGR", created_at: 1 },
      { field: "allowedChannels", value: "C0PUB", action: "remove", created_by: "U0MGR", created_at: 2 },
      { field: "dmAllowedUsers", value: "U0FRIEND", action: "add", created_by: "U0MGR", created_at: 3 },
    ]);
    expect(out.trustedChannels.sort()).toEqual(["C0NEW", "C0TEAM"]);
    expect(out.allowedChannels).toEqual([]);
    expect(out.dmAllowedUsers).toEqual(["U0FRIEND"]);
    // base untouched (pure)
    expect(base.allowedChannels).toEqual(["C0PUB"]);
  });

  it("duplicate add of a SOUL.md entry stays deduped", () => {
    const out = applyOverrides(base, [
      { field: "trustedChannels", value: "C0TEAM", action: "add", created_by: "U0MGR", created_at: 1 },
    ]);
    expect(out.trustedChannels).toEqual(["C0TEAM"]);
  });

  it("no rows → same reference (no copy cost)", () => {
    expect(applyOverrides(base, [])).toBe(base);
  });
});

describe("mutateOverride", () => {
  beforeEach(() => db.run("DELETE FROM soul_overrides"));

  it("accepts alias fields and strips Slack wrappers", () => {
    const r = mutateOverride(
      { field: "trust", action: "add", value: "<#C0WRAP|general>", by: "U0MGR" },
      { managerId: "U0MGR" },
    );
    expect(r.ok).toBe(true);
    expect(SO.list()[0]).toMatchObject({ field: "trustedChannels", value: "C0WRAP", action: "add" });
  });

  it("rejects malformed ids per field type", () => {
    const r1 = mutateOverride({ field: "trust", action: "add", value: "U0NOTCHANNEL", by: "U0MGR" }, { managerId: "U0MGR" });
    expect(r1.ok).toBe(false);
    const r2 = mutateOverride({ field: "dm", action: "add", value: "C0NOTUSER", by: "U0MGR" }, { managerId: "U0MGR" });
    expect(r2.ok).toBe(false);
    expect(SO.list().length).toBe(0);
  });

  it("refuses to block the manager (self-lockout guard)", () => {
    const r = mutateOverride({ field: "block", action: "add", value: "<@U0MGR>", by: "U0MGR" }, { managerId: "U0MGR" });
    expect(r.ok).toBe(false);
    expect(SO.list().length).toBe(0);
  });
});

describe("FIELD_ALIASES", () => {
  it("maps all four command nouns", () => {
    expect(FIELD_ALIASES).toEqual({
      trust: "trustedChannels",
      allow: "allowedChannels",
      dm: "dmAllowedUsers",
      block: "blockedUsers",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/soul-overrides-merge.test.ts`
Expected: FAIL — `Cannot find module '../src/soul/overrides'`

- [ ] **Step 3: Implement `src/soul/overrides.ts`**

```ts
import type { SoulData } from "./data";
import * as SO from "../db/soul-overrides";
import type { OverrideField, OverrideRow } from "../db/soul-overrides";

/** Command-noun → SoulData field. Single source for slash + MCP surfaces. */
export const FIELD_ALIASES = {
  trust: "trustedChannels",
  allow: "allowedChannels",
  dm: "dmAllowedUsers",
  block: "blockedUsers",
} as const;
export type FieldAlias = keyof typeof FIELD_ALIASES;

const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
const USER_RE = /^[UW][A-Z0-9]+$/;
const CHANNEL_FIELDS: ReadonlySet<OverrideField> = new Set(["trustedChannels", "allowedChannels"]);

/** Pure merge: effective[field] = (base ∪ adds) − removes. Base untouched. */
export function applyOverrides(base: SoulData, rows: OverrideRow[]): SoulData {
  if (rows.length === 0) return base;
  const out: SoulData = { ...base };
  for (const field of Object.values(FIELD_ALIASES)) {
    const adds = rows.filter((r) => r.field === field && r.action === "add").map((r) => r.value);
    const removes = new Set(rows.filter((r) => r.field === field && r.action === "remove").map((r) => r.value));
    if (adds.length === 0 && removes.size === 0) continue;
    out[field] = [...new Set([...base[field], ...adds])].filter((v) => !removes.has(v));
  }
  return out;
}

/** Strip <#C…|name> / <@U…> wrappers down to the raw id. Raw ids pass through. */
export function normalizeId(raw: string): string {
  const m = raw.trim().match(/^<[#@]?([A-Z0-9]+)(\|[^>]*)?>$/);
  return m ? m[1]! : raw.trim();
}

export type MutateResult = { ok: true; field: OverrideField; value: string } | { ok: false; reason: string };

/** Validated write. Authority (manager check) is the CALLER's job — this layer
 *  enforces id shape + the self-lockout guard, and is shared by slash + MCP. */
export function mutateOverride(
  i: { field: FieldAlias | OverrideField; action: "add" | "remove"; value: string; by: string },
  opts: { managerId?: string },
): MutateResult {
  const field: OverrideField = (FIELD_ALIASES as Record<string, OverrideField>)[i.field] ?? (i.field as OverrideField);
  if (!Object.values(FIELD_ALIASES).includes(field)) return { ok: false, reason: `unknown field \`${i.field}\`` };
  const value = normalizeId(i.value);
  const re = CHANNEL_FIELDS.has(field) ? CHANNEL_RE : USER_RE;
  if (!re.test(value)) {
    return { ok: false, reason: `\`${value}\` is not a valid ${CHANNEL_FIELDS.has(field) ? "channel (C…/G…/D…)" : "user (U…/W…)"} id` };
  }
  if (field === "blockedUsers" && i.action === "add" && opts.managerId && value === opts.managerId) {
    return { ok: false, reason: "refusing to block the manager (self-lockout guard)" };
  }
  SO.upsert({ field, value, action: i.action, created_by: i.by });
  console.log(`[soul-override] field=${field} value=${value} action=${i.action} by=${i.by}`);
  return { ok: true, field, value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/soul-overrides-merge.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/soul/overrides.ts tests/soul-overrides-merge.test.ts
git commit -m "feat(soul): override merge + validated mutate helper"
```

---

### Task 3: Wire merge into `soulData()` — the immediacy mechanism

**Files:**
- Modify: `src/soul/extract.ts:163-187` (accessor region)
- Test: extend `tests/soul-overrides-merge.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/soul-overrides-merge.test.ts`)

```ts
import { soulData, soulDataBase, setSoulData, __resetSoulDataMemo } from "../src/soul/extract";

describe("soulData() overlay", () => {
  beforeEach(() => {
    db.run("DELETE FROM soul_overrides");
    setSoulData(base); // memo = base fixture from above
  });

  it("applies overrides on every read — memo path included", () => {
    expect(soulData().trustedChannels).toEqual(["C0TEAM"]);
    SO.upsert({ field: "trustedChannels", value: "C0LIVE", action: "add", created_by: "U0MGR" });
    expect(soulData().trustedChannels.sort()).toEqual(["C0LIVE", "C0TEAM"]); // no reload needed
    SO.upsert({ field: "trustedChannels", value: "C0TEAM", action: "remove", created_by: "U0MGR" });
    expect(soulData().trustedChannels).toEqual(["C0LIVE"]); // shadows SOUL.md entry
  });

  it("soulDataBase() exposes the un-overlaid view (provenance rendering)", () => {
    SO.upsert({ field: "trustedChannels", value: "C0LIVE", action: "add", created_by: "U0MGR" });
    expect(soulDataBase().trustedChannels).toEqual(["C0TEAM"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/soul-overrides-merge.test.ts`
Expected: FAIL — `soulDataBase` not exported / overlay not applied

- [ ] **Step 3: Implement in `src/soul/extract.ts`**

Rename the current `soulData()` body to `soulDataBase()` and layer on top:

```ts
import { applyOverrides } from "./overrides";
import * as SoulOverrides from "../db/soul-overrides";

/** Un-overlaid view of SOUL.md (memo / disk cache / regex fallback).
 *  Use for provenance rendering; gates must use soulData(). */
export function soulDataBase(): SoulData {
  if (memo) return memo;
  try {
    const sha = sha256(loadSoul());
    const cp = cachePath(sha);
    if (existsSync(cp)) {
      return SoulDataSchema.parse(JSON.parse(readFileSync(cp, "utf8")));
    }
  } catch { /* fall through */ }
  return regexFallback();
}

/** Effective soul: (SOUL.md ∪ runtime adds) − runtime removes. Overlay read
 *  per call → an override is live on the next message in every session. */
export function soulData(): SoulData {
  const base = soulDataBase();
  try {
    return applyOverrides(base, SoulOverrides.list());
  } catch {
    return base; // overlay must never take the gates down
  }
}
```

- [ ] **Step 4: Run full suite (not just the new file) — 22 consumers ride this accessor**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all tests pass (soul fixtures inject via setSoulData → memo = base → overlay empty in unrelated tests, behavior unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/soul/extract.ts tests/soul-overrides-merge.test.ts
git commit -m "feat(soul): soulData() applies runtime overrides on every read"
```

---

### Task 4: `/soul` slash command — parse

**Files:**
- Modify: `src/gateway/slack/commands.ts` (SlashHit union, AGENT_COMMANDS, parser)
- Test: `tests/commands.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/commands.test.ts`)

```ts
describe("/soul", () => {
  it("parses add/remove for all four nouns", () => {
    expect(parseSlashCommand("/soul trust add <#C0NEW|general>")).toEqual({
      kind: "soul", field: "trust", action: "add", value: "<#C0NEW|general>",
    });
    expect(parseSlashCommand("/soul allow remove C0PUB")).toEqual({
      kind: "soul", field: "allow", action: "remove", value: "C0PUB",
    });
    expect(parseSlashCommand("/soul dm add <@U0FRIEND>")).toEqual({
      kind: "soul", field: "dm", action: "add", value: "<@U0FRIEND>",
    });
    expect(parseSlashCommand("/soul block add <@U0BAD>")).toEqual({
      kind: "soul", field: "block", action: "add", value: "<@U0BAD>",
    });
  });

  it("parses list and clear", () => {
    expect(parseSlashCommand("/soul list")).toEqual({ kind: "soul-list" });
    expect(parseSlashCommand("/soul clear trust")).toEqual({ kind: "soul-clear", field: "trust" });
    expect(parseSlashCommand("/soul clear all")).toEqual({ kind: "soul-clear", field: "all" });
  });

  it("rejects malformed forms", () => {
    expect(parseSlashCommand("/soul")).toBeNull();
    expect(parseSlashCommand("/soul trust")).toBeNull();
    expect(parseSlashCommand("/soul trust add")).toBeNull();
    expect(parseSlashCommand("/soul trust drop C1")).toBeNull();
    expect(parseSlashCommand("/soul clear bogus")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts`
Expected: FAIL — parser returns null for `/soul …`

- [ ] **Step 3: Implement parser**

SlashHit union additions:

```ts
  | { kind: "soul"; field: "trust" | "allow" | "dm" | "block"; action: "add" | "remove"; value: string }
  | { kind: "soul-list" }
  | { kind: "soul-clear"; field: "trust" | "allow" | "dm" | "block" | "all" };
```

AGENT_COMMANDS additions:

```ts
  { usage: "/soul <trust|allow|dm|block> <add|remove> <id>", summary: "manager-only: runtime override of soul ACLs (channels/users) — immediate, shadows SOUL.md" },
  { usage: "/soul list", summary: "show runtime soul overrides vs SOUL.md base" },
  { usage: "/soul clear <trust|allow|dm|block|all>", summary: "manager-only: drop runtime overrides (revert to SOUL.md)" },
```

Parser branch (before the `HELP_NAMES` check):

```ts
  if (cmd === "soul") {
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub === "list") return { kind: "soul-list" };
    if (sub === "clear") {
      const f = (rest[1] ?? "").toLowerCase();
      if (!["trust", "allow", "dm", "block", "all"].includes(f)) return null;
      return { kind: "soul-clear", field: f as "trust" | "allow" | "dm" | "block" | "all" };
    }
    if (["trust", "allow", "dm", "block"].includes(sub)) {
      const action = (rest[1] ?? "").toLowerCase();
      if (action !== "add" && action !== "remove") return null;
      const value = rest[2]; // case-preserved: ids/wrappers
      if (!value) return null;
      return { kind: "soul", field: sub as "trust" | "allow" | "dm" | "block", action, value };
    }
    return null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/commands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/commands.ts tests/commands.test.ts
git commit -m "feat(commands): parse /soul trust|allow|dm|block add|remove + list/clear"
```

---

### Task 5: Gateway dispatch — manager gate + immediacy seam test

**Files:**
- Modify: `src/gateway/core/gateway.ts` (slash dispatcher, near the `one-on-one` branch ~line 688)
- Test: `tests/gateway/core/gateway-seam.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("createGateway")`; reuse `capturingTransport`, `writeSoulFixture`, `WORLD` — manager is `U0MGR`, trusted `C0TEAM`)

```ts
  describe("/soul runtime overrides", () => {
    const dm = (ts: string, text: string, user = WORLD.manager) => ({
      event: { type: "message", channel: "D_MGR", channel_type: "im", user, team: "T", ts, text },
      context: { teamId: "T" },
    });

    it("manager adds a trusted channel — gate opens on the next message (immediacy)", async () => {
      db.run("DELETE FROM sessions");
      db.run("DELETE FROM soul_overrides");
      process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
      writeSoulFixture(WORLD);
      const cap = capturingTransport();
      const agent = new AgentManager();
      const sends: string[] = [];
      agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
      createGateway(agent, cap.t);

      // C0FRESH is not in the soul fixture: a non-manager message there drops.
      const fresh = (ts: string, text: string) => ({
        event: { type: "message", channel: "C0FRESH", channel_type: "channel", user: "U0RANDO", team: "T", ts, text },
        context: { teamId: "T" },
      });
      // engage via app_mention (U_SLAUDE underscore landmine)
      const args1 = { ...fresh("600.1", "<@U_SLAUDE> hi"), client: cap.t.client };
      await cap.emit("app_mention", { ...args1, event: { ...args1.event, type: "app_mention" } });
      await cap.emit("message", args1);
      expect(sends.length).toBe(0); // unlisted channel, non-manager → dropped

      // manager: /soul allow add C0FRESH (from their DM)
      await cap.emit("message", { ...dm("600.2", "/soul allow add C0FRESH"), client: cap.t.client });
      const confirm = cap.posts.find((p) => String(p.text).includes("C0FRESH"));
      expect(confirm).toBeDefined();

      // same user, same channel, next message → now passes the gate
      const args2 = { ...fresh("600.3", "<@U_SLAUDE> hi again"), client: cap.t.client };
      await cap.emit("app_mention", { ...args2, event: { ...args2.event, type: "app_mention" } });
      await cap.emit("message", args2);
      expect(sends.length).toBe(1);
    });

    it("non-manager /soul refused, store untouched (backup manager too)", async () => {
      db.run("DELETE FROM soul_overrides");
      writeSoulFixture(WORLD);
      const cap = capturingTransport();
      const agent = new AgentManager();
      agent.sendMessage = async () => {};
      createGateway(agent, cap.t);

      // backup manager is NOT enough — owner: "only Manager"
      await cap.emit("message", {
        event: { type: "message", channel: "D_BCK", channel_type: "im", user: WORLD.backup, team: "T", ts: "601.1", text: "/soul allow add C0NOPE" },
        context: { teamId: "T" }, client: cap.t.client,
      });
      const refusal = cap.posts.find((p) => String(p.text).includes("manager-only"));
      expect(refusal).toBeDefined();
      const { list } = await import("../../../src/db/soul-overrides");
      expect(list().length).toBe(0);
    });

    it("/soul block add drops the user's next message; /soul clear reverts", async () => {
      db.run("DELETE FROM sessions");
      db.run("DELETE FROM soul_overrides");
      writeSoulFixture(WORLD);
      const cap = capturingTransport();
      const agent = new AgentManager();
      const sends: string[] = [];
      agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
      createGateway(agent, cap.t);

      const teamMsg = (ts: string, user: string) => {
        const a = { event: { type: "message", channel: WORLD.trusted[0]!, channel_type: "channel", user, team: "T", ts, text: "<@U_SLAUDE> hello" }, context: { teamId: "T" }, client: cap.t.client };
        return Promise.resolve()
          .then(() => cap.emit("app_mention", { ...a, event: { ...a.event, type: "app_mention" } }))
          .then(() => cap.emit("message", a));
      };
      await teamMsg("602.1", "U0NOISY");
      expect(sends.length).toBe(1); // trusted channel: anyone can chat

      await cap.emit("message", { ...dm("602.2", "/soul block add <@U0NOISY>"), client: cap.t.client });
      await teamMsg("602.3", "U0NOISY");
      expect(sends.length).toBe(1); // blocked → dropped

      await cap.emit("message", { ...dm("602.4", "/soul clear block"), client: cap.t.client });
      await teamMsg("602.5", "U0NOISY");
      expect(sends.length).toBe(2); // unblocked → flows again
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/core/gateway-seam.test.ts`
Expected: FAIL — `/soul …` falls through to the model path / no refusal posted

- [ ] **Step 3: Implement dispatcher branch in `src/gateway/core/gateway.ts`**

Imports at top:

```ts
import { mutateOverride, FIELD_ALIASES } from "../../soul/overrides";
import * as SoulOverrides from "../../db/soul-overrides";
import { soulDataBase } from "../../soul/extract";
```

Branch after the `one-on-one` block in the slash dispatcher:

```ts
      if (slash.kind === "soul" || slash.kind === "soul-list" || slash.kind === "soul-clear") {
        // Manager-only — primary manager, NOT backup (owner: "only Manager").
        // Gate on the signed inbound Slack user id before any mutation.
        const soul = soulData();
        if (!soul.manager.userId || userId !== soul.manager.userId) {
          await reply(":lock: `/soul` is manager-only.");
          return;
        }
        if (slash.kind === "soul") {
          const res = mutateOverride(
            { field: slash.field, action: slash.action, value: slash.value, by: userId },
            { managerId: soul.manager.userId },
          );
          await reply(
            res.ok
              ? `:white_check_mark: soul override: \`${res.field}\` ${slash.action} \`${res.value}\` — effective immediately, all sessions.`
              : `:warning: ${res.reason}`,
          );
          return;
        }
        if (slash.kind === "soul-clear") {
          if (slash.field === "all") SoulOverrides.clear();
          else SoulOverrides.clear(FIELD_ALIASES[slash.field]);
          await reply(`:leftwards_arrow_with_hook: soul overrides cleared (\`${slash.field}\`) — reverted to SOUL.md.`);
          return;
        }
        // soul-list: provenance — base vs overlay
        const base = soulDataBase();
        const rows = SoulOverrides.list();
        const lines: string[] = ["*soul runtime overrides*"];
        for (const [alias, field] of Object.entries(FIELD_ALIASES)) {
          const adds = rows.filter((r) => r.field === field && r.action === "add");
          const removes = rows.filter((r) => r.field === field && r.action === "remove");
          const baseIds = base[field];
          if (!adds.length && !removes.length && !baseIds.length) continue;
          lines.push(
            `*${alias}* — soul: ${baseIds.length ? baseIds.map((v) => `\`${v}\``).join(" ") : "_none_"}` +
              (adds.length ? ` | +runtime: ${adds.map((r) => `\`${r.value}\``).join(" ")}` : "") +
              (removes.length ? ` | −masked: ${removes.map((r) => `\`${r.value}\``).join(" ")}` : ""),
          );
        }
        if (lines.length === 1) lines.push("_no overrides, no soul ACL entries_");
        await reply(lines.join("\n"));
        return;
      }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/gateway/core/gateway-seam.test.ts`
Expected: PASS (all, including the 3 new)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts tests/gateway/core/gateway-seam.test.ts
git commit -m "feat(gateway): /soul dispatcher — manager-gated runtime ACL overrides"
```

---

### Task 6: MCP tool — `soul_override` on the surface server

**Files:**
- Modify: `src/gateway/core/surface-mcp.ts` (surfaceTools signature + new tool; createSurfaceMcp passthrough)
- Modify: `src/gateway/core/gateway.ts:241` (pass initiator)
- Test: `tests/gateway/core/soul-override-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/core/soul-override-tool.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../../src/db/schema";
import { surfaceTools } from "../../../src/gateway/core/surface-mcp";
import { setSoulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";
import * as SO from "../../../src/db/soul-overrides";
import type { Surface } from "../../../src/gateway/core/surface";

const fakeSurface: Surface = {
  id: "fake",
  capabilities: new Set() as any,
  reply: async () => ({ ref: "r" }),
  getHistory: async () => ({ messages: [], hasMore: false }),
  requestApproval: async () => ({ approved: true, by: "U0MGR" }),
};

const soul = SoulDataSchema.parse({ manager: { userId: "U0MGR" }, backupManager: { userId: "U0BACKUP" } });

function toolFor(initiator: string | undefined) {
  const defs = surfaceTools(fakeSurface, { initiator: () => initiator });
  const def = defs.find((d) => d.name === "soul_override");
  if (!def) throw new Error("soul_override tool not mounted");
  return def;
}

describe("soul_override MCP tool", () => {
  beforeEach(() => {
    db.run("DELETE FROM soul_overrides");
    setSoulData(soul);
  });

  it("manager-initiated turn mutates the store", async () => {
    const r = await toolFor("U0MGR").handler({ field: "trust", action: "add", value: "C0MCP" });
    expect(JSON.stringify(r)).toContain("C0MCP");
    expect(SO.list()[0]).toMatchObject({ field: "trustedChannels", value: "C0MCP", action: "add" });
  });

  it("non-manager (incl. backup) refused, store untouched", async () => {
    for (const who of ["U0BACKUP", "U0RANDO", undefined]) {
      const r: any = await toolFor(who as any).handler({ field: "block", action: "add", value: "U0X" });
      expect(r.isError).toBe(true);
    }
    expect(SO.list().length).toBe(0);
  });

  it("list action reports provenance without mutating", async () => {
    SO.upsert({ field: "trustedChannels", value: "C0A", action: "add", created_by: "U0MGR" });
    const r: any = await toolFor("U0MGR").handler({ field: "trust", action: "list" });
    expect(r.content[0].text).toContain("C0A");
    expect(SO.list().length).toBe(1);
  });

  it("not mounted when no initiator resolver provided (legacy callers)", () => {
    const defs = surfaceTools(fakeSurface);
    expect(defs.find((d) => d.name === "soul_override")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/core/soul-override-tool.test.ts`
Expected: FAIL — `soul_override tool not mounted`

- [ ] **Step 3: Implement**

`src/gateway/core/surface-mcp.ts` — signature + tool:

```ts
import { mutateOverride, FIELD_ALIASES, type FieldAlias } from "../../soul/overrides";
import * as SoulOverrides from "../../db/soul-overrides";
import { soulData } from "../../soul/extract";

export interface SurfaceMcpOpts {
  /** Resolves the CURRENT turn's inbound platform user id (live getter — the
   *  gateway mutates ctx per turn). Required to mount manager-gated tools. */
  initiator?: () => string | undefined;
}

export function surfaceTools(surface: Surface, opts: SurfaceMcpOpts = {}): SurfaceToolDef[] {
  // ... existing defs unchanged ...

  if (opts.initiator) {
    const initiator = opts.initiator;
    defs.push({
      name: "soul_override",
      description:
        "MANAGER-ONLY. Runtime override of soul ACLs: add/remove trusted channels (trust), public channels (allow), DM allowlist (dm), blocked users (block). Takes effect on the next message in every session and shadows SOUL.md. Refused unless the current turn was initiated by the manager's own Slack message.",
      schema: {
        field: z.enum(["trust", "allow", "dm", "block"]).describe("Which ACL to override."),
        action: z.enum(["add", "remove", "list", "clear"]).describe("list shows provenance; clear drops this field's overrides."),
        value: z.string().optional().describe("Channel (C…/G…/D…) or user (U…/W…) id. Required for add/remove."),
      },
      handler: async ({ field, action, value }) => {
        const soul = soulData();
        const who = initiator();
        // Primary manager only (owner: "only Manager") — checked against the
        // signed inbound Slack user id, not the model's intent.
        if (!soul.manager.userId || who !== soul.manager.userId) {
          return fail("soul_override is manager-only: this turn was not initiated by the manager.");
        }
        if (action === "list") {
          return ok(JSON.stringify(SoulOverrides.list(), null, 2) || "[]");
        }
        if (action === "clear") {
          SoulOverrides.clear(FIELD_ALIASES[field as FieldAlias]);
          return ok(`cleared runtime overrides for ${field}`);
        }
        if (!value) return fail("value is required for add/remove");
        const res = mutateOverride({ field: field as FieldAlias, action, value, by: who }, { managerId: soul.manager.userId });
        return res.ok
          ? ok(`soul override applied: ${res.field} ${action} ${res.value} — effective immediately`)
          : fail(res.reason);
      },
    });
  }

  return defs;
}

export function createSurfaceMcp(surface: Surface, opts: SurfaceMcpOpts = {}): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SURFACE_MCP_NAME,
    version: "0.1.0",
    tools: surfaceTools(surface, opts).map((d) => tool(d.name, d.description, d.schema, d.handler)),
  });
}
```

`src/gateway/core/gateway.ts:241`:

```ts
      [SURFACE_MCP_NAME]: createSurfaceMcp(route.surface, { initiator: () => route.ctx.userId }),
```

- [ ] **Step 4: Run tests + full suite + typecheck**

Run: `bun test tests/gateway/core/soul-override-tool.test.ts && bun run typecheck && bun test`
Expected: all PASS, typecheck clean

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/surface-mcp.ts src/gateway/core/gateway.ts tests/gateway/core/soul-override-tool.test.ts
git commit -m "feat(mcp): soul_override surface tool, gated to manager-initiated turns"
```

---

### Task 7: Finding doc + index

**Files:**
- Create: `docs/findings/2026-06-11-soul-runtime-overrides.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)

- [ ] **Step 1: Write finding doc** — summarize: problem (static SOUL.md ACLs), design decisions (manager-only incl. backup exclusion, full shadow, per-read merge in `soulData()` = immediacy), link spec. Index in CLAUDE.md.

- [ ] **Step 2: Commit**

```bash
git add docs/findings/2026-06-11-soul-runtime-overrides.md CLAUDE.md
git commit -m "docs(findings): soul runtime overrides"
```
