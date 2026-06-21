import { describe, it, expect, afterEach } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { metrics } from "../../../src/metrics";

/** Capture the registered Slack event handlers so a test can drive them directly. */
function captureTransport() {
  const handlers: Record<string, (args: any) => any> = {};
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_BOT", bot_id: "B_BOT", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {},
    event: (name: string, h: any) => { handlers[name] = h; },
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  return { t, handlers };
}

/** Outbound user-token client: its auth.test reports the agent's *user* id. */
function fakeUserClient() {
  return {
    auth: { test: async () => ({ user_id: "U_AGENT", bot_id: undefined, team: "T" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "2.2" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Agent" } }) },
  } as any;
}

function dropCount(reason: string): number {
  const line = metrics.render().split("\n").find((l) => l.includes("slaude_slack_drops_total") && l.includes(`reason="${reason}"`));
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).pop());
}

describe("post-as-user self-echo loop guard", () => {
  it("drops a plain message authored by the agent's own user id (no bot_id)", async () => {
    const { t, handlers } = captureTransport();
    createGateway(new AgentManager(), t, { outClient: fakeUserClient() });

    const before = dropCount("self_user");
    // The agent's own post arrives as a normal user message: real user id, no bot_id.
    await handlers["message"]!({
      event: { type: "message", channel: "C1", ts: "10.0", user: "U_AGENT", text: "hi from agent" },
      context: { teamId: "T" },
    });
    expect(dropCount("self_user")).toBe(before + 1);
  });

  it("does NOT drop a message from a different real user", async () => {
    const { t, handlers } = captureTransport();
    createGateway(new AgentManager(), t, { outClient: fakeUserClient() });

    const before = dropCount("self_user");
    await handlers["message"]!({
      event: { type: "message", channel: "C1", ts: "11.0", user: "U_HUMAN", text: "hello" },
      context: { teamId: "T" },
    });
    expect(dropCount("self_user")).toBe(before);
  });

  it("drops a self-user echo arriving via app_mention (handleMessage guard)", async () => {
    const { t, handlers } = captureTransport();
    createGateway(new AgentManager(), t, { outClient: fakeUserClient() });

    const before = dropCount("self_user");
    // An app_mention engages first, then defers to handleMessage — whose own
    // self-user guard must also drop the agent's own post.
    await handlers["app_mention"]!({
      event: { type: "app_mention", channel: "C1", ts: "12.0", user: "U_AGENT", text: "<@U_AGENT> loop" },
      context: { teamId: "T" },
    });
    expect(dropCount("self_user")).toBe(before + 1);
  });

  it("when the user-token auth.test fails, resolves to null and drops nothing", async () => {
    const { t, handlers } = captureTransport();
    const throwingClient = {
      auth: { test: async () => { throw Object.assign(new Error("invalid_auth"), { data: { error: "invalid_auth" } }); } },
      chat: { postMessage: async () => ({ ok: true, ts: "3.3" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Agent" } }) },
    } as any;
    createGateway(new AgentManager(), t, { outClient: throwingClient });

    const before = dropCount("self_user");
    // getSelfUserId() catches the auth.test failure → null → no self-echo guard.
    await handlers["message"]!({
      event: { type: "message", channel: "C1", ts: "13.0", user: "U_AGENT", text: "hi" },
      context: { teamId: "T" },
    });
    expect(dropCount("self_user")).toBe(before);
  });
});

describe("post-as-user env wiring", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ["SLACK_POST_AS_USER", "SLACK_USER_TOKEN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("warns and stays on the bot when SLACK_POST_AS_USER=true but no user token", () => {
    saved.SLACK_POST_AS_USER = process.env.SLACK_POST_AS_USER;
    saved.SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
    process.env.SLACK_POST_AS_USER = "true";
    delete process.env.SLACK_USER_TOKEN;
    process.env.SLACK_BOT_TOKEN ||= "xoxb-test";

    const { t } = captureTransport();
    // No outClient + flag on + token unset → postsAsUser false, warn branch fires.
    // Constructing without throwing exercises the fallback path.
    expect(() => createGateway(new AgentManager(), t)).not.toThrow();
  });
});
