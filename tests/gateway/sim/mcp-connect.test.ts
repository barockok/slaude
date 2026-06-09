import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo } from "../../../src/soul/extract";
import { paths } from "../../../src/config/home";
import * as OneOnOne from "../../../src/db/one-on-one";
import { initiatorConfigDir } from "../../../src/agent/oauth-home";
import { oauthKey, type OAuthServerConfig } from "../../../src/agent/mcp-oauth/store";

/** Transport that records `chat.postMessage` and captures registered event/action
 *  handlers so a test can drive an inbound Slack message through the gateway. */
function capturingTransport(): { t: Transport; posts: any[]; emit: (name: string, args: any) => Promise<void> } {
  const posts: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    } as any,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, posts, emit };
}

const TEAM = "T";
const CHANNEL = "C0TEAM";        // a trusted channel in WORLD (anyone heard)
const THREAD = "100.0";
const INITIATOR = "U0ALICE";

function inbound(text: string, user: string, ts: string, client: any) {
  return {
    event: { type: "message", channel: CHANNEL, channel_type: "channel", user, team: TEAM, ts, thread_ts: THREAD, text: `<@U_SLAUDE> ${text}` },
    client,
    context: { teamId: TEAM },
  };
}

/** Drive a thread message the way Slack does: app_mention engages the thread, then
 *  the message event runs the gateway. The bot id (U_SLAUDE) carries an underscore,
 *  so the plain `<@id>` mention-regex won't engage on its own — app_mention does. */
async function sendInbound(emit: (n: string, a: any) => Promise<void>, text: string, user: string, ts: string, client: any) {
  const args = inbound(text, user, ts, client);
  await emit("app_mention", { ...args, event: { ...args.event, type: "app_mention" } });
  await emit("message", args);
}

const mcpJsonPath = join(paths.home, ".mcp.json");
const initiatorDir = initiatorConfigDir(INITIATOR);

beforeEach(() => {
  writeSoulFixture(WORLD);                       // manager = U0MGR, trusted = C0TEAM
  OneOnOne._wipeForTests();
  writeFileSync(mcpJsonPath, JSON.stringify({
    mcpServers: { workbench: { type: "http", url: "https://workbench.example/mcp" } },
  }), "utf8");
});

afterEach(() => {
  OneOnOne._wipeForTests();
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
  try { rmSync(mcpJsonPath, { force: true }); } catch {}
  try { rmSync(initiatorDir, { recursive: true, force: true }); } catch {}
});

describe("/mcp gating + connect", () => {
  it("rejects /mcp when the thread has no 1on1 lock and runs no connect", async () => {
    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    let connectCalls = 0;
    createGateway(agent, t, { oauthConnect: async () => { connectCalls++; return { clientId: "x", accessToken: "x" }; } });

    await sendInbound(emit, "/mcp", INITIATOR, "100.1", t.client);

    const reply = posts.find((p) => String(p.text ?? "").includes("requires a 1on1 lock"));
    expect(reply).toBeDefined();
    expect(connectCalls).toBe(0);
  });

  it("connects an HTTP server for the lock initiator and writes the token to their config store", async () => {
    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};

    let postedAuthorize = "";
    createGateway(agent, t, {
      oauthConnect: async ({ postAuthorizeUrl }) => {
        await postAuthorizeUrl("https://authorize.example/x");
        return { clientId: "cid", accessToken: "AT", refreshToken: "RT", expiresIn: 3600 };
      },
    });
    // Find the authorize URL the gateway posted.
    // (captured via posts below.)

    // Lock the thread to the initiator (seed directly, equivalent to /1on1).
    OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

    await sendInbound(emit, "/mcp connect workbench", INITIATOR, "100.2", t.client);

    const authPost = posts.find((p) => String(p.text ?? "").includes("https://authorize.example/x"));
    expect(authPost).toBeDefined();
    postedAuthorize = String(authPost.text);
    expect(postedAuthorize).toContain("workbench");

    const okPost = posts.find((p) => String(p.text ?? "").includes("connected"));
    expect(okPost).toBeDefined();

    // The token landed in the INITIATOR's isolated config store under the CLI's key.
    const credPath = join(initiatorDir, ".credentials.json");
    expect(existsSync(credPath)).toBe(true);
    const creds = JSON.parse(readFileSync(credPath, "utf8"));
    const cfg: OAuthServerConfig = { type: "http", url: "https://workbench.example/mcp", headers: undefined };
    const key = oauthKey("workbench", cfg);
    expect(creds.mcpOAuth?.[key]).toBeDefined();
    expect(creds.mcpOAuth[key].accessToken).toBe("AT");
    expect(creds.mcpOAuth[key].refreshToken).toBe("RT");
    expect(creds.mcpOAuth[key].clientId).toBe("cid");
  });

  it("paste-back mode: posts the authorize URL, then completes on a pasted callback", async () => {
    const prev = process.env.SLAUDE_OAUTH_REDIRECT_URL;
    process.env.SLAUDE_OAUTH_REDIRECT_URL = "https://slaude.example/oauth/paste";
    try {
      const { t, posts, emit } = capturingTransport();
      const agent = new AgentManager();
      agent.sendMessage = async () => {};

      let prepareCalls = 0;
      let exchangeCalls = 0;
      createGateway(agent, t, {
        oauthPrepare: async ({ redirectUri }) => {
          prepareCalls++;
          return {
            authorizeUrl: `https://authorize.example/x?redirect_uri=${encodeURIComponent(redirectUri)}&state=STATE123`,
            state: "STATE123",
            exchange: async (code: string) => { exchangeCalls++; expect(code).toBe("THECODE"); return { clientId: "cid", accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }; },
          };
        },
      });

      OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

      // 1) start connect → posts authorize URL + paste instructions, NO token yet.
      await sendInbound(emit, "/mcp connect workbench", INITIATOR, "100.4", t.client);
      expect(prepareCalls).toBe(1);
      const authPost = posts.find((p) => String(p.text ?? "").includes("authorize.example"));
      expect(authPost).toBeDefined();
      expect(String(authPost.text)).toMatch(/[Pp]aste/);
      expect(existsSync(join(initiatorDir, ".credentials.json"))).toBe(false);

      // 2) initiator pastes the callback URL → exchange + write + connected.
      await sendInbound(emit, "https://slaude.example/oauth/paste?code=THECODE&state=STATE123", INITIATOR, "100.5", t.client);
      expect(exchangeCalls).toBe(1);
      const okPost = posts.find((p) => String(p.text ?? "").includes("connected"));
      expect(okPost).toBeDefined();

      const creds = JSON.parse(readFileSync(join(initiatorDir, ".credentials.json"), "utf8"));
      const key = oauthKey("workbench", { type: "http", url: "https://workbench.example/mcp", headers: undefined });
      expect(creds.mcpOAuth?.[key]?.accessToken).toBe("AT");
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
      else process.env.SLAUDE_OAUTH_REDIRECT_URL = prev;
    }
  });

  it("paste-back mode: rejects a state mismatch and writes nothing", async () => {
    const prev = process.env.SLAUDE_OAUTH_REDIRECT_URL;
    process.env.SLAUDE_OAUTH_REDIRECT_URL = "https://slaude.example/oauth/paste";
    try {
      const { t, posts, emit } = capturingTransport();
      const agent = new AgentManager();
      agent.sendMessage = async () => {};
      let exchangeCalls = 0;
      createGateway(agent, t, {
        oauthPrepare: async () => ({
          authorizeUrl: "https://authorize.example/x?state=GOOD",
          state: "GOOD",
          exchange: async () => { exchangeCalls++; return { clientId: "c", accessToken: "A" }; },
        }),
      });
      OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

      await sendInbound(emit, "/mcp connect workbench", INITIATOR, "100.6", t.client);
      await sendInbound(emit, "https://slaude.example/oauth/paste?code=X&state=BAD", INITIATOR, "100.7", t.client);

      expect(exchangeCalls).toBe(0);
      expect(posts.find((p) => String(p.text ?? "").includes("state` mismatch"))).toBeDefined();
      expect(existsSync(join(initiatorDir, ".credentials.json"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
      else process.env.SLAUDE_OAUTH_REDIRECT_URL = prev;
    }
  });

  it("rejects /mcp from a non-initiator in an initiator-locked thread and runs no connect", async () => {
    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    let connectCalls = 0;
    createGateway(agent, t, { oauthConnect: async () => { connectCalls++; return { clientId: "x", accessToken: "x" }; } });

    // Thread is locked to INITIATOR, but the manager (heard in the thread via the
    // manager exception, so reaches slash parsing) is NOT the lock owner.
    OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

    await sendInbound(emit, "/mcp connect workbench", WORLD.manager, "100.3", t.client);

    const reply = posts.find((p) => String(p.text ?? "").includes("requires a 1on1 lock"));
    expect(reply).toBeDefined();
    expect(connectCalls).toBe(0);
  });
});
