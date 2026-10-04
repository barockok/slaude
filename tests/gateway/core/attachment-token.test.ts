/**
 * D1.1: the bot token for attachment downloads comes from the app the event
 * belongs to, and is read only when there are files. In HTTP mode there is no
 * SLACK_BOT_TOKEN in the environment, so reading it per message threw and
 * dropped every message.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { db } from "../../../src/db/schema";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

const saved = { token: process.env.SLACK_BOT_TOKEN, mode: process.env.SLAUDE_SLACK_MODE, fetch: globalThis.fetch };

function setup() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  createGateway(agent, t);
  const dm = (ts: string, files: any[] | undefined, context: any) =>
    handlers.get("message")!({
      event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts, text: "hello", ...(files ? { files } : {}) },
      client: t.client,
      context,
    });
  return { sends, dm };
}

describe("attachment download token", () => {
  let auths: string[];
  beforeEach(async () => {
    await db.run("DELETE FROM sessions");
    await db.run("DELETE FROM seen_events");
    writeSoulFixture(WORLD);
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLAUDE_SLACK_MODE = "http";
    auths = [];
    globalThis.fetch = (async (_u: any, init: any) => {
      auths.push(String(init?.headers?.Authorization));
      return new Response("file-bytes");
    }) as any;
  });
  afterEach(() => {
    if (saved.token === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved.token;
    if (saved.mode === undefined) delete process.env.SLAUDE_SLACK_MODE;
    else process.env.SLAUDE_SLACK_MODE = saved.mode;
    globalThis.fetch = saved.fetch;
  });

  it("HTTP mode, no files, no SLACK_BOT_TOKEN: the message is still handled", async () => {
    const g = setup();
    await g.dm("900.1", undefined, { teamId: "T", botToken: "xoxb-app-two" });
    expect(g.sends.length).toBe(1);
    expect(auths).toEqual([]);
  });

  it("HTTP mode with files downloads with the event app's own token", async () => {
    const g = setup();
    const f = { id: "F1", name: "a.txt", url_private: "https://files.example.com/a.txt", size: 10, mimetype: "text/plain" };
    await g.dm("900.2", [f], { teamId: "T", botToken: "xoxb-app-two" });
    expect(auths).toEqual(["Bearer xoxb-app-two"]);
    expect(g.sends[0]).toContain("a.txt");
  });

  it("HTTP mode with files but no token on the context skips the download instead of using the environment", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-env-should-not-be-used";
    const g = setup();
    const f = { id: "F2", name: "b.txt", url_private: "https://files.example.com/b.txt", size: 10, mimetype: "text/plain" };
    await g.dm("900.3", [f], { teamId: "T" });
    expect(auths).toEqual([]);
    expect(g.sends.length).toBe(1);
  });

  it("Socket Mode falls back to the environment token", async () => {
    process.env.SLAUDE_SLACK_MODE = "socket";
    process.env.SLACK_BOT_TOKEN = "xoxb-env-token";
    const g = setup();
    const f = { id: "F3", name: "c.txt", url_private: "https://files.example.com/c.txt", size: 10, mimetype: "text/plain" };
    await g.dm("900.4", [f], { teamId: "T" });
    expect(auths).toEqual(["Bearer xoxb-env-token"]);
  });
});
