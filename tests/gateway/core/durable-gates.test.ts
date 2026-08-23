import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as PendingGates from "../../../src/db/pending-gates";
import * as OneOnOne from "../../../src/db/one-on-one";
import { PermissionGate } from "../../../src/gateway/slack/permission-gate";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";

/**
 * M2 semantics at the gateway level: the durable state (seen_events,
 * pending_gates, sessions.engaged) must behave identically when a fresh
 * gateway instance — a "restarted process" sharing the same DB — picks up
 * where the previous one left off.
 */

const TEAM = "T";
const CH = "C0TEAM"; // trusted channel in WORLD

/** Transport capturing posts + event/action handlers, so a test can drive
 *  inbound messages and Block Kit clicks through the gateway. */
function makeTransport() {
  const posts: any[] = [];
  const events = new Map<string, (args: any) => Promise<void>>();
  const actions: Array<{ id: string | RegExp; h: (args: any) => Promise<void> }> = [];
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "USLAUDEBOT", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: `${Date.now()}.0` }; }, update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: (id: string | RegExp, h: any) => { actions.push({ id, h }); },
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { events.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await events.get(name)?.(args); };
  const click = async (action_id: string, userId: string) => {
    const responds: any[] = [];
    for (const a of actions) {
      const match = typeof a.id === "string" ? a.id === action_id : a.id.test(action_id);
      if (!match) continue;
      await a.h({
        ack: async () => {},
        action: { action_id },
        body: { user: { id: userId } },
        respond: async (m: any) => { responds.push(m); },
      });
    }
    return responds;
  };
  return { t, posts, emit, click };
}

/** Gateway + a stubbed agent that records every dispatched envelope. */
function makeGw(gwOpts: any = {}) {
  const cap = makeTransport();
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  createGateway(agent, cap.t, gwOpts);
  return { ...cap, agent, sends };
}

const msg = (client: any, text: string, ts: string, opts: { user?: string; thread?: string } = {}) => ({
  event: {
    type: "message", channel: CH, channel_type: "channel",
    user: opts.user ?? WORLD.manager, team: TEAM, ts,
    ...(opts.thread ? { thread_ts: opts.thread } : {}),
    text,
  },
  client,
  context: { teamId: TEAM },
});

/** Engage the way real Slack does: a bot mention fires app_mention first. */
async function mention(g: ReturnType<typeof makeGw>, ts: string, text: string, thread?: string) {
  const args = msg(g.t.client, text, ts, { thread });
  await g.emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
  await g.emit("message", args);
}

let seq = 50_000;
const nextTs = () => `${++seq}.1`;

beforeEach(async () => {
  writeSoulFixture(WORLD);
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM pending_gates");
  OneOnOne._wipeForTests();
});

afterEach(() => {
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("durable gate state across gateway restarts", () => {
  it("a redelivered event is dropped by a fresh gateway instance (dedup survives restart)", async () => {
    const ts = nextTs();
    const g1 = makeGw();
    await mention(g1, ts, "<@USLAUDEBOT> hello");
    expect(g1.sends.length).toBe(1);

    // "Restart": new gateway, new in-memory state, same DB. Slack redelivers.
    const g2 = makeGw();
    await mention(g2, ts, "<@USLAUDEBOT> hello");
    expect(g2.sends.length).toBe(0);

    // A genuinely new event still flows.
    await mention(g2, nextTs(), "<@USLAUDEBOT> hello again");
    expect(g2.sends.length).toBe(1);
  });

  it("engagement survives a restart: plain replies keep flowing, disengage sticks", async () => {
    const thread = nextTs();
    const g1 = makeGw();
    await mention(g1, thread, "<@USLAUDEBOT> hi");
    expect(g1.sends.length).toBe(1);

    // Restart. Plain reply (no mention) — engaged thread keeps being handled.
    const g2 = makeGw();
    await g2.emit("message", msg(g2.t.client, "plain follow-up", nextTs(), { thread }));
    expect(g2.sends.length).toBe(1);

    // Colleague mention disengages, durably.
    await g2.emit("message", msg(g2.t.client, "<@U0APP> your turn", nextTs(), { thread }));

    // Restart again. Plain reply is recorded-suppressed, not processed.
    const g3 = makeGw();
    await g3.emit("message", msg(g3.t.client, "thanks!", nextTs(), { thread }));
    expect(g3.sends.length).toBe(1);
    expect(g3.sends[0]).toContain("do NOT reply");
  });

  it("a /mcp connect card minted before the restart still connects after it", async () => {
    // The card's whole click context lives in the pending_gates payload — a
    // fresh process (with no in-memory map) must be able to run the connect.
    writeFileSync(join(paths.home, ".mcp.json"), JSON.stringify({
      mcpServers: { workbench: { type: "http", url: "https://workbench.example/mcp" } },
    }), "utf8");
    try {
      await PendingGates.create({
        id: "cardtoken1", kind: "mcp_connect", sessionId: "S_OLD",
        payload: { channelId: CH, threadTs: "500.0", userId: WORLD.manager, serverName: "workbench", scope: "global" },
      });
      // persistTokens writes into the agent's CLAUDE_CONFIG_DIR — make sure it exists.
      mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
      const g = makeGw({ oauthConnect: async () => ({ clientId: "c", accessToken: "a" }) });
      await g.click("slaude_mcp:connect:cardtoken1", WORLD.manager);
      expect(g.posts.some((p) => /connected/i.test(String(p.text ?? "")))).toBe(true);
      expect((await PendingGates.get("cardtoken1"))!.status).toBe("approved");

      // A second click on the consumed card does nothing.
      const before = g.posts.length;
      await g.click("slaude_mcp:connect:cardtoken1", WORLD.manager);
      expect(g.posts.length).toBe(before);
    } finally {
      rmSync(join(paths.home, ".mcp.json"), { force: true });
    }
  });

  it("a non-owner click never consumes a connect card", async () => {
    writeFileSync(join(paths.home, ".mcp.json"), JSON.stringify({
      mcpServers: { workbench: { type: "http", url: "https://workbench.example/mcp" } },
    }), "utf8");
    try {
      await PendingGates.create({
        id: "cardtoken2", kind: "mcp_connect", sessionId: "S_OLD",
        payload: { channelId: CH, threadTs: "501.0", userId: WORLD.manager, serverName: "workbench", scope: "global" },
      });
      const g = makeGw({ oauthConnect: async () => ({ clientId: "c", accessToken: "a" }) });
      await g.click("slaude_mcp:connect:cardtoken2", "U0ALICE"); // not the requester
      expect((await PendingGates.get("cardtoken2"))!.status).toBe("pending");
      expect(g.posts.length).toBe(0);
    } finally {
      rmSync(join(paths.home, ".mcp.json"), { force: true });
    }
  });

  it("a waiter-less approval row minted by THIS instance is settled as a stray (abort raced the click)", async () => {
    // Same instance id + no local waiter can only mean our own teardown raced
    // the click — settle it so it doesn't linger until expiry.
    await PendingGates.create({
      id: "orphan_appr", kind: "approval", sessionId: "S_OLD",
      payload: { channel: CH, threadTs: "1.0", summary: "old plan", approvers: [WORLD.manager] },
    });
    const g = makeGw();
    const responds = await g.click("slaude_appr:approve:orphan_appr", WORLD.manager);
    expect(responds.some((r) => /already decided/.test(r.text ?? ""))).toBe(true);
    expect((await PendingGates.get("orphan_appr"))!.status).toBe("cancelled");
  });

  it("a pending row from ANOTHER instance is never click-cancelled — clicker is told it lives elsewhere", async () => {
    // A foreign pending row may belong to a live sibling replica holding the
    // in-process waiter. Cancelling it would hang the sibling forever; the
    // row must survive the click untouched and drain via expiry instead.
    await PendingGates.create({
      id: "foreign_appr", kind: "approval", sessionId: "S_SIBLING",
      payload: { channel: CH, threadTs: "2.0", summary: "sibling plan", approvers: [WORLD.manager] },
    });
    await db.run(`UPDATE pending_gates SET instance_id = 'some-other-replica' WHERE id = 'foreign_appr'`);
    const g = makeGw();
    const responds = await g.click("slaude_appr:approve:foreign_appr", WORLD.manager);
    expect(responds.some((r) => /another replica/.test(r.text ?? ""))).toBe(true);
    expect(responds.some((r) => r.replace_original === true)).toBe(false); // buttons stay
    expect((await PendingGates.get("foreign_appr"))!.status).toBe("pending");
    // Same protection for permission prompts.
    await PendingGates.create({ id: "foreign_perm", kind: "perm", sessionId: "S_SIBLING", payload: {} });
    await db.run(`UPDATE pending_gates SET instance_id = 'some-other-replica' WHERE id = 'foreign_perm'`);
    const r2 = await g.click("slaude_perm:allow:foreign_perm", WORLD.manager);
    expect(r2.some((r) => /another replica/.test(r.text ?? ""))).toBe(true);
    expect((await PendingGates.get("foreign_perm"))!.status).toBe("pending");
  });
});

describe("stale-click idempotency (two clicks, one wins)", () => {
  function fakeApp() {
    const handlers: { matcher: RegExp; fn: (a: any) => Promise<void> }[] = [];
    const posts: any[] = [];
    const app: any = {
      action: (matcher: RegExp, fn: any) => handlers.push({ matcher, fn }),
      client: { chat: { postMessage: async (m: any) => { posts.push(m); return { ok: true, ts: "9.9" }; }, update: async () => ({ ok: true }) } },
    };
    const fire = async (action_id: string, userId: string) => {
      const calls: any[] = [];
      for (const h of handlers) {
        if (h.matcher.test(action_id)) {
          await h.fn({ ack: async () => {}, action: { action_id }, body: { user: { id: userId } }, respond: async (m: any) => { calls.push(m); } });
        }
      }
      return calls;
    };
    return { app, posts, fire };
  }

  it("permission prompt: concurrent allow + deny → exactly one decision", async () => {
    const f = fakeApp();
    const gate = new PermissionGate(f.app);
    gate.bindSession("S", CH, "700.0");
    const ac = new AbortController();
    const p = gate.resolver("S", "Bash", { command: "ls" }, { toolUseID: "race_tu", signal: ac.signal } as any);
    // wait for the prompt (row + waiter are in place before the post)
    for (let i = 0; i < 500 && f.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));

    const [a, b] = await Promise.all([
      f.fire("slaude_perm:allow:race_tu", "U1"),
      f.fire("slaude_perm:deny:race_tu", "U2"),
    ]);
    const r = (await p) as any;
    const row = (await PendingGates.get("race_tu"))!;
    // The SDK decision matches whichever click won the row.
    expect(r.behavior).toBe(row.status === "approved" ? "allow" : "deny");
    // One winner replaced the message with the decision; the loser saw stale.
    const all = [...a, ...b];
    expect(all.filter((m) => /already decided/.test(m.text ?? "")).length).toBe(1);
    expect(all.filter((m) => !/already decided/.test(m.text ?? "")).length).toBe(1);
  });

  it("approval: second click after the decision is stale", async () => {
    // WORLD's structured soul (memoized by writeSoulFixture) makes U0APP the
    // catchall approver.
    const f = fakeApp();
    const gate = new ApprovalGate(f.app, []);
    const p = gate.request({ channel: CH, threadTs: "701.0", summary: "ship it" });
    for (let i = 0; i < 500 && f.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const id = f.posts[0].blocks
      .find((b: any) => b.type === "actions")
      .elements[0].action_id.split(":")[2];

    const first = await f.fire(`slaude_appr:approve:${id}`, "U0APP");
    expect((await p).approved).toBe(true);
    expect(first.some((m) => /Approved/.test(m.text ?? ""))).toBe(true);

    const second = await f.fire(`slaude_appr:deny:${id}`, "U0APP");
    expect(second.some((m) => /already decided/.test(m.text ?? ""))).toBe(true);
    expect((await PendingGates.get(id))!.status).toBe("approved");
  });
});
