# Simulation Gateway — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm)
**Goal:** Exercise every Slack-dependent behavior with no real Slack, by running the
*real* gateway logic against an injected in-memory transport. Consistency between
simulation and production is guaranteed *by construction* — both run the same
`createGateway` code. Bolt remains the only component that knows the Slack wire protocol.

---

## Problem

`createSlackApp` (`src/gateway/slack/adapter.ts`, 843 lines) entangles Slack-agnostic
logic with the Slack I/O edge:

- **Logic (must be testable without Slack):** engagement gate, channel-mode gate
  (DM / allowed / trusted / restricted), blocklist, ignore gate, slash-command authz
  (manager / approver), inbound envelope construction, MCP resolver wiring, approval-gate
  authz, connect-broker grant flow.
- **I/O edge (Slack-specific):** `new App({...})` (bolt Socket Mode), `app.client`
  (WebClient), `app.event(...)`, `app.action(...)`.

Today the logic can only be driven by a live Slack workspace. We want to drive it from
a terminal — scripted (CI) and interactive (manual) — to verify roles, channels, and
approval flows deterministically.

## Constraints (user-stated)

1. **Consistent behavior** between simulation and real Slack. The simulation must *not*
   reimplement the gates — it must run the same code, or it will drift.
2. **Easy maintenance.** Small, bounded fake surface. No reverse-engineering of bolt's
   wire protocol.

## Surface inventory (grounds the seam)

WebClient methods actually called across `gateway/slack` + `agent`:

```
auth.test, chat.postMessage, chat.update,
conversations.info, conversations.members, conversations.replies,
reactions.add, reactions.remove, search.messages,
users.info, users.profile.set
```

Bolt handlers: `app.event("message")`, `app.event("app_mention")`, `app.use(...)`,
`app.action(/slaude_appr:.../)` (approval-gate), `app.action(/slaude_perm:.../)`
(permission-gate).

That bounded edge (~11 client methods + 2 events + 2 action handlers + 1 middleware) is
the entire thing the simulation must fake.

## Chosen approach — C: dependency inversion at the edge

Considered three:

- **A — Protocol fake** (fake bolt receiver + WebClient, run `adapter.ts` byte-for-byte):
  rejected. `adapter.ts` hardcodes `new App({...})` so it can't be injected without a
  refactor *anyway*; reverse-engineering bolt's receiver + action-payload envelopes is a
  large, brittle, untested surface that breaks on `@slack/bolt` bumps.
- **B — Full gateway-core extraction** (move *all* gate/command logic into a
  transport-agnostic core): strongest consistency but the largest refactor of a file
  shipped days ago, with real regression risk on live behavior. More than the goal warrants.
- **C — Dependency inversion at the edge** (chosen): extract one `Transport` port,
  parameterize the factory to accept it. All gate/command/wiring logic stays put and runs
  unchanged; only `new App()` + the WebClient become injected. Slack transport wraps bolt;
  sim transport is in-memory. Consistency by construction, moderate mechanical refactor,
  no bolt-protocol faking, fake surface = the 11 bounded methods.

## Architecture

### 1. The port — `Transport`

Bolt's `App` already exposes `.client`, `.action(idOrRegex, h)`, `.event(name, h)`,
`.use(mw)`, `.start()`, `.stop()`. Extract exactly that shape:

```ts
// src/gateway/core/transport.ts

/** The subset of @slack/web-api WebClient that slaude actually calls. Methods are
 *  typed loosely (args/result as the WebClient declares) so bolt's real client and the
 *  sim fake both satisfy it. */
export interface WebClientLike {
  auth: { test(args?: any): Promise<any> };
  chat: { postMessage(args: any): Promise<any>; update(args: any): Promise<any> };
  reactions: { add(args: any): Promise<any>; remove(args: any): Promise<any> };
  conversations: {
    info(args: any): Promise<any>;
    members(args: any): Promise<any>;
    replies(args: any): Promise<any>;
  };
  users: { info(args: any): Promise<any>; profile: { set(args: any): Promise<any> } };
  search: { messages(args: any): Promise<any> };
}

export type ActionHandler = (args: {
  ack: () => Promise<void>;
  action: { action_id: string };
  body: any;
  respond: (msg: any) => Promise<void>;
}) => Promise<void>;

export type EventHandler = (args: { event: any; client: WebClientLike; context: any }) => Promise<void>;
export type Middleware = (args: { payload: any; next: () => Promise<void> }) => Promise<void>;

export interface Transport {
  client: WebClientLike;
  action(idOrRegex: string | RegExp, h: ActionHandler): void;
  event(name: string, h: EventHandler): void;
  use(mw: Middleware): void;
  start(): Promise<void>; stop(): Promise<void>;
}
```

Gate constructors that take `app: App` change to take `t: Transport` (they only use
`app.client` and `app.action`). Bolt's `App` satisfies `Transport` structurally, so the
Slack path is unchanged. `ReactionTracker` / `Status` take `t.client`; `Presence` already
no-ops without `SLACK_USER_TOKEN` (fine in sim).

### 2. Invert the factory

`createSlackApp(agent: AgentManager)` becomes `createGateway(agent: AgentManager, t: Transport)`,
moved to `src/gateway/core/gateway.ts`. All gate construction, the MCP resolver, event
fanout, slash-command handling, engagement state, and connect-broker wiring move verbatim
(replace `app` → `t`, `app.client` → `t.client`). It returns `{ start, stop }` (delegating
to `t.start/.stop`).

Two thin bindings:

- `src/gateway/slack/transport.ts` — `createSlackTransport(): Transport` builds the bolt
  `App` (token/appToken/socketMode) and returns it (already structurally a `Transport`,
  but wrap explicitly for clarity + to expose `start/stop`).
- `src/server.ts` — `createGateway(agent, createSlackTransport())`.

### 3. Sim transport

```ts
// src/gateway/sim/transport.ts
export interface OutboundCard {
  kind: "message" | "approval" | "permission" | "status" | "reaction";
  channel: string;
  threadTs?: string;
  text?: string;
  blocks?: any[];
  actionIds: string[];   // extracted from blocks' action elements
  resolved: boolean;     // flipped true when respond({replace_original:true}) fires for it
  raw: any;              // the exact args passed to the client method
}

export class SimTransport implements Transport {
  client: WebClientLike;          // in-memory fake; records every call to the bus
  outbound: OutboundCard[];        // append-only capture bus
  // registered by createGateway:
  feedMessage(raw: { channel: string; user: string; text: string; channel_type?: string;
                     thread_ts?: string; ts?: string; team?: string }): Promise<void>;
  feedAction(actionId: string, byUser: string): Promise<void>;  // replays matching action handler
  start(): Promise<void>; stop(): Promise<void>;
}
```

- `client.chat.postMessage` / `update` / `reactions.*` push an `OutboundCard` onto
  `outbound` and return a synthetic `{ ok: true, ts }`.
- `client.auth.test` returns a fixed bot identity (`user_id: "U_SLAUDE"`, `bot_id: "B_SLAUDE"`).
- `client.users.info` returns a name from the sim's user registry.
- `client.conversations.*`, `search.messages` return configured fixtures (empty by default).
- `client.users.profile.set` is a no-op (matches `Presence` disabled path).
- `action`/`event`/`use` store the registered handlers. `feedMessage` builds a bolt-shaped
  `args` ({ event, client, context: { teamId } }) and invokes the `message` (and, when text
  @mentions the bot, `app_mention`) handler. `feedAction` finds the handler whose regex
  matches `actionId`, builds `{ ack, action:{action_id}, body:{user:{id:byUser}}, respond }`
  where `respond` pushes a replacement card to the bus and marks the matched card resolved.

`respond({ replace_original: true })` marks the prior card `resolved` in the bus, so
`expect_card` will not re-match a decided approval.

### 4. Stub vs real agent (switchable)

The agent is already an injected dependency, so this is orthogonal to the transport.

```ts
// src/gateway/sim/stub-agent.ts
export class StubAgent extends EventEmitter {
  // Implements the AgentManager surface createGateway calls:
  ensureSession(key): { id; working_dir; model };
  sendMessage(sessionId, envelope): Promise<void>;   // runs the active scripted behavior
  setMcpResolver(fn); setPermissionResolver(fn); setStopGuard(fn);
  setPermissionMode(id, mode): Promise<void>;
  abort(id); reload(id): Promise<void>;
  getTokenSnapshot(id);
  // sim-only:
  setBehavior(name: string): void;                   // selects the next sendMessage scenario
}
```

A **behavior** is a function `(ctx: { sessionId; envelope; mcp: ResolvedMcpServers; emit })
=> Promise<void>` that drives the turn by invoking the session's *real resolved MCP tool
handlers* (e.g. call `slaude_slack.reply`, `request_approval`, `slaude_connect.mcp_call`)
and/or emitting agent events. Because it calls the real handlers, approval-gate and the
connect-broker run for real — only Claude is absent.

Built-in behaviors (v1): `reply` (echo a fixed line via `slaude_slack.reply`),
`request_approval` (post an approval card, await decision, reply with the outcome),
`connect_borrow` (call `slaude_connect.mcp_call` with `on_behalf_of` to trigger the
owner-approval grant flow). Transcripts select a behavior via `agent_behavior:`.

`SIM_AGENT=real` injects the real `AgentManager` instead — for manual end-to-end demos
(costs tokens, non-deterministic, not run in CI).

### 5. Roles & channels (soul fixture)

`soulData()` is a disk-backed global (loads `$SLAUDE_HOME/SOUL.md`). The sim engine, at
boot, writes a temp `$SLAUDE_HOME` containing a fixture `SOUL.md` (manager, backup,
approvers, `## Trusted channels`, `## Allowed channels`) and a temp `db.sqlite`, then sets
env so the real loaders read the fixture. Mapping:

- **role** = the `as` user id on an injected event (manager / approver / arbitrary member).
- **trusted / allowed channel** = channel id listed in the fixture SOUL sections.
- **restricted** = any channel id not listed.
- **DM** = `channel_type: "im"`.

This drives the real channel-mode gate (`adapter.ts:355-379`) and slash-command authz
without any sim-specific gate logic.

### 6. Scenario presets (one-pick, overridable)

The common cases ("be the manager in a DM", "be anyone in a public channel", "trigger an
approval", "borrow another user's connection") are pre-bundled so the operator picks one by
name/number instead of assembling soul + actor + channel + behavior by hand. Presets ship
built-in; every field stays overridable afterward.

```ts
// src/gateway/sim/presets.ts
export interface ScenarioPreset {
  name: string;            // "manager-dm", "member-public", ...
  title: string;           // human label for the menu
  soul: SoulFixture;       // manager/backup/approvers/trusted/allowed
  actor: string;           // default acting user id
  channel: string;         // default channel id
  dm?: boolean;            // default DM flag
  behavior: string;        // default stub-agent behavior
}

export const PRESETS: ScenarioPreset[];   // built-in list, ordered
export function getPreset(nameOrIndex: string): ScenarioPreset | undefined;
```

Built-in presets (v1):

| name | actor | channel | behavior | proves |
|------|-------|---------|----------|--------|
| `manager-dm` | `U_MGR` | DM | `reply` | manager admitted in restricted/DM zone |
| `member-public` | `U_ALICE` | `C_PUB` (allowed) | `reply` | anyone admitted in allowed channel |
| `member-trusted` | `U_ALICE` | `C_TEAM` (trusted) | `reply` | anyone admitted in trusted channel |
| `restricted-blocked` | `U_BOB` | `C_RANDOM` (unlisted) | `reply` | non-manager dropped (`whitelist`) |
| `approval-flow` | `U_ALICE` | `C_TEAM` | `request_approval` | approval card → approver authz → resolve |
| `borrow-grant` | `U_BOB` | `C_TEAM` | `connect_borrow` | owner-approval grant (`grant_thread`/`once`/`deny`) |

All presets share one `SoulFixture` (`U_MGR` manager, `U_BACKUP` backup, `U_APP` approver,
`C_TEAM` trusted, `C_PUB` allowed) so switching preset mid-REPL only changes actor/channel/
behavior, not the world. A preset that needs a different world carries its own `soul`.

### 7. Driver — shared engine, two faces

```ts
// src/gateway/sim/engine.ts
export class SimSession {
  transport: SimTransport;
  agent: StubAgent | AgentManager;
  // current selection — mutated by loadPreset / overrides, read by send() defaults:
  actor: string; channel: string; dm: boolean; behavior: string;
  // boots a temp $SLAUDE_HOME + soul fixture + db, calls createGateway(agent, transport)
  static async create(opts: { preset?: string; soul?: SoulFixture; agent: "stub" | "real" }): Promise<SimSession>;
  loadPreset(nameOrIndex: string): void;   // set actor/channel/dm/behavior; reboot soul if the preset carries one
  send(step?: { as?: string; channel?: string; text: string; dm?: boolean }): Promise<void>;  // omitted fields fall back to current selection
  click(step: { as?: string; action: string }): Promise<void>;  // `as` defaults to current actor
  cards(): OutboundCard[];                                       // current capture bus
  drops(): { reason: string }[];                                // captured slackDropsTotal increments
  dispose(): Promise<void>;
}
```

`loadPreset` sets the current actor/channel/dm/behavior (and reboots the soul fixture only
if the preset carries a different `soul`). Subsequent explicit overrides (`/as`, `/channel`,
`/dm`, `/behavior`, or per-step fields) replace individual selection fields without touching
the rest.

- **Transcript** — `src/gateway/sim/transcript.ts`. YAML schema. A transcript may start
  from a `preset:` (inherits its soul/actor/channel/behavior) and override any field, or
  define `soul:`/`agent_behavior:` explicitly. Per-step `as`/`channel` still win:

  ```yaml
  preset: approval-flow          # optional shorthand; sets soul + defaults
  soul:                          # optional — overrides preset fields it names
    approvers: [U_APP]
  agent_behavior: request_approval
  steps:
    - send:   { as: U_ALICE, channel: C_TEAM, text: "deploy prod" }
    - expect_card: { kind: approval, to: U_MGR }
    - click:  { as: U_APP, action: deny }          # not an approver for this → stays pending
    - expect_pending: {}
    - click:  { as: U_MGR, action: approve }
    - expect_reply: { contains: "Approved" }
    - send:   { as: U_BOB, channel: C_DM, dm: true, text: "hi" }
    - expect_drop: { reason: whitelist }
  ```

  Assertions read `SimSession.cards()` and `SimSession.drops()`. Drop reasons are captured
  by intercepting `metric.slackDropsTotal.inc({ reason })` (the existing counter the gates
  already call). A failed assertion throws with a diff. `bun sim run <glob>` runs all,
  prints pass/fail per transcript, exits non-zero on any failure (CI gate).

- **REPL** — `src/gateway/sim/repl.ts`. Scenario-first: on launch it prints the preset menu;
  pick one to load the whole scenario, then poke. Commands:
  - `/scenarios` — list presets (number + title); `/scenario <n|name>` — load one.
  - `/state` — show current actor / channel / dm / behavior / soul.
  - `/as <user>`, `/channel <id>`, `/dm`, `/behavior <name>` — override one selection field.
  - bare text = `send` (uses current selection); `/cards` — pretty-print the bus;
    `/click <n>` (nth card's primary action) or `/click <n> <action>`.

  ```
  $ bun sim repl
  Scenarios:  1) manager-dm  2) member-public  3) member-trusted
              4) restricted-blocked  5) approval-flow  6) borrow-grant
  > /scenario 5
  loaded approval-flow — as U_ALICE in C_TEAM, behavior=request_approval
  > deploy prod
  [card 1] approval → @U_MGR   [approve | deny]
  > /as U_MGR
  > /click 1 approve
  [card 2] Plan → *Approved* by <@U_MGR>
  ```

- **CLI** — `src/gateway/sim/cli.ts`: `bun sim run <glob>` | `bun sim repl`. Wired as a
  `sim` script in `package.json`.

### 8. Error handling

- Transcript parse error → fail that file with line context, continue to next file, exit non-zero.
- `expect_card`/`expect_reply` with no match → throw with the actual bus dumped.
- `click` referencing an action id not present in any live (unresolved) card → throw
  ("no live card with action X").
- Behavior that throws → surfaces as the step's failure, bus preserved for diagnosis.

## Testing

- **Unit:** `SimTransport` (records outbound, replays handlers, respond/replace + resolved
  semantics, drop capture); `StubAgent` (behavior dispatch, MCP handler invocation);
  transcript parser + each assertion type (incl. `preset:` resolution + field override
  precedence); `getPreset` by name and index; `createSlackTransport` shape (structural —
  `App` satisfies `Transport`).
- **Integration (the consistency proof):** transcripts covering — engagement
  (mention engages, mention-other disengages), channel-mode (DM/restricted blocks
  non-manager, trusted/allowed admits anyone), blocklist, ignore, approval (authz: wrong
  approver stays pending; right approver resolves; timeout/abort), connect-broker grant
  (`grant_thread` / `grant_once` / `deny`), slash authz (ingest/cron/ignore manager-or-approver).
- **Parity smoke:** one transcript that reproduces a known-good live flow; eyeball the bolt
  binding is thin.
- Coverage stays within the existing `bunfig.toml` thresholds.

## Consistency guarantee (why this can't drift)

The same `createGateway(agent, transport)` runs in production (bolt transport) and in
simulation (sim transport). No gate, command, or card-rendering logic is duplicated. A
behavioral change to a gate changes both paths simultaneously, and the CI transcripts
assert the real emitted Block Kit. Drift is structurally impossible for anything above the
transport edge.

## YAGNI / deferred

- File attachments in sim (download path is `fetch`-based against Slack file URLs, not the
  WebClient — out of the v1 fake surface).
- Web UI driver (terminal-only v1).
- Real-agent mode in CI (manual demo only).
- Faking `conversations.*` / `search.messages` payloads beyond empty defaults (add per-test
  fixtures when a transcript needs them).

## File layout

```
src/gateway/core/transport.ts        # Transport port + WebClientLike
src/gateway/core/gateway.ts          # createGateway(agent, transport)  ← moved from adapter.ts
src/gateway/slack/transport.ts       # createSlackTransport() (bolt binding)
src/gateway/sim/transport.ts         # SimTransport + OutboundCard bus
src/gateway/sim/stub-agent.ts        # StubAgent + built-in behaviors
src/gateway/sim/presets.ts           # built-in ScenarioPreset list + getPreset
src/gateway/sim/engine.ts            # SimSession (boots soul fixture + gateway + transport)
src/gateway/sim/transcript.ts        # YAML runner + assertions
src/gateway/sim/repl.ts              # interactive terminal
src/gateway/sim/cli.ts               # `bun sim run <glob> | repl`
```

`src/gateway/slack/adapter.ts` is replaced by `core/gateway.ts` + `slack/transport.ts`
(a back-compat re-export of `createGateway` may be kept if any import path depends on it);
`server.ts` updated to wire the slack transport.

## Refactor risk & mitigation

One mechanical refactor touches: `createSlackApp` signature/location, `ApprovalGate` +
`PermissionGate` constructors (`app` → `Transport`), `ReactionTracker`/`Status` (already
take `client`), and `server.ts`. No logic changes. Mitigation: the move is verbatim;
existing Slack tests plus a parity smoke transcript prove behavior is unchanged before merge.

## Stacking note

This branch (`feat/simulation-gateway`) is based on `feat/contextual-mcp-connections`
(PR #8), not `main`, because the sim exercises the connect-broker grant flow. When PR #8
merges, rebase this branch onto `main`.
