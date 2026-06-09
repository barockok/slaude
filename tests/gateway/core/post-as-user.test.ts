import { describe, it, expect } from "bun:test";
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
});
