import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { db } from "../../../src/db/schema";

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

beforeEach(async () => {
  // Parked flows are durable now, so a leftover from another test file would
  // otherwise be picked up as this thread's pending connect.
  await db.run("DELETE FROM slack_oauth_flows");
  writeSoulFixture(WORLD);                       // manager = U0MGR, trusted = C0TEAM
  OneOnOne._wipeForTests();
  // Durable dedup: tests reuse the same channel:ts across cases on purpose.
  await db.run("DELETE FROM seen_events");
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

    // INITIATOR (U0ALICE) is not the manager, and there's no lock → global connect is
    // manager-only, so they're told to /1on1 first. No connect runs.
    const reply = posts.find((p) => String(p.text ?? "").includes("manager-only"));
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
    // Paste-back parks the flow encrypted, so this mode needs a master key.
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
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
            parts: {
              tokenEndpoint: "https://authorize.example/token",
              redirectUri,
              clientId: "cid",
              verifier: "v",
              resource: "https://workbench.example/mcp",
            },
          };
        },
        oauthExchange: async (_parts, code: string) => {
          exchangeCalls++;
          expect(code).toBe("THECODE");
          return { clientId: "cid", accessToken: "AT", refreshToken: "RT", expiresIn: 3600 };
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
    // Paste-back parks the flow encrypted, so this mode needs a master key.
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
    try {
      const { t, posts, emit } = capturingTransport();
      const agent = new AgentManager();
      agent.sendMessage = async () => {};
      let exchangeCalls = 0;
      createGateway(agent, t, {
        oauthPrepare: async ({ redirectUri }) => ({
          authorizeUrl: "https://authorize.example/x?state=GOOD",
          state: "GOOD",
          parts: {
            tokenEndpoint: "https://authorize.example/token",
            redirectUri,
            clientId: "c",
            verifier: "v",
            resource: "https://workbench.example/mcp",
          },
        }),
        oauthExchange: async () => { exchangeCalls++; return { clientId: "c", accessToken: "A" }; },
      });
      OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

      await sendInbound(emit, "/mcp connect workbench", INITIATOR, "100.6", t.client);
      await sendInbound(emit, "https://slaude.example/oauth/paste?code=X&state=BAD", INITIATOR, "100.7", t.client);

      expect(exchangeCalls).toBe(0);
      expect(posts.find((p) => String(p.text ?? "").includes("state` mismatch"))).toBeDefined();
      expect(existsSync(join(initiatorDir, ".credentials.json"))).toBe(false);

      // The mismatch message tells the person to paste the URL from the same
      // authorize step. That is only true if the flow survived the mismatch —
      // it used to be deleted before the state was even compared.
      await sendInbound(emit, "https://slaude.example/oauth/paste?code=X&state=GOOD", INITIATOR, "100.8", t.client);
      expect(exchangeCalls).toBe(1);
      expect(posts.find((p) => String(p.text ?? "").includes("connected"))).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
      else process.env.SLAUDE_OAUTH_REDIRECT_URL = prev;
    }
  });

  it("paste-back mode: a second gateway finishes a flow the first one started", async () => {
    const prev = process.env.SLAUDE_OAUTH_REDIRECT_URL;
    process.env.SLAUDE_OAUTH_REDIRECT_URL = "https://slaude.example/oauth/paste";
    process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    __resetMasterKeyCache();
    try {
      // Two gateways over one database, which is the whole topology in
      // miniature: the authorize step runs on one, the pasted callback lands on
      // the other. Before the flow was parked in the database, the second knew
      // nothing about it and the paste fell through to the model.
      const parts = {
        tokenEndpoint: "https://authorize.example/token",
        redirectUri: "https://slaude.example/oauth/paste",
        clientId: "cid",
        verifier: "v",
        resource: "https://workbench.example/mcp",
      };
      let exchangeCalls = 0;
      const opts = {
        oauthPrepare: async () => ({ authorizeUrl: "https://authorize.example/x?state=STATE123", state: "STATE123", parts }),
        oauthExchange: async (_p: any, code: string) => {
          exchangeCalls++;
          expect(code).toBe("THECODE");
          return { clientId: "cid", accessToken: "AT", refreshToken: "RT", expiresIn: 3600 };
        },
      };

      const first = capturingTransport();
      const firstAgent = new AgentManager();
      firstAgent.sendMessage = async () => {};
      createGateway(firstAgent, first.t, opts);

      const second = capturingTransport();
      const secondAgent = new AgentManager();
      secondAgent.sendMessage = async () => {};
      createGateway(secondAgent, second.t, opts);

      OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

      await sendInbound(first.emit, "/mcp connect workbench", INITIATOR, "101.1", first.t.client);
      expect(first.posts.find((p) => String(p.text ?? "").includes("authorize.example"))).toBeDefined();

      // Two gateways in one process share module state, so the handoff above
      // cannot by itself tell a database from a module-level Map. This is the
      // property that actually makes another replica able to finish the flow:
      // it is a row, and completing it removes that row.
      const FLOW_KEY = `${CHANNEL}:${THREAD}:${INITIATOR}`;
      expect(await db.query("SELECT flow_key FROM slack_oauth_flows WHERE flow_key = ?", [FLOW_KEY])).toHaveLength(1);

      await sendInbound(second.emit, "https://slaude.example/oauth/paste?code=THECODE&state=STATE123", INITIATOR, "101.2", second.t.client);

      expect(await db.query("SELECT flow_key FROM slack_oauth_flows WHERE flow_key = ?", [FLOW_KEY])).toHaveLength(0);
      expect(exchangeCalls).toBe(1);
      expect(second.posts.find((p) => String(p.text ?? "").includes("connected"))).toBeDefined();
      const creds = JSON.parse(readFileSync(join(initiatorDir, ".credentials.json"), "utf8"));
      const key = oauthKey("workbench", { type: "http", url: "https://workbench.example/mcp", headers: undefined });
      expect(creds.mcpOAuth?.[key]?.accessToken).toBe("AT");
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
      else process.env.SLAUDE_OAUTH_REDIRECT_URL = prev;
    }
  });

  it("paste-back mode: refuses to start without a master key, since the flow is parked encrypted", async () => {
    const prev = process.env.SLAUDE_OAUTH_REDIRECT_URL;
    const prevKey = process.env.SLAUDE_MASTER_KEY;
    process.env.SLAUDE_OAUTH_REDIRECT_URL = "https://slaude.example/oauth/paste";
    delete process.env.SLAUDE_MASTER_KEY;
    __resetMasterKeyCache();
    try {
      const { t, posts, emit } = capturingTransport();
      const agent = new AgentManager();
      agent.sendMessage = async () => {};
      let prepareCalls = 0;
      createGateway(agent, t, {
        oauthPrepare: async () => {
          prepareCalls++;
          throw new Error("must not register a client we cannot park");
        },
      });
      OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

      await sendInbound(emit, "/mcp connect workbench", INITIATOR, "102.1", t.client);

      expect(prepareCalls).toBe(0);
      expect(posts.find((p) => String(p.text ?? "").includes("SLAUDE_MASTER_KEY"))).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
      else process.env.SLAUDE_OAUTH_REDIRECT_URL = prev;
      if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
      else process.env.SLAUDE_MASTER_KEY = prevKey;
      __resetMasterKeyCache();
    }
  });

  it("global connect: the manager (no lock) writes the token to the AGENT config dir", async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    const agentDir = join(paths.home, "agent-cfg-test");
    mkdirSync(agentDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = agentDir;
    try {
      const { t, posts, emit } = capturingTransport();
      const agent = new AgentManager();
      agent.sendMessage = async () => {};
      createGateway(agent, t, {
        oauthConnect: async ({ postAuthorizeUrl }) => {
          await postAuthorizeUrl("https://authorize.example/g");
          return { clientId: "gcid", accessToken: "GAT", refreshToken: "GRT", expiresIn: 3600 };
        },
      });

      // No lock. The manager runs /mcp connect → global scope → agent config dir.
      await sendInbound(emit, "/mcp connect workbench", WORLD.manager, "100.9", t.client);

      expect(posts.find((p) => String(p.text ?? "").includes("connected"))).toBeDefined();
      const creds = JSON.parse(readFileSync(join(agentDir, ".credentials.json"), "utf8"));
      const key = oauthKey("workbench", { type: "http", url: "https://workbench.example/mcp", headers: undefined });
      expect(creds.mcpOAuth?.[key]?.accessToken).toBe("GAT");
      // It did NOT leak into any per-initiator dir.
      expect(existsSync(join(initiatorConfigDir(WORLD.manager), ".credentials.json"))).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      try { rmSync(initiatorConfigDir(WORLD.manager), { recursive: true, force: true }); } catch {}
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
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

    // The thread is locked to INITIATOR; even the manager is not the lock owner, so
    // /mcp here is refused (a locked thread is initiator-scoped, not global).
    const reply = posts.find((p) => String(p.text ?? "").includes("lock owner"));
    expect(reply).toBeDefined();
    expect(connectCalls).toBe(0);
  });

  it("disconnects an HTTP server for the lock initiator and removes the token", async () => {
    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    // Connect via the real gateway path so the credential is written with the
    // exact same server config (and thus the same oauthKey) disconnect uses.
    createGateway(agent, t, {
      oauthConnect: async () => ({ clientId: "cid", accessToken: "AT", refreshToken: "RT", expiresIn: 3600 }),
    });

    OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

    await sendInbound(emit, "/mcp connect workbench", INITIATOR, "100.41", t.client);
    const credPath = join(initiatorDir, ".credentials.json");
    const oauthCount = () => Object.keys(JSON.parse(readFileSync(credPath, "utf8")).mcpOAuth ?? {}).length;
    expect(oauthCount()).toBe(1);

    await sendInbound(emit, "/mcp disconnect workbench", INITIATOR, "100.42", t.client);

    expect(posts.find((p) => String(p.text ?? "").includes("Disconnected"))).toBeDefined();
    expect(oauthCount()).toBe(0);
  });

  it("disconnect of a not-connected server reports nothing to do", async () => {
    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);
    OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

    await sendInbound(emit, "/mcp disconnect workbench", INITIATOR, "100.5", t.client);

    expect(posts.find((p) => String(p.text ?? "").includes("nothing to disconnect"))).toBeDefined();
  });

  it("disconnect of an unknown server is rejected", async () => {
    const { t, posts, emit } = capturingTransport();
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    createGateway(agent, t);
    OneOnOne.lock({ channelId: CHANNEL, threadTs: THREAD, lockedUser: INITIATOR, createdBy: INITIATOR });

    await sendInbound(emit, "/mcp disconnect bogus", INITIATOR, "100.6", t.client);

    expect(posts.find((p) => String(p.text ?? "").includes("unknown HTTP MCP server"))).toBeDefined();
  });
});
