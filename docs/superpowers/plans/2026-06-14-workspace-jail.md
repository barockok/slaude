# Workspace Filesystem Jail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confine non-manager Slack sessions to their per-thread workspace dir (reads + writes + bash), with a configurable strength (`off` / `discipline` / `adversarial`); manager/backup DMs roam free.

**Architecture:** Trust is computed at session boot: a DM whose partner is the manager/backup is unjailed; everything else is jailed. Jailed sessions get a `canUseTool` path gate (hard-deny file tools outside the workspace) plus — in `adversarial` mode — the SDK's native OS sandbox for Bash (sandbox-exec/bubblewrap), failing closed (Bash disabled + manager alert) if the sandbox binary is absent. `discipline` mode adds a best-effort bash string-check instead of the OS sandbox.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `@anthropic-ai/claude-agent-sdk@0.1.77` (`Options.sandbox`, `Options.disallowedTools`), `bun test`.

Spec: `docs/superpowers/specs/2026-06-14-workspace-jail-design.md`

---

## Implementation note (deviation from spec wording)

The spec describes "Layer 2 in `permission-gate.ts`". In code, the permission gate is the `#resolver` that `manager.ts` wraps into `canUseTool` at boot (`manager.ts:312-315`). The jail check is enforced **in that wrapper**, before delegating to the resolver, using pure functions in `src/agent/jail.ts`. This needs no new plumbing into the gateway gate and keeps jail state where it's computed (session boot). Same requirement, cleaner seam.

The spec says "alert manager via Telegram". The Telegram bridge is an **agent-runtime MCP tool**, not a core notify API. Core has the Slack client, so the alert is a **best-effort Slack DM to the manager** (Task 7).

## File Structure

- Modify: `src/config/env.ts` — `jailMode()`, `jailBashNetwork()`.
- Create: `src/agent/jail.ts` — pure trust + path + decision helpers.
- Create: `src/agent/sandbox.ts` — sandbox availability probe + options builder.
- Modify: `src/db/schema.ts` — `dm_user_id` column + migration + `SessionRow` field.
- Modify: `src/db/sessions.ts` — `createForThread` accepts `dm_user_id`.
- Modify: `src/agent/manager.ts` — `ensureSession` `dmUserId` arg; `#startSession` jail wiring + jail-aware `canUseTool`; one-shot sandbox-unavailable event.
- Modify: `src/gateway/core/gateway.ts` — pass `dmUserId` when `isDM`; Slack-DM the manager on the sandbox-unavailable event.
- Tests: `tests/jail.test.ts`, `tests/sandbox.test.ts`, `tests/jail-env.test.ts`, plus a sessions/migration assertion.

---

## Task 1: `env.jailMode` + `env.jailBashNetwork`

**Files:**
- Modify: `src/config/env.ts` (add near `idleMs`, ~line 106)
- Test: `tests/jail-env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/jail-env.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { env } from "../src/config/env";

const orig = { ...process.env };
afterEach(() => {
  process.env = { ...orig };
});

describe("env.jailMode", () => {
  test("defaults to discipline", () => {
    delete process.env.SLAUDE_JAIL_MODE;
    expect(env.jailMode()).toBe("discipline");
  });
  test("parses off and adversarial", () => {
    process.env.SLAUDE_JAIL_MODE = "off";
    expect(env.jailMode()).toBe("off");
    process.env.SLAUDE_JAIL_MODE = "adversarial";
    expect(env.jailMode()).toBe("adversarial");
  });
  test("unknown value falls back to discipline", () => {
    process.env.SLAUDE_JAIL_MODE = "wat";
    expect(env.jailMode()).toBe("discipline");
  });
});

describe("env.jailBashNetwork", () => {
  test("default: no domains", () => {
    delete process.env.SLAUDE_JAIL_BASH_NETWORK;
    expect(env.jailBashNetwork()).toEqual([]);
  });
  test("parses comma list", () => {
    process.env.SLAUDE_JAIL_BASH_NETWORK = "api.example.com, pkg.dev";
    expect(env.jailBashNetwork()).toEqual(["api.example.com", "pkg.dev"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/jail-env.test.ts`
Expected: FAIL — `env.jailMode is not a function`.

- [ ] **Step 3: Implement**

In `src/config/env.ts`, add inside the `env` object (after the `idleMs` block, ~line 111):

```ts
  /**
   * Filesystem jail strength for non-trusted (non manager/backup DM) sessions.
   * - `off`         — no confinement (legacy behavior).
   * - `discipline`  — file-tool path gate + best-effort bash string-check (default).
   * - `adversarial` — OS sandbox for bash + path gate + fail-closed.
   * Unknown values fall back to `discipline`.
   */
  jailMode: (): "off" | "discipline" | "adversarial" => {
    const raw = (opt("SLAUDE_JAIL_MODE", "discipline") || "discipline").toLowerCase();
    return raw === "off" || raw === "adversarial" ? raw : "discipline";
  },
  /** Domains a jailed session's sandboxed bash may reach (adversarial mode).
   *  Default empty = no egress. Comma-separated. */
  jailBashNetwork: (): string[] =>
    (opt("SLAUDE_JAIL_BASH_NETWORK", "") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/jail-env.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/jail-env.test.ts
git commit -m "feat(config): SLAUDE_JAIL_MODE + SLAUDE_JAIL_BASH_NETWORK"
```

---

## Task 2: `dm_user_id` column + migration

**Files:**
- Modify: `src/db/schema.ts` (SCHEMA sessions table ~line 11-25; migration block ~line 116; `SessionRow` ~line 150)
- Modify: `src/db/sessions.ts` (`createForThread` ~line 20-49)
- Test: `tests/jail.test.ts` (migration assertion added in Task 3; here just wire the column)

- [ ] **Step 1: Add column to CREATE TABLE**

In `src/db/schema.ts`, inside the `sessions` CREATE TABLE, after the
`permission_mode TEXT NOT NULL DEFAULT 'default',` line, add:

```sql
  dm_user_id TEXT,
```

- [ ] **Step 2: Add the migration**

After the `engaged` migration block (~line 121), add:

```ts
// Migration: DM partner id — drives the workspace-jail trust check
// (a DM whose partner is the manager/backup boots unjailed).
if (!sessionCols.some((c) => c.name === "dm_user_id")) {
  db.run(`ALTER TABLE sessions ADD COLUMN dm_user_id TEXT`);
}
```

- [ ] **Step 3: Extend `SessionRow`**

In the `SessionRow` type, after `engaged: number;`, add:

```ts
  dm_user_id: string | null;
```

- [ ] **Step 4: Thread it through `createForThread`**

In `src/db/sessions.ts`, in the `createForThread` args type add `dm_user_id?: string | null;`, add `dm_user_id` to the INSERT column list and a `?` placeholder, and pass `args.dm_user_id ?? null` in the values array. The function becomes:

```ts
export function createForThread(args: {
  thread: ThreadKey;
  model: string;
  working_dir: string;
  title?: string;
  permission_mode?: string;
  dm_user_id?: string | null;
}): SessionRow {
  const id = randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO sessions
     (id, created_at, updated_at, title, model, working_dir, status,
      claude_started, slack_team_id, slack_channel_id, slack_thread_ts,
      permission_mode, dm_user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?, ?, ?)`,
    [
      id,
      now,
      now,
      args.title ?? null,
      args.model,
      args.working_dir,
      args.thread.team_id,
      args.thread.channel_id,
      args.thread.thread_ts,
      args.permission_mode ?? "default",
      args.dm_user_id ?? null,
    ],
  );
  return findById(id)!;
}
```

- [ ] **Step 5: Typecheck + existing suite**

Run: `bun run typecheck && bun test tests/commands.test.ts`
Expected: typecheck clean; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/sessions.ts
git commit -m "feat(db): sessions.dm_user_id column + migration"
```

---

## Task 3: `jail.ts` — trust, path, and decision helpers

**Files:**
- Create: `src/agent/jail.ts`
- Test: `tests/jail.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/jail.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDmChannel,
  isTrustedSession,
  pathWithinWorkspace,
  jailDecision,
} from "../src/agent/jail";
import type { SessionRow } from "../src/db/schema";
import type { SoulData } from "../src/soul/data";

const soul = {
  manager: { userId: "MGR" },
  backupManager: { userId: "BAK" },
} as unknown as SoulData;

function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: "s", created_at: 0, updated_at: 0, title: null, model: "m",
    working_dir: "/ws", status: "idle", claude_started: 0,
    slack_team_id: "T", slack_channel_id: "D1", slack_thread_ts: "1",
    permission_mode: "default", engaged: 1, dm_user_id: null, ...over,
  };
}

describe("isDmChannel", () => {
  test("D-prefixed is DM", () => expect(isDmChannel("D123")).toBe(true));
  test("channel/group are not", () => {
    expect(isDmChannel("C123")).toBe(false);
    expect(isDmChannel("G123")).toBe(false);
    expect(isDmChannel(null)).toBe(false);
  });
});

describe("isTrustedSession", () => {
  test("manager DM trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: "MGR" }), soul)).toBe(true));
  test("backup DM trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: "BAK" }), soul)).toBe(true));
  test("stranger DM not trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: "X" }), soul)).toBe(false));
  test("manager in a channel (not DM) not trusted", () =>
    expect(isTrustedSession(row({ slack_channel_id: "C1", dm_user_id: "MGR" }), soul)).toBe(false));
  test("missing dm_user_id not trusted", () =>
    expect(isTrustedSession(row({ dm_user_id: null }), soul)).toBe(false));
});

describe("pathWithinWorkspace", () => {
  let ws: string;
  let outside: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "jail-"));
    ws = join(base, "ws");
    outside = join(base, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(ws, "escape"));
  });
  test("in-tree path allowed", () =>
    expect(pathWithinWorkspace(join(ws, "a/b.txt"), ws)).toBe(true));
  test("new file in tree allowed", () =>
    expect(pathWithinWorkspace(join(ws, "new.txt"), ws)).toBe(true));
  test("absolute outside denied", () =>
    expect(pathWithinWorkspace(outside + "/x", ws)).toBe(false));
  test(".. escape denied", () =>
    expect(pathWithinWorkspace(join(ws, "../outside/x"), ws)).toBe(false));
  test("symlink escape denied", () =>
    expect(pathWithinWorkspace(join(ws, "escape/x"), ws)).toBe(false));
});

describe("jailDecision", () => {
  const root = "/ws";
  test("off mode: never denies", () =>
    expect(jailDecision({ mode: "off", jailed: true, toolName: "Read", input: { file_path: "/etc/passwd" }, root })).toBeNull());
  test("trusted (jailed=false): never denies", () =>
    expect(jailDecision({ mode: "adversarial", jailed: false, toolName: "Read", input: { file_path: "/etc/passwd" }, root })).toBeNull());
  test("discipline denies out-of-tree Read", () => {
    const d = jailDecision({ mode: "discipline", jailed: true, toolName: "Read", input: { file_path: "/etc/passwd" }, root });
    expect(d?.behavior).toBe("deny");
  });
  test("discipline allows in-tree Write", () =>
    expect(jailDecision({ mode: "discipline", jailed: true, toolName: "Write", input: { file_path: "/ws/a.txt" }, root })).toBeNull());
  test("discipline denies bash escape", () => {
    const d = jailDecision({ mode: "discipline", jailed: true, toolName: "Bash", input: { command: "cat /etc/passwd" }, root });
    expect(d?.behavior).toBe("deny");
  });
  test("discipline allows in-tree bash", () =>
    expect(jailDecision({ mode: "discipline", jailed: true, toolName: "Bash", input: { command: "ls ." }, root })).toBeNull());
  test("adversarial ignores bash (OS sandbox owns it)", () =>
    expect(jailDecision({ mode: "adversarial", jailed: true, toolName: "Bash", input: { command: "cat /etc/passwd" }, root })).toBeNull());
  test("non-fs tool ignored", () =>
    expect(jailDecision({ mode: "discipline", jailed: true, toolName: "mcp__x__y", input: {}, root })).toBeNull());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/jail.test.ts`
Expected: FAIL — cannot find module `../src/agent/jail`.

- [ ] **Step 3: Implement**

Create `src/agent/jail.ts`:

```ts
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { SessionRow } from "../db/schema";
import type { SoulData } from "../soul/data";

export type JailMode = "off" | "discipline" | "adversarial";

/** Slack DM channels are `D`-prefixed; channels `C`, group/mpim `G`. */
export function isDmChannel(channelId: string | null | undefined): boolean {
  return !!channelId && channelId.startsWith("D");
}

/** Unjailed iff a DM whose partner is the primary or backup manager. */
export function isTrustedSession(row: SessionRow, soul: SoulData): boolean {
  if (!isDmChannel(row.slack_channel_id)) return false;
  const id = row.dm_user_id;
  if (!id) return false;
  return id === soul.manager?.userId || id === soul.backupManager?.userId;
}

/** Resolve symlinks on the nearest existing ancestor, then confirm `target`
 *  stays within `root`. Handles not-yet-existing files (new writes). */
export function pathWithinWorkspace(target: string, root: string): boolean {
  const absRoot = realSafe(resolve(root));
  let abs = resolve(absRoot, target);
  // Walk up to the nearest existing ancestor and realpath it (defeats symlink escape).
  let probe = abs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync(probe);
      abs = probe === abs ? real : resolve(real, relative(probe, abs));
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break; // reached filesystem root
      probe = parent;
    }
  }
  const rel = relative(absRoot, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const FILE_PATH_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);
const OPTIONAL_PATH_TOOLS = new Set(["Grep", "Glob"]);

/** Extract candidate filesystem paths an SDK tool call would touch. */
export function toolTargetPaths(toolName: string, input: any): string[] {
  if (FILE_PATH_TOOLS.has(toolName) && typeof input?.file_path === "string") {
    return [input.file_path];
  }
  if (OPTIONAL_PATH_TOOLS.has(toolName) && typeof input?.path === "string") {
    return [input.path];
  }
  return [];
}

/** Best-effort (leaky) bash escape detector for `discipline` mode. Flags
 *  absolute paths and `..` traversal that point outside the workspace. */
export function bashEscapesWorkspace(command: string, root: string): boolean {
  if (typeof command !== "string") return false;
  // Absolute path tokens that resolve outside the workspace.
  for (const m of command.matchAll(/(?<![\w/])(\/[^\s;|&()'"<>]+)/g)) {
    if (!pathWithinWorkspace(m[1], root)) return true;
  }
  // `..` traversal tokens.
  for (const m of command.matchAll(/(?<![\w/])((?:\.\.\/)+[^\s;|&()'"<>]*)/g)) {
    if (!pathWithinWorkspace(m[1], root)) return true;
  }
  return false;
}

export interface JailDecisionArgs {
  mode: JailMode;
  jailed: boolean;
  toolName: string;
  input: any;
  root: string;
}

/** Returns a hard deny result, or null to fall through to the normal gate. */
export function jailDecision(
  args: JailDecisionArgs,
): { behavior: "deny"; message: string } | null {
  const { mode, jailed, toolName, input, root } = args;
  if (!jailed || mode === "off") return null;

  for (const p of toolTargetPaths(toolName, input)) {
    if (!pathWithinWorkspace(p, root)) {
      return { behavior: "deny", message: `workspace jail: \`${p}\` is outside this session's workspace` };
    }
  }
  // OS sandbox owns bash in adversarial mode; only string-check in discipline.
  if (mode === "discipline" && toolName === "Bash" && bashEscapesWorkspace(input?.command, root)) {
    return { behavior: "deny", message: "workspace jail: command reaches outside this session's workspace" };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/jail.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add src/agent/jail.ts tests/jail.test.ts
git commit -m "feat(agent): jail helpers — trust, path confinement, decision"
```

---

## Task 4: `sandbox.ts` — availability probe + options

**Files:**
- Create: `src/agent/sandbox.ts`
- Test: `tests/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sandbox.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { __probeSandbox, jailSandboxOptions, __resetSandboxCache } from "../src/agent/sandbox";

afterEach(() => __resetSandboxCache());

describe("__probeSandbox", () => {
  test("darwin → available (sandbox-exec built in)", () => {
    expect(__probeSandbox("darwin", () => false)).toBe(true);
  });
  test("linux with bwrap → available", () => {
    expect(__probeSandbox("linux", (bin) => bin === "bwrap")).toBe(true);
  });
  test("linux without bwrap → unavailable", () => {
    expect(__probeSandbox("linux", () => false)).toBe(false);
  });
});

describe("jailSandboxOptions", () => {
  test("locks bash: enabled, no unsandboxed escape, deny-all egress", () => {
    const o = jailSandboxOptions([]);
    expect(o.enabled).toBe(true);
    expect(o.allowUnsandboxedCommands).toBe(false);
    expect(o.autoAllowBashIfSandboxed).toBe(true);
    expect(o.network?.allowedDomains).toEqual([]);
  });
  test("passes through allowed domains", () => {
    expect(jailSandboxOptions(["pkg.dev"]).network?.allowedDomains).toEqual(["pkg.dev"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sandbox.test.ts`
Expected: FAIL — cannot find module `../src/agent/sandbox`.

- [ ] **Step 3: Implement**

Create `src/agent/sandbox.ts`:

```ts
import { execFileSync } from "node:child_process";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

/** True if a usable OS sandbox backend is present for `claude` to jail bash.
 *  darwin ships `sandbox-exec`; linux needs `bwrap` (bubblewrap) on PATH. */
export function __probeSandbox(
  platform: NodeJS.Platform,
  hasBin: (bin: string) => boolean,
): boolean {
  if (platform === "darwin") return true;
  if (platform === "linux") return hasBin("bwrap");
  return false;
}

function binExists(bin: string): boolean {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/sh" } as any);
    return true;
  } catch {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

let cache: boolean | null = null;

/** Test-only cache reset. */
export function __resetSandboxCache(): void {
  cache = null;
}

/** Cached availability of the OS sandbox on this host. */
export function sandboxAvailable(): boolean {
  if (cache === null) cache = __probeSandbox(process.platform, binExists);
  return cache;
}

/** SandboxSettings for a jailed (non-trusted) session: bash jailed to cwd,
 *  no escape to unsandboxed exec, network egress limited to `allowedDomains`
 *  (empty = none). */
export function jailSandboxOptions(allowedDomains: string[]): SandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sandbox.test.ts`
Expected: PASS (5 tests).

If `SandboxSettings` is not re-exported from the package root, import it from the deep path used elsewhere; verify with:
Run: `bun run typecheck`
Expected: clean. If the import fails, change the import to `from "@anthropic-ai/claude-agent-sdk/entrypoints/sandboxTypes"` (the source of truth) and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox.ts tests/sandbox.test.ts
git commit -m "feat(agent): OS sandbox probe + jail sandbox options"
```

---

## Task 5: Plumb `dmUserId` from gateway into the session

**Files:**
- Modify: `src/agent/manager.ts` (`ensureSession` ~line 134-148)
- Modify: `src/gateway/core/gateway.ts` (`ensureSession` call ~line 614; `isDM` at ~line 538)

- [ ] **Step 1: Extend `ensureSession`**

In `src/agent/manager.ts`, change `ensureSession` to accept and persist `dmUserId`:

```ts
  ensureSession(thread: ThreadKey, opts: { title?: string; dmUserId?: string } = {}) {
    let row = Sessions.findByThread(thread);
    if (!row) {
      const workingDir = join(paths.workspaces, `${thread.team_id}-${thread.channel_id}-${thread.thread_ts}`);
      mkdirSync(workingDir, { recursive: true });
      row = Sessions.createForThread({
        thread,
        model: env.model(),
        working_dir: workingDir,
        title: opts.title,
        permission_mode: env.defaultPermissionMode(),
        dm_user_id: opts.dmUserId ?? null,
      });
    }
    return row;
  }
```

- [ ] **Step 2: Pass it from the gateway**

In `src/gateway/core/gateway.ts`, at the `ensureSession` call (~line 614), pass `dmUserId` only for DMs (`isDM` is defined at ~line 538):

```ts
    const session = agent.ensureSession(
      {
        team_id: teamId,
        channel_id: channelId,
        thread_ts: threadTs,
      },
      isDM ? { dmUserId: userId } : {},
    );
```

- [ ] **Step 3: Typecheck + existing suite**

Run: `bun run typecheck && bun test`
Expected: clean; no regressions (the column is written for new DM sessions; existing rows stay `null`).

- [ ] **Step 4: Commit**

```bash
git add src/agent/manager.ts src/gateway/core/gateway.ts
git commit -m "feat(agent): persist DM partner id on session creation"
```

---

## Task 6: Jail wiring in `#startSession`

**Files:**
- Modify: `src/agent/manager.ts` (imports; `#startSession` ~line 312-399)

- [ ] **Step 1: Add imports**

Near the top of `src/agent/manager.ts`, alongside the soul import (line 29), add:

```ts
import { soulData } from "../soul/extract";
import { isTrustedSession, jailDecision, type JailMode } from "./jail";
import { sandboxAvailable, jailSandboxOptions } from "./sandbox";
```

- [ ] **Step 2: Compute jail state + jail-aware canUseTool**

In `#startSession`, replace the resolver/canUseTool block (currently lines 312-315):

```ts
    const resolver = this.#resolver;
    const canUseTool: CanUseTool | undefined = resolver
      ? (toolName, input, ctx) => resolver(sessionId, toolName, input, ctx)
      : undefined;
```

with:

```ts
    // Workspace jail: trusted (manager/backup DM) sessions roam free; everything
    // else is confined to row.working_dir per SLAUDE_JAIL_MODE.
    const jailMode: JailMode = env.jailMode();
    const trusted = isTrustedSession(row, soulData());
    const jailed = !trusted && jailMode !== "off";
    const jailRoot = row.working_dir;

    const resolver = this.#resolver;
    const canUseTool: CanUseTool | undefined =
      resolver || jailed
        ? (toolName, input, ctx) => {
            if (jailed) {
              const deny = jailDecision({ mode: jailMode, jailed, toolName, input, root: jailRoot });
              if (deny) return deny;
            }
            return resolver
              ? resolver(sessionId, toolName, input, ctx)
              : { behavior: "allow", updatedInput: input };
          }
        : undefined;
```

- [ ] **Step 3: Wire the OS sandbox / fail-closed into `options`**

In the `options` object (~line 361), after the `permissionMode`/`allowDangerouslySkipPermissions` spread (line 376) and before `hooks:`, add a computed sandbox/​disallow spread. First, just above the `const options: Options = {` line, compute:

```ts
    // Adversarial mode: OS-sandbox bash for jailed sessions. If the sandbox
    // backend is missing, fail closed — disable Bash entirely and alert.
    let sandboxOpt: ReturnType<typeof jailSandboxOptions> | undefined;
    let disallowBash = false;
    if (jailed && jailMode === "adversarial") {
      if (sandboxAvailable()) {
        sandboxOpt = jailSandboxOptions(env.jailBashNetwork());
      } else {
        disallowBash = true;
        if (!AgentManager.#sandboxAlerted) {
          AgentManager.#sandboxAlerted = true;
          console.error(
            "[jail] OS sandbox unavailable (install bubblewrap) — Bash disabled in jailed sessions",
          );
          this.emit("event", { type: "sandboxUnavailable", sessionId } satisfies AgentEvent);
        }
      }
    }
```

Then add into the `options` object literal, right after the `allowDangerouslySkipPermissions` spread:

```ts
      ...(sandboxOpt ? { sandbox: sandboxOpt } : {}),
      ...(disallowBash ? { disallowedTools: ["Bash"] } : {}),
```

- [ ] **Step 4: Add the static one-shot alert flag + event type**

In the `AgentManager` class body (near other private fields, ~line 94), add:

```ts
  static #sandboxAlerted = false;
```

In the `AgentEvent` union (search for `type AgentEvent =` / the other `satisfies AgentEvent` payloads), add a member:

```ts
  | { type: "sandboxUnavailable"; sessionId: string }
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean. Confirm `Options` accepts `sandbox` and `disallowedTools` (both in SDK 0.1.77 runtimeTypes).

- [ ] **Step 6: Full suite**

Run: `bun test`
Expected: green. Existing sessions are non-DM/`dm_user_id` null → in default `discipline` mode they become jailed; confirm no test boots a real SDK session that would now hit the gate. (Tests mock the SDK; jail logic is unit-tested in Task 3.)

- [ ] **Step 7: Commit**

```bash
git add src/agent/manager.ts
git commit -m "feat(agent): wire workspace jail into session boot (gate + OS sandbox)"
```

---

## Task 7: Sandbox-unavailable manager alert (Slack DM)

**Files:**
- Modify: `src/gateway/core/gateway.ts` (where `agent.on("event", …)` is wired)

- [ ] **Step 1: Locate the event subscription**

Find the existing `agent.on("event", …)` handler in `src/gateway/core/gateway.ts` (the SDK event fanout). Confirm the handler shape and the available Slack `client` + `soulData()`.

Run: `grep -n "agent.on(\"event\"\|app.client\|const client" src/gateway/core/gateway.ts`
Expected: shows the subscription + a Slack WebClient handle.

- [ ] **Step 2: Add a one-shot DM on `sandboxUnavailable`**

Inside the `agent.on("event", async (e) => { … })` handler, add a branch (module-scoped `let sandboxAlertSent = false;` near the top of the file to dedup):

```ts
      if (e.type === "sandboxUnavailable") {
        if (sandboxAlertSent) return;
        sandboxAlertSent = true;
        const mgr = soulData().manager?.userId;
        if (!mgr) return;
        try {
          const im = await client.conversations.open({ users: mgr });
          const ch = (im as any).channel?.id;
          if (ch) {
            await client.chat.postMessage({
              channel: ch,
              text: ":warning: OS sandbox unavailable on the host — Bash is disabled in jailed (non-manager-DM) sessions. Install `bubblewrap` to restore sandboxed bash, or set `SLAUDE_JAIL_MODE=discipline`.",
            });
          }
        } catch (err) {
          console.error("[jail] manager sandbox alert failed:", err);
        }
        return;
      }
```

(Match the actual variable names for the Slack client and the soul accessor in this file; both are already used by neighbouring handlers.)

- [ ] **Step 3: Typecheck + suite**

Run: `bun run typecheck && bun test`
Expected: clean, green.

- [ ] **Step 4: Commit**

```bash
git add src/gateway/core/gateway.ts
git commit -m "feat(gateway): DM manager when OS sandbox unavailable"
```

---

## Task 8: Docs — findings, index, .env.example

**Files:**
- Create: `docs/findings/2026-06-14-workspace-jail.md`
- Modify: `CLAUDE.md` (Findings Log, newest first)
- Modify: `.env.example` (document the two env vars)

- [ ] **Step 1: Findings doc**

Create `docs/findings/2026-06-14-workspace-jail.md` summarizing: the trust model (manager/backup DM unjailed), the two enforcement layers (canUseTool path gate + OS sandbox for bash), `SLAUDE_JAIL_MODE` (off/discipline/adversarial, default discipline), fail-closed + Slack alert, and the behavior shift. Link the spec and plan.

- [ ] **Step 2: Index in CLAUDE.md**

Add to the Findings Log, above the top (2026-06-14 model-switch) entry:

```markdown
- [2026-06-14 — Workspace filesystem jail (manager-DM trust, OS sandbox + path gate, SLAUDE_JAIL_MODE)](docs/findings/2026-06-14-workspace-jail.md)
```

- [ ] **Step 3: Document env vars in .env.example**

Add a section to `.env.example`:

```bash
# Workspace jail: confine non-(manager/backup DM) sessions to their workspace dir.
#   off         — no confinement (legacy behavior)
#   discipline  — file-tool path gate + best-effort bash check (default)
#   adversarial — OS sandbox for bash (needs bubblewrap on Linux) + fail-closed
SLAUDE_JAIL_MODE=discipline
# Domains a jailed session's sandboxed bash may reach (adversarial). Empty = none.
SLAUDE_JAIL_BASH_NETWORK=
```

- [ ] **Step 4: Full verify**

Run: `bun run typecheck && bun test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/findings/2026-06-14-workspace-jail.md .env.example
git commit -m "docs(findings): workspace filesystem jail"
```

---

## Self-Review Notes

- **Spec coverage:** trust model (T3 `isTrustedSession`, T2 `dm_user_id`, T5 plumbing); jail modes (T1 env, T6 wiring); Layer 1 OS sandbox + fail-closed (T4, T6); Layer 2 path gate (T3 `jailDecision`, T6 canUseTool); discipline bash string-check (T3 `bashEscapesWorkspace`); manager alert (T6 emit, T7 Slack DM); behavior-change docs (T8). All mapped.
- **Type consistency:** `JailMode` ("off"|"discipline"|"adversarial"), `jailDecision`, `isTrustedSession`, `jailSandboxOptions`, `sandboxAvailable`, `dm_user_id`, `SessionRow` — names identical across env/jail/sandbox/manager/db tasks.
- **No placeholders:** every code step is complete; commands carry expected output.
- **Risk flagged:** the `AgentEvent` union member and the `agent.on("event")` variable names (Slack client, soul accessor) must be matched to the actual gateway code in T6/T7 — both steps say so explicitly and give the grep to confirm.
- **Behavior shift:** default `discipline` jails all non-manager-DM threads' file tools. Called out in T8 docs and the spec.
```
