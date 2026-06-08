# Private Services in /1on1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a `/1on1` thread, whitelisted external MCP servers mount with the agent's credentials stripped so they run as the initiator (self-prompting auth), while every other session keeps the agent identity.

**Architecture:** A new pure module `src/gateway/core/external-mcp.ts` owns all external-MCP concerns: parse `.mcp.json` (servers + `privateServices`), strip credentials (`clearCredentials`), and compute per-session overrides (`privateOverrides`). `gateway.ts` loses its inline loader, imports the module, and in the per-session `mcpResolver` overlays cleared mounts when the thread is `/1on1`-locked. `/1on1 on`/`off` call `agent.reload(session.id)` so the next turn reboots and the resolver re-evaluates the lock.

**Tech Stack:** Bun + TypeScript, `bun:test`, `@anthropic-ai/claude-agent-sdk` (`McpServerConfig` union: stdio `{command,args?,env?}` | sse/http `{url,headers?}` | sdk).

**Spec:** `docs/superpowers/specs/2026-06-08-private-services-1on1-design.md`

---

## File Structure

- **Create** `src/gateway/core/external-mcp.ts` — pure external-MCP logic:
  - `clearCredentials(cfg)` — strip env/headers/url-auth, return a copy.
  - `parseExternalMcp(parsed, env?)` — expand `${VAR}`, return `{ servers, privateServices }`, warn on unknown private name.
  - `loadExternalMcp()` — read `~/.slaude/.mcp.json`, delegate to `parseExternalMcp`.
  - `privateOverrides(servers, privateServices, isLocked)` — cleared copies of whitelisted servers when locked; `{}` otherwise.
- **Modify** `src/gateway/core/gateway.ts` — delete inline `loadExternalMcp`; import the module; adapt the load site + resolver; add `agent.reload` to the `one-on-one` handler.
- **Create** `tests/gateway/core/external-mcp.test.ts` — unit tests for all four functions.
- **Create** `tests/gateway/sim/private-services.test.ts` — integration: `/1on1` reloads the session.

---

## Task 1: `clearCredentials` — strip secrets from a server config

**Files:**
- Create: `src/gateway/core/external-mcp.ts`
- Test: `tests/gateway/core/external-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/core/external-mcp.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { clearCredentials } from "../../../src/gateway/core/external-mcp";

describe("clearCredentials", () => {
  it("empties env on a stdio server, preserving command + args", () => {
    const cfg = { command: "npx", args: ["-y", "srv"], env: { WB_TOKEN: "secret" } };
    const out = clearCredentials(cfg as any) as any;
    expect(out.command).toBe("npx");
    expect(out.args).toEqual(["-y", "srv"]);
    expect(out.env).toEqual({});
  });

  it("empties headers + strips url userinfo/query on an http server, preserving host/path", () => {
    const cfg = { type: "http", url: "https://user:pass@api.example.com/mcp?token=x", headers: { Authorization: "Bearer s" } };
    const out = clearCredentials(cfg as any) as any;
    expect(out.headers).toEqual({});
    const u = new URL(out.url);
    expect(u.username).toBe("");
    expect(u.password).toBe("");
    expect(u.search).toBe("");
    expect(u.host).toBe("api.example.com");
    expect(u.pathname).toBe("/mcp");
  });

  it("does not mutate the input object", () => {
    const cfg = { command: "x", env: { A: "1" } };
    clearCredentials(cfg as any);
    expect(cfg.env).toEqual({ A: "1" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/gateway/core/external-mcp.test.ts`
Expected: FAIL — `clearCredentials` is not exported / module missing.

- [ ] **Step 3: Write the minimal implementation**

Create `src/gateway/core/external-mcp.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../../config/home";

/** Return a copy of a server config with all injected secrets removed.
 *  stdio → env emptied; sse/http → headers emptied + url userinfo/query stripped.
 *  command/args and url host/path are preserved so the server still launches/reaches
 *  its endpoint — just anonymous. The input is never mutated. */
export function clearCredentials(cfg: McpServerConfig): McpServerConfig {
  const c: any = { ...(cfg as any) };
  if ("env" in c) c.env = {};
  if ("headers" in c) c.headers = {};
  if (typeof c.url === "string") {
    try {
      const u = new URL(c.url);
      u.username = "";
      u.password = "";
      u.search = "";
      c.url = u.toString();
    } catch {
      // Non-absolute URL: leave as-is (can't carry userinfo/query meaningfully).
    }
  }
  return c as McpServerConfig;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/gateway/core/external-mcp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/external-mcp.ts tests/gateway/core/external-mcp.test.ts
git commit -m "feat(mcp): clearCredentials strips secrets from a server config"
```

---

## Task 2: `parseExternalMcp` — parse servers + privateServices from JSON

**Files:**
- Modify: `src/gateway/core/external-mcp.ts`
- Test: `tests/gateway/core/external-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/gateway/core/external-mcp.test.ts`:

```ts
import { parseExternalMcp } from "../../../src/gateway/core/external-mcp";

describe("parseExternalMcp", () => {
  it("returns servers and privateServices, expanding ${VAR} from the env map", () => {
    const parsed = {
      mcpServers: { composio: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${KEY}" } } },
      privateServices: ["composio"],
    };
    const out = parseExternalMcp(parsed, { KEY: "abc" });
    expect((out.servers.composio as any).headers.Authorization).toBe("Bearer abc");
    expect(out.privateServices).toEqual(["composio"]);
  });

  it("defaults privateServices to [] when absent", () => {
    const out = parseExternalMcp({ mcpServers: { a: { command: "x" } } }, {});
    expect(out.privateServices).toEqual([]);
  });

  it("drops a privateServices name that is not a configured server (warns)", () => {
    const out = parseExternalMcp({ mcpServers: { a: { command: "x" } }, privateServices: ["a", "ghost"] }, {});
    expect(out.privateServices).toEqual(["a"]);
  });

  it("returns empty maps for an empty/garbage object", () => {
    const out = parseExternalMcp({}, {});
    expect(out.servers).toEqual({});
    expect(out.privateServices).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/gateway/core/external-mcp.test.ts`
Expected: FAIL — `parseExternalMcp` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/gateway/core/external-mcp.ts`:

```ts
export interface ExternalMcp {
  servers: Record<string, McpServerConfig>;
  privateServices: string[];
}

/** Parse a `.mcp.json`-shaped object: expand ${VAR} placeholders across stdio/http
 *  fields and read the `privateServices` whitelist. Names not present in `mcpServers`
 *  are warned-about and dropped. `env` is injectable for testing. */
export function parseExternalMcp(
  parsed: any,
  env: Record<string, string | undefined> = process.env,
): ExternalMcp {
  const expand = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => env[name] ?? "");
  const servers: Record<string, McpServerConfig> = parsed?.mcpServers ?? {};
  for (const cfg of Object.values<any>(servers)) {
    if (cfg?.env && typeof cfg.env === "object") {
      for (const [k, v] of Object.entries<any>(cfg.env)) if (typeof v === "string") cfg.env[k] = expand(v);
    }
    if (cfg?.headers && typeof cfg.headers === "object") {
      for (const [k, v] of Object.entries<any>(cfg.headers)) if (typeof v === "string") cfg.headers[k] = expand(v);
    }
    if (typeof cfg?.url === "string") cfg.url = expand(cfg.url);
    if (Array.isArray(cfg?.args)) cfg.args = cfg.args.map((a: unknown) => (typeof a === "string" ? expand(a) : a));
  }
  const raw: unknown = parsed?.privateServices;
  const list = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  const privateServices = list.filter((n) => {
    const ok = n in servers;
    if (!ok) console.warn(`[mcp] privateServices entry "${n}" is not a configured server — ignored`);
    return ok;
  });
  return { servers, privateServices };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/gateway/core/external-mcp.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/external-mcp.ts tests/gateway/core/external-mcp.test.ts
git commit -m "feat(mcp): parseExternalMcp reads servers + privateServices whitelist"
```

---

## Task 3: `loadExternalMcp` + `privateOverrides`

**Files:**
- Modify: `src/gateway/core/external-mcp.ts`
- Test: `tests/gateway/core/external-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/gateway/core/external-mcp.test.ts`:

```ts
import { privateOverrides } from "../../../src/gateway/core/external-mcp";

describe("privateOverrides", () => {
  const servers = {
    composio: { type: "http", url: "https://x", headers: { Authorization: "Bearer s" } },
    jira: { command: "npx", env: { T: "secret" } },
  } as any;

  it("returns cleared copies of whitelisted servers when locked", () => {
    const out = privateOverrides(servers, new Set(["composio"]), true) as any;
    expect(Object.keys(out)).toEqual(["composio"]);
    expect(out.composio.headers).toEqual({});
    expect(servers.composio.headers).toEqual({ Authorization: "Bearer s" }); // source untouched
  });

  it("returns {} when not locked", () => {
    expect(privateOverrides(servers, new Set(["composio"]), false)).toEqual({});
  });

  it("ignores whitelist names with no matching server", () => {
    const out = privateOverrides(servers, new Set(["ghost"]), true);
    expect(out).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/gateway/core/external-mcp.test.ts`
Expected: FAIL — `privateOverrides` / `loadExternalMcp` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/gateway/core/external-mcp.ts`:

```ts
/** Per-session overrides: when the thread is /1on1-locked, return cleared copies of
 *  each whitelisted server so they mount anonymous. Empty when unlocked. Source map
 *  is never mutated (clearCredentials copies). */
export function privateOverrides(
  servers: Record<string, McpServerConfig>,
  privateServices: ReadonlySet<string>,
  isLocked: boolean,
): Record<string, McpServerConfig> {
  if (!isLocked) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const name of privateServices) {
    const cfg = servers[name];
    if (cfg) out[name] = clearCredentials(cfg);
  }
  return out;
}

/** Load + parse `~/.slaude/.mcp.json`. Missing file → empty result. */
export function loadExternalMcp(): ExternalMcp {
  const f = join(paths.home, ".mcp.json");
  if (!existsSync(f)) return { servers: {}, privateServices: [] };
  try {
    return parseExternalMcp(JSON.parse(readFileSync(f, "utf8")));
  } catch (err) {
    console.error(`[mcp] failed to load ${f}:`, err);
    return { servers: {}, privateServices: [] };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/gateway/core/external-mcp.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/external-mcp.ts tests/gateway/core/external-mcp.test.ts
git commit -m "feat(mcp): privateOverrides + loadExternalMcp return shape"
```

---

## Task 4: Wire the module into `gateway.ts` (resolver overlay)

**Files:**
- Modify: `src/gateway/core/gateway.ts` (delete inline loader ~`53-83`; load site ~`214-217`; resolver ~`228-263`)

- [ ] **Step 1: Delete the inline `loadExternalMcp` from `gateway.ts`**

Remove the entire `function loadExternalMcp(): Record<string, McpServerConfig> { ... }` block (the one currently at lines ~53-83). Add an import near the other `./` imports at the top of the file:

```ts
import { loadExternalMcp, privateOverrides } from "./external-mcp";
```

(Leave the `import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";` line in place — it is still used by the resolver's `servers` type.)

- [ ] **Step 2: Adapt the load site**

Replace the current load block (lines ~214-217):

```ts
  const externalMcp = loadExternalMcp();
  if (Object.keys(externalMcp).length) {
    console.log(`[mcp] loaded external servers: ${Object.keys(externalMcp).join(", ")}`);
  }
```

with:

```ts
  const externalMcp = loadExternalMcp();
  const privateServiceSet = new Set(externalMcp.privateServices);
  if (Object.keys(externalMcp.servers).length) {
    console.log(`[mcp] loaded external servers: ${Object.keys(externalMcp.servers).join(", ")}`);
  }
  if (externalMcp.privateServices.length) {
    console.log(`[mcp] private (1on1-scoped) services: ${externalMcp.privateServices.join(", ")}`);
  }
```

- [ ] **Step 3: Spread the cleared servers + apply the lock in the resolver**

In `agent.setMcpResolver(...)`, change the `servers` object's external spread from `...externalMcp` to `...externalMcp.servers` (line ~240). Then, immediately after the `servers` object literal is constructed (before the connect-broker block at ~245), add:

```ts
    // 1on1 privacy: when this thread is locked, whitelisted external services mount
    // with the agent's credentials stripped so they run as the initiator (self-prompt
    // auth). Other sessions/threads keep the agent identity (source map untouched).
    const oneOnOneLock = OneOnOne.find(route.ctx.channel, route.ctx.threadTs);
    Object.assign(servers, privateOverrides(externalMcp.servers, privateServiceSet, !!oneOnOneLock));
```

(`OneOnOne` is already imported at gateway.ts:39; `route.ctx.channel` and `route.ctx.threadTs` are the same fields the connect-broker block reads just below.)

- [ ] **Step 4: Verify typecheck + full suite**

Run: `bun run typecheck`
Expected: PASS (no errors).

Run: `bun test tests/gateway/core/`
Expected: PASS — existing `gateway-seam` / `transport` tests still green, plus `external-mcp`.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts
git commit -m "feat(mcp): resolver clears whitelisted services in a /1on1 thread"
```

---

## Task 5: `/1on1 on`/`off` reloads the session

**Files:**
- Modify: `src/gateway/core/gateway.ts` (`one-on-one` handler, lines ~500-514)
- Test: `tests/gateway/sim/private-services.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/sim/private-services.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";

let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; });

describe("/1on1 reloads the session so the resolver re-evaluates privacy", () => {
  it("calls agent.reload on lock and on release", async () => {
    s = await SimSession.create({ agent: "stub", layer: "trusted", as: "member" });
    s.thread = "T1";                       // pin to one thread so the lock applies
    const calls: string[] = [];
    const orig = s.agent.reload.bind(s.agent);
    s.agent.reload = (id: string) => { calls.push(id); return orig(id); };

    await s.send({ text: "/1on1" });        // lock
    await s.send({ as: "U0MGR", text: "/1on1 off", thread: "T1" }); // manager releases

    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/gateway/sim/private-services.test.ts`
Expected: FAIL — `reload` is not yet called by the handler (`calls.length` is 0).

- [ ] **Step 3: Add the reload calls to the handler**

In `gateway.ts`, the `one-on-one` slash handler (lines ~500-513). After the lock branch:

```ts
        if (slash.action === "on") {
          OneOnOne.lock({ channelId, threadTs, lockedUser: userId, createdBy: userId });
          agent.reload(session.id);   // reboot so the resolver clears private services next turn
          await reply(`:lock: *1on1 mode* — only <@${userId}> and the manager will be heard in this thread. \`/1on1 off\` to release.`);
          return;
        }
```

And after the unlock:

```ts
        OneOnOne.unlock(channelId, threadTs);
        agent.reload(session.id);     // reboot so the resolver restores agent-cred mounts next turn
        await reply(":unlock: 1on1 released — the thread is open again.");
        return;
```

(`agent` and `session` are both in scope in `handleMessage`; `agent.reload` returns `false` as a harmless no-op when the session is not live, and the next boot re-evaluates the lock regardless.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/gateway/sim/private-services.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck + the full suite**

Run: `bun run typecheck && bun test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/core/gateway.ts tests/gateway/sim/private-services.test.ts
git commit -m "feat(1on1): reload the session on lock/release to re-evaluate private services"
```

---

## Task 6: Finding doc + index

**Files:**
- Create: `docs/findings/2026-06-08-private-services-1on1.md`
- Modify: `CLAUDE.md` (Findings Log index — newest first)

- [ ] **Step 1: Write the finding**

Create `docs/findings/2026-06-08-private-services-1on1.md`:

```markdown
# 2026-06-08 — Private services in /1on1 (run as the initiator)

`privateServices: [...]` in `~/.slaude/.mcp.json` whitelists external MCP servers that
must NOT use the agent's shared OAuth inside a `/1on1` thread. On lock, the session
reloads; the per-session resolver overlays cleared mounts (`clearCredentials`: env/headers
emptied, url userinfo/query stripped) for whitelisted servers, so they boot anonymous and
self-prompt the initiator to authenticate. Other sessions keep the agent identity (the
source server map is never mutated). `/1on1 off` reloads again to restore agent-cred mounts.

**Mechanism:** trigger = `agent.reload(session.id)` in the `one-on-one` handler → next turn
reboots → `mcpResolver` checks `OneOnOne.find` and applies `privateOverrides`. A session that
boots already-locked is cleared with no special-casing (the resolver checks the lock every boot).

**Logic lives in pure helpers** (`src/gateway/core/external-mcp.ts`): `clearCredentials`,
`parseExternalMcp`, `privateOverrides` — all unit-tested; gateway wiring is thin glue.

**Contract:** a whitelisted service MUST support anonymous start + interactive auth. Stripped
of creds it must boot and prompt, not crash. `clearCredentials` clears the whole env/headers
block (it can't know which key is the secret) — per-key clearing deferred.

Spec: `docs/superpowers/specs/2026-06-08-private-services-1on1-design.md`.
Plan: `docs/superpowers/plans/2026-06-08-private-services-1on1.md`.
```

- [ ] **Step 2: Add the index line to `CLAUDE.md`**

In the `## Findings Log` list, add as the new top (newest-first) entry:

```markdown
- [2026-06-08 — Private services in /1on1 (run as the initiator)](docs/findings/2026-06-08-private-services-1on1.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/findings/2026-06-08-private-services-1on1.md CLAUDE.md
git commit -m "docs(findings): private services in /1on1"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** config whitelist (T2/T3), `clearCredentials` semantics (T1), resolver clear-when-locked (T4 wiring over T1-T3 helpers), reload on `/1on1 on`+`off` (T5), boot-already-locked (free — resolver checks lock every boot, asserted indirectly via `privateOverrides`), other-sessions-untouched (T1/T2 "source untouched" assertions).
- **Type consistency:** `ExternalMcp = { servers, privateServices }` is the single return shape used by `loadExternalMcp`, the resolver, and `privateOverrides`'s first arg. `privateOverrides(servers, ReadonlySet<string>, boolean)`.
- **No new prompt infra:** auth prompting is the external service's own behavior; nothing in this plan renders it.
