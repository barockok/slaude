# Simulation Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive every Slack-dependent behavior (engagement, channel-mode, blocklist/ignore, approval + connect-grant buttons, slash-command authz across roles/channels) with zero real Slack, by running the *real* gateway logic against an injected in-memory transport.

**Architecture:** Extract a `Transport` port; turn `createSlackApp(agent)` into `createGateway(agent, transport)` with all gate/command/wiring logic unchanged. Bolt `App` satisfies the port structurally (Slack path untouched). A `SimTransport` provides an in-memory client + event/action injection. A `StubAgent` drives turns by calling the *real* exported MCP handlers (`slackHandlers`, `brokerHandlers`) through a narrow `__sessionCtx` test seam, so approval-gate and the connect-broker run for real without Claude. Scenario presets + a YAML transcript runner + a REPL share one `SimSession` engine.

**Tech Stack:** Bun + TypeScript, `bun:test`, `bun:sqlite`, `@anthropic-ai/claude-agent-sdk`, `@slack/bolt` (prod transport only), `yaml`.

**Spec:** `docs/superpowers/specs/2026-05-29-simulation-gateway-design.md`

---

## Shared types (defined once, referenced throughout)

```ts
// src/gateway/core/transport.ts
export interface WebClientLike {
  auth: { test(args?: any): Promise<any> };
  chat: { postMessage(args: any): Promise<any>; update(args: any): Promise<any> };
  reactions: { add(args: any): Promise<any>; remove(args: any): Promise<any> };
  conversations: { info(args: any): Promise<any>; members(args: any): Promise<any>; replies(args: any): Promise<any> };
  users: { info(args: any): Promise<any>; profile: { set(args: any): Promise<any> } };
  search: { messages(args: any): Promise<any> };
  // assistant.threads.setStatus is reached via `(client as any).assistant...` in status.ts;
  // sim client provides it as a no-op (see Task 5).
}
export type ActionHandler = (args: { ack: () => Promise<void>; action: { action_id: string }; body: any; respond: (msg: any) => Promise<void> }) => Promise<void>;
export type EventHandler = (args: { event: any; client: WebClientLike; context: any }) => Promise<void>;
export type Middleware = (args: { payload: any; next: () => Promise<void> }) => Promise<void>;
export interface Transport {
  client: WebClientLike;
  action(idOrRegex: string | RegExp, h: ActionHandler): void;
  event(name: string, h: EventHandler): void;
  use(mw: Middleware): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

```ts
// src/gateway/core/gateway.ts (added exports)
import type { SlackContext } from "../slack/mcp-tools";
import type { BrokerToolCtx } from "../../agent/connect-broker/broker-mcp";
export interface SessionMcpCtx { slack: SlackContext; connect?: BrokerToolCtx }
export interface GatewayHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** TEST/SIM SEAM ONLY. Live per-session MCP contexts built by the resolver.
   *  Undefined until the session's resolver has run. Production never calls this. */
  __sessionCtx(sessionId: string): SessionMcpCtx | undefined;
}
```

```ts
// src/gateway/sim/transport.ts
export interface OutboundCard {
  kind: "message" | "approval" | "permission" | "status" | "reaction";
  channel: string;
  threadTs?: string;
  text?: string;
  blocks?: any[];
  actionIds: string[];
  resolved: boolean;
  raw: any;
}
```

```ts
// src/gateway/sim/stub-agent.ts
export interface BehaviorArgs {
  sessionId: string;
  envelope: string;
  ctx?: import("../core/gateway").SessionMcpCtx;
  emit: (e: import("../../agent/manager").AgentEvent) => void;
}
export type Behavior = (a: BehaviorArgs) => Promise<void>;
```

```ts
// src/gateway/sim/engine.ts
export interface SoulFixture { manager: string; backup?: string; approvers: string[]; trusted: string[]; allowed: string[] }
```

```ts
// src/gateway/sim/presets.ts
export interface ScenarioPreset {
  name: string; title: string;
  soul: import("./engine").SoulFixture;
  actor: string; channel: string; dm?: boolean; behavior: string;
}
```

```ts
// src/gateway/sim/transcript.ts
export interface Transcript {
  preset?: string;
  soul?: Partial<import("./engine").SoulFixture>;
  agent_behavior?: string;
  steps: Step[];
}
export type Step =
  | { send: { as?: string; channel?: string; text: string; dm?: boolean } }
  | { click: { as?: string; action: string } }
  | { expect_card: { kind: OutboundCard["kind"]; to?: string; contains?: string } }
  | { expect_reply: { contains: string } }
  | { expect_drop: { reason: string } }
  | { expect_pending: Record<string, never> };
```

---

## Task 1: Transport port

**Files:**
- Create: `src/gateway/core/transport.ts`
- Test: `tests/gateway/core/transport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/core/transport.test.ts
import { describe, it, expect } from "bun:test";
import type { Transport, WebClientLike } from "../../../src/gateway/core/transport";

describe("Transport port", () => {
  it("a minimal in-memory object satisfies the Transport shape", () => {
    const t: Transport = {
      client: {} as WebClientLike,
      action: () => {},
      event: () => {},
      use: () => {},
      start: async () => {},
      stop: async () => {},
    };
    expect(typeof t.action).toBe("function");
    expect(typeof t.start).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/core/transport.test.ts`
Expected: FAIL — cannot find module `../core/transport`.

- [ ] **Step 3: Write the port**

Create `src/gateway/core/transport.ts` with the `WebClientLike`, `ActionHandler`,
`EventHandler`, `Middleware`, and `Transport` declarations from **Shared types** above.

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/core/transport.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/transport.ts tests/gateway/core/transport.test.ts
git commit -m "feat(gateway-core): Transport port + WebClientLike"
```

---

## Task 2: Gate constructors accept `Transport`

`ApprovalGate` and `PermissionGate` only use `app.client` and `app.action`. Change their
constructors to take a `Transport`. Bolt `App` satisfies it structurally, so the Slack path
keeps passing the bolt app. `ReactionTracker`/`Status` already take a `WebClient` — widen
their parameter type to `WebClientLike`.

**Files:**
- Modify: `src/gateway/slack/approval-gate.ts:1-2,49-66` (import + constructor)
- Modify: `src/gateway/slack/permission-gate.ts:1-2,28-44` (import + constructor)
- Modify: `src/gateway/slack/reactions.ts:1,12-14` (param type)
- Modify: `src/gateway/slack/status.ts:1,12-19` (param type)
- Test: `tests/gateway/slack/approval-gate-transport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/slack/approval-gate-transport.test.ts
import { describe, it, expect } from "bun:test";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";
import type { Transport } from "../../../src/gateway/core/transport";

function fakeTransport(): Transport & { actions: Array<{ id: any; h: any }>; posted: any[] } {
  const actions: Array<{ id: any; h: any }> = [];
  const posted: any[] = [];
  return {
    actions, posted,
    client: {
      chat: { postMessage: async (a: any) => { posted.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
    } as any,
    action: (id, h) => { actions.push({ id, h }); },
    event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

describe("ApprovalGate accepts a Transport", () => {
  it("registers an action handler and posts a card", async () => {
    const t = fakeTransport();
    const gate = new ApprovalGate(t, [], { timeoutSeconds: () => 0 });
    expect(t.actions.length).toBe(1);                       // slaude_appr:* handler registered
    const decision = gate.request({ channel: "C1", threadTs: "1.0", summary: "do it", approvers: ["U_MGR"] });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.posted.length).toBe(1);                        // approval card posted via t.client
    // resolve via the registered handler
    const handler = t.actions[0]!.h;
    await handler({
      ack: async () => {}, action: { action_id: `${(t.posted[0].blocks.at(-1).elements[0].action_id)}` },
      body: { user: { id: "U_MGR" } }, respond: async () => {},
    });
    expect((await decision).approved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/slack/approval-gate-transport.test.ts`
Expected: FAIL — `ApprovalGate` constructor expects `App`, type error / runtime mismatch.

- [ ] **Step 3: Change the constructors**

In `src/gateway/slack/approval-gate.ts`:

```ts
// replace the bolt imports at top
import type { Transport } from "../core/transport";
import type { WebClientLike } from "../core/transport";
// ...
export class ApprovalGate {
  #client: WebClientLike;
  // ...unchanged fields...
  constructor(
    transport: Transport,
    envApprovers: string[],
    opts: { timeoutSeconds?: () => number } = {},
  ) {
    this.#client = transport.client;
    this.#envApprovers = new Set(envApprovers);
    this.#timeoutSeconds = opts.timeoutSeconds ?? (() => 0);
    transport.action(
      /^slaude_appr:(approve|deny|grant_thread|grant_once):.+$/,
      async ({ ack, action, body, respond }) => { /* body unchanged */ },
    );
  }
```

(Keep the entire action-handler body and `request()` method byte-for-byte; only the
constructor parameter type and the `app.action`→`transport.action`, `app.client`→
`transport.client` references change.)

In `src/gateway/slack/permission-gate.ts` apply the same change: constructor takes
`transport: Transport`, set `this.#client = transport.client`, register via
`transport.action(/^slaude_perm:.../ , ...)`. Keep the rest unchanged.

In `src/gateway/slack/reactions.ts` and `src/gateway/slack/status.ts`, change the import
`import type { WebClient } from "@slack/web-api"` → `import type { WebClientLike } from "../core/transport"`
and the constructor/field types `WebClient` → `WebClientLike`.

- [ ] **Step 4: Run the new test + the full suite + typecheck**

Run: `bun test tests/gateway/slack/approval-gate-transport.test.ts && bun test && bun run typecheck`
Expected: new test PASS; existing suite still green; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/approval-gate.ts src/gateway/slack/permission-gate.ts src/gateway/slack/reactions.ts src/gateway/slack/status.ts tests/gateway/slack/approval-gate-transport.test.ts
git commit -m "refactor(gateway): gates accept Transport port instead of bolt App"
```

---

## Task 3: Extract `createGateway` + `__sessionCtx` seam

Move `createSlackApp`'s body into `createGateway(agent, transport)`. This is a **verbatim
move** with three mechanical substitutions plus one added seam. Do not change any gate/
command/engagement logic.

**Files:**
- Create: `src/gateway/core/gateway.ts` (moved body + seam)
- Modify: `src/gateway/slack/adapter.ts` (becomes a thin re-export — see Task 4)
- Test: `tests/gateway/core/gateway-seam.test.ts`

- [ ] **Step 1: Create `core/gateway.ts` by moving the body**

Copy the entire contents of `src/gateway/slack/adapter.ts` into
`src/gateway/core/gateway.ts`, then apply:

1. Rename the export: `export function createSlackApp(agent: AgentManager)` →
   `export function createGateway(agent: AgentManager, t: Transport): GatewayHandle`.
2. Delete the bolt construction block (`const app = new App({...})`, lines ~87-92) and
   every `app.` reference becomes `t.` (`app.client`→`t.client`, `app.event`→`t.event`,
   `app.action` is inside the gates already, `app.use`→`t.use`). The diag `auth.test`
   block uses `t.client.auth.test()`.
3. Construct gates with `t`: `new ApprovalGate(t, env.slack.approvers(), {...})`,
   `new PermissionGate(t)`, `new ReactionTracker(t.client)`, `new Presence(t.client)`,
   `new Status(t.client)`.
4. Fix imports: add `import type { Transport } from "./transport";` and
   `import type { GatewayHandle, SessionMcpCtx } from "./gateway";` is not needed (same
   file — declare `SessionMcpCtx`/`GatewayHandle` here per **Shared types**). Adjust all
   relative import paths from `./X` (slack-local) to `../slack/X`, and `../../X` →
   `../../X` stays (now one dir deeper: `../../agent` → `../../agent`). **Verify every
   import resolves** — `core/` is a sibling of `slack/`, so `./reactions` becomes
   `../slack/reactions`, `../../agent/manager` becomes `../../agent/manager` (unchanged
   depth).
5. Add the session-ctx map + seam. Near the top of the function:

```ts
const sessionCtx = new Map<string, SessionMcpCtx>();
```

   Inside `agent.setMcpResolver((sessionId) => { ... })`, after `route` is fetched and the
   servers record is built, capture the contexts. Change the broker mount block to keep a
   reference and stash both ctxs before `return servers;`:

```ts
    let connectCtx: BrokerToolCtx | undefined;
    if (connectBroker && route.ctx.teamId && route.ctx.userId) {
      connectCtx = connectBroker.buildCtx({
        getCallerUserId: () => route.ctx.userId ?? "unknown",
        thread: { team_id: route.ctx.teamId, channel_id: route.ctx.channel, thread_ts: route.ctx.threadTs },
        postConnectUrl: async (_service) => ({ url: "(login host not configured in this build)", expiresInMs: 0 }),
      });
      servers[CONNECT_MCP_NAME] = createConnectMcp(connectCtx);
    }
    sessionCtx.set(sessionId, { slack: route.ctx, connect: connectCtx });
    return servers;
```

6. Replace `return app;` with:

```ts
  return {
    start: () => t.start(),
    stop: () => t.stop(),
    __sessionCtx: (sessionId: string) => sessionCtx.get(sessionId),
  };
```

   Add `import type { BrokerToolCtx } from "../../agent/connect-broker/broker-mcp";`.

- [ ] **Step 2: Write the seam test (fake transport)**

```ts
// tests/gateway/core/gateway-seam.test.ts
import { describe, it, expect } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";

function fakeTransport(): Transport {
  return {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
  };
}

describe("createGateway", () => {
  it("returns a handle with start/stop/__sessionCtx", () => {
    const h = createGateway(new AgentManager(), fakeTransport());
    expect(typeof h.start).toBe("function");
    expect(typeof h.stop).toBe("function");
    expect(h.__sessionCtx("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the seam test + full suite + typecheck**

Run: `bun test tests/gateway/core/gateway-seam.test.ts && bun test && bun run typecheck`
Expected: PASS. (The full suite proves the verbatim move didn't change behavior; existing
slack adapter tests, if any, still pass via the re-export added in Task 4.)

- [ ] **Step 4: Commit**

```bash
git add src/gateway/core/gateway.ts tests/gateway/core/gateway-seam.test.ts
git commit -m "feat(gateway-core): createGateway(agent, transport) + __sessionCtx seam"
```

---

## Task 4: Slack transport binding + re-export + server wiring

**Files:**
- Create: `src/gateway/slack/transport.ts`
- Modify: `src/gateway/slack/adapter.ts` (replace body with a re-export)
- Modify: `src/server.ts:3,20`
- Test: `tests/gateway/slack/transport.test.ts`

- [ ] **Step 1: Write the slack transport**

```ts
// src/gateway/slack/transport.ts
import { App, LogLevel } from "@slack/bolt";
import { env } from "../../config/env";
import type { Transport } from "../core/transport";

/** Production transport: wraps a bolt Socket Mode App. Bolt's App already
 *  satisfies Transport structurally; we wrap it so start/stop are explicit and
 *  the client is typed as WebClientLike. */
export function createSlackTransport(): Transport {
  const app = new App({
    token: env.slack.botToken(),
    appToken: env.slack.appToken(),
    socketMode: true,
    logLevel: LogLevel.INFO,
  });
  return {
    client: app.client as any,
    action: (idOrRegex, h) => app.action(idOrRegex as any, h as any),
    event: (name, h) => app.event(name as any, h as any),
    use: (mw) => app.use(mw as any),
    start: () => app.start().then(() => undefined),
    stop: () => app.stop().then(() => undefined),
  };
}
```

- [ ] **Step 2: Replace adapter.ts with a re-export**

```ts
// src/gateway/slack/adapter.ts
import type { AgentManager } from "../../agent/manager";
import { createGateway, type GatewayHandle } from "../core/gateway";
import { createSlackTransport } from "./transport";

/** Back-compat entry: build the production (bolt) gateway. */
export function createSlackApp(agent: AgentManager): GatewayHandle {
  return createGateway(agent, createSlackTransport());
}
```

- [ ] **Step 3: Wire server.ts**

`src/server.ts` already imports `createSlackApp` from `./gateway/slack/adapter` and calls
`createSlackApp(agent)` → `.start()`/`.stop()`. No change needed beyond confirming it
compiles against the new `GatewayHandle` return type. Leave the import as-is.

- [ ] **Step 4: Write the binding shape test**

```ts
// tests/gateway/slack/transport.test.ts
import { describe, it, expect } from "bun:test";

describe("slack transport binding", () => {
  it("exposes the Transport shape without constructing bolt (smoke import)", async () => {
    const mod = await import("../../../src/gateway/slack/transport");
    expect(typeof mod.createSlackTransport).toBe("function");
  });
});
```

(We do not call `createSlackTransport()` in tests — it needs real Slack tokens. The shape
is enforced by `bun run typecheck`.)

- [ ] **Step 5: Run suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/slack/transport.ts src/gateway/slack/adapter.ts tests/gateway/slack/transport.test.ts
git commit -m "feat(gateway): slack transport binding + adapter re-export"
```

---

## Task 5: SimTransport

**Files:**
- Create: `src/gateway/sim/transport.ts`
- Test: `tests/gateway/sim/transport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/transport.test.ts
import { describe, it, expect } from "bun:test";
import { SimTransport } from "../../../src/gateway/sim/transport";

describe("SimTransport", () => {
  it("records postMessage as a message card and classifies approval cards", async () => {
    const t = new SimTransport({ users: { U1: "Alice" } });
    await t.client.chat.postMessage({ channel: "C1", thread_ts: "1.0", text: "hi", blocks: [] });
    expect(t.outbound[0]).toMatchObject({ kind: "message", channel: "C1", text: "hi", resolved: false });

    await t.client.chat.postMessage({
      channel: "C1", text: "appr",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: "slaude_appr:approve:x1" }, { type: "button", action_id: "slaude_appr:deny:x1" }] }],
    });
    const card = t.outbound[1]!;
    expect(card.kind).toBe("approval");
    expect(card.actionIds).toEqual(["slaude_appr:approve:x1", "slaude_appr:deny:x1"]);
  });

  it("feedMessage invokes the message handler with a bolt-shaped arg", async () => {
    const t = new SimTransport({});
    const seen: any[] = [];
    t.event("message", async (a) => { seen.push(a.event); });
    await t.feedMessage({ channel: "C1", user: "U1", text: "yo", team: "T1" });
    expect(seen[0]).toMatchObject({ channel: "C1", user: "U1", text: "yo" });
  });

  it("feedAction routes to the regex-matching handler and respond() resolves the card", async () => {
    const t = new SimTransport({});
    await t.client.chat.postMessage({ channel: "C1", text: "appr", blocks: [{ type: "actions", elements: [{ type: "button", action_id: "slaude_appr:approve:x1" }] }] });
    let gotUser = "";
    t.action(/^slaude_appr:(approve|deny):.+$/, async ({ action, body, respond, ack }) => {
      await ack(); gotUser = body.user.id;
      await respond({ replace_original: true, text: "done", blocks: [] });
    });
    await t.feedAction("slaude_appr:approve:x1", "U_MGR");
    expect(gotUser).toBe("U_MGR");
    expect(t.outbound[0]!.resolved).toBe(true);         // original approval marked resolved
    expect(t.outbound.at(-1)!.text).toBe("done");        // replacement card appended
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement SimTransport**

```ts
// src/gateway/sim/transport.ts
import type { Transport, WebClientLike, ActionHandler, EventHandler, Middleware } from "../core/transport";

export interface OutboundCard {
  kind: "message" | "approval" | "permission" | "status" | "reaction";
  channel: string;
  threadTs?: string;
  text?: string;
  blocks?: any[];
  actionIds: string[];
  resolved: boolean;
  raw: any;
}

function extractActionIds(blocks: any[] | undefined): string[] {
  if (!Array.isArray(blocks)) return [];
  const ids: string[] = [];
  for (const b of blocks) {
    if (b?.type === "actions" && Array.isArray(b.elements)) {
      for (const el of b.elements) if (el?.action_id) ids.push(el.action_id);
    }
  }
  return ids;
}

function classify(actionIds: string[]): OutboundCard["kind"] {
  if (actionIds.some((a) => a.startsWith("slaude_appr:"))) return "approval";
  if (actionIds.some((a) => a.startsWith("slaude_perm:"))) return "permission";
  return "message";
}

export class SimTransport implements Transport {
  outbound: OutboundCard[] = [];
  client: WebClientLike;
  #events = new Map<string, EventHandler>();
  #actions: Array<{ id: string | RegExp; h: ActionHandler }> = [];
  #users: Record<string, string>;
  #botUserId: string;
  #seq = 0;

  constructor(opts: { users?: Record<string, string>; botUserId?: string } = {}) {
    this.#users = opts.users ?? {};
    this.#botUserId = opts.botUserId ?? "U_SLAUDE";
    const push = (kind: OutboundCard["kind"], channel: string, threadTs: string | undefined, text: string | undefined, blocks: any[] | undefined, raw: any) => {
      const actionIds = extractActionIds(blocks);
      const card: OutboundCard = { kind, channel, threadTs, text, blocks, actionIds, resolved: false, raw };
      this.outbound.push(card);
      return { ok: true, ts: `${++this.#seq}.0` };
    };
    this.client = {
      auth: { test: async () => ({ ok: true, user_id: this.#botUserId, bot_id: "B_SLAUDE", team: "T_SIM", url: "https://sim" }) },
      chat: {
        postMessage: async (a: any) => push(classify(extractActionIds(a.blocks)), a.channel, a.thread_ts, a.text, a.blocks, a),
        update: async (a: any) => push("message", a.channel, a.ts, a.text, a.blocks, a),
      },
      reactions: {
        add: async (a: any) => push("reaction", a.channel, a.timestamp, `:${a.name}:`, undefined, a),
        remove: async () => ({ ok: true }),
      },
      conversations: {
        info: async (a: any) => ({ ok: true, channel: { id: a.channel } }),
        members: async () => ({ ok: true, members: [] }),
        replies: async () => ({ ok: true, messages: [] }),
      },
      users: { info: async (a: any) => ({ ok: true, user: { id: a.user, real_name: this.#users[a.user] ?? a.user } }), profile: { set: async () => ({ ok: true }) } },
      search: { messages: async () => ({ ok: true, messages: { matches: [] } }) },
      // status.ts reaches assistant.threads.setStatus via (client as any)
      assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    } as any;
  }

  action(idOrRegex: string | RegExp, h: ActionHandler) { this.#actions.push({ id: idOrRegex, h }); }
  event(name: string, h: EventHandler) { this.#events.set(name, h); }
  use(_mw: Middleware) { /* sim ignores diagnostic middleware */ }
  async start() {}
  async stop() {}

  async feedMessage(raw: { channel: string; user: string; text: string; channel_type?: string; thread_ts?: string; ts?: string; team?: string }) {
    const ts = raw.ts ?? `${++this.#seq}.5`;
    const event = {
      type: "message", channel: raw.channel, user: raw.user, text: raw.text,
      channel_type: raw.channel_type, thread_ts: raw.thread_ts, ts, team: raw.team,
    };
    const args = { event, client: this.client, context: { teamId: raw.team } };
    // app_mention path: if the text @mentions the bot, fire app_mention first (matches bolt).
    if (raw.text.includes(`<@${this.#botUserId}>`)) {
      await this.#events.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    }
    await this.#events.get("message")?.(args);
  }

  async feedAction(actionId: string, byUser: string) {
    const entry = this.#actions.find((a) => (typeof a.id === "string" ? a.id === actionId : a.id.test(actionId)));
    if (!entry) throw new Error(`no action handler matches ${actionId}`);
    const respond = async (msg: any) => {
      if (msg?.replace_original) {
        // mark the most recent unresolved card carrying this actionId as resolved
        for (let i = this.outbound.length - 1; i >= 0; i--) {
          if (!this.outbound[i]!.resolved && this.outbound[i]!.actionIds.includes(actionId)) { this.outbound[i]!.resolved = true; break; }
        }
      }
      this.outbound.push({ kind: "message", channel: "(respond)", text: msg?.text, blocks: msg?.blocks, actionIds: extractActionIds(msg?.blocks), resolved: false, raw: msg });
    };
    await entry.h({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: byUser } }, respond });
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/sim/transport.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/transport.ts tests/gateway/sim/transport.test.ts
git commit -m "feat(sim): SimTransport — in-memory client + event/action injection"
```

---

## Task 6: StubAgent + behaviors

**Files:**
- Create: `src/gateway/sim/stub-agent.ts`
- Test: `tests/gateway/sim/stub-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/stub-agent.test.ts
import { describe, it, expect } from "bun:test";
import { StubAgent } from "../../../src/gateway/sim/stub-agent";
import type { SessionMcpCtx } from "../../../src/gateway/core/gateway";

describe("StubAgent", () => {
  it("runs the 'reply' behavior, calling the real slack reply handler via ctx", async () => {
    const posted: any[] = [];
    const ctx: SessionMcpCtx = {
      slack: { client: { chat: { postMessage: async (a: any) => { posted.push(a); return { ts: "1.1" }; } } } as any, channel: "C1", threadTs: "1.0", inboundTs: "1.0", userId: "U1", teamId: "T1" },
    };
    const agent = new StubAgent();
    agent.attachGateway({ start: async () => {}, stop: async () => {}, __sessionCtx: () => ctx });
    agent.setMcpResolver(() => ({}));        // no-op resolver; ctx comes from the handle
    agent.setBehavior("reply");
    const events: any[] = [];
    agent.on("event", (e) => events.push(e));
    await agent.sendMessage("S1", "<channel>hi</channel>");
    await agent.drain();
    expect(posted[0].channel).toBe("C1");
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("throws-captures an unknown behavior", async () => {
    const agent = new StubAgent();
    agent.attachGateway({ start: async () => {}, stop: async () => {}, __sessionCtx: () => undefined });
    agent.setMcpResolver(() => ({}));
    agent.setBehavior("nope");
    await agent.sendMessage("S1", "x");
    await agent.drain();
    expect(agent.lastError()).toContain("unknown sim behavior: nope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/stub-agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement StubAgent + behaviors**

```ts
// src/gateway/sim/stub-agent.ts
import { AgentManager, type McpResolver, type AgentEvent } from "../../agent/manager";
import type { GatewayHandle, SessionMcpCtx } from "../core/gateway";
import { slackHandlers } from "../slack/mcp-tools";
import { brokerHandlers } from "../../agent/connect-broker/broker-mcp";

export interface BehaviorArgs {
  sessionId: string;
  envelope: string;
  ctx?: SessionMcpCtx;
  emit: (e: AgentEvent) => void;
}
export type Behavior = (a: BehaviorArgs) => Promise<void>;

/** Pull the inbound author's user id out of the channel envelope the gateway builds. */
function userIdFromEnvelope(envelope: string): string {
  return envelope.match(/user_id="([^"]+)"/)?.[1] ?? "unknown";
}

export const BEHAVIORS: Record<string, Behavior> = {
  // Echo a fixed line via the real slack reply handler.
  async reply({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("reply behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_slack__reply", input: {} });
    await slackHandlers.reply(ctx.slack, { text: "ack: done" });
  },
  // Post an approval card, await the decision, reply with the outcome.
  async request_approval({ ctx, emit, sessionId }) {
    if (!ctx) throw new Error("request_approval behavior: no session ctx");
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_slack__request_approval", input: {} });
    const res = await slackHandlers.request_approval(ctx.slack, { summary: "deploy prod", risks: "irreversible" });
    await slackHandlers.reply(ctx.slack, { text: res.content[0]!.text });
  },
  // Borrow another user's connection — triggers the broker owner-approval grant flow.
  async connect_borrow({ ctx, emit, sessionId, envelope }) {
    if (!ctx?.connect) throw new Error("connect_borrow behavior: no broker ctx (SLAUDE_ENCRYPTION_KEY unset?)");
    const onBehalf = userIdFromEnvelope(envelope);
    emit({ type: "toolCall", sessionId, tool: "mcp__slaude_connect__mcp_call", input: {} });
    const res = await brokerHandlers.mcp_call(ctx.connect, { service: "jira", tool: "jira_search", args: { jql: "assignee=currentUser()" }, on_behalf_of: onBehalf });
    await slackHandlers.reply(ctx.slack, { text: res.content[0]!.text });
  },
};

export class StubAgent extends AgentManager {
  #resolverLocal?: McpResolver;
  #behavior = "reply";
  #handle?: Pick<GatewayHandle, "__sessionCtx">;
  #running?: Promise<void>;
  #errors: string[] = [];

  override setMcpResolver(resolver: McpResolver | undefined) {
    super.setMcpResolver(resolver);
    this.#resolverLocal = resolver;
  }
  setBehavior(name: string) { this.#behavior = name; }
  attachGateway(h: Pick<GatewayHandle, "__sessionCtx">) { this.#handle = h; }
  lastError(): string | undefined { return this.#errors.at(-1); }

  override async sendMessage(sessionId: string, envelope: string): Promise<void> {
    // Force the resolver to run so the gateway stashes the live session ctx.
    this.#resolverLocal?.(sessionId);
    const ctx = this.#handle?.__sessionCtx(sessionId);
    const beh = BEHAVIORS[this.#behavior];
    const emit = (e: AgentEvent) => this.emit("event", e);
    this.#running = (async () => {
      try {
        if (!beh) throw new Error(`unknown sim behavior: ${this.#behavior}`);
        await beh({ sessionId, envelope, ctx, emit });
        emit({ type: "done", sessionId });
      } catch (e) {
        this.#errors.push(String(e instanceof Error ? e.message : e));
        emit({ type: "error", sessionId, error: String(e) });
      }
    })();
  }

  /** Let detached behavior work settle (microtask + macrotask flush). */
  async drain(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }
}
```

(Note: `request_approval` and `connect_borrow` behaviors park on the decision Promise. The
overridden `sendMessage` launches them detached so `send()` returns; the parked behavior
resumes when the matching `feedAction` resolves the gate. `drain()` flushes the card post
before assertions.)

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/sim/stub-agent.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/stub-agent.ts tests/gateway/sim/stub-agent.test.ts
git commit -m "feat(sim): StubAgent + reply/request_approval/connect_borrow behaviors"
```

---

## Task 7: Soul fixture writer + extraction test

The sim engine writes a fixture `SOUL.md` under `paths.home` (the test/temp home), then
calls the real `loadSoulData()`/`setSoulData()` so the production channel-mode and approver
gates read it. This task creates the writer and proves the fixture parses.

**Files:**
- Create: `src/gateway/sim/soul-fixture.ts`
- Test: `tests/gateway/sim/soul-fixture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/soul-fixture.test.ts
import { describe, it, expect } from "bun:test";
import { writeSoulFixture } from "../../../src/gateway/sim/soul-fixture";
import { loadSoulData } from "../../../src/soul/extract";

describe("soul fixture", () => {
  it("writes a SOUL.md the real loader extracts manager/approvers/trusted/allowed from", async () => {
    writeSoulFixture({ manager: "U_MGR", backup: "U_BACKUP", approvers: ["U_APP"], trusted: ["C_TEAM"], allowed: ["C_PUB"] });
    const soul = await loadSoulData();
    expect(soul.manager.userId).toBe("U_MGR");
    expect(soul.backupManager.userId).toBe("U_BACKUP");
    expect(soul.approvers.some((a) => a.userId === "U_APP")).toBe(true);
    expect(soul.trustedChannels).toContain("C_TEAM");
    expect(soul.allowedChannels).toContain("C_PUB");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/soul-fixture.test.ts`
Expected: FAIL — module not found. (If, after Step 3, the assertions fail on a specific
field, open `src/soul/loader.ts` and match the exact section syntax that the parser for
that field expects — the section headers are `## Reporting`, `## Approvers`,
`## Allowed channels`, `## Trusted channels`; adjust the emitted lines until the loader
extracts them. This test is the contract.)

- [ ] **Step 3: Implement the writer**

```ts
// src/gateway/sim/soul-fixture.ts
import { writeFileSync } from "node:fs";
import { paths } from "../../config/home";
import type { SoulFixture } from "./engine";

/** Write a minimal SOUL.md fixture into $SLAUDE_HOME that the real soul loader
 *  parses into manager/backup/approvers/trusted/allowed. */
export function writeSoulFixture(f: SoulFixture): void {
  const lines = [
    "# SOUL",
    "",
    "## Identity",
    "Sim agent.",
    "",
    "## Reporting",
    `- Manager: ${f.manager}`,
    `- Backup manager: ${f.backup ?? ""}`,
    "",
    "## Approvers",
    ...f.approvers.map((a) => `- <@${a}>: anything ; catchall`),
    "",
    "## Allowed channels",
    ...f.allowed.map((c) => `- ${c}`),
    "",
    "## Trusted channels",
    ...f.trusted.map((c) => `- ${c}`),
    "",
  ];
  writeFileSync(paths.soul, lines.join("\n"), "utf8");
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/sim/soul-fixture.test.ts && bun run typecheck`
Expected: PASS. (If a field fails, adjust the emitted section per the loader, per Step 2.)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/soul-fixture.ts tests/gateway/sim/soul-fixture.test.ts
git commit -m "feat(sim): SOUL.md fixture writer (real loader parses roles/channels)"
```

---

## Task 8: Presets

**Files:**
- Create: `src/gateway/sim/presets.ts`
- Test: `tests/gateway/sim/presets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/presets.test.ts
import { describe, it, expect } from "bun:test";
import { PRESETS, getPreset } from "../../../src/gateway/sim/presets";

describe("presets", () => {
  it("ships the six built-in scenarios", () => {
    expect(PRESETS.map((p) => p.name)).toEqual([
      "manager-dm", "member-public", "member-trusted", "restricted-blocked", "approval-flow", "borrow-grant",
    ]);
  });
  it("getPreset resolves by name and by 1-based index", () => {
    expect(getPreset("approval-flow")?.behavior).toBe("request_approval");
    expect(getPreset("5")?.name).toBe("approval-flow");
    expect(getPreset("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/presets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement presets**

```ts
// src/gateway/sim/presets.ts
import type { SoulFixture } from "./engine";

const WORLD: SoulFixture = { manager: "U_MGR", backup: "U_BACKUP", approvers: ["U_APP"], trusted: ["C_TEAM"], allowed: ["C_PUB"] };

export interface ScenarioPreset {
  name: string; title: string; soul: SoulFixture;
  actor: string; channel: string; dm?: boolean; behavior: string;
}

export const PRESETS: ScenarioPreset[] = [
  { name: "manager-dm",         title: "Manager in a DM (restricted zone)",        soul: WORLD, actor: "U_MGR",   channel: "D_MGR",    dm: true,  behavior: "reply" },
  { name: "member-public",      title: "Anyone in an allowed/public channel",      soul: WORLD, actor: "U_ALICE", channel: "C_PUB",              behavior: "reply" },
  { name: "member-trusted",     title: "Anyone in a trusted channel",              soul: WORLD, actor: "U_ALICE", channel: "C_TEAM",             behavior: "reply" },
  { name: "restricted-blocked", title: "Non-manager in an unlisted channel (drop)",soul: WORLD, actor: "U_BOB",   channel: "C_RANDOM",           behavior: "reply" },
  { name: "approval-flow",      title: "Approval card → approver authz → resolve", soul: WORLD, actor: "U_ALICE", channel: "C_TEAM",             behavior: "request_approval" },
  { name: "borrow-grant",       title: "Borrow another user's connection (grant)", soul: WORLD, actor: "U_BOB",   channel: "C_TEAM",             behavior: "connect_borrow" },
];

export function getPreset(nameOrIndex: string): ScenarioPreset | undefined {
  const byName = PRESETS.find((p) => p.name === nameOrIndex);
  if (byName) return byName;
  const idx = Number(nameOrIndex);
  if (Number.isInteger(idx) && idx >= 1 && idx <= PRESETS.length) return PRESETS[idx - 1];
  return undefined;
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/sim/presets.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/presets.ts tests/gateway/sim/presets.test.ts
git commit -m "feat(sim): built-in scenario presets + getPreset"
```

---

## Task 9: SimSession engine

**Files:**
- Create: `src/gateway/sim/engine.ts`
- Test: `tests/gateway/sim/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/sim/engine.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { SimSession } from "../../../src/gateway/sim/engine";

let s: SimSession | undefined;
afterEach(async () => { await s?.dispose(); s = undefined; });

describe("SimSession", () => {
  it("manager in a DM gets a reply; the gate admits them", async () => {
    s = await SimSession.create({ preset: "manager-dm", agent: "stub" });
    await s.send({ text: "hello" });
    const replies = s.cards().filter((c) => c.kind === "message" && c.channel !== "(respond)");
    expect(replies.length).toBeGreaterThan(0);
  });

  it("non-manager in an unlisted channel is dropped (whitelist)", async () => {
    s = await SimSession.create({ preset: "restricted-blocked", agent: "stub" });
    await s.send({ text: "hello" });
    expect(s.drops().some((d) => d.reason === "whitelist")).toBe(true);
    expect(s.cards().filter((c) => c.kind === "message" && c.channel !== "(respond)").length).toBe(0);
  });

  it("approval flow: wrong approver leaves it pending, right approver resolves", async () => {
    s = await SimSession.create({ preset: "approval-flow", agent: "stub" });
    await s.send({ text: "deploy prod" });
    const appr = s.cards().find((c) => c.kind === "approval");
    expect(appr).toBeDefined();
    await s.click({ as: "U_BOB", action: "approve" });    // not an approver → stays pending
    expect(s.cards().find((c) => c.kind === "approval")!.resolved).toBe(false);
    await s.click({ as: "U_MGR", action: "approve" });    // manager is catchall approver
    expect(s.cards().find((c) => c.kind === "approval")!.resolved).toBe(true);
    expect(s.cards().some((c) => (c.text ?? "").includes("Approved") || (c.text ?? "").includes("approved"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

```ts
// src/gateway/sim/engine.ts
import { rmSync } from "node:fs";
import { createGateway, type GatewayHandle } from "../core/gateway";
import { SimTransport } from "./transport";
import { StubAgent } from "./stub-agent";
import { writeSoulFixture } from "./soul-fixture";
import { getPreset } from "./presets";
import { AgentManager } from "../../agent/manager";
import { loadSoulData, setSoulData } from "../../soul/extract";
import { paths } from "../../config/home";
import { m as metric } from "../../metrics";

export interface SoulFixture { manager: string; backup?: string; approvers: string[]; trusted: string[]; allowed: string[] }

const TEAM = "T_SIM";

export class SimSession {
  transport: SimTransport;
  agent: StubAgent | AgentManager;
  handle: GatewayHandle;
  actor = "U_MGR";
  channel = "C_TEAM";
  dm = false;
  behavior = "reply";
  #drops: { reason: string }[] = [];
  #restoreDropInc: () => void;

  private constructor(transport: SimTransport, agent: StubAgent | AgentManager, handle: GatewayHandle) {
    this.transport = transport; this.agent = agent; this.handle = handle;
    // Capture drop reasons by wrapping the existing counter's inc().
    const counter: any = metric.slackDropsTotal;
    const orig = counter.inc.bind(counter);
    counter.inc = (labels: any) => { this.#drops.push({ reason: labels?.reason ?? "unknown" }); return orig(labels); };
    this.#restoreDropInc = () => { counter.inc = orig; };
  }

  static async create(opts: { preset?: string; soul?: SoulFixture; agent: "stub" | "real"; behavior?: string }): Promise<SimSession> {
    let soul: SoulFixture | undefined = opts.soul;
    let actor = "U_MGR", channel = "C_TEAM", dm = false, behavior = opts.behavior ?? "reply";
    if (opts.preset) {
      const p = getPreset(opts.preset);
      if (!p) throw new Error(`unknown preset: ${opts.preset}`);
      soul = p.soul; actor = p.actor; channel = p.channel; dm = p.dm ?? false; behavior = opts.behavior ?? p.behavior;
    }
    if (!soul) soul = { manager: "U_MGR", approvers: ["U_APP"], trusted: ["C_TEAM"], allowed: ["C_PUB"] };
    writeSoulFixture(soul);
    setSoulData(await loadSoulData());

    const transport = new SimTransport({ users: { U_MGR: "Manager", U_APP: "Approver", U_ALICE: "Alice", U_BOB: "Bob" } });
    const agent: StubAgent | AgentManager = opts.agent === "real" ? new AgentManager() : new StubAgent();
    const handle = createGateway(agent, transport);
    if (agent instanceof StubAgent) { agent.attachGateway(handle); agent.setBehavior(behavior); }

    const s = new SimSession(transport, agent, handle);
    s.actor = actor; s.channel = channel; s.dm = dm; s.behavior = behavior;
    return s;
  }

  loadPreset(nameOrIndex: string): void {
    const p = getPreset(nameOrIndex);
    if (!p) throw new Error(`unknown preset: ${nameOrIndex}`);
    this.actor = p.actor; this.channel = p.channel; this.dm = p.dm ?? false; this.behavior = p.behavior;
    if (this.agent instanceof StubAgent) this.agent.setBehavior(this.behavior);
    // NOTE: switching to a preset carrying a different world requires a new SimSession.
  }

  async send(step: { as?: string; channel?: string; text: string; dm?: boolean } ): Promise<void> {
    const as = step.as ?? this.actor;
    const channel = step.channel ?? this.channel;
    const dm = step.dm ?? (step.channel ? false : this.dm);
    if (this.agent instanceof StubAgent) this.agent.setBehavior(this.behavior);
    await this.transport.feedMessage({ channel, user: as, text: step.text, channel_type: dm ? "im" : "channel", team: TEAM });
    await this.#drain();
  }

  async click(step: { as?: string; action: string }): Promise<void> {
    const as = step.as ?? this.actor;
    // resolve the verb to the full action_id from the latest live (unresolved) card carrying it
    const card = [...this.transport.outbound].reverse().find((c) => !c.resolved && c.actionIds.some((id) => id.split(":")[1] === step.action));
    if (!card) throw new Error(`no live card with action ${step.action}`);
    const actionId = card.actionIds.find((id) => id.split(":")[1] === step.action)!;
    await this.transport.feedAction(actionId, as);
    await this.#drain();
  }

  cards() { return this.transport.outbound; }
  drops() { return this.#drops; }

  async #drain(): Promise<void> {
    if (this.agent instanceof StubAgent) await this.agent.drain();
    else await new Promise((r) => setTimeout(r, 0));
  }

  async dispose(): Promise<void> {
    this.#restoreDropInc();
    await this.handle.stop();
    try { rmSync(paths.soul, { force: true }); } catch {}
  }
}
```

(The `setBehavior` call inside `send` lets a transcript switch behaviors mid-run by mutating
`this.behavior` before the step. The drop-counter wrap is restored on `dispose`.)

- [ ] **Step 4: Run test + full suite + typecheck**

Run: `bun test tests/gateway/sim/engine.test.ts && bun test && bun run typecheck`
Expected: PASS. (Full suite confirms the drop-counter wrap/restore doesn't leak across files.)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/engine.ts tests/gateway/sim/engine.test.ts
git commit -m "feat(sim): SimSession engine — boot fixture, send/click/cards/drops"
```

---

## Task 10: Transcript parser + runner

**Files:**
- Create: `src/gateway/sim/transcript.ts`
- Test: `tests/gateway/sim/transcript.test.ts`
- Test fixtures: `tests/gateway/sim/fixtures/approval.yaml`, `tests/gateway/sim/fixtures/restricted.yaml`

- [ ] **Step 1: Write the failing test + fixtures**

```yaml
# tests/gateway/sim/fixtures/restricted.yaml
preset: restricted-blocked
steps:
  - send: { text: "hello" }
  - expect_drop: { reason: whitelist }
```

```yaml
# tests/gateway/sim/fixtures/approval.yaml
preset: approval-flow
steps:
  - send: { text: "deploy prod" }
  - expect_card: { kind: approval }
  - click: { as: U_BOB, action: approve }
  - expect_pending: {}
  - click: { as: U_MGR, action: approve }
  - expect_reply: { contains: Approved }
```

```ts
// tests/gateway/sim/transcript.test.ts
import { describe, it, expect } from "bun:test";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n), "utf8");

describe("transcript", () => {
  it("parses preset + steps", () => {
    const t = parseTranscript(fx("restricted.yaml"));
    expect(t.preset).toBe("restricted-blocked");
    expect(t.steps.length).toBe(2);
  });
  it("runs the restricted transcript green", async () => {
    await runTranscript(parseTranscript(fx("restricted.yaml")));   // throws on assertion failure
  });
  it("runs the approval transcript green", async () => {
    await runTranscript(parseTranscript(fx("approval.yaml")));
  });
  it("fails a transcript whose assertion does not hold", async () => {
    const bad = parseTranscript("preset: manager-dm\nsteps:\n  - send: { text: hi }\n  - expect_drop: { reason: whitelist }\n");
    await expect(runTranscript(bad)).rejects.toThrow(/expect_drop/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/transcript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement parser + runner**

```ts
// src/gateway/sim/transcript.ts
import { parse as parseYaml } from "yaml";
import { SimSession, type SoulFixture } from "./engine";
import type { OutboundCard } from "./transport";

export interface Transcript {
  preset?: string;
  soul?: Partial<SoulFixture>;
  agent_behavior?: string;
  steps: any[];
}

export function parseTranscript(yamlText: string): Transcript {
  const doc = parseYaml(yamlText);
  if (!doc || !Array.isArray(doc.steps)) throw new Error("transcript: missing `steps` array");
  return { preset: doc.preset, soul: doc.soul, agent_behavior: doc.agent_behavior, steps: doc.steps };
}

function liveCards(cards: OutboundCard[]): OutboundCard[] { return cards.filter((c) => !c.resolved); }

export async function runTranscript(t: Transcript): Promise<void> {
  const s = await SimSession.create({
    preset: t.preset,
    soul: t.soul && t.preset ? undefined : (t.soul as SoulFixture | undefined),
    behavior: t.agent_behavior,
    agent: "stub",
  });
  try {
    for (const step of t.steps) {
      if (step.send) { await s.send(step.send); continue; }
      if (step.click) { await s.click(step.click); continue; }
      if (step.expect_card) {
        const { kind, to, contains } = step.expect_card;
        const hit = liveCards(s.cards()).find((c) => c.kind === kind
          && (to ? JSON.stringify(c.blocks).includes(to) : true)
          && (contains ? (c.text ?? "").includes(contains) : true));
        if (!hit) throw new Error(`expect_card ${JSON.stringify(step.expect_card)} — no match. bus=${dump(s.cards())}`);
        continue;
      }
      if (step.expect_reply) {
        const hit = s.cards().some((c) => (c.text ?? "").includes(step.expect_reply.contains));
        if (!hit) throw new Error(`expect_reply contains ${JSON.stringify(step.expect_reply.contains)} — no match. bus=${dump(s.cards())}`);
        continue;
      }
      if (step.expect_drop) {
        if (!s.drops().some((d) => d.reason === step.expect_drop.reason)) throw new Error(`expect_drop ${step.expect_drop.reason} — drops=${JSON.stringify(s.drops())}`);
        continue;
      }
      if (step.expect_pending) {
        if (!liveCards(s.cards()).some((c) => c.kind === "approval")) throw new Error(`expect_pending — no unresolved approval card. bus=${dump(s.cards())}`);
        continue;
      }
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
    }
  } finally {
    await s.dispose();
  }
}

function dump(cards: OutboundCard[]): string {
  return JSON.stringify(cards.map((c) => ({ kind: c.kind, channel: c.channel, text: c.text, resolved: c.resolved, actionIds: c.actionIds })), null, 2);
}
```

(`soul` override when both `preset` and `soul` are present is deferred — v1 either uses a
preset's world or an explicit `soul`. The parser keeps both fields; the runner picks the
preset's world when a preset is named. Field-level soul-merge-over-preset is YAGNI for v1.)

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/sim/transcript.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/transcript.ts tests/gateway/sim/transcript.test.ts tests/gateway/sim/fixtures/
git commit -m "feat(sim): YAML transcript parser + runner + assertions"
```

---

## Task 11: Scenario transcripts (consistency proof) + suite runner

Add the canonical transcripts the spec calls for and a test that runs every transcript in
the `scenarios/` directory, so they gate CI.

**Files:**
- Create: `src/gateway/sim/scenarios/engagement.yaml`, `channel-mode.yaml`, `approval-authz.yaml`, `borrow-grant.yaml`, `slash-authz.yaml`
- Test: `tests/gateway/sim/scenarios.test.ts`

- [ ] **Step 1: Write the scenario transcripts**

```yaml
# src/gateway/sim/scenarios/channel-mode.yaml — restricted blocks non-manager
preset: restricted-blocked
steps:
  - send: { text: "hi" }
  - expect_drop: { reason: whitelist }
```

```yaml
# src/gateway/sim/scenarios/engagement.yaml — trusted channel admits anyone
preset: member-trusted
steps:
  - send: { text: "status?" }
  - expect_reply: { contains: "ack" }
```

```yaml
# src/gateway/sim/scenarios/approval-authz.yaml — approver authz + resolve
preset: approval-flow
steps:
  - send: { text: "deploy prod" }
  - expect_card: { kind: approval }
  - click: { as: U_BOB, action: approve }
  - expect_pending: {}
  - click: { as: U_MGR, action: approve }
  - expect_reply: { contains: "Approved" }
```

```yaml
# src/gateway/sim/scenarios/borrow-grant.yaml — owner approves a borrow (grant_thread)
preset: borrow-grant
steps:
  - send: { text: "list my jira" }
  - expect_card: { kind: approval }
  - click: { as: U_BOB, action: grant_thread }
  - expect_reply: { contains: "jira" }
```

```yaml
# src/gateway/sim/scenarios/slash-authz.yaml — /ingest by non-manager/non-approver is refused
preset: member-trusted
steps:
  - send: { as: U_ALICE, channel: C_TEAM, text: "/ingest" }
  - expect_reply: { contains: "not authorized" }
```

(Note on `borrow-grant`: the owner of the connection is whoever connected `jira` first; in
this v1 transcript no prior connection exists, so the broker returns a `needs_connect` hint
and the reply contains the service name `jira`. The grant-button path is exercised directly
by `tests/gateway/sim/engine.test.ts` + the broker's own unit tests; this transcript proves
the broker tool is reachable and replies. A full owner-approval transcript requires a
`connect` step, deferred until the CDP login host seam is wired — see spec YAGNI.)

- [ ] **Step 2: Write the suite runner test**

```ts
// tests/gateway/sim/scenarios.test.ts
import { describe, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript, runTranscript } from "../../../src/gateway/sim/transcript";

const dir = join(import.meta.dir, "../../../src/gateway/sim/scenarios");
describe("scenario transcripts", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
    it(`runs ${f} green`, async () => {
      await runTranscript(parseTranscript(readFileSync(join(dir, f), "utf8")));
    });
  }
});
```

- [ ] **Step 3: Run the scenarios + full suite**

Run: `bun test tests/gateway/sim/scenarios.test.ts && bun test`
Expected: PASS. If `slash-authz` or `borrow-grant` reply text differs, adjust the
`contains:` to match the actual handler output (read `adapter.ts`/`broker-mcp.ts` strings).

- [ ] **Step 4: Commit**

```bash
git add src/gateway/sim/scenarios/ tests/gateway/sim/scenarios.test.ts
git commit -m "test(sim): canonical scenario transcripts (consistency proof)"
```

---

## Task 12: REPL

**Files:**
- Create: `src/gateway/sim/repl.ts`
- Test: `tests/gateway/sim/repl.test.ts`

- [ ] **Step 1: Write the failing test (command dispatch, no real stdin)**

```ts
// tests/gateway/sim/repl.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { ReplController } from "../../../src/gateway/sim/repl";

let r: ReplController | undefined;
afterEach(async () => { await r?.dispose(); r = undefined; });

describe("REPL controller", () => {
  it("loads a scenario and reports state", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 5");
    expect(out.join("\n")).toContain("approval-flow");
    await r.handle("/state");
    expect(out.join("\n")).toContain("U_ALICE");
  });
  it("bare text sends and shows a card", async () => {
    r = new ReplController();
    const out: string[] = [];
    r.onOutput((l) => out.push(l));
    await r.handle("/scenario 1");      // manager-dm
    await r.handle("hello");
    await r.handle("/cards");
    expect(out.join("\n")).toContain("ack");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/sim/repl.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the REPL controller**

```ts
// src/gateway/sim/repl.ts
import { SimSession } from "./engine";
import { PRESETS } from "./presets";
import type { OutboundCard } from "./transport";

/** Transport-agnostic REPL logic: feed it command lines, it emits output lines.
 *  cli.ts wires this to stdin/stdout. */
export class ReplController {
  #session?: SimSession;
  #out: (line: string) => void = () => {};
  onOutput(fn: (line: string) => void) { this.#out = fn; }

  async handle(line: string): Promise<void> {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (cmd === "/scenarios") return this.#listScenarios();
    if (cmd === "/scenario") return this.#loadScenario(rest[0] ?? "");
    if (cmd === "/state") return this.#state();
    if (cmd === "/as") { this.#requireSession().actor = rest[0] ?? this.#requireSession().actor; return; }
    if (cmd === "/channel") { const s = this.#requireSession(); s.channel = rest[0] ?? s.channel; s.dm = false; return; }
    if (cmd === "/dm") { this.#requireSession().dm = true; return; }
    if (cmd === "/behavior") { this.#requireSession().behavior = rest[0] ?? this.#requireSession().behavior; return; }
    if (cmd === "/cards") return this.#dumpCards();
    if (cmd === "/click") return this.#click(rest);
    if (cmd?.startsWith("/")) { this.#out(`unknown command: ${cmd}`); return; }
    // bare text → send
    await this.#requireSession().send({ text: line });
    this.#dumpCards();
  }

  #listScenarios() { this.#out("Scenarios:\n" + PRESETS.map((p, i) => `  ${i + 1}) ${p.name} — ${p.title}`).join("\n")); }

  async #loadScenario(sel: string) {
    await this.#session?.dispose();
    this.#session = await SimSession.create({ preset: sel || "1", agent: "stub" });
    const s = this.#session;
    this.#out(`loaded ${sel} — as ${s.actor} in ${s.channel}${s.dm ? " (dm)" : ""}, behavior=${s.behavior}`);
  }

  #state() {
    const s = this.#requireSession();
    this.#out(`actor=${s.actor} channel=${s.channel} dm=${s.dm} behavior=${s.behavior}`);
  }

  async #click(rest: string[]) {
    const s = this.#requireSession();
    const n = Number(rest[0]);
    const live = s.cards().filter((c) => !c.resolved && c.actionIds.length);
    const card = live[n - 1];
    if (!card) { this.#out(`no live card #${n}`); return; }
    const verb = rest[1] ?? card.actionIds[0]!.split(":")[1]!;
    await s.click({ action: verb });
    this.#dumpCards();
  }

  #dumpCards() {
    const s = this.#requireSession();
    s.cards().forEach((c: OutboundCard, i) => {
      const buttons = c.actionIds.map((a) => a.split(":")[1]).join(" | ");
      this.#out(`[card ${i + 1}] ${c.kind}${c.resolved ? " (resolved)" : ""} ${c.text ?? ""}${buttons ? `  [${buttons}]` : ""}`);
    });
  }

  #requireSession(): SimSession { if (!this.#session) throw new Error("no scenario loaded — use /scenario <n>"); return this.#session; }

  async dispose() { await this.#session?.dispose(); this.#session = undefined; }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/gateway/sim/repl.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/repl.ts tests/gateway/sim/repl.test.ts
git commit -m "feat(sim): scenario-first REPL controller"
```

---

## Task 13: CLI entrypoint + `sim` script

**Files:**
- Create: `src/gateway/sim/cli.ts`
- Modify: `package.json:10-19` (add `sim` script)

- [ ] **Step 1: Implement the CLI (temp-home bootstrap first)**

```ts
// src/gateway/sim/cli.ts
// Force an isolated $SLAUDE_HOME BEFORE importing anything that reads config/home,
// so the REPL never touches the operator's real ~/.slaude.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SLAUDE_HOME = mkdtempSync(join(tmpdir(), "slaude-sim-"));
process.env.SLAUDE_HEALTH_PORT = "0";

const [, , mode, ...args] = process.argv;

if (mode === "run") {
  const { parseTranscript, runTranscript } = await import("./transcript");
  const { readFileSync } = await import("node:fs");
  const { Glob } = await import("bun");
  const patterns = args.length ? args : ["src/gateway/sim/scenarios/*.yaml"];
  let failures = 0;
  for (const pat of patterns) {
    for await (const file of new Glob(pat).scan(".")) {
      try { await runTranscript(parseTranscript(readFileSync(file, "utf8"))); console.log(`✓ ${file}`); }
      catch (e) { failures++; console.error(`✗ ${file}\n  ${(e as Error).message}`); }
    }
  }
  process.exit(failures ? 1 : 0);
} else {
  // REPL
  const { ReplController } = await import("./repl");
  const r = new ReplController();
  r.onOutput((l) => console.log(l));
  await r.handle("/scenarios");
  console.log("\nPick a scenario: /scenario <n>. Then type a message. /cards, /click <n> <verb>, /state, Ctrl-D to quit.\n");
  for await (const line of console) {
    if (!line.trim()) continue;
    try { await r.handle(line); } catch (e) { console.error((e as Error).message); }
  }
  await r.dispose();
}
```

- [ ] **Step 2: Add the `sim` script to package.json**

In `package.json` `scripts`, add:

```json
    "sim": "bun src/gateway/sim/cli.ts",
```

- [ ] **Step 3: Manual smoke (not a unit test)**

Run: `bun sim run` — expected: prints `✓ src/gateway/sim/scenarios/<file>.yaml` for each
scenario, exit 0.
Run: `echo "/scenario 1\nhello\n/cards" | bun sim` — expected: lists scenarios, loads
`manager-dm`, prints a card containing `ack`.

- [ ] **Step 4: Typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/sim/cli.ts package.json
git commit -m "feat(sim): bun sim CLI — run <glob> | repl, isolated temp home"
```

---

## Task 14: Docs — README + finding

**Files:**
- Modify: `README.md` (add a "Simulation gateway" section + Features bullet)
- Create: `docs/findings/2026-05-29-simulation-gateway.md`
- Modify: `CLAUDE.md` (Findings Log index — newest first)

- [ ] **Step 1: Add the README section**

Add a Features bullet: `- **Simulation gateway** — drive every Slack-dependent flow with
no real Slack (transcripts for CI + a scenario REPL). See [Simulation gateway](#simulation-gateway).`

Add a section:

````markdown
## Simulation gateway

Verify Slack-dependent behavior (engagement, channel-mode, approval + connect-grant
buttons, slash-command authz) with no Slack workspace. The simulation runs the *same*
`createGateway` code as production against an in-memory transport, so behavior cannot drift.

```bash
bun sim run                 # run every scenario transcript (CI gate), exit non-zero on failure
bun sim run path/to/*.yaml  # run specific transcripts
bun sim                     # interactive REPL
```

REPL is scenario-first:

```
> /scenario 5          # load approval-flow (manager/approver world, U_ALICE in C_TEAM)
> deploy prod          # send as the current actor
> /as U_MGR            # become the manager
> /click 1 approve     # click the approval card
```

Built-in scenarios: `manager-dm`, `member-public`, `member-trusted`, `restricted-blocked`,
`approval-flow`, `borrow-grant`. Override any field with `/as`, `/channel`, `/dm`,
`/behavior`. Transcripts mirror the same engine — see `src/gateway/sim/scenarios/`.
````

- [ ] **Step 2: Write the finding doc**

```markdown
# 2026-05-29 — Simulation gateway (Slack-free verification)

**Decision:** Extract a `Transport` port and invert `createSlackApp` →
`createGateway(agent, transport)`. Production binds bolt; simulation binds an in-memory
`SimTransport`. All gate/command/approval logic runs unchanged in both — consistency by
construction.

**Why not fake the Slack wire protocol:** `adapter.ts` hardcoded `new App()`, so it needed
a refactor regardless; faking bolt's receiver + action envelopes is brittle across bolt
bumps and is itself untested surface. Inverting the edge is a mechanical, lower-risk move.

**Stub agent seam:** `StubAgent` drives turns by calling the *real* exported MCP handlers
(`slackHandlers`, `brokerHandlers`) through a narrow `__sessionCtx` test seam on the gateway
handle, so approval-gate and the connect-broker execute for real without Claude.

**Drop assertions:** the runner wraps the existing `metric.slackDropsTotal.inc` counter to
capture `{reason}` labels, restoring it on dispose.

**Deferred:** file attachments (fetch-based, off the WebClient surface), web UI, real-agent
CI runs, full owner-approval borrow transcript (needs the CDP login-host seam).
```

- [ ] **Step 3: Index it in CLAUDE.md**

Add to the Findings Log (newest first), above the contextual-mcp-connections entry:

```markdown
- [2026-05-29 — Simulation gateway (Slack-free verification)](docs/findings/2026-05-29-simulation-gateway.md)
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/findings/2026-05-29-simulation-gateway.md CLAUDE.md
git commit -m "docs(sim): README simulation section + finding + index"
```

---

## Final verification

- [ ] Run the full suite + coverage + typecheck:

```bash
bun run typecheck && bun test --coverage
```

Expected: all green; coverage at or above `bunfig.toml` thresholds (line 0.97, function
0.80, statement 0.97). If the move in Task 3 dropped coverage because `core/gateway.ts`
(largely the old adapter body) is now measured but only partially exercised, the sim
scenario tests should lift it — if still short, add a transcript that drives an
under-covered branch (e.g. a `/mode` slash command, an ignore gate hit) rather than
lowering the threshold.

- [ ] Then complete the branch with **superpowers:finishing-a-development-branch**.

---

## Self-review notes (author)

- **Spec coverage:** Transport port (T1), gate refactor (T2), createGateway + seam (T3),
  slack binding (T4), SimTransport (T5), StubAgent + behaviors (T6), soul fixture (T7),
  presets (T8), engine (T9), transcript runner (T10), scenario transcripts (T11), REPL
  (T12), CLI (T13), docs (T14). All spec sections mapped.
- **Type consistency:** `Transport`/`WebClientLike` (T1) reused in T2-T5; `SessionMcpCtx`/
  `GatewayHandle` (T3) reused in T6/T9; `OutboundCard` (T5) reused in T9/T10/T12;
  `SoulFixture` (T9) reused in T7/T8; `ScenarioPreset` (T8) reused in T9/T12.
- **Known sequencing:** `SoulFixture` is declared in `engine.ts` (T9) but imported by
  `soul-fixture.ts` (T7) and `presets.ts` (T8) as a type-only import. Type-only imports do
  not create a runtime cycle; `bun run typecheck` in T7/T8 will resolve the type from
  `engine.ts` even though the engine's runtime code lands in T9. If an engineer runs T7's
  test before T9 exists, add the `SoulFixture` interface to `engine.ts` first (a 1-line
  stub file is acceptable) — note this when starting T7.
```
