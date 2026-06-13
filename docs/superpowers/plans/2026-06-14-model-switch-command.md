# `/model` Per-Thread Model Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/model [id]` Slack slash command that shows or sets the current thread's session model, validating ids against the live provider model list.

**Architecture:** A new `listModels()` helper fetches `GET /v1/models` (5-min in-memory cache, same auth pattern as `soul/extract.ts`). `AgentManager.setSessionModel()` swaps the model on the live SDK Query and persists to `sessions.model`. The parser gains a `model` branch; the gateway dispatch gates on manager/backup/approver, lists on no-arg, validates+applies on arg (pass-through + warn when the provider has no `/v1/models`).

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `@anthropic-ai/claude-agent-sdk`, `bun test`.

Spec: `docs/superpowers/specs/2026-06-14-model-switch-command-design.md`

---

## File Structure

- Create: `src/agent/models.ts` — `listModels()` + 5-min cache. Provider fetch only; no DB, no Slack.
- Create: `src/gateway/slack/model-auth.ts` — `canChangeModel(userId, soul)` predicate (manager + backup + approver).
- Create: `tests/models.test.ts` — cache TTL + fallback behavior.
- Create: `tests/model-auth.test.ts` — ACL predicate.
- Modify: `src/db/sessions.ts` — add `setModel(id, model)`.
- Modify: `src/agent/manager.ts` — add `setSessionModel(sessionId, model)`.
- Modify: `src/gateway/slack/commands.ts` — `SlashHit` `model` variant, `AGENT_COMMANDS` entry, parser branch.
- Modify: `src/gateway/core/gateway.ts` — dispatch block.
- Modify: `tests/commands.test.ts` — parser cases.

---

## Task 1: `setModel` DB writer

**Files:**
- Modify: `src/db/sessions.ts:90-96` (add after `setPermissionMode`)

- [ ] **Step 1: Add the writer**

After the `setPermissionMode` function (ends line 96), add:

```ts
export function setModel(id: string, model: string) {
  db.run(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`, [
    model,
    Date.now(),
    id,
  ]);
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit` (or the repo's typecheck script — check `package.json`)
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/sessions.ts
git commit -m "feat(db): sessions.setModel writer"
```

---

## Task 2: `listModels()` provider fetch + cache

**Files:**
- Create: `src/agent/models.ts`
- Create: `tests/models.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/models.test.ts`:

```ts
import { afterEach, describe, expect, test, mock } from "bun:test";
import { listModels, __resetModelCache } from "../src/agent/models";

const origFetch = globalThis.fetch;
const origKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = origKey;
  __resetModelCache();
});

describe("listModels", () => {
  test("maps provider data to {id, display_name}", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-8", display_name: "Opus 4.8" }] }),
        { status: 200 },
      ),
    ) as any;
    expect(await listModels()).toEqual([{ id: "claude-opus-4-8", display_name: "Opus 4.8" }]);
  });

  test("caches within TTL (single fetch for two calls)", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const f = mock(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    globalThis.fetch = f as any;
    await listModels();
    await listModels();
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("throws on non-200", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as any;
    expect(listModels()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/models.test.ts`
Expected: FAIL — cannot find module `../src/agent/models`.

- [ ] **Step 3: Write the implementation**

Create `src/agent/models.ts`:

```ts
export interface ModelInfo {
  id: string;
  display_name: string;
}

const TTL_MS = 5 * 60 * 1000;
let cache: { data: ModelInfo[]; fetchedAtMs: number } | null = null;

/** Test-only: clear the module cache between cases. */
export function __resetModelCache(): void {
  cache = null;
}

/**
 * Fetch the provider's available models from `GET /v1/models`. Returns the
 * exact `id` strings to pass to the SDK `options.model` / `Query.setModel()`.
 *
 * Auth + base URL mirror `soul/extract.ts`: API key wins over OAuth; OAuth
 * needs the anthropic-beta header. Result cached in-memory for 5 minutes.
 * Throws on missing auth, non-200, or network error — callers treat any throw
 * as "can't verify" (pass-through + warn).
 */
export async function listModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.fetchedAtMs < TTL_MS) return cache.data;

  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const key = process.env.ANTHROPIC_API_KEY;
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!key && !oauth) {
    throw new Error("missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  }
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (key) {
    headers["x-api-key"] = key;
  } else {
    headers["authorization"] = `Bearer ${oauth}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const res = await fetch(`${base.replace(/\/$/, "")}/v1/models?limit=100`, { headers });
  if (!res.ok) throw new Error(`models list http ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  const data: ModelInfo[] = (body.data ?? []).map((m) => ({
    id: m.id,
    display_name: m.display_name ?? m.id,
  }));
  cache = { data, fetchedAtMs: Date.now() };
  return data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/models.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/models.ts tests/models.test.ts
git commit -m "feat(agent): listModels provider fetch with 5m cache"
```

---

## Task 3: `canChangeModel` ACL predicate

**Files:**
- Create: `src/gateway/slack/model-auth.ts`
- Create: `tests/model-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/model-auth.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canChangeModel } from "../src/gateway/slack/model-auth";
import type { SoulData } from "../src/soul/data";

const soul = {
  manager: { userId: "MGR" },
  backupManager: { userId: "BAK" },
  approvers: [{ userId: "APP" }],
} as unknown as SoulData;

describe("canChangeModel", () => {
  test("manager allowed", () => expect(canChangeModel("MGR", soul)).toBe(true));
  test("backup allowed", () => expect(canChangeModel("BAK", soul)).toBe(true));
  test("approver allowed", () => expect(canChangeModel("APP", soul)).toBe(true));
  test("stranger denied", () => expect(canChangeModel("X", soul)).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/model-auth.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `src/gateway/slack/model-auth.ts`:

```ts
import type { SoulData } from "../../soul/data";

/**
 * Authorisation gate for the /model command. Same predicate as
 * /ingest, /cron, /ignore: primary manager, backup manager, or any approver.
 * Defensive against missing soul fields (all optional in the schema).
 */
export function canChangeModel(userId: string, soul: SoulData): boolean {
  if (soul.manager?.userId === userId) return true;
  if (soul.backupManager?.userId === userId) return true;
  if (soul.approvers?.some((a) => a.userId === userId)) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/model-auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/model-auth.ts tests/model-auth.test.ts
git commit -m "feat(gateway): canChangeModel ACL predicate"
```

---

## Task 4: Parser + `SlashHit` + help entry

**Files:**
- Modify: `src/gateway/slack/commands.ts:43` (union), `:65` (AGENT_COMMANDS), parser branch before `HELP_NAMES` check (`:151`)
- Modify: `tests/commands.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/commands.test.ts`, inside the `describe("parseSlashCommand", …)` block, add:

```ts
test("/model with no arg → list", () => {
  expect(parseSlashCommand("/model")).toEqual({ kind: "model" });
});
test("/model <id> → set", () => {
  expect(parseSlashCommand("/model claude-opus-4-8")).toEqual({
    kind: "model",
    id: "claude-opus-4-8",
  });
});
test("/model keeps only the first token", () => {
  expect(parseSlashCommand("/model claude-opus-4-8 extra")).toEqual({
    kind: "model",
    id: "claude-opus-4-8",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts`
Expected: FAIL — `/model` returns `null`, not the expected object.

- [ ] **Step 3a: Extend the `SlashHit` union**

In `src/gateway/slack/commands.ts`, change the last union member (line 43) from:

```ts
  | { kind: "soul-clear"; field: "trust" | "allow" | "dm" | "block" | "all" };
```

to:

```ts
  | { kind: "soul-clear"; field: "trust" | "allow" | "dm" | "block" | "all" }
  | { kind: "model"; id?: string };
```

- [ ] **Step 3b: Add the help descriptor**

In `AGENT_COMMANDS`, after the `/soul clear` entry (line 64), add:

```ts
  { usage: "/model [id]", summary: "show or set this thread's model (manager/approver) — no arg lists available models" },
```

- [ ] **Step 3c: Add the parser branch**

In `parseSlashCommand`, immediately before `if (HELP_NAMES.has(cmd)) {` (line 151), add:

```ts
  if (cmd === "model") {
    const id = rest[0]; // case-preserved provider id; ignore trailing tokens
    return id ? { kind: "model", id } : { kind: "model" };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/commands.test.ts`
Expected: PASS (including the 3 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/commands.ts tests/commands.test.ts
git commit -m "feat(gateway): parse /model command"
```

---

## Task 5: `AgentManager.setSessionModel`

**Files:**
- Modify: `src/agent/manager.ts` (add after `setPermissionMode`, ends line 213)

- [ ] **Step 1: Add the method**

After the `setPermissionMode` method (closes at line 213), add:

```ts
  /** Change the model for a session. Persists; if live, also pushed to the SDK Query. */
  async setSessionModel(sessionId: string, model: string) {
    Sessions.setModel(sessionId, model);
    const live = this.#live.get(sessionId);
    if (live?.query) {
      try {
        await live.query.setModel(model);
      } catch (e) {
        console.error("[agent] setModel failed:", e);
      }
    }
  }
```

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit` (or repo typecheck script)
Expected: no new errors. (`Sessions` is already imported; `live.query.setModel` exists per the SDK `Query` type — see comment at `manager.ts:50`.)

- [ ] **Step 3: Commit**

```bash
git add src/agent/manager.ts
git commit -m "feat(agent): setSessionModel — live swap + persist"
```

---

## Task 6: Gateway dispatch block

**Files:**
- Modify: `src/gateway/core/gateway.ts` — add imports + dispatch block after the cron block (the cron `if` block ends around line 950; place the new block right after it, still inside `if (slash) { … }`)

- [ ] **Step 1: Add imports**

Near the other gateway imports for `commands` / `ingest-auth`, add:

```ts
import { canChangeModel } from "../slack/model-auth";
import { listModels } from "../../agent/models";
```

(Match the existing relative-path style used by neighbouring imports in this file.)

- [ ] **Step 2: Add the dispatch block**

Immediately after the closing brace of the `if (slash.kind === "cron-add" || slash.kind === "cron-list" || slash.kind === "cron-remove") { … }` block, add:

```ts
      if (slash.kind === "model") {
        const soul = soulData();
        if (!canChangeModel(userId, soul)) {
          await reply(":lock: `/model` — manager or approver only.");
          return;
        }
        if (!slash.id) {
          try {
            const models = await listModels();
            const lines = models.map((m) => `• \`${m.id}\``).join("\n") || "_none returned_";
            await reply(`*available models*\n${lines}\n\ncurrent: \`${session.model}\``);
          } catch {
            await reply(`can't fetch model list from provider. current: \`${session.model}\``);
          }
          return;
        }
        let verified = false;
        try {
          verified = (await listModels()).some((m) => m.id === slash.id);
        } catch {
          // provider has no /v1/models (non-Anthropic gateway) — pass through.
        }
        await agent.setSessionModel(session.id, slash.id);
        await reply(
          verified
            ? `model → \`${slash.id}\``
            : `model → \`${slash.id}\` :warning: couldn't verify against provider`,
        );
        return;
      }
```

- [ ] **Step 3: Typecheck**

Run: `bun run tsc --noEmit`
Expected: no new errors. Confirm `session` (the `ensureSession` row, `gateway.ts:614`) exposes `.model`, `agent` exposes `setSessionModel`, and `soulData()` / `userId` / `reply` are in scope (they are — used by sibling blocks).

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: all pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts
git commit -m "feat(gateway): /model dispatch — list, validate, swap"
```

---

## Task 7: Manual smoke + docs

**Files:**
- Modify: `.env.example` (only if a `/model` note adds value — optional, skip if redundant with existing `SLAUDE_MODEL` docs)
- Modify: `CLAUDE.md` Findings Log — add a findings entry link
- Create: `docs/findings/2026-06-14-model-switch-command.md`

- [ ] **Step 1: Write the findings doc**

Create `docs/findings/2026-06-14-model-switch-command.md` with a short writeup: the `/model` command, per-thread scope, provider `/v1/models` as the validation source, pass-through+warn fallback for non-Anthropic gateways, 5-min cache. Link the spec and plan.

- [ ] **Step 2: Index it in CLAUDE.md**

Add to the Findings Log (newest first), under the existing top entry:

```markdown
- [2026-06-14 — /model per-thread model switch (provider /v1/models validation, pass-through fallback)](docs/findings/2026-06-14-model-switch-command.md)
```

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bun run tsc --noEmit`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/findings/2026-06-14-model-switch-command.md
git commit -m "docs(findings): /model per-thread model switch"
```

---

## Self-Review Notes

- **Spec coverage:** listModels+cache (T2), setSessionModel live+persist (T1,T5), parser typed-id+no-arg (T4), ACL manager+approver (T3,T6), pass-through+warn fallback (T6), per-thread scope via `session.model`/`session.id` (T6). All spec sections mapped.
- **Type consistency:** `ModelInfo {id, display_name}`, `listModels()`, `canChangeModel`, `setSessionModel`, `Sessions.setModel`, `SlashHit {kind:"model", id?}` — names identical across tasks.
- **No placeholders:** every code step shows full code; commands have expected output.
- **Typecheck command:** confirm the exact script in `package.json` (`bun run tsc --noEmit` assumed); substitute the repo's if different.
