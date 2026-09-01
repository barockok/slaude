# gbrain × slaude Phase 1 (slaude_kb v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace slaude's keyword-only KB with a gbrain BrainEngine: scoped per-Slack-user reads/writes (DB-enforced), approval-gated mutations, semantic-ready search, KB wikis indexed as brain sources.

**Architecture:** gbrain embedded as a Bun library (git dep, pinned sha). slaude builds an `OperationContext` per tool call with `remote:true` + synthetic `AuthInfo` derived from the live Slack identity (`route.ctx.userId`, /1on1 lock, SoulData channel trust) so gbrain's own fail-closed SQL scoping enforces isolation. A thin gated dispatch classifies ops into auto/approval/manager/deny tiers and routes approval tiers through the existing Surface `requestApproval` (Block Kit). Design doc: `docs/findings/2026-06-10-gbrain-slaude-kb.md`.

**Tech Stack:** Bun + TypeScript, `gbrain` (github:garrytan/gbrain#03ffc6eb, MIT), PGLite engine under `~/.slaude/brain/`, bun:test.

**Spike-verified facts (do not re-derive):**
- `createEngine({engine:'pglite',database_path}) → engine.connect(cfg) → engine.initSchema()` boots in ~2s (110 migrations), idempotent.
- Calling `operations.find(o=>o.name===N)!.handler(ctx, params)` directly works; 89 ops.
- `OperationContext` minimum: `{ engine, config: loadConfig() ?? {}, logger, dryRun:false, remote, sourceId, auth? }`.
- Scoped read enforcement: `auth.allowedSources` filters SQL; out-of-scope search returns `[]`.
- `sources_add { id, federated:true }` works pathless; with `path` registers local dir.
- `sync_brain { repo, no_pull:true, no_embed:true }` imports a local markdown dir (needs `repo`; source routing falls back to "sole non-default" — set `GBRAIN_SOURCE` env around the call when multiple sources exist).
- **Never `put_page` into a nonexistent source** (observed runaway spin). Always `ensureSources()` first.
- Keyword search works with zero API keys (`conservative` path); embeddings optional.
- npm `gbrain` is an UNRELATED package — git dep only.

---

### Task 1: Add gbrain dependency

**Files:**
- Modify: `package.json`
- Possibly create: `src/types/gbrain.d.ts` (only if `bun run typecheck` chokes on gbrain's `.ts` imports)

- [ ] **Step 1: Add pinned git dep**

```bash
cd /Users/barock/Code/slaude
bun add "github:garrytan/gbrain#03ffc6ebdbc7dd8b29e5bfd0c3a9a6c983b54f01"
```

Expected: installs ~200 packages; postinstall blocked is fine (it only runs `gbrain apply-migrations` when a global CLI exists; engine self-migrates via `initSchema()`).

- [ ] **Step 2: Verify import + typecheck**

```bash
bun -e 'import { operations } from "gbrain/operations"; console.log(operations.length)'   # expect 89
bun run typecheck
```

If `tsc` fails inside `node_modules/gbrain` (gbrain uses `.ts` import extensions): add `src/types/gbrain.d.ts` with minimal `declare module "gbrain/engine-factory" { export function createEngine(c: any): Promise<any> }` etc. for each subpath we import (`gbrain/operations`, `gbrain/config`), and ensure tsconfig excludes node_modules from check (default). Re-run typecheck.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock src/types/gbrain.d.ts 2>/dev/null; git add package.json bun.lock
git commit -m "feat(kb): add gbrain as pinned git dependency"
```

### Task 2: Scope resolver (`src/knowledge/scope.ts`)

**Files:**
- Create: `src/knowledge/scope.ts`
- Test: `tests/brain-scope.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/brain-scope.test.ts
import { describe, expect, test } from "bun:test";
import {
  AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE,
  userSourceId, kbSourceId, channelTrustFor, resolveBrainScope,
} from "../src/knowledge/scope";
import type { SoulData } from "../src/soul/data";

const soul = { trustedChannels: ["C_TRUST"], allowedChannels: ["C_PUB"] } as unknown as SoulData;

describe("userSourceId / kbSourceId", () => {
  test("lowercases and strips to [a-z0-9-], max 32", () => {
    expect(userSourceId("U04ABC_DEF")).toBe("user-u04abcdef");
    expect(userSourceId("U".repeat(40)).length).toBeLessThanOrEqual(32);
    expect(kbSourceId("My Wiki!")).toBe("kb-my-wiki-");
  });
});

describe("channelTrustFor", () => {
  test("trusted > public > unknown", () => {
    expect(channelTrustFor("C_TRUST", soul)).toBe("trusted");
    expect(channelTrustFor("C_PUB", soul)).toBe("public");
    expect(channelTrustFor("C_X", soul)).toBe("unknown");
  });
});

describe("resolveBrainScope", () => {
  const kb = ["kb-runbook"];
  test("agent turn (no user): writes agent, reads everything", () => {
    const s = resolveBrainScope({ userId: null, lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb });
    expect(s.sourceId).toBe(AGENT_SOURCE);
    expect(s.allowedSources).toEqual([AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
    expect(s.clientId).toBe("agent");
  });
  test("locked 1on1: writes own slice, reads own+shared+public+kb", () => {
    const s = resolveBrainScope({ userId: "U1", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: kb });
    expect(s.sourceId).toBe("user-u1");
    expect(s.allowedSources).toEqual(["user-u1", SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
  });
  test("trusted channel: writes shared, no agent source in reads", () => {
    const s = resolveBrainScope({ userId: "U2", lockedUser: null, channelTrust: "trusted", isManager: false, kbSources: kb });
    expect(s.sourceId).toBe(SHARED_SOURCE);
    expect(s.allowedSources).toEqual([SHARED_SOURCE, PUBLIC_SOURCE, "kb-runbook"]);
    expect(s.allowedSources).not.toContain(AGENT_SOURCE);
  });
  test("manager in unknown channel gets trusted scope", () => {
    const s = resolveBrainScope({ userId: "UMGR", lockedUser: null, channelTrust: "unknown", isManager: true, kbSources: [] });
    expect(s.sourceId).toBe(SHARED_SOURCE);
  });
  test("public/unknown channel: public reads only", () => {
    for (const trust of ["public", "unknown"] as const) {
      const s = resolveBrainScope({ userId: "U3", lockedUser: null, channelTrust: trust, isManager: false, kbSources: kb });
      expect(s.sourceId).toBe(PUBLIC_SOURCE);
      expect(s.allowedSources).toEqual([PUBLIC_SOURCE]);
    }
  });
  test("other user in someone else's locked thread gets public scope", () => {
    const s = resolveBrainScope({ userId: "U9", lockedUser: "U1", channelTrust: "trusted", isManager: false, kbSources: [] });
    expect(s.sourceId).toBe(PUBLIC_SOURCE);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test tests/brain-scope.test.ts` → FAIL (module not found)

- [ ] **Step 3: Implement**

```typescript
// src/knowledge/scope.ts
import type { SoulData } from "../soul/data";

export type ChannelTrust = "trusted" | "public" | "unknown";

/** Synthetic identity threaded into gbrain's OperationContext.auth — gbrain's
 * fail-closed SQL scoping (sourceScopeOpts) does the actual enforcement. */
export interface BrainScope {
  clientId: string;
  sourceId: string;          // write authority (single source)
  allowedSources: string[];  // federated read union
}

export interface ScopeInput {
  userId: string | null;      // null = agent-initiated turn (cron, internal)
  lockedUser: string | null;  // /1on1 lock owner for this thread
  channelTrust: ChannelTrust;
  isManager: boolean;
  kbSources: string[];
}

export const AGENT_SOURCE = "agent";
export const SHARED_SOURCE = "shared";
export const PUBLIC_SOURCE = "public";

// gbrain source ids must match [a-z0-9-]{1,32}
const sourceSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");

export function userSourceId(userId: string): string {
  return ("user-" + sourceSafe(userId).replace(/-/g, "")).slice(0, 32);
}

export function kbSourceId(label: string): string {
  return ("kb-" + label.toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 32);
}

export function channelTrustFor(channel: string, soul: SoulData): ChannelTrust {
  if (soul.trustedChannels.includes(channel)) return "trusted";
  if (soul.allowedChannels.includes(channel)) return "public";
  return "unknown";
}

export function resolveBrainScope(i: ScopeInput): BrainScope {
  if (i.userId === null) {
    return {
      clientId: "agent",
      sourceId: AGENT_SOURCE,
      allowedSources: [AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources],
    };
  }
  if (i.lockedUser !== null) {
    if (i.lockedUser === i.userId) {
      const own = userSourceId(i.userId);
      return { clientId: i.userId, sourceId: own, allowedSources: [own, SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources] };
    }
    if (!i.isManager) {
      // someone else's private thread — most restrictive scope
      return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
    }
  }
  if (i.channelTrust === "trusted" || i.isManager) {
    return { clientId: i.userId, sourceId: SHARED_SOURCE, allowedSources: [SHARED_SOURCE, PUBLIC_SOURCE, ...i.kbSources] };
  }
  return { clientId: i.userId, sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE] };
}
```

- [ ] **Step 4: Run, verify pass** — `bun test tests/brain-scope.test.ts` → PASS
- [ ] **Step 5: Commit** — `git add src/knowledge/scope.ts tests/brain-scope.test.ts && git commit -m "feat(kb): brain scope resolver — Slack identity → gbrain source scope"`

### Task 3: Gated dispatch (`src/knowledge/gated-dispatch.ts`)

**Files:**
- Create: `src/knowledge/gated-dispatch.ts`
- Test: `tests/brain-gate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/brain-gate.test.ts
import { describe, expect, test } from "bun:test";
import { classifyBrainOp, gatedBrainCall, type GateInput } from "../src/knowledge/gated-dispatch";
import { resolveBrainScope } from "../src/knowledge/scope";

const gate = (over: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false, ...over,
});
const scopeFor = (g: GateInput, kb: string[] = []) =>
  resolveBrainScope({ ...g, kbSources: kb });

describe("classifyBrainOp", () => {
  test("reads are auto everywhere", () => {
    for (const op of ["search", "think", "get_page", "list_pages", "get_links", "get_backlinks", "query"]) {
      expect(classifyBrainOp(op, scopeFor(gate({ channelTrust: "unknown" })), gate({ channelTrust: "unknown" }))).toBe("auto");
    }
  });
  test("agent turn writes are auto", () => {
    const g = gate({ userId: null });
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("auto");
  });
  test("own-slice write in locked 1on1 is auto", () => {
    const g = gate({ lockedUser: "U1" });
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("auto");
  });
  test("shared write from trusted channel needs approval", () => {
    const g = gate();
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("approval");
  });
  test("write from public channel is denied", () => {
    const g = gate({ channelTrust: "public" });
    expect(classifyBrainOp("put_page", scopeFor(g), g)).toBe("deny");
  });
  test("deletes always need approval, even own slice", () => {
    const g = gate({ lockedUser: "U1" });
    expect(classifyBrainOp("delete_page", scopeFor(g), g)).toBe("approval");
  });
  test("admin ops are manager tier", () => {
    for (const op of ["purge_deleted_pages", "sources_add", "sources_remove"]) {
      expect(classifyBrainOp(op, scopeFor(gate()), gate())).toBe("manager");
    }
  });
  test("unknown ops fail closed to manager", () => {
    expect(classifyBrainOp("run_skillopt", scopeFor(gate()), gate())).toBe("manager");
  });
});

describe("gatedBrainCall", () => {
  test("auto tier calls through without approval", async () => {
    let approvals = 0;
    const r = await gatedBrainCall("search", {
      scope: scopeFor(gate()), gate: gate(),
      requestApproval: async () => { approvals++; return { approved: true, by: "x" }; },
      call: async () => ["hit"], describe: "search",
    });
    expect(r).toEqual({ ok: true, result: ["hit"] });
    expect(approvals).toBe(0);
  });
  test("approval tier asks and respects denial", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(gate()), gate: gate(),
      requestApproval: async () => ({ approved: false, by: "UMGR", note: "nope" }),
      call: async () => { throw new Error("must not run"); }, describe: "write page",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("UMGR");
  });
  test("approval tier runs call after approval", async () => {
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(gate()), gate: gate(),
      requestApproval: async () => ({ approved: true, by: "UMGR" }),
      call: async () => "written", describe: "write page",
    });
    expect(r).toEqual({ ok: true, result: "written" });
  });
  test("deny tier never calls approval or op", async () => {
    const g = gate({ channelTrust: "public" });
    let touched = 0;
    const r = await gatedBrainCall("put_page", {
      scope: scopeFor(g), gate: g,
      requestApproval: async () => { touched++; return { approved: true, by: "x" }; },
      call: async () => { touched++; return null; }, describe: "write",
    });
    expect(r.ok).toBe(false);
    expect(touched).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test tests/brain-gate.test.ts` → FAIL
- [ ] **Step 3: Implement**

```typescript
// src/knowledge/gated-dispatch.ts
import type { BrainScope, ChannelTrust } from "./scope";
import { userSourceId } from "./scope";

export type GateTier = "auto" | "approval" | "manager" | "deny";

export interface GateInput {
  userId: string | null;
  lockedUser: string | null;
  channelTrust: ChannelTrust;
  isManager: boolean;
}

const READ_OPS = new Set([
  "search", "query", "think", "get_page", "list_pages", "get_links",
  "get_backlinks", "traverse_graph", "get_timeline", "get_tags",
  "get_stats", "sources_list", "resolve_slugs", "takes_list", "takes_search",
]);

// Mutations allowed without a gate when writing to the caller's own slice
const WRITE_OPS = new Set([
  "put_page", "add_tag", "remove_tag", "add_link", "remove_link", "add_timeline_entry",
]);

// Destructive: approval even on own slice
const DESTRUCTIVE_OPS = new Set(["delete_page", "restore_page"]);

// Brain administration: manager approval always
const MANAGER_OPS = new Set([
  "purge_deleted_pages", "sources_add", "sources_remove", "sync_brain",
  "schema_apply_mutations", "reload_schema_pack", "revert_version", "forget_fact",
]);

export function classifyBrainOp(op: string, scope: BrainScope, g: GateInput): GateTier {
  if (READ_OPS.has(op)) return "auto";
  if (MANAGER_OPS.has(op)) return "manager";
  if (DESTRUCTIVE_OPS.has(op)) {
    return g.channelTrust === "public" && !g.isManager ? "deny" : "approval";
  }
  if (WRITE_OPS.has(op)) {
    if (g.userId === null) return "auto"; // agent's own mind
    if (g.lockedUser === g.userId && scope.sourceId === userSourceId(g.userId)) return "auto";
    if (g.channelTrust === "trusted" || g.isManager) return "approval";
    return "deny";
  }
  return "manager"; // unknown op: fail closed
}

export interface ApprovalReq {
  summary: string;
  tools?: string[];
  risks?: string[];
  category?: string;
}
export interface ApprovalRes { approved: boolean; by: string; note?: string }

export interface GatedCallDeps {
  scope: BrainScope;
  gate: GateInput;
  requestApproval: (r: ApprovalReq) => Promise<ApprovalRes>;
  call: () => Promise<unknown>;
  describe: string;
}

export type GatedResult = { ok: true; result: unknown } | { ok: false; reason: string };

export async function gatedBrainCall(op: string, d: GatedCallDeps): Promise<GatedResult> {
  const tier = classifyBrainOp(op, d.scope, d.gate);
  if (tier === "deny") {
    return { ok: false, reason: `kb operation "${op}" is not allowed from this channel` };
  }
  if (tier === "approval" || tier === "manager") {
    const r = await d.requestApproval({
      summary: d.describe,
      tools: [op],
      category: tier === "manager" ? "kb-admin" : "kb",
    });
    if (!r.approved) return { ok: false, reason: `denied by ${r.by}${r.note ? `: ${r.note}` : ""}` };
  }
  return { ok: true, result: await d.call() };
}
```

- [ ] **Step 4: Run, verify pass** — `bun test tests/brain-gate.test.ts` → PASS
- [ ] **Step 5: Commit** — `git add src/knowledge/gated-dispatch.ts tests/brain-gate.test.ts && git commit -m "feat(kb): gated dispatch — tier classification + approval bridge for brain ops"`

### Task 4: Brain engine module (`src/knowledge/brain.ts`)

**Files:**
- Create: `src/knowledge/brain.ts`
- Test: `tests/brain.test.ts` (real PGLite in temp dir — integration, ~5s)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/brain.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainCall, brainAdminCall, closeBrain, ensureSources, getBrain } from "../src/knowledge/brain";
import type { BrainScope } from "../src/knowledge/scope";

const home = mkdtempSync(join(tmpdir(), "slaude-brain-test-"));
process.env.SLAUDE_BRAIN_HOME = home;

afterAll(async () => {
  await closeBrain();
  rmSync(home, { recursive: true, force: true });
});

const aliceScope: BrainScope = { clientId: "U_ALICE", sourceId: "user-ualice", allowedSources: ["user-ualice", "shared"] };
const bobScope: BrainScope = { clientId: "U_BOB", sourceId: "shared", allowedSources: ["shared"] };

describe("brain engine (integration)", () => {
  test("boots, ensures baseline sources", async () => {
    await getBrain();
    await ensureSources(["user-ualice"]);
    const sources = (await brainAdminCall("sources_list", {})) as Array<{ id: string }>;
    const ids = sources.map((s) => s.id);
    for (const want of ["agent", "shared", "public", "user-ualice"]) expect(ids).toContain(want);
  }, 30_000);

  test("write lands in scope source; cross-scope read is empty", async () => {
    await brainCall("put_page", { slug: "notes/secret", content: "Alice private zanzibar fact." }, aliceScope);
    const mine = (await brainCall("search", { query: "zanzibar" }, aliceScope)) as unknown[];
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await brainCall("search", { query: "zanzibar" }, bobScope)) as unknown[];
    expect(theirs.length).toBe(0);
  }, 30_000);

  test("unknown op throws", async () => {
    expect(brainCall("nope_op", {}, aliceScope)).rejects.toThrow(/unknown brain op/);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test tests/brain.test.ts` → FAIL
- [ ] **Step 3: Implement**

```typescript
// src/knowledge/brain.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { loadKbs } from "./loader";
import { AGENT_SOURCE, PUBLIC_SOURCE, SHARED_SOURCE, kbSourceId, type BrainScope } from "./scope";

// Engine is `any`-shaped on purpose: gbrain ships TS sources; we keep our
// surface minimal and let gbrain's own types stay internal to it.
type Engine = {
  connect(c: object): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
};

let enginePromise: Promise<Engine> | null = null;

export function brainHome(): string {
  return process.env.SLAUDE_BRAIN_HOME || join(paths.home, "brain");
}

export function brainEnabled(): boolean {
  return process.env.SLAUDE_BRAIN_DISABLED !== "1";
}

async function boot(): Promise<Engine> {
  const home = brainHome();
  mkdirSync(home, { recursive: true });
  // gbrain reads GBRAIN_HOME for config.json, locks, clones.
  process.env.GBRAIN_HOME = home;
  const { createEngine } = await import("gbrain/engine-factory");
  const cfg = { engine: "pglite" as const, database_path: join(home, "db") };
  const engine = (await createEngine(cfg)) as Engine;
  await engine.connect(cfg);
  await engine.initSchema();
  return engine;
}

export function getBrain(): Promise<Engine> {
  return (enginePromise ??= boot());
}

export async function closeBrain(): Promise<void> {
  if (!enginePromise) return;
  const e = await enginePromise;
  enginePromise = null;
  await e.disconnect();
}

const quietLogger = {
  info: () => {},
  warn: (...a: unknown[]) => console.warn("[brain]", ...a),
  error: (...a: unknown[]) => console.error("[brain]", ...a),
};

async function buildCtx(over: Record<string, unknown>) {
  const engine = await getBrain();
  const { loadConfig } = await import("gbrain/config");
  return {
    engine,
    config: loadConfig() ?? {},
    logger: quietLogger,
    dryRun: false,
    remote: true,
    sourceId: "default",
    ...over,
  };
}

async function findOp(name: string) {
  const { operations } = await import("gbrain/operations");
  const op = (operations as Array<{ name: string; handler: (ctx: unknown, p: Record<string, unknown>) => Promise<unknown> }>)
    .find((o) => o.name === name);
  if (!op) throw new Error(`unknown brain op: ${name}`);
  return op;
}

/** User-scoped call: remote=true + synthetic AuthInfo → gbrain enforces scope in SQL. */
export async function brainCall(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> {
  const op = await findOp(name);
  const ctx = await buildCtx({
    remote: true,
    sourceId: scope.sourceId,
    auth: {
      token: "in-process",
      clientId: scope.clientId,
      clientName: scope.clientId,
      scopes: ["read", "write"],
      sourceId: scope.sourceId,
      allowedSources: scope.allowedSources,
    },
    takesHoldersAllowList: [scope.clientId, "world"],
  });
  return op.handler(ctx, params);
}

/** Trusted local call (boot, admin, sync) — slaude owns the box. */
export async function brainAdminCall(name: string, params: Record<string, unknown>, sourceId = "default"): Promise<unknown> {
  const op = await findOp(name);
  const ctx = await buildCtx({ remote: false, sourceId });
  return op.handler(ctx, params);
}

export function baselineSources(): string[] {
  return [AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, ...loadKbs().map((k) => kbSourceId(k.label))];
}

/** Idempotently create sources. NEVER write to a source before this ran. */
export async function ensureSources(extra: string[] = []): Promise<void> {
  const existing = new Set(
    ((await brainAdminCall("sources_list", {})) as Array<{ id: string }>).map((s) => s.id),
  );
  for (const id of [...baselineSources(), ...extra]) {
    if (existing.has(id)) continue;
    const kb = loadKbs().find((k) => kbSourceId(k.label) === id);
    await brainAdminCall("sources_add", kb ? { id, path: join(kb.path, "wiki"), federated: true } : { id, federated: true });
  }
}
```

Note: `getBrain()` does NOT call `ensureSources()` itself — `tests/brain.test.ts` and the gateway boot call it explicitly. This keeps boot deterministic and the loadKbs() fs scan out of the hot path. KB source `path` points at the wiki/ subdir (the curated content; raw/ stays out of the index).

- [ ] **Step 4: Run, verify pass** — `bun test tests/brain.test.ts` → PASS (allow ~10s)
- [ ] **Step 5: Commit** — `git add src/knowledge/brain.ts tests/brain.test.ts && git commit -m "feat(kb): brain engine module — PGLite boot, scoped + admin dispatch, source bootstrap"`

### Task 5: slaude_kb v2 MCP tools

**Files:**
- Modify: `src/knowledge/mcp-tools.ts`
- Test: `tests/brain-mcp-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/brain-mcp-tools.test.ts
import { describe, expect, test } from "bun:test";
import { brainHandlers, type BrainToolDeps } from "../src/knowledge/mcp-tools";
import type { BrainScope } from "../src/knowledge/scope";

const scope: BrainScope = { clientId: "U1", sourceId: "shared", allowedSources: ["shared"] };
const deps = (over: Partial<BrainToolDeps> = {}): BrainToolDeps => ({
  scope: () => scope,
  gate: () => ({ userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false }),
  requestApproval: async () => ({ approved: true, by: "UMGR" }),
  call: async (name) => ({ echoed: name }),
  ...over,
});

describe("brainHandlers", () => {
  test("kb_search returns JSON of op result", async () => {
    const r = await brainHandlers.kb_search({ query: "x" }, deps());
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toEqual({ echoed: "search" });
  });

  test("kb_put_page goes through the gate — denial surfaces as error", async () => {
    const d = deps({ requestApproval: async () => ({ approved: false, by: "UMGR" }) });
    const r = await brainHandlers.kb_put_page({ slug: "a/b", content: "x", summary: "add page" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("denied");
  });

  test("kb_put_page passes slug+content to the op after approval", async () => {
    let got: { name?: string; params?: Record<string, unknown> } = {};
    const d = deps({ call: async (name, params) => { got = { name, params }; return { ok: 1 }; } });
    const r = await brainHandlers.kb_put_page({ slug: "a/b", content: "hello", summary: "add" }, d);
    expect(r.isError).toBeUndefined();
    expect(got.name).toBe("put_page");
    expect(got.params).toEqual({ slug: "a/b", content: "hello" });
  });

  test("op errors map to tool errors, not throws", async () => {
    const d = deps({ call: async () => { throw new Error("db on fire"); } });
    const r = await brainHandlers.kb_search({ query: "x" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("db on fire");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test tests/brain-mcp-tools.test.ts` → FAIL
- [ ] **Step 3: Implement — extend `src/knowledge/mcp-tools.ts`**

Add below the existing `kbHandlers` (keep all legacy code; only `createKbMcp` signature grows an optional param):

```typescript
import { brainCall, brainEnabled } from "./brain";
import { gatedBrainCall, type ApprovalReq, type ApprovalRes, type GateInput } from "./gated-dispatch";
import type { BrainScope } from "./scope";

export interface BrainToolDeps {
  scope: () => BrainScope;
  gate: () => GateInput;
  requestApproval: (r: ApprovalReq) => Promise<ApprovalRes>;
  /** Injectable op caller (tests). Default: brainCall with current scope. */
  call?: (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;
}

const asJson = (v: unknown) => ok(typeof v === "string" ? v : JSON.stringify(v, null, 2));

async function runRead(name: string, params: Record<string, unknown>, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    return asJson(await call(name, params, d.scope()));
  } catch (e) {
    return err(`brain ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runGated(name: string, params: Record<string, unknown>, summary: string, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    const r = await gatedBrainCall(name, {
      scope: d.scope(),
      gate: d.gate(),
      requestApproval: d.requestApproval,
      call: () => call(name, params, d.scope()),
      describe: summary,
    });
    return r.ok ? asJson(r.result) : err(r.reason);
  } catch (e) {
    return err(`brain ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const brainHandlers = {
  kb_think: (p: { question: string }, d: BrainToolDeps) => runRead("think", { question: p.question }, d),
  kb_search: (p: { query: string; limit?: number }, d: BrainToolDeps) =>
    runRead("search", { query: p.query, ...(p.limit ? { limit: p.limit } : {}) }, d),
  kb_get_page: (p: { slug: string }, d: BrainToolDeps) => runRead("get_page", { slug: p.slug }, d),
  kb_list_pages: (p: { type?: string; tag?: string; limit?: number }, d: BrainToolDeps) =>
    runRead("list_pages", { ...p }, d),
  kb_graph: async (p: { slug: string }, d: BrainToolDeps) => {
    const links = await runRead("get_links", { slug: p.slug }, d);
    const back = await runRead("get_backlinks", { slug: p.slug }, d);
    if (links.isError) return links;
    if (back.isError) return back;
    return ok(JSON.stringify({ links: JSON.parse(links.content[0]!.text), backlinks: JSON.parse(back.content[0]!.text) }, null, 2));
  },
  kb_put_page: (p: { slug: string; content: string; summary: string }, d: BrainToolDeps) =>
    runGated("put_page", { slug: p.slug, content: p.content }, `KB write: ${p.slug} — ${p.summary}`, d),
  kb_delete_page: (p: { slug: string; reason: string }, d: BrainToolDeps) =>
    runGated("delete_page", { slug: p.slug }, `KB delete: ${p.slug} — ${p.reason}`, d),
};
```

Then in `createKbMcp`, accept deps and register the new tools when present:

```typescript
export function createKbMcp(deps?: BrainToolDeps): McpSdkServerConfigWithInstance {
  const tools = [
    /* the three existing legacy tool(...) entries stay verbatim */
  ];
  if (deps && brainEnabled()) {
    tools.push(
      tool("kb_think",
        "Ask the knowledge brain a question. Returns a synthesized answer with [Source: ...] citations and explicit gaps. Prefer this over kb_search when you need an answer, not documents.",
        { question: z.string().describe("The question to answer from the brain.") },
        (a) => brainHandlers.kb_think(a, deps)),
      tool("kb_search",
        "Search the knowledge brain (pages across your allowed scopes). Returns ranked chunks with slugs.",
        { query: z.string(), limit: z.number().optional().describe("Max results (default 20).") },
        (a) => brainHandlers.kb_search(a, deps)),
      tool("kb_get_page",
        "Read a brain page by slug (e.g. 'people/alice').",
        { slug: z.string() },
        (a) => brainHandlers.kb_get_page(a, deps)),
      tool("kb_list_pages",
        "List brain pages, optionally filtered by type or tag.",
        { type: z.string().optional(), tag: z.string().optional(), limit: z.number().optional() },
        (a) => brainHandlers.kb_list_pages(a, deps)),
      tool("kb_graph",
        "Get knowledge-graph edges for a page: outgoing links and backlinks.",
        { slug: z.string() },
        (a) => brainHandlers.kb_graph(a, deps)),
      tool("kb_put_page",
        "Write/update a brain page (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Writes outside your own slice require human approval — provide a clear summary.",
        { slug: z.string(), content: z.string(), summary: z.string().describe("One-line description of the change, shown on the approval card.") },
        (a) => brainHandlers.kb_put_page(a, deps)),
      tool("kb_delete_page",
        "Soft-delete a brain page (recoverable). Requires approval.",
        { slug: z.string(), reason: z.string() },
        (a) => brainHandlers.kb_delete_page(a, deps)),
    );
  }
  return createSdkMcpServer({ name: KB_MCP_NAME, version: "0.2.0", tools });
}
```

- [ ] **Step 4: Run all knowledge tests** — `bun test tests/brain-mcp-tools.test.ts tests/brain-scope.test.ts tests/brain-gate.test.ts` → PASS; also `bun run typecheck`
- [ ] **Step 5: Commit** — `git add src/knowledge/mcp-tools.ts tests/brain-mcp-tools.test.ts && git commit -m "feat(kb): slaude_kb v2 — brain-backed think/search/page/graph tools with gated writes"`

### Task 6: Gateway wiring

**Files:**
- Modify: `src/gateway/core/gateway.ts` (mcpResolver, ~line 203-224; boot section near end)

- [ ] **Step 1: Add imports + deps builder**

In `src/gateway/core/gateway.ts` imports:

```typescript
import { brainEnabled, ensureSources } from "../../knowledge/brain";
import { channelTrustFor, kbSourceId, resolveBrainScope } from "../../knowledge/scope";
import type { GateInput } from "../../knowledge/gated-dispatch";
import { loadKbs } from "../../knowledge/loader";
```

Above `mcpResolver`, add:

```typescript
const brainGateFor = (ctx: SlackContext): GateInput => {
  const soul = soulData();
  const lock = OneOnOne.find(ctx.channel, ctx.threadTs);
  return {
    userId: ctx.userId ?? null,
    lockedUser: lock?.locked_user ?? null,
    channelTrust: channelTrustFor(ctx.channel, soul),
    isManager: !!ctx.userId && (ctx.userId === soul.manager.userId || ctx.userId === soul.backupManager.userId),
  };
};
```

(Adjust `lock?.locked_user` to the actual row field of `OneOnOne.find` — check `src/db/one-on-one.ts`.)

- [ ] **Step 2: Wire deps into createKbMcp inside mcpResolver**

Replace `[KB_MCP_NAME]: createKbMcp(),` with:

```typescript
[KB_MCP_NAME]: createKbMcp(
  brainEnabled()
    ? {
        scope: () => resolveBrainScope({ ...brainGateFor(route.ctx), kbSources: loadKbs().map((k) => kbSourceId(k.label)) }),
        gate: () => brainGateFor(route.ctx),
        requestApproval: (r) => route.surface.requestApproval(r),
      }
    : undefined,
),
```

`scope()`/`gate()` are closures over `route.ctx` — they read `userId` live per tool call, same pattern the Slack MCP tools use.

- [ ] **Step 3: Boot-time source bootstrap**

In the gateway/server startup path (where the canary check runs, gateway.ts ~line 681), add:

```typescript
if (brainEnabled()) {
  void ensureSources().catch((e) => console.error("[brain] source bootstrap failed:", e));
}
```

- [ ] **Step 4: Verify** — `bun run typecheck && bun test` → all green
- [ ] **Step 5: Commit** — `git add src/gateway/core/gateway.ts && git commit -m "feat(kb): wire brain scope + approval deps into slaude_kb per session"`

### Task 7: KB wiki sync into brain sources

**Files:**
- Create: `src/knowledge/brain-sync.ts`
- Test: `tests/brain-sync.test.ts` (integration: temp KB dir + temp brain)
- Modify: `src/gateway/core/gateway.ts` (boot: sync after ensureSources)

- [ ] **Step 1: Write failing test**

```typescript
// tests/brain-sync.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "slaude-brainsync-"));
process.env.SLAUDE_BRAIN_HOME = join(home, "brain");
process.env.SLAUDE_HOME = home; // loadKbs reads $SLAUDE_HOME/knowledge

// fake installed KB with a git-backed wiki
const wiki = join(home, "knowledge", "runbook", "wiki");
mkdirSync(wiki, { recursive: true });
writeFileSync(join(home, "knowledge", "runbook", "README.md"), "---\ndescription: runbook\n---\n# Runbook\n");
writeFileSync(join(wiki, "alerts.md"), "# Alerts\nGrafana dashboard quirks for billing.\n");
execSync(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: wiki });

import { closeBrain, ensureSources, brainCall } from "../src/knowledge/brain";
import { syncKbWikis } from "../src/knowledge/brain-sync";
import { kbSourceId } from "../src/knowledge/scope";

afterAll(async () => {
  await closeBrain();
  rmSync(home, { recursive: true, force: true });
});

describe("syncKbWikis (integration)", () => {
  test("imports wiki markdown into kb-<label> source, searchable in scope", async () => {
    await ensureSources();
    const results = await syncKbWikis();
    expect(results.find((r) => r.label === "runbook")?.ok).toBe(true);
    const src = kbSourceId("runbook");
    const hits = (await brainCall("search", { query: "grafana billing" }, {
      clientId: "U1", sourceId: "shared", allowedSources: ["shared", src],
    })) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  }, 60_000);
});
```

(Confirm `loadKbs` honors `SLAUDE_HOME` — `paths` is computed from env at import time in `src/config/home.ts`; if it's frozen before the test sets env, set `SLAUDE_HOME` at the very top of the file before any imports, as shown.)

- [ ] **Step 2: Run, verify fail** — `bun test tests/brain-sync.test.ts` → FAIL
- [ ] **Step 3: Implement**

```typescript
// src/knowledge/brain-sync.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { brainAdminCall } from "./brain";
import { loadKbs } from "./loader";
import { kbSourceId } from "./scope";

export interface KbSyncResult { label: string; ok: boolean; error?: string }

/**
 * Import each installed KB's wiki/ into its kb-<label> brain source.
 * gbrain's sync source-routing falls back to "sole non-default source" when
 * ambiguous, so we pin the target via GBRAIN_SOURCE for the duration of each
 * call (sequential — never parallelize this loop).
 */
export async function syncKbWikis(): Promise<KbSyncResult[]> {
  const out: KbSyncResult[] = [];
  for (const kb of loadKbs()) {
    const wikiDir = join(kb.path, "wiki");
    const repo = existsSync(wikiDir) ? wikiDir : kb.path;
    const sourceId = kbSourceId(kb.label);
    const prev = process.env.GBRAIN_SOURCE;
    process.env.GBRAIN_SOURCE = sourceId;
    try {
      await brainAdminCall("sync_brain", { repo, no_pull: true, no_embed: true }, sourceId);
      out.push({ label: kb.label, ok: true });
    } catch (e) {
      out.push({ label: kb.label, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_SOURCE;
      else process.env.GBRAIN_SOURCE = prev;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass** — `bun test tests/brain-sync.test.ts` → PASS
- [ ] **Step 5: Wire into boot** — in gateway boot (same place as ensureSources):

```typescript
if (brainEnabled()) {
  void ensureSources()
    .then(() => syncKbWikis())
    .then((rs) => {
      for (const r of rs) if (!r.ok) console.error(`[brain] kb sync failed for ${r.label}: ${r.error}`);
    })
    .catch((e) => console.error("[brain] source bootstrap failed:", e));
}
```

(Replace the Task 6 Step 3 block with this combined version.)

- [ ] **Step 6: Full suite + commit**

```bash
bun run typecheck && bun test
git add src/knowledge/brain-sync.ts tests/brain-sync.test.ts src/gateway/core/gateway.ts
git commit -m "feat(kb): index installed KB wikis as brain sources at boot"
```

### Task 8: Docs

**Files:**
- Modify: `docs/findings/2026-06-10-gbrain-slaude-kb.md` (status line)
- Modify: `CLAUDE.md` (architecture tree note)

- [ ] **Step 1: Update finding status** — change `**Status:** Design (pre-implementation)` to `**Status:** Phase 1 implemented (slaude_kb v2: scoped brain, gated writes, KB wiki indexing). Phases 2-4 pending.` and append a short "Implementation notes (Phase 1)" section listing: spike caveats (source-before-write, sync source pinning, GBRAIN_HOME), new modules, env vars (`SLAUDE_BRAIN_HOME`, `SLAUDE_BRAIN_DISABLED`).
- [ ] **Step 2: CLAUDE.md** — in the Architecture tree under `knowledge/`, update comment to `# KB loader + brain (gbrain engine) + MCP tools + ingest`.
- [ ] **Step 3: Commit** — `git commit -am "docs(kb): record gbrain Phase 1 implementation status"`

---

## Self-review notes

- Spec coverage: design §2 (library embed + synthetic AuthInfo) → Tasks 1/4; §3 (scope table) → Task 2; §4 (approval tiers) → Task 3 (Tier-1 PermissionGate folded into approval tier for Phase 1 — every shared write asks; "always-allow" refinement deferred); §5 dream cycle + §6 multi-agent + memory provider → out of scope (Phases 2-4); §8 step 2 (slaude_kb v2 + wiki migration) → Tasks 5-7.
- Type consistency: `BrainScope`/`GateInput`/`ApprovalReq`/`ApprovalRes` defined once (Tasks 2-3) and imported elsewhere; `brainHandlers` deps use injectable `call` to keep unit tests off PGLite.
- Known adjust-on-contact points (verify, don't assume): `OneOnOne.find` row field name, `route.surface.requestApproval` request-shape vs `ApprovalReq`, `paths` env-freeze order in tests.
