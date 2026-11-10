# Channel Session Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an agent run one long-lived session per channel, chosen per channel in its definition, with root mentions answered at root, other root messages recorded, and proactive wakes running in that session.

**Architecture:** A reserved `channel:<id>` value finds or creates the session; a root turn otherwise keeps its real message `ts`, so existing Slack-facing code is untouched. Replies reach root through the existing `postTarget: "channel"` seam, now also signed into the job token. Wakes get per-channel state and a boot switch in `AgentManager`, because caps and tools are fixed when a query starts.

**Tech Stack:** Bun, TypeScript, `bun:test`, Postgres and sqlite dual schema, Claude Agent SDK.

Spec: `docs/superpowers/specs/2026-11-10-channel-session.md`. Read it first.

**Rules for every task:** run from the worktree. No emoji or em dashes. Before each commit, run the leak scan in `CLAUDE.md` over the staged diff. No AI co-author trailers. Never use an unscoped `pkill`.

---

### Task 1: Parse the channel mode from a soul

**Files:**
- Modify: `src/soul/proactive.ts`
- Test: `tests/soul/channel-session.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { __setProactiveSoulSource, channelSessionOn, channelSessionWakes, parseProactive, proactiveChannels, proactiveFor, proactiveRead } from "../../src/soul/proactive";

const soul = `## Channel <#C111>
### Session
- Mode: channel
### Proactive
- Enabled: yes
- Max per day: 2
- Cooldown: 4 hours
- Highest: ask

## Channel <#C222>
### Proactive
- Enabled: yes

## Channel <#C333>
### Session
- Mode: nonsense
`;

afterEach(() => __setProactiveSoulSource(null));

describe("channel session mode", () => {
  test("parses Mode only under ### Session", () => {
    const c = parseProactive(soul);
    expect(c.sessions).toEqual({ C111: "channel" });
    expect(c.invalidSessions).toEqual(["C333"]);
  });
  test("a channel-mode channel leaves the agent-level wake and stays readable", () => {
    __setProactiveSoulSource(() => soul);
    expect(channelSessionOn("a", "C111")).toBe(true);
    expect(channelSessionOn("a", "C222")).toBe(false);
    expect(proactiveChannels("a")).toEqual(["C222"]);
    expect(channelSessionWakes("a")).toEqual(["C111"]);
    expect(proactiveRead("a")).toContain("C111");
  });
  test("per-channel limits do not apply in channel mode", () => {
    __setProactiveSoulSource(() => soul);
    const r = proactiveFor("a", "C111");
    expect(r.enabled).toBe(true);
    expect(r.highest).toBe("act");
    expect(r.cooldownHours).toBe(0);
    expect(r.maxPerPersonPerDay).toBe(Number.MAX_SAFE_INTEGER);
  });
});
```

**Step 2: Run it to verify it fails**

Run: `bun test tests/soul/channel-session.test.ts`
Expected: FAIL, `channelSessionOn` is not exported.

**Step 3: Implement**

In `ProactiveConfig` add `sessions: Record<string, "channel">` and `invalidSessions: string[]`, both initialised empty in `parseProactive`, and add both to the keys removed in `proactiveFor`'s destructure.

Replace `inProactive: boolean` on the channel `where` with `sub: "proactive" | "session" | null`:

```ts
if (where?.kind === "channel") {
  const h = line.trim();
  where.sub = /^###\s+proactive\s*$/i.test(h) ? "proactive" : /^###\s+session\s*$/i.test(h) ? "session" : null;
} else where = null;
```

Where the key/value is handled for a channel:

```ts
if (where.kind === "channel") {
  if (where.sub === "session") {
    if (key === "mode") {
      if (value.toLowerCase() === "channel") out.sessions[where.id] = "channel";
      else out.invalidSessions.push(where.id);
    }
    continue;
  }
  if (where.sub !== "proactive") continue;
  // existing enabled / highest / cooldown / max per day handling
```

In `proactiveFor`, after building the channel result:

```ts
if (c.sessions[channelId]) {
  return { ...resolved, highest: "act", cooldownHours: 0, maxPerPersonPerDay: Number.MAX_SAFE_INTEGER };
}
```

Add and change the exports:

```ts
/** Whether this agent runs one long-lived session in this channel. Any failure reads as off. */
export function channelSessionOn(personaId: string, channelId: string): boolean {
  return configFor(personaId)?.sessions[channelId] === "channel";
}

/** The channels whose wakes run in their channel session. */
export function channelSessionWakes(personaId: string): string[] {
  const c = configFor(personaId);
  return c ? Object.entries(c.channels).filter(([id, on]) => on && c.sessions[id]).map(([id]) => id).sort() : [];
}
```

`proactiveChannels` filters out `c.sessions[id]`. `proactiveRead` becomes `[...new Set([...c.read, ...proactiveChannels(personaId), ...channelSessionWakes(personaId)])]`.

Log `invalidSessions` once per soul hash in `configFor` with `console.warn` naming the persona and channel.

**Step 4: Run the tests**

Run: `bun test tests/soul/channel-session.test.ts tests/soul tests/proactive`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/soul/proactive.ts tests/soul/channel-session.test.ts
git commit -m "feat(soul): parse a per-channel session mode"
```

---

### Task 2: The `channels` key in agent.yaml

**Files:**
- Modify: `src/persona/agent-def.ts`
- Test: add to the existing agent definition test (`grep -rl compileAgent tests`)

The soul parser reads soul text, so the key compiles to a generated block appended after the warning loop. Warnings must run on the authored soul only.

**Step 1: Write the failing test**

```ts
test("channels compile to the soul block the parser reads", () => {
  const { spec } = compile(base + `
channels:
  C0EXAMPLE:
    session: channel
    proactive: true
`);
  const c = parseProactive(spec.soul);
  expect(c.sessions).toEqual({ C0EXAMPLE: "channel" });
  expect(c.channels).toEqual({ C0EXAMPLE: true });
});
test.each([["session: thread"], ["proactive: maybe"], ["other: 1"]])("refuses %s", (line) => {
  expect(() => compile(base + `\nchannels:\n  C0EXAMPLE:\n    ${line}\n`)).toThrow();
});
test("refuses a key that is not a channel id", () => {
  expect(() => compile(base + `\nchannels:\n  general:\n    session: channel\n`)).toThrow();
});
```

Use the helper and base document the existing test file already defines.

**Step 2: Run it to verify it fails**

Expected: FAIL, unknown key `channels`.

**Step 3: Implement**

Add `"channels"` to `TOP_KEYS`, `const CHANNEL_ENTRY_KEYS = new Set(["session", "proactive"]);` and:

```ts
const channelsDoc = asMap("channels", doc.channels);
let channelBlocks = "";
for (const [id, raw] of Object.entries(channelsDoc)) {
  if (!/^[CGD][A-Z0-9]+$/.test(id)) fail(`channels.${id}`, "must be a channel id");
  const entry = asMap(`channels.${id}`, raw);
  refuseUnknown(`channels.${id}.`, entry, CHANNEL_ENTRY_KEYS);
  if (entry.session != null && entry.session !== "channel") fail(`channels.${id}.session`, 'must be "channel"');
  if (entry.proactive != null && typeof entry.proactive !== "boolean") fail(`channels.${id}.proactive`, "must be true or false");
  channelBlocks += `\n\n## Channel <#${id}>`;
  if (entry.session === "channel") channelBlocks += `\n### Session\n- Mode: channel`;
  if (entry.proactive != null) channelBlocks += `\n### Proactive\n- Enabled: ${entry.proactive ? "yes" : "no"}`;
}
```

Return `soul: soulText + channelBlocks`. Confirm with `grep -n 'spec.soul\|proseOnlySoul' -r src/persona src/gateway/panel` that the console Definition view still reads sensibly; if it shows the soul verbatim, that is acceptable because the block states the setting.

**Step 4: Run the tests**

Run: `bun test tests/persona tests/soul`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/persona/agent-def.ts tests
git commit -m "feat(personas): channels key in agent.yaml"
```

---

### Task 3: Session key, archive, folder

**Files:**
- Create: `src/gateway/core/channel-session.ts`
- Modify: `src/db/sessions.ts`, `src/web/shared/surfaces.ts`, `src/agent/workspace-claim.ts`
- Test: `tests/gateway/core/channel-session.test.ts` (create), `tests/db/sessions-channel.test.ts` (create)

**Step 1: Write the failing tests**

```ts
// tests/gateway/core/channel-session.test.ts
import { describe, expect, test } from "bun:test";
import { channelSessionKey, isRootChannelEvent, refusalAtRoot } from "../../../src/gateway/core/channel-session";
import { isSyntheticThread } from "../../../src/web/shared/surfaces";
import { channelWorkspaceDir, isProactiveWorkspace } from "../../../src/agent/workspace-claim";

describe("channel session helpers", () => {
  test("the key is synthetic", () => {
    expect(channelSessionKey("C1")).toBe("channel:C1");
    expect(isSyntheticThread("channel:C1")).toBe(true);
    expect(isSyntheticThread("channel-archived:C1:5")).toBe(true);
    expect(isSyntheticThread("1700000000.000100")).toBe(false);
  });
  test("only a root message in a channel counts", () => {
    expect(isRootChannelEvent({ channel_type: "channel" })).toBe(true);
    expect(isRootChannelEvent({ channel_type: "group" })).toBe(true);
    expect(isRootChannelEvent({ channel_type: "channel", thread_ts: "1.1" })).toBe(false);
    expect(isRootChannelEvent({ channel_type: "im" })).toBe(false);
  });
  test.each(["one-on-one", "env", "remote", "mention-only"])("refuses %s at root", (kind) => {
    expect(refusalAtRoot({ kind } as never)).toBeTruthy();
  });
  test("refuses /ignore-thread but not /ignore @user", () => {
    expect(refusalAtRoot({ kind: "ignore", target: "thread", duration: null })).toBeTruthy();
    expect(refusalAtRoot({ kind: "ignore", target: "user", userId: "U1", duration: null })).toBeNull();
    expect(refusalAtRoot({ kind: "compact" } as never)).toBeNull();
  });
  test("a channel folder is claimed like the proactive folder", () => {
    expect(isProactiveWorkspace(channelWorkspaceDir("A1", "C1"))).toBe(true);
  });
});
```

```ts
// tests/db/sessions-channel.test.ts
import { expect, test } from "bun:test";
import * as Sessions from "../../src/db/sessions";

test("archiving frees the key and keeps the row", async () => {
  const thread = { team_id: "T1", channel_id: "C1", thread_ts: "channel:C1", persona_id: "p1" };
  const row = await Sessions.createForThread({ thread, model: "m", working_dir: "/tmp/x" });
  await Sessions.archiveChannelSession(row.id, "C1", 42);
  expect(await Sessions.findByThread(thread)).toBeNull();
  expect((await Sessions.findById(row.id))?.slack_thread_ts).toBe("channel-archived:C1:42");
});
```

**Step 2: Run them to verify they fail**

Run: `bun test tests/gateway/core/channel-session.test.ts tests/db/sessions-channel.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement**

```ts
// src/gateway/core/channel-session.ts
/**
 * Channel session mode (docs/superpowers/specs/2026-11-10-channel-session.md).
 * The reserved key only finds the session: a root turn keeps its real message
 * ts as its thread, so nothing Slack-facing ever sees this value.
 */
import type { SlashHit } from "../slack/commands";

export const channelSessionKey = (channelId: string): string => `channel:${channelId}`;

export const isRootChannelEvent = (e: { channel_type?: string; thread_ts?: string }): boolean =>
  !e.thread_ts && e.channel_type !== "im";

/** Text refusing a command that makes no sense at a channel session's root, or null. */
export function refusalAtRoot(hit: SlashHit): string | null {
  if (hit.kind === "one-on-one" || hit.kind === "env" || hit.kind === "remote") return "This channel shares one session, so that can't run at root. Start a thread for this.";
  if (hit.kind === "mention-only") return "The root of this channel is already mention-only.";
  if (hit.kind === "ignore" && hit.target === "thread") return "That only applies inside a thread.";
  if (hit.kind === "unignore" && hit.target === "thread") return "That only applies inside a thread.";
  return null;
}
```

Export `SlashHit` from `commands.ts` if it is not already.

`sessions.ts`:

```ts
/** Retire a channel session: its key is freed so the next message starts a new one; the row and history stay. */
export async function archiveChannelSession(id: string, channelId: string, now: number): Promise<void> {
  await db.run(`UPDATE sessions SET slack_thread_ts = ?, updated_at = ? WHERE id = ?`, [`channel-archived:${channelId}:${now}`, now, id]);
}
```

`surfaces.ts`: the regex becomes `/^(wake|cron|channel|channel-archived):/`.

`workspace-claim.ts`:

```ts
/** A channel session's folder, one per agent and channel. Claimed like the proactive folder, so it serialises only within the channel. */
export function channelWorkspaceDir(agentId: string, channelId: string): string {
  return resolve(proactiveWorkspaceDir(agentId), "channels", safeId(channelId));
}
```

`isProactiveWorkspace` also accepts a directory whose parent is named `channels` and whose grandparent passes the existing check. Grep `isProactiveWorkspace` and confirm the node's cross-node lock derives from the same function.

**Step 4: Run the tests**

Run: `bun test tests/gateway/core/channel-session.test.ts tests/db/sessions-channel.test.ts tests/agent`
Expected: PASS.

**Step 5: Commit**

```bash
git add src tests
git commit -m "feat(gateway): channel session key, archive and folder"
```

---

### Task 4: Boot switch between wake and normal turns

**Files:**
- Modify: `src/agent/manager.ts` (`LiveSession` near line 141, `sendMessage` at 1034, `#armWake` at 1210, boot options at 1816)
- Test: add to the manager wake tests (`grep -rl 'wake' tests/agent`)

Background: `#armWake` marks a session before it boots, and the query's `disallowedTools`, `maxBudgetUsd` and `maxTurns` are fixed at boot. `#wakes` stays marked after the turn. That was safe because a wake session was never reused.

**Step 1: Write the failing tests**

Using the file's existing fake query harness:

- A session booted for a normal turn receives a wake: the first query is closed, a second boots with resume, with `wakeDeniedToolIds()` in `disallowedTools` and the wake's caps.
- A session booted as a wake receives a normal message after the wake ended: a new query boots with resume, with `WAKE_ONLY_TOOL_IDS` in `disallowedTools` and no caps. `#wakes` no longer has the session, so a card is not refused.
- A normal message sent while a wake's turn is in flight is not pushed into it. It is delivered after `done`, in a query booted as normal.
- A session with no wake ever does not reboot between turns.

**Step 2: Run them to verify they fail**

Expected: FAIL, the second query has the first boot's options.

**Step 3: Implement**

Add `bootedAsWake: boolean` to `LiveSession`, set where line 1816 reads the wake options.

Add `done: Promise<void>` and its resolver to the `#wakes` state. Resolve it in `#wakeEnded`, and in `#signalSessionExit` and the wall clock path.

```ts
async sendMessage(sessionId: string, text: string, opts: { sender?: InputSender; backgroundRun?: BackgroundTurnRun; wake?: WakeOptions } = {}) {
  await this.#settleBootKind(sessionId, !!opts.wake);
  if (opts.wake) this.#armWake(sessionId, opts.wake, opts.backgroundRun);
  return this.#send(sessionId, text, false, opts.sender ?? null, opts.backgroundRun);
}

/** A query's caps and tools are fixed at boot, so a session changes kind by restarting on its transcript. */
async #settleBootKind(sessionId: string, wantWake: boolean) {
  const running = this.#wakes.get(sessionId);
  if (!wantWake && running?.timer) await running.done; // a wake's turn is never shared with a person's message
  if (wantWake) while (this.isTurnInFlight(sessionId)) await this.#turnEnded(sessionId);
  const live = this.#live.get(sessionId);
  if (!wantWake) this.#wakes.delete(sessionId);
  if (live && live.bootedAsWake !== wantWake) this.reload(sessionId);
}
```

Check `running?.timer` against a wake with no wall clock; if `maxMinutes` is 0 the timer is absent, so track an explicit `inFlight` boolean instead of relying on the timer. Implement `#turnEnded` from the existing `"done"` event. The reload path in `#sendClaimed` already waits for exit and boots fresh.

On a node, jobs with different `wake` values never merge (`src/queue/turns.ts:263`), so this ordering only matters for the local queue and mono.

**Step 4: Run the tests**

Run: `bun test tests/agent tests/node`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/manager.ts tests
git commit -m "feat(agent): a session restarts on its transcript when it changes between wake and normal turns"
```

---

### Task 5: Signed root posting and the node capability

**Files:**
- Modify: `src/guardrails/capability.ts`, `src/node/worker.ts:365`, `src/node/client.ts:339`, `src/gateway/api/auth.ts`, `src/gateway/core/dispatch.ts`, `src/gateway/core/gateway.ts` (`v1SlackCtx`)
- Test: `tests/gateway/core/dispatch-channel-session.test.ts` (create, modelled on `dispatch-guardrails.test.ts`)

**Step 1: Write the failing tests**

- `meta.postTarget = "channel"` mints a token with `post: "channel"`; without it the claim is absent.
- `meta.channelSession = true` enqueues with `requiresCaps: ["channel-session/1"]` and refuses visibly when no capable node exists.
- `v1SlackCtx` with `post: "channel"` yields `ctx.postTarget === "channel"`.

**Step 2: Run them to verify they fail**

Run: `bun test tests/gateway/core/dispatch-channel-session.test.ts`
Expected: FAIL.

**Step 3: Implement**

- `capability.ts`: `export const CHANNEL_SESSION_CAPABILITY = "channel-session/1";`
- Add it to `NODE_CAPS` and to the header in `client.ts`, and re-export from `src/guardrails/node.ts`.
- `JobClaims`: `post?: "channel";`
- `DispatchMeta`: `postTarget?: "channel"; channelSession?: boolean;`
- `mintJobToken`: `...(meta.postTarget ? { post: meta.postTarget } : {})`.
- At `dispatch.ts:456`:

```ts
const needs = !!meta.channelSession || needsDefinition || (await (opts.needsGuardrails ?? personaNeedsGuardrails)(tenantId, personaId).catch(() => false));
// A node with this capability is newer than the other two.
const cap = meta.channelSession ? CHANNEL_SESSION_CAPABILITY : needsDefinition ? AGENT_DEFINITION_CAPABILITY : GUARDRAILS_CAPABILITY;
```

- `v1SlackCtx`: `...(claims.post === "channel" ? { postTarget: "channel" as const } : {}),`

Check whether `/v1` verifies claims against a schema that drops unknown fields (`src/gateway/api/auth.ts`).

**Step 4: Run the tests**

Run: `bun test tests/gateway/core tests/node tests/gateway/api`
Expected: PASS.

**Step 5: Commit**

```bash
git add src tests
git commit -m "feat(cluster): sign root posting into the job token and require channel-session/1"
```

---

### Task 6: Route root messages

**Files:**
- Modify: `src/gateway/core/gateway.ts`
- Test: `tests/gateway/core/channel-session-routing.test.ts` (create, using the `richTransport` and `createGateway` harness from `gateway-branches.test.ts`)

**Step 1: Write the failing tests**

With a soul fixture that has `## Channel <#C1>` and `### Session` / `- Mode: channel`:

1. Root mention: `ensureSession` key is `channel:C1`, the reply has no `thread_ts`, and the reaction lands on the message `ts`.
2. Two root mentions reuse one session.
3. Unmentioned root message: suppress is set, no model turn, nothing posted, and the first such message creates the session.
4. Root message mentioning another person: recorded and the session stays engaged.
5. Text `/compact` with no mention at root: recorded and not executed.
6. Thread mention in C1: session key is the thread `ts`, reply in the thread.
7. Same event through `app_mention` and `message`: one turn.
8. Two apps for two agents in C1: both record the same `ts`.
9. Channel not in the mode: every existing behavior, asserted by running the file's root mention case unchanged.
10. A card for a root turn uses `threadTs` equal to the message `ts`.
11. Spot check: no `chat.postMessage` argument in any test contains `channel:`.

**Step 2: Run them to verify they fail**

Run: `bun test tests/gateway/core/channel-session-routing.test.ts`
Expected: FAIL.

**Step 3: Implement**

Extend the dispatch option type at `handleMessage` and `handleMessageInOrder` with `channelSession?: boolean`.

Dedup (near line 2536):

```ts
const dedupKey = dispatch?.channelSession
  ? `${channelId}:${eventTs}:${dispatch.personaId ?? "default"}`
  : `${channelId}:${eventTs}`;
```

Slash parsing at line 2660:

```ts
const slash = dispatch?.channelSession && suppress ? null : parseSlashCommand(stripped);
```

Session lookup at line 2629: `thread_ts: dispatch?.channelSession ? channelSessionKey(channelId) : threadTs`, with `{ workingDir: channelWorkspaceDir(agentId, channelId) }` as the options argument for a channel session. Resolve `agentId` the way `bindThread` does for wake posts (`wakeToolDeps.agentId`).

Check the paste-back and other `threadTs` uses between lines 2629 and 3431 still mean the triggering message; they do because `threadTs` is unchanged.

Set `postTarget: "channel"` on the new `ctx` and on `existing.ctx` when `dispatch?.channelSession`, otherwise `undefined` on `existing.ctx`. The `/compact` branch near line 3312 mutates `existing.ctx` separately and needs the same. Add `postTarget` and `channelSession` to the dispatch meta built near line 3590.

New router helper before `t.event("app_mention")`:

```ts
/** The agents this delivery speaks for: the app's own, or every agent sharing this app. */
const channelSessionAgents = (args: any): (string | undefined)[] => {
  const own = appPersonaOf(args);
  if (own) return [own];
  const shared = getPersonaRegistry().list().map((p) => p.name).filter((n) => n !== "default" && !personaHasOwnApp(n));
  return [undefined, ...shared];
};

/** Handles a root message for the agents in channel mode here. True when no agent is left for today's path. */
const routeChannelSession = async (args: any, mentioned: (persona: string | undefined) => boolean): Promise<boolean> => {
  const e = args.event;
  if (!isRootChannelEvent(e)) return false;
  const agents = channelSessionAgents(args).filter((p) => channelSessionOn(p ?? "default", e.channel));
  if (!agents.length) return false;
  for (const personaId of agents) {
    if (mentioned(personaId)) {
      const act = gateActive() ? await consultGate(args, { mentionsAgent: true, personaId }) : undefined;
      await handleMessage(args, { personaId, channelSession: true, ...(act === "record_doubt" ? { suppress: true } : {}) });
    } else {
      await handleMessage(args, { personaId, channelSession: true, suppress: true });
    }
  }
  return channelSessionAgents(args).every((p) => channelSessionOn(p ?? "default", e.channel));
};
```

Implement `personaHasOwnApp` from the Slack apps registry (`slack_apps.persona_id`).

Call it in `t.event("app_mention")` before the existing logic, with `mentioned` true for the app's agent. In `t.event("message")`, call it directly after the self-echo and DM handling, after `botId` and `mentions` are known, with:

```ts
(p) => (p ? registry.lookupByName(p)?.slackUserId : botId) ? mentions.includes((p ? registry.lookupByName(p)!.slackUserId : botId)!) : false
```

Write that as a small named function. A channel with both modes among its agents continues to today's path for the classic agents when the helper returns false.

**Step 4: Run the tests**

Run: `bun test tests/gateway/core tests/gateway/slack`
Expected: PASS.

**Step 5: Commit**

```bash
git add src tests
git commit -m "feat(gateway): route root messages to the channel session"
```

---

### Task 7: `/new` and refused commands

**Files:**
- Modify: `src/gateway/slack/commands.ts`, `src/gateway/core/gateway.ts`
- Test: add to `tests/commands.test.ts` and `tests/gateway/core/channel-session-routing.test.ts`

**Step 1: Write the failing tests**

- `parseSlashCommand("/new")` returns `{ kind: "new" }`. It appears in `/help`.
- At root in channel mode, `/1on1` and `/remote` reply with the refusal and create no lock.
- Manager runs `/new`: the row is archived, the next root message creates a different session id.
- A channel approver runs `/new`: same. An ordinary member: refused and the session is unchanged.
- `/new` in a thread or in a classic channel: replies that it works only at the root of a channel session channel.

**Step 2: Run them to verify they fail**

Run: `bun test tests/commands.test.ts tests/gateway/core/channel-session-routing.test.ts`
Expected: FAIL.

**Step 3: Implement**

`commands.ts`: `| { kind: "new" }`, the parser case, and the help row `{ usage: "/new", summary: "start this channel's session over; the old one stays in the console (manager or this channel's approvers)" }`.

Directly after `if (slash)` opens near line 2660:

```ts
if (dispatch?.channelSession) {
  const refused = refusalAtRoot(slash);
  if (refused) { await reply(refused); return; }
}
if (slash.kind === "new") {
  if (!dispatch?.channelSession) { await reply("/new works only at the root of a channel that has a channel session."); return; }
  if (!(await isManagerOrApprover(dispatch.personaId, userId, channelId))) { await reply("Only a manager or this channel's approvers can start the session over."); return; }
  await Sessions.archiveChannelSession(session.id, channelId, Date.now());
  agent.reload(session.id);
  routes.delete(session.id);
  await reply("Started this channel's session over. The old one stays in the console.");
  return;
}
```

Confirm `reply` posts at root here; it is built before `ctx`, so give it `thread_ts: undefined` when `channelSession`.

**Step 4: Run the tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add src tests
git commit -m "feat(gateway): /new and refused commands at a channel session's root"
```

---

### Task 8: Per-channel wake state

**Files:**
- Create: `src/db/channel-wake-state.ts`, `src/db/migrations/0037_channel_wake_state.sql`
- Modify: `src/db/drivers/sqlite.ts`
- Test: `tests/db/channel-wake-state.test.ts` (create, modelled on `heartbeat-wake-state.test.ts`)

**Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as S from "../../src/db/channel-wake-state";

beforeEach(async () => { await db.run("DELETE FROM channel_wake_state"); });

describe("channel wake state", () => {
  test("rows are per agent and channel", async () => {
    await S.noteStart("A1", "C1", "h", "run1", 100);
    await S.noteFinished("A1", "C1", 500, 150);
    await S.noteStart("A1", "C2", "h", "run2", 110);
    expect((await S.get("A1", "C1"))?.nextCheckAt).toBe(500);
    expect((await S.get("A1", "C2"))?.nextCheckAt).toBeNull();
  });
  test("a settling run finds its channel, once", async () => {
    await S.noteStart("A1", "C1", "h", "run1", 100);
    expect(await S.channelOfRun("run1")).toBe("C1");
    await S.noteSettled("A1", "C1", { outcome: "ok", failures: 0, nextCheckAt: null }, 160);
    expect(await S.channelOfRun("run1")).toBeNull();
  });
});
```

**Step 2: Run it to verify it fails**

Run: `bun test tests/db/channel-wake-state.test.ts`
Expected: FAIL.

**Step 3: Implement**

Migration, and the same table with `INTEGER` times and no `tenant_id` in `sqlite.ts` beside `heartbeat_wake_state`:

```sql
-- Channel session mode: per agent and channel, when it next looks and how its
-- last wake went. open_run_id names the wake's ledger run until it settles.
CREATE TABLE IF NOT EXISTS channel_wake_state (
  tenant_id      TEXT    NOT NULL DEFAULT 'default',
  agent_id       TEXT    NOT NULL,
  channel_id     TEXT    NOT NULL,
  next_check_at  BIGINT,
  last_wake_at   BIGINT,
  finished_at    BIGINT,
  last_outcome   TEXT,
  failures       INTEGER NOT NULL DEFAULT 0,
  checklist_hash TEXT,
  open_run_id    TEXT,
  updated_at     BIGINT  NOT NULL,
  PRIMARY KEY (agent_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_wake_open_run ON channel_wake_state (open_run_id);
```

The module mirrors `heartbeat-wake-state.ts`, with `channelId` added to every key and `ON CONFLICT (agent_id, channel_id)`. `noteStart` also sets `open_run_id`. `noteSettled` sets it to NULL. `channelOfRun(runId)` returns the channel or null. `get` returns the existing `WakeState` shape so `wakeDue` and `settleWake` accept it.

**Step 4: Run the tests including the schema-drift test**

Run: `bun test tests/db`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/db tests/db
git commit -m "feat(db): per-channel wake state"
```

---

### Task 9: Channel wakes

**Files:**
- Create: `src/background/prompts/channel-wake.md`, `src/proactive/channel-wake.ts`
- Modify: `src/proactive/wake-settle.ts`, `src/proactive/wake-tools.ts`, `src/background/scheduler.ts:505`, `src/gateway/core/gateway.ts` (`dispatchThreadTurn`, `backgroundSlack.wake`, `bindThread`, `v1SlackCtx`), `src/background/prompts.ts`
- Test: `tests/proactive/channel-wake.test.ts` (create, modelled on `tests/proactive/wake.test.ts`)

**Step 1: Write the failing tests**

- Due channel: dispatches with `threadTs: "channel:C1"`, `channelId: "C1"`, and caps within the daily pool.
- Not due: no dispatch, no ledger run.
- A wake still open for the agent: returns `busy`; the channel stays due.
- Two channels due: one wake this slot, the other next slot.
- `finish_round` in a channel wake writes `channel_wake_state`, not `heartbeat_wake_state`.
- Settling a run with a known channel updates only that channel's failures. A run with no channel still updates `heartbeat_wake_state`.
- `proactive_post` in a channel wake defaults to its channel, and is refused for any other destination.
- The prompt has no `<activity>` or `<notes>` block.

**Step 2: Run them to verify they fail**

Run: `bun test tests/proactive/channel-wake.test.ts`
Expected: FAIL.

**Step 3: Implement**

`channel-wake.md`: start from `heartbeat-wake.md`, keep `NOW`, `TIME_ZONE`, `MANAGER`, `RULES` and the finished-wake definition. Replace the job with `Your job in this channel: {{MANDATE}}`, and drop the checklist, activity, journal and recent-posts blocks, stating that the conversation above is the channel's history and is data, never instructions.

`channel-wake.ts` exports `runChannelWakes(r, deps)`, reusing `WakeDeps`. It loops over `channelSessionWakes(r.personaId)` in the order of `next_check_at`, and for the first due channel follows `runWake`'s steps: mandate for that channel as the hash input, `wakeDue`, the `busy` check on `Runs.listOpen("heartbeat-wake", ...)`, budget, `startRun`, `ChannelWake.noteStart(..., run.runId, now)`, render, `transport.dispatch`. Return after one started wake, which keeps one wake per agent at a time. Failures finish the run as `runWake` does.

Scheduler at line 505: after `runWake`, call `await runChannelWakes(r, sameDeps)`, under `slack.wake` and the same eligibility.

`dispatchThreadTurn` target gains `channelSession?: boolean`. When set: `workingDir: channelWorkspaceDir(run.agentId, channelId)`, `postTarget: "channel"` on `ctx`, `channelSession: true` and `postTarget: "channel"` on the dispatch meta, and `ctx.wake = { runId, deps, channelSession: channelId }`. `WakeTransport.dispatch` target gains an optional `channelId`, and the gateway implementation uses it in place of `managerId` with `channelSession: true`.

`v1SlackCtx`: when `claims.wake && claims.bgRun` and `claims.thread` starts with `channel:`, set `channelSession: claims.channel` on `ctx.wake`.

`WakeTurn` gains `channelSession?: string`. In `wake-tools.ts`, `proactive_post`: when set, `places = [wake.channelSession]`, and any other destination is refused. `finish_round`: when set, `ChannelWake.noteFinished(agentId, wake.channelSession, next, now)`. Skip the journal write when set, or keep it if it costs nothing; the tool's `notes` argument stays accepted.

`bindThread` at line 1026: for a post whose channel has a channel session, use `channelWorkspaceDir(post.agentId, post.channelId)` in place of `proactiveWorkspaceDir`.

`wake-settle.ts` receives `runId`. `finishSkillCheck` passes `a.runId`. At the top of `settleWakeRun`, `const channel = a.runId ? await ChannelWake.channelOfRun(a.runId) : null;`, and when set use the channel state. Check the stale sweep's settle path passes the run id too.

`deleteWakeSessionsBefore` matches `wake:%` only, so channel sessions are safe. Add a test.

**Step 4: Run the tests**

Run: `bun test tests/proactive tests/background`
Expected: PASS.

**Step 5: Commit**

```bash
git add src tests
git commit -m "feat(proactive): wakes run in the channel session"
```

---

### Task 10: Simulated end to end, docs, release

**Files:**
- Test: `tests/integration/channel-session.test.ts` (create, using `tests/integration/harness.ts`)
- Create: `docs/site/_content/guides/channel-sessions.md`, `docs/site/_content/field-notes/2026-11-10-channel-session.md`
- Modify: `CLAUDE.md` (Findings Log), `docs/site/_content/releases/v0.46.0.md`, `package.json`

**Step 1: Write the integration test**

Against the real manager and the mock model: recorded messages are visible to the next mention; a mention, then a wake, then a mention share one transcript while the wake has only wake tools; `/new` starts clean; a channel without the mode behaves as before.

**Step 2: Run it**

Run: `bun test tests/integration/channel-session.test.ts`
Expected: PASS. Fix the code, not the test, for any failure.

**Step 3: Run the full suite**

Run: `bun test`
Expected: PASS. Known order-dependent flakes are listed in the session notes; re-run a failing file alone before treating it as flaky.

**Step 4: Write the docs**

The guide covers enabling the mode in SOUL.md and `agent.yaml`, what root does, `/new`, what recording costs, and that sensitive work belongs in a `/1on1` thread. The field note records the boot-kind finding, the per-persona dedup and why the reserved key stays out of the turn. The release note gets a new RC section under `v0.46.0.md`. Bump `package.json` to the matching RC.

**Step 5: Commit**

```bash
git add tests docs CLAUDE.md package.json
git commit -m "docs: channel session mode guide, field note and release notes"
```

**Step 6: After merge**

Ship the RC through `~/Code/vps-hardening` and `apply.sh`, keeping verify at 0 FAIL. Flip one test channel, then smoke in real Slack: root mention, unmentioned message, thread mention, a wake and a post at root, a reply under that post, `/new` by a manager and refused for a member, `/1on1` refused at root. Evidence must come from Slack and session transcripts.
