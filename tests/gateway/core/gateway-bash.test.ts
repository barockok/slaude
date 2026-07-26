import { describe, it, expect, beforeEach } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { db } from "../../../src/db/schema";

function makeTransport() {
  const posts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client = {
    auth: { test: async () => ({ user_id: "UBOTTEST", bot_id: "BBOTTEST", team: "T", url: "x" }) },
    chat: {
      postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: `${Date.now()}.0` }; },
      update: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  } as any;
  const t: Transport = {
    client,
    action: () => {},
    event: (name: string, fn: any) => handlers.set(name, fn),
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const emit = async (args: any) => handlers.get("message")?.(args);
  return { t, client, posts, emit };
}

let counter = 9000;
const nextTs = () => `${++counter}.1`;

function msgArgs(client: any, text: string, userId: string, channel = "D_TEST", channelType = "im") {
  return {
    event: { type: "message", channel, channel_type: channelType, user: userId, team: "T", ts: nextTs(), text },
    client,
    context: { teamId: "T" },
  };
}

beforeEach(() => {
  db.run("DELETE FROM sessions");
  writeSoulFixture(WORLD);
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
});

describe("gateway /bash command", () => {
  it("non-manager is denied (trusted channel, bot mentioned, bash still rejects)", async () => {
    const { t, client, posts, emit } = makeTransport();
    createGateway(new AgentManager(), t);
    // UBOTTEST is the bot's user_id (auth.test returns user_id="UBOTTEST").
    // Channel messages only route to handleMessage when the bot is @-mentioned.
    // NOTE: Slack user IDs must be [A-Z0-9]+ — no underscores — so the gateway's
    // mention regex matches correctly.
    await emit(msgArgs(client, "<@UBOTTEST> /bash whoami", "UMEMBER", WORLD.trusted[0]!, "channel"));
    expect(posts.some((p) => /manager-only/i.test(p.text ?? ""))).toBe(true);
  });

  it("manager runs a command and gets output", async () => {
    const { t, client, posts, emit } = makeTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);

    await emit(msgArgs(client, "/bash echo hello-from-bash", WORLD.manager));

    const reply = posts.find((p) => /echo hello-from-bash/.test(p.text ?? ""));
    expect(reply).toBeDefined();
    expect(reply.text).toContain("hello-from-bash");
    expect(reply.text).toContain("exit 0");
  });

  it("exit code is reported on failure", async () => {
    const { t, client, posts, emit } = makeTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);

    await emit(msgArgs(client, "/bash exit 42", WORLD.manager));

    const reply = posts.find((p) => /exit 42/.test(p.text ?? ""));
    expect(reply).toBeDefined();
  });

  it("decodes Slack URL encoding before running", async () => {
    const { t, client, posts, emit } = makeTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);

    // Slack encodes https://example.com as <https://example.com|example.com>
    await emit(msgArgs(client, "/bash echo <https://example.com|example.com>", WORLD.manager));

    const reply = posts.find((p) => /echo https/.test(p.text ?? ""));
    expect(reply).toBeDefined();
    // The decoded URL, not the raw Slack markup, appears in the output header
    expect(reply.text).toContain("https://example.com");
    expect(reply.text).not.toContain("<https://");
  });

  it("backup manager can also run commands", async () => {
    const { t, client, posts, emit } = makeTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);

    await emit(msgArgs(client, "/bash echo backup-ok", WORLD.backup!));

    expect(posts.some((p) => /backup-ok/.test(p.text ?? ""))).toBe(true);
  });
});
