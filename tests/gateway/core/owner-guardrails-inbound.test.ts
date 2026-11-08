/**
 * Owner inbound rules at the gateway (design section 4): a deny drops the
 * message before any turn and replies with the rule's message, at most once
 * per person per thread per quiet window; an audit rule lets it on; both are
 * audited without the message text. On-match Guidance an inbound trigger
 * matches is handed to the session for its next turn.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __setGrantsReader } from "../../../src/access/role";
import { __clearGuardrailsForTests, applyGuardrailChange } from "../../../src/db/guardrails";
import { __resetGuardrailSnapshotsForTests, refreshGuardrails } from "../../../src/guardrails/snapshot";
import { flushAudits } from "../../../src/audit/emit";
import { makeReplyQuiet } from "../../../src/gateway/core/owner-guardrails";

const SECRET = "hunter2-do-not-store";
const GUARD = [
  "---",
  "name: inbound-care",
  "description: d",
  "---",
  "```rules",
  "- id: no-passwords",
  "  on: inbound",
  "  match: { text: '(?i)password\\s*[:=]' }",
  "  action: deny",
  "  message: Please do not paste passwords here.",
  "- id: watch-invoices",
  "  on: inbound",
  "  match: { text: '(?i)invoice' }",
  "  action: audit",
  "```",
].join("\n");
const GUIDE = "---\nname: invoice-help\ndescription: How invoices work\nload: on-match\ntriggers: { inbound: '(?i)invoice' }\n---\nInvoices go to the finance channel.";

let stopGateway: (() => Promise<void>) | null = null;
function setup() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const posts: Array<{ kind: "post" | "ephemeral"; text: string; user?: string; thread?: string }> = [];
  const client: any = {
    auth: { test: async () => ({ user_id: "U0BOT", bot_id: "B0BOT", team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => (posts.push({ kind: "post", text: String(a.text ?? ""), thread: a.thread_ts }), { ok: true, ts: "1.1" }),
      postEphemeral: async (a: any) => (posts.push({ kind: "ephemeral", text: String(a.text ?? ""), user: a.user, thread: a.thread_ts }), { ok: true }),
      update: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { info: async () => ({}), members: async () => ({ ok: true, members: [] }), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = {
    client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const agent = new AgentManager();
  const turns: string[] = [];
  const offered: string[][] = [];
  agent.sendMessage = async (id: string) => void turns.push(id);
  const realOffer = agent.offerGuidance.bind(agent);
  agent.offerGuidance = (id, items) => {
    offered.push(items.map((i) => i.slug));
    realOffer(id, items);
  };
  const gw = createGateway(agent, t);
  stopGateway = () => gw.stop();
  let seq = 700;
  const deliver = (user: string, text: string, thread?: string) => {
    const ts = `${++seq}.1`;
    return handlers.get("message")!({
      event: { type: "message", channel: "C0TEAM", channel_type: "channel", team: "T", user, ts, ...(thread ? { thread_ts: thread } : {}), text: `<@U0BOT> ${text}` },
      client,
      context: { teamId: "T", botUserId: "U0BOT" },
    });
  };
  return { deliver, turns, posts, offered };
}

beforeEach(async () => {
  await db.run("DELETE FROM sessions");
  await db.run("DELETE FROM seen_events");
  await db.run("DELETE FROM audit_events");
  writeSoulFixture(WORLD);
  __setGrantsReader(async () => []);
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
  await applyGuardrailChange("default", { upsert: [{ slug: "inbound-care", md: GUARD, source: "file" }, { slug: "invoice-help", md: GUIDE, source: "file" }], by: "test" });
  await refreshGuardrails();
});
afterEach(async () => {
  __setGrantsReader(null);
  await stopGateway?.();
  stopGateway = null;
});

describe("inbound owner rules", () => {
  it("a deny drops the message, replies once per person per thread, and audits without the text", async () => {
    const g = setup();
    await g.deliver("U0BOB", `my password: ${SECRET}`, "100.1");
    expect(g.turns).toHaveLength(0);
    expect(g.posts).toEqual([{ kind: "ephemeral", text: "Please do not paste passwords here.", user: "U0BOB", thread: "100.1" }]);
    await g.deliver("U0BOB", `password=${SECRET} again`, "100.1");
    expect(g.turns).toHaveLength(0);
    expect(g.posts).toHaveLength(1);
    // Another person in the same thread gets their own reply.
    await g.deliver("U0CAROL", "password: x", "100.1");
    expect(g.posts).toHaveLength(2);
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; decision: string; summary: string; details: string; actor_id: string }>(
      `SELECT action, target_id, decision, summary, details, actor_id FROM audit_events WHERE action LIKE 'guardrail.inbound.%' ORDER BY id`,
    );
    expect(rows.map((r) => `${r.action}:${r.target_id}:${r.decision}:${r.actor_id}`).sort()).toEqual([
      "guardrail.inbound.denied:inbound-care#no-passwords:deny:U0BOB",
      "guardrail.inbound.denied:inbound-care#no-passwords:deny:U0BOB",
      "guardrail.inbound.denied:inbound-care#no-passwords:deny:U0CAROL",
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain("my password");
  });

  it("an audit rule lets the message on and records it; an inbound trigger hands its Guidance to the session", async () => {
    const g = setup();
    await g.deliver("U0BOB", "where does the invoice go?");
    expect(g.turns).toHaveLength(1);
    expect(g.posts.filter((p) => p.kind === "ephemeral")).toHaveLength(0);
    expect(g.offered).toEqual([["invoice-help"]]);
    await g.deliver("U0BOB", "hello there");
    expect(g.offered.at(-1)).toEqual([]);
    await flushAudits();
    const rows = await db.query<{ action: string; target_id: string; decision: string }>(`SELECT action, target_id, decision FROM audit_events WHERE action LIKE 'guardrail.inbound.%'`);
    expect(rows).toEqual([{ action: "guardrail.inbound.audited", target_id: "inbound-care#watch-invoices", decision: "allow" }]);
  });

  it("a disabled guardrail applies to nobody", async () => {
    await applyGuardrailChange("default", { setEnabled: [{ slug: "inbound-care", enabled: false }], by: "test" });
    await refreshGuardrails();
    const g = setup();
    await g.deliver("U0BOB", "password: x");
    expect(g.turns).toHaveLength(1);
  });
});

describe("the reply quiet window", () => {
  it("one reply per key per window, then again after it", () => {
    let now = 0;
    const quiet = makeReplyQuiet(() => 1000, 2, () => now);
    expect(quiet("a")).toBe(true);
    expect(quiet("a")).toBe(false);
    expect(quiet("b")).toBe(true);
    now = 1500;
    expect(quiet("a")).toBe(true);
    expect(quiet("c")).toBe(true);
  });
});

// The database is shared by every test file of the run: leave no guardrail behind.
afterAll(async () => {
  await __clearGuardrailsForTests();
  __resetGuardrailSnapshotsForTests();
});
