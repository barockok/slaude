import { describe, it, expect, afterEach, setSystemTime } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createGateway, type GatewayHandle, type GatewayOptions } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import type { Surface, SessionBinding } from "../../../src/gateway/core/surface";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as OneOnOne from "../../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { paths } from "../../../src/config/home";
import { KB_MCP_NAME } from "../../../src/knowledge/mcp-tools";

// ————————————————————————————————————————————————————————————————————————————
// Harness: a transport that records posts AND captures event/action/use hooks,
// extending the gateway-seam.test.ts pattern with action + middleware capture.
// ————————————————————————————————————————————————————————————————————————————

type Rich = ReturnType<typeof richTransport>;

function richTransport(o: { botUserId?: string; authThrows?: boolean } = {}) {
  const posts: any[] = [];
  const edits: any[] = [];
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const actions: { pattern: RegExp | string; fn: any }[] = [];
  const middlewares: any[] = [];
  const client = {
    auth: {
      test: async () => {
        if (o.authThrows) throw new Error("boom-auth");
        return { user_id: o.botUserId ?? "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" };
      },
    },
    chat: {
      postMessage: async (a: any) => { const ts = `${Date.now()}.${posts.length}`; posts.push({ ...a, ts }); return { ok: true, ts }; },
      update: async (a: any) => { edits.push(a); return { ok: true }; },
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  } as any;
  const t: Transport = {
    client,
    action: (pattern: any, fn: any) => actions.push({ pattern, fn }),
    event: (name: string, fn: any) => handlers.set(name, fn),
    use: (fn: any) => middlewares.push(fn),
    start: async () => {},
    stop: async () => {},
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  const emitAction = async (actionId: string, userId: string) => {
    for (const { pattern, fn } of actions) {
      const hit = typeof pattern === "string" ? pattern === actionId : pattern.test(actionId);
      if (hit) await fn({ ack: async () => {}, action: { action_id: actionId }, body: { user: { id: userId } }, respond: async () => {} });
    }
  };
  return { t, client, posts, edits, emit, emitAction, middlewares };
}

function makeGw(o: { transport?: Rich; gwOpts?: GatewayOptions; agent?: AgentManager } = {}) {
  process.env.SLACK_BOT_TOKEN ||= "xoxb-test";
  const cap = o.transport ?? richTransport();
  const agent = o.agent ?? new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (_id: string, txt: string) => { sends.push(txt); };
  const h: GatewayHandle = createGateway(agent, cap.t, o.gwOpts);
  return { ...cap, agent, sends, h };
}

let tsCounter = 7000;
const nextTs = () => `${++tsCounter}.1`;

const dmArgs = (g: { client: any }, text: string, opts: { ts?: string; user?: string; channel?: string; thread_ts?: string; files?: any[]; bot_id?: string } = {}) => ({
  event: {
    type: "message",
    channel: opts.channel ?? "D_MGR",
    channel_type: "im",
    user: opts.user ?? WORLD.manager,
    team: "T",
    ts: opts.ts ?? nextTs(),
    ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    ...(opts.bot_id ? { bot_id: opts.bot_id } : {}),
    text,
  },
  client: g.client,
  context: { teamId: "T" },
});

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
};

// Fake OAuth IdP: discovery (401 challenge → PRM → AS metadata), dynamic client
// registration, and a token endpoint that can be toggled to fail.
function startIdp() {
  const state = { failToken: false };
  // Explicit annotation breaks the circular inference: `fetch` reads `server.port`.
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/prm"` },
        });
      }
      if (url.pathname === "/prm") return Response.json({ authorization_servers: [`${base}/as`] });
      if (url.pathname === "/as/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
        });
      }
      if (url.pathname === "/register") return Response.json({ client_id: "cid-test" });
      if (url.pathname === "/token") {
        if (state.failToken) return new Response("{}", { status: 500 });
        return Response.json({ access_token: "atk", refresh_token: "rtk", expires_in: 3600 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { server, state, url: (p: string) => `http://127.0.0.1:${server.port}${p}` };
}

const mcpJsonPath = join(paths.home, ".mcp.json");
function writeMcpJson(servers: Record<string, any>) {
  writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: servers }), "utf8");
}

const fakeSurfaceFactory =
  (sink?: { binding?: SessionBinding; approvals: any[] }) =>
  (b: SessionBinding): Surface => {
    if (sink) sink.binding = b;
    return {
      id: "fake",
      capabilities: new Set([]),
      reply: async () => ({ ref: "r1" }),
      getHistory: async () => ({ messages: [], hasMore: false }),
      requestApproval: async (r) => {
        sink?.approvals.push(r);
        return { approved: false, by: "fake" };
      },
    };
  };

afterEach(() => {
  rmSync(mcpJsonPath, { force: true });
  delete process.env.SLAUDE_OAUTH_REDIRECT_URL;
  delete process.env.SLAUDE_METRICS_PER_USER;
  delete process.env.SLAUDE_BRAIN_DISABLED;
  setSystemTime(); // reset any time travel
  OneOnOne._wipeForTests();
  db.run("DELETE FROM cron_jobs");
  db.run("DELETE FROM soul_overrides");
  // The /mcp connect flows persist OAuth tokens to the agent config dir and to
  // per-initiator config homes. Scrub them so credential residue doesn't leak
  // into other files' tests (e.g. mcp-connect's "no per-initiator leak" assert).
  rmSync(join(paths.claudeConfig, ".credentials.json"), { force: true });
  rmSync(join(paths.home, "oauth"), { recursive: true, force: true });
});

// ————————————————————————————————————————————————————————————————————————————

describe("gateway uncovered branches", () => {
  it("binding getters expose the live SlackContext (surfaceFactory seam)", async () => {
    writeSoulFixture(WORLD);
    const sink: { binding?: SessionBinding; approvals: any[] } = { approvals: [] };
    const g = makeGw({ gwOpts: { surfaceFactory: fakeSurfaceFactory(sink) } });
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hello", { ts }));
    expect(g.sends.length).toBe(1);
    const b = sink.binding!;
    expect(b.conversationId).toBe("D_MGR");
    expect(b.threadRef).toBe(ts);
    expect(b.inboundRef).toBe(ts);
    expect(b.userId).toBe(WORLD.manager);
    expect(b.teamId).toBe("T");
    expect(typeof b.reloadSession()).toBe("boolean");
  });

  it("5-minute cleanup interval prunes expired pendingPaste entries", async () => {
    writeSoulFixture(WORLD);
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    const real = globalThis.setInterval;
    const captured: { fn: Function; ms: number }[] = [];
    (globalThis as any).setInterval = (fn: any, ms: any) => { captured.push({ fn, ms }); return 0 as any; };
    try {
      makeGw();
    } finally {
      globalThis.setInterval = real;
    }
    const cleanup = captured.find((c) => c.ms === 5 * 60 * 1000);
    expect(cleanup).toBeDefined();
    cleanup!.fn(); // runs the ignore-cleanup import + pendingPaste sweep
    await new Promise((r) => setTimeout(r, 20));
  });

  it("cron-session ctx.requestApproval routes through the ApprovalGate", async () => {
    writeSoulFixture(WORLD);
    db.run("DELETE FROM cron_jobs");
    const job = CronJobs.create({
      slackTeamId: "T",
      slackChannelId: "C0TEAM",
      channelId: "C0TEAM",
      createdBy: WORLD.manager,
      cronExpr: "* * * * *",
      prompt: "tick",
      nextRunAt: Date.now() - 1000,
      target: "channel",
    });
    const g = makeGw();
    // scheduler.start() runs the due job through onExecute synchronously-ish
    await new Promise((r) => setTimeout(r, 80));
    const session = g.agent.ensureSession({ team_id: "T", channel_id: "C0TEAM", thread_ts: `cron:${job.id}` });
    const servers = g.h.__resolveMcp(session.id);
    expect(servers).toBeDefined();
    const ctx = g.h.__sessionCtx(session.id)!;
    expect(ctx).toBeDefined();
    const decision = ctx.slack.requestApproval!({ summary: "cron wants something" });
    await waitFor(() => g.posts.some((p) => String(p.text).includes("Approval needed")));
    const apprPost = g.posts.find((p) => String(p.text).includes("Approval needed"));
    const actionsBlock = apprPost.blocks.find((b: any) => b.type === "actions");
    const denyId = actionsBlock.elements.find((e: any) => e.action_id.includes("deny")).action_id;
    await g.emitAction(denyId, WORLD.approvers[0]!);
    const d = await decision;
    expect(d.approved).toBe(false);
  });

  it("startup auth.test diagnostic failure is caught", async () => {
    writeSoulFixture(WORLD);
    const cap = richTransport({ authThrows: true });
    makeGw({ transport: cap });
    await new Promise((r) => setTimeout(r, 20)); // flush the void async diag
  });

  it("stop guard: blocks silent stop, passes after a user-visible tool, ignores unknown sessions", async () => {
    writeSoulFixture(WORLD);
    const agent = new AgentManager();
    let guard: ((id: string) => string | null) | undefined;
    const orig = agent.setStopGuard.bind(agent);
    agent.setStopGuard = ((fn: any) => { guard = fn; orig(fn); }) as any;
    const g = makeGw({ agent });
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hello", { ts }));
    const session = g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });

    expect(guard!("no-such-session")).toBeNull();
    expect(typeof guard!(session.id)).toBe("string"); // hasn't spoken yet

    // user-visible tool → spoke
    g.agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_surface__reply", input: {} } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(guard!(session.id)).toBeNull();

    // non-user-visible tool → humanized status path (incl. slack thread history case)
    g.agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_slack__get_thread_history", input: {} } as any);
    g.agent.emit("event", { type: "toolCall", sessionId: session.id, tool: "mcp__slaude_surface__react", input: { name: "eyes" } } as any);
    await new Promise((r) => setTimeout(r, 10));
  });

  it("KB MCP deps evaluate gate/scope/managers from the live route (brain enabled)", async () => {
    writeSoulFixture(WORLD);
    const sink: { binding?: SessionBinding; approvals: any[] } = { approvals: [] };
    const g = makeGw({ gwOpts: { surfaceFactory: fakeSurfaceFactory(sink) } });
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hello kb", { ts }));
    const session = g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });
    const servers = g.h.__resolveMcp(session.id)!;
    const kb: any = servers[KB_MCP_NAME];
    expect(kb?.instance).toBeDefined();

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await kb.instance.connect(st);
    const client = new Client({ name: "t", version: "0.0.0" });
    await client.connect(ct);

    // kb_memoize → gatedBrainCall evaluates scope() (brainGateFor), gate(),
    // managers() eagerly; manager in a DM (restricted trust) → approval tier →
    // our fake surface denies → tool returns the denial reason without touching gbrain.
    const res: any = await client.callTool({
      name: "kb_memoize",
      arguments: { pages: [{ slug: "test-page", content: "x", summary: "test write" }] },
    });
    expect(res.isError).toBe(true);
    expect(sink.approvals.length).toBe(1);
    await client.close();
  });

  it("brain disabled → KB MCP mounts without deps (undefined branch)", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    const ts = nextTs();
    await g.emit("message", dmArgs(g, "hi", { ts }));
    const session = g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    const servers = g.h.__resolveMcp(session.id)!;
    expect(servers[KB_MCP_NAME]).toBeDefined();
  });

  it("self bot echo is dropped inside handleMessage (app_mention path)", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    const args = dmArgs(g, "echo", { bot_id: "B_SLAUDE" });
    (args.event as any).type = "app_mention";
    await g.emit("app_mention", args);
    expect(g.sends.length).toBe(0);
  });

  it("agent.sendMessage throwing is caught", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    g.agent.sendMessage = async () => { throw new Error("send-boom"); };
    await g.emit("message", dmArgs(g, "hello"));
    // no throw — error logged and swallowed
  });

  it("/1on1 off with no active lock replies 'No active 1on1'", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    await g.emit("message", dmArgs(g, "/1on1 off"));
    expect(g.posts.some((p) => String(p.text).includes("No active 1on1"))).toBe(true);
  });

  it("/soul with an invalid id replies the validation reason", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    await g.emit("message", dmArgs(g, "/soul trust add notachannel"));
    expect(g.posts.some((p) => String(p.text).includes("not a valid channel"))).toBe(true);
  });

  it("/soul list renders base + runtime + masked; /soul clear all reverts; empty world says so", async () => {
    writeSoulFixture(WORLD);
    db.run("DELETE FROM soul_overrides");
    const g = makeGw();
    await g.emit("message", dmArgs(g, "/soul dm add <@U0EXTRA>"));
    await g.emit("message", dmArgs(g, "/soul allow remove C0PUB"));
    await g.emit("message", dmArgs(g, "/soul list"));
    const listing = g.posts.find((p) => String(p.text).includes("soul runtime overrides"));
    expect(listing).toBeDefined();
    expect(String(listing.text)).toContain("+runtime");
    expect(String(listing.text)).toContain("−masked");

    await g.emit("message", dmArgs(g, "/soul clear all"));
    expect(g.posts.some((p) => String(p.text).includes("overrides cleared"))).toBe(true);
    const { list } = await import("../../../src/db/soul-overrides");
    expect(list().length).toBe(0);

    // Empty ACL world → "no overrides, no soul ACL entries"
    writeSoulFixture({ manager: WORLD.manager, approvers: [], trusted: [], allowed: [] });
    await g.emit("message", dmArgs(g, "/soul list"));
    const empty = g.posts.filter((p) => String(p.text).includes("soul runtime overrides")).at(-1);
    expect(String(empty.text)).toContain("no overrides, no soul ACL entries");
    writeSoulFixture(WORLD);
  });

  it("/ignore-thread, /unignore-thread, /unignore @user round-trip", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    await g.emit("message", dmArgs(g, "/ignore-thread 10m"));
    expect(g.posts.some((p) => String(p.text).includes("ignoring this thread for 10m"))).toBe(true);
    await g.emit("message", dmArgs(g, "/unignore-thread"));
    expect(g.posts.some((p) => String(p.text).includes("stopped ignoring this thread"))).toBe(true);
    await g.emit("message", dmArgs(g, "/ignore <@U0NOISY> 5m"));
    await g.emit("message", dmArgs(g, "/unignore <@U0NOISY>"));
    expect(g.posts.some((p) => String(p.text).includes("stopped ignoring <@U0NOISY>"))).toBe(true);
  });

  it("skill invocation rewrites the user text via buildSkillInvocation", async () => {
    writeSoulFixture(WORLD);
    const dir = join(paths.skills, "branchskill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: branchskill\ndescription: test skill\n---\nDo the thing with ${SLAUDE_SKILL_ARGS}\n", "utf8");
    try {
      const g = makeGw();
      await g.emit("message", dmArgs(g, "/branchskill now please"));
      expect(g.sends.length).toBe(1);
      expect(g.sends[0]!).toContain("now please");
      expect(g.sends[0]!).not.toContain("/branchskill now please");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("per-user metrics counter increments when SLAUDE_METRICS_PER_USER=1", async () => {
    writeSoulFixture(WORLD);
    process.env.SLAUDE_METRICS_PER_USER = "1";
    const g = makeGw();
    await g.emit("message", dmArgs(g, "count me"));
    expect(g.sends.length).toBe(1);
  });

  it("file attachments are downloaded and wrapped in <attachment> blocks", async () => {
    writeSoulFixture(WORLD);
    const fileServer = Bun.serve({ port: 0, fetch: async () => new Response("hello attachment") });
    try {
      const g = makeGw();
      await g.emit("message", dmArgs(g, "see the file", {
        files: [{ id: "F1", name: "no tes.txt", mimetype: "text/plain", size: 16, url_private: `http://127.0.0.1:${fileServer.port}/f` }],
      }));
      expect(g.sends.length).toBe(1);
      expect(g.sends[0]!).toContain("<attachment name=\"no_tes.txt\"");
      expect(g.sends[0]!).toContain("User attached 1 file(s)");
    } finally {
      fileServer.stop(true);
    }
  });

  it("bolt diag middleware logs payloads (with and without fields)", async () => {
    writeSoulFixture(WORLD);
    const g = makeGw();
    expect(g.middlewares.length).toBe(1);
    let nexted = 0;
    await g.middlewares[0]!({ payload: { type: "message", subtype: "x", channel: "C", ts: "1" }, next: async () => { nexted++; } });
    await g.middlewares[0]!({ payload: undefined, next: async () => { nexted++; } });
    expect(nexted).toBe(2);
  });

  it("message-event bot mention engages + handles (bot id without underscore)", async () => {
    writeSoulFixture(WORLD);
    const cap = richTransport({ botUserId: "UBOT99" });
    const g = makeGw({ transport: cap });
    await g.emit("message", {
      event: { type: "message", channel: "C0TEAM", channel_type: "channel", user: "U0RANDO", team: "T", ts: nextTs(), text: "<@UBOT99> hi there" },
      client: g.client,
      context: { teamId: "T" },
    });
    expect(g.sends.length).toBe(1);
  });

  describe("/mcp connect & status", () => {
    it("/mcp disabled by the store-format canary", async () => {
      writeSoulFixture(WORLD);
      const g = makeGw({ gwOpts: { mcpConnectEnabled: false } });
      await g.emit("message", dmArgs(g, "/mcp"));
      expect(g.posts.some((p) => String(p.text).includes("temporarily disabled"))).toBe(true);
    });

    it("/mcp connect with an unknown server warns", async () => {
      writeSoulFixture(WORLD);
      const g = makeGw();
      await g.emit("message", dmArgs(g, "/mcp connect nosuch"));
      expect(g.posts.some((p) => String(p.text).includes("unknown HTTP MCP server"))).toBe(true);
    });

    it("/mcp status: session not booted, empty list, and connect buttons + click guards", async () => {
      writeSoulFixture(WORLD);
      writeMcpJson({ svc: { type: "http", url: "http://127.0.0.1:1/mcp" } });
      const tokens = { clientId: "c", accessToken: "a", expiresIn: 60 };
      let connects = 0;
      const g = makeGw({ gwOpts: { oauthConnect: async () => { connects++; return tokens; } } });
      mkdirSync(paths.claudeConfig, { recursive: true });

      // 1) statuses === null → boot hint
      g.agent.mcpServerStatus = async () => null;
      await g.emit("message", dmArgs(g, "/mcp"));
      expect(g.posts.some((p) => String(p.text).includes("Send a message in this thread first"))).toBe(true);

      // 2) empty statuses → "(no MCP servers mounted)", no buttons
      g.agent.mcpServerStatus = async () => [];
      await g.emit("message", dmArgs(g, "/mcp"));
      const emptyCard = g.posts.filter((p) => p.blocks).at(-1);
      expect(JSON.stringify(emptyCard.blocks)).toContain("no MCP servers mounted");

      // 3) non-connected http server → Connect button
      g.agent.mcpServerStatus = async () => [
        { name: "svc", status: "needs-auth" },
        { name: "other", status: "connected" },
      ] as any;
      const cardTs = nextTs();
      await g.emit("message", dmArgs(g, "/mcp", { ts: cardTs }));
      const card = g.posts.filter((p) => p.blocks).at(-1);
      const btn = card.blocks.find((b: any) => b.type === "actions").elements[0];
      expect(btn.action_id).toStartWith("slaude_mcp:connect:");

      // unknown token → ignored
      await g.emitAction("slaude_mcp:connect:deadbeef00000000", WORLD.manager);
      expect(connects).toBe(0);
      // wrong clicker → ignored
      await g.emitAction(btn.action_id, "U0RANDO");
      expect(connects).toBe(0);
      // a 1on1 lock appeared on the card's thread → global no longer applies
      OneOnOne.lock({ channelId: "D_MGR", threadTs: cardTs, lockedUser: "U0SOMEONE", createdBy: "U0SOMEONE" });
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(0);
      OneOnOne.unlock("D_MGR", cardTs);
      // clicker no longer manager → ignored
      writeSoulFixture({ ...WORLD, manager: "U0NEWMGR", backup: "U0NEWBCK" });
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(0);
      writeSoulFixture(WORLD);
      // happy path: manager clicks, no lock → connect runs and persists tokens
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(1);
      expect(g.posts.some((p) => String(p.text).includes("`svc` connected"))).toBe(true);
      // token consumed — second click is a no-op
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(1);
    });

    it("natural-language connect (agentConnect): scope-gated, fire-and-forget, no URL to the model", async () => {
      writeSoulFixture(WORLD);
      writeMcpJson({ svc: { type: "http", url: "http://127.0.0.1:1/mcp" } });
      let connects = 0;
      const g = makeGw({ gwOpts: { oauthConnect: async () => { connects++; return { clientId: "c", accessToken: "a" }; } } });
      mkdirSync(paths.claudeConfig, { recursive: true });

      // boot a manager DM route, then resolve its session id
      const ts = nextTs();
      await g.emit("message", dmArgs(g, "hi", { ts }));
      const session = g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });

      // happy path (global/manager): returns a started-status, never the URL; same engine fires
      const status = await g.h.__agentConnect(session.id, "svc");
      expect(status).toContain("Started authorizing");
      expect(status).not.toContain("http");
      await waitFor(() => g.posts.some((p) => String(p.text).includes("`svc` connected")));
      expect(connects).toBe(1);

      // unknown server → helpful error, no connect attempt
      const unknown = await g.h.__agentConnect(session.id, "nope");
      expect(unknown).toContain("unknown MCP server");
      expect(connects).toBe(1);

      // non-manager (no lock → global) → refused, engine never runs
      writeSoulFixture({ ...WORLD, manager: "U0NEWMGR", backup: "U0NEWBCK" });
      const denied = await g.h.__agentConnect(session.id, "svc");
      expect(denied).toContain("manager-only");
      expect(connects).toBe(1);
      writeSoulFixture(WORLD);

      // initiator scope: caller owns the 1on1 lock → connect runs into their config home
      OneOnOne.lock({ channelId: "D_MGR", threadTs: ts, lockedUser: WORLD.manager, createdBy: WORLD.manager });
      const asInitiator = await g.h.__agentConnect(session.id, "svc");
      expect(asInitiator).toContain("Started authorizing");
      await waitFor(() => connects === 2);
      expect(existsSync(join(paths.home, "oauth", WORLD.manager))).toBe(true);
      OneOnOne.unlock("D_MGR", ts);

      // a 1on1 lock owned by someone else → refused (initiator scope, not the owner)
      OneOnOne.lock({ channelId: "D_MGR", threadTs: ts, lockedUser: "U0OTHER", createdBy: "U0OTHER" });
      const notOwner = await g.h.__agentConnect(session.id, "svc");
      expect(notOwner).toContain("belongs to");
      expect(connects).toBe(2);
      OneOnOne.unlock("D_MGR", ts);

      // unknown session → no active thread
      expect(await g.h.__agentConnect("no-such-session", "svc")).toContain("no active thread");
    });

    it("agent connect is disabled when the store-format canary failed", async () => {
      writeSoulFixture(WORLD);
      writeMcpJson({ svc: { type: "http", url: "http://127.0.0.1:1/mcp" } });
      const g = makeGw({ gwOpts: { mcpConnectEnabled: false } });
      const ts = nextTs();
      await g.emit("message", dmArgs(g, "hi", { ts }));
      const session = g.agent.ensureSession({ team_id: "T", channel_id: "D_MGR", thread_ts: ts });
      expect(await g.h.__agentConnect(session.id, "svc")).toContain("disabled");
    });

    it("initiator-scoped connect card: click gated on still owning the 1on1 lock", async () => {
      writeSoulFixture(WORLD);
      writeMcpJson({ svc: { type: "http", url: "http://127.0.0.1:1/mcp" } });
      let connects = 0;
      const g = makeGw({ gwOpts: { oauthConnect: async () => { connects++; return { clientId: "c", accessToken: "a" }; } } });
      g.agent.mcpServerStatus = async () => [{ name: "svc", status: "needs-auth" }] as any;

      const threadTs = nextTs();
      OneOnOne.lock({ channelId: "C0TEAM", threadTs, lockedUser: WORLD.manager, createdBy: WORLD.manager });
      const args = {
        event: { type: "app_mention", channel: "C0TEAM", channel_type: "channel", user: WORLD.manager, team: "T", ts: nextTs(), thread_ts: threadTs, text: "<@U_SLAUDE> /mcp" },
        client: g.client,
        context: { teamId: "T" },
      };
      await g.emit("app_mention", args);
      const card = g.posts.filter((p) => p.blocks).at(-1);
      const btn = card.blocks.find((b: any) => b.type === "actions").elements[0];

      // lock dropped → click invalid
      OneOnOne.unlock("C0TEAM", threadTs);
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(0);
      // lock now owned by someone else → click invalid
      OneOnOne.lock({ channelId: "C0TEAM", threadTs, lockedUser: "U0OTHER", createdBy: "U0OTHER" });
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(0);
      // restore owner → click runs the connect as initiator
      OneOnOne.unlock("C0TEAM", threadTs);
      OneOnOne.lock({ channelId: "C0TEAM", threadTs, lockedUser: WORLD.manager, createdBy: WORLD.manager });
      await g.emitAction(btn.action_id, WORLD.manager);
      expect(connects).toBe(1);
      expect(existsSync(join(paths.home, "oauth", WORLD.manager))).toBe(true);
    });

    it("loopback connect failure posts the error", async () => {
      writeSoulFixture(WORLD);
      writeMcpJson({ svc: { type: "http", url: "http://127.0.0.1:1/mcp" } });
      const g = makeGw({ gwOpts: { oauthConnect: async () => { throw new Error("loopback-kaput"); } } });
      await g.emit("message", dmArgs(g, "/mcp connect svc"));
      expect(g.posts.some((p) => String(p.text).includes("connect failed: loopback-kaput"))).toBe(true);
    });

    it("default loopback flow end-to-end against a fake IdP (discover → register → code → exchange)", async () => {
      writeSoulFixture(WORLD);
      const idp = startIdp();
      try {
        writeMcpJson({ svc: { type: "http", url: idp.url("/mcp") } });
        const g = makeGw(); // no oauthConnect override → real discover/beginConnect path
        mkdirSync(paths.claudeConfig, { recursive: true });
        rmSync(join(paths.claudeConfig, ".credentials.json"), { force: true });

        const done = g.emit("message", dmArgs(g, "/mcp connect svc"));
        await waitFor(() => g.posts.some((p) => String(p.text).includes(":link: Authorize")));
        const authPost = g.posts.find((p) => String(p.text).includes(":link: Authorize"));
        const m = String(authPost.text).match(/(https?:\/\/\S+)/);
        const authorizeUrl = new URL(m![1]!);
        const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
        redirect.hostname = "127.0.0.1"; // loopback binds v4
        redirect.searchParams.set("code", "the-code");
        redirect.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
        const cb = await fetch(redirect.toString());
        expect(cb.status).toBe(200);
        await done;
        expect(g.posts.some((p) => String(p.text).includes("`svc` connected"))).toBe(true);
        // the auth-URL message is edited in place to strip the live link once the
        // flow settles — redacted text, no URL.
        const redact = g.edits.find((e) => String(e.text).includes("link removed"));
        expect(redact).toBeDefined();
        expect(redact.ts).toBe(String(authPost.ts));
        expect(String(redact.text)).not.toContain("http");
        const creds = JSON.parse(readFileSync(join(paths.claudeConfig, ".credentials.json"), "utf8"));
        expect(JSON.stringify(creds.mcpOAuth)).toContain("atk");
      } finally {
        idp.server.stop(true);
      }
    });

    it("paste-back mode: prepare, plain-message passthrough, state mismatch, success, exchange failure, expiry, prepare failure", async () => {
      writeSoulFixture(WORLD);
      const idp = startIdp();
      try {
        writeMcpJson({
          svc: { type: "http", url: idp.url("/mcp") },
          bad: { type: "http", url: "http://127.0.0.1:1/mcp" },
        });
        process.env.SLAUDE_OAUTH_REDIRECT_URL = "http://127.0.0.1:9/cb";
        const g = makeGw();
        mkdirSync(paths.claudeConfig, { recursive: true });

        const connect = async () => {
          const ts = nextTs();
          await g.emit("message", dmArgs(g, "/mcp connect svc", { ts }));
          const authPost = g.posts.filter((p) => String(p.text).includes("Paste the full redirect URL")).at(-1);
          expect(authPost).toBeDefined();
          const state = new URL(String(authPost.text).match(/(https?:\/\/\S+)/)![1]!).searchParams.get("state")!;
          return { ts, state };
        };

        // prepare failure (default runPrepare → discover against unreachable server)
        await g.emit("message", dmArgs(g, "/mcp connect bad"));
        expect(g.posts.some((p) => String(p.text).includes("`bad` connect failed"))).toBe(true);

        // park a flow; a plain message without a code passes through to the model
        const f1 = await connect();
        const before = g.sends.length;
        await g.emit("message", dmArgs(g, "just chatting", { thread_ts: f1.ts }));
        expect(g.sends.length).toBe(before + 1);

        // state mismatch consumes the flow with an error
        await g.emit("message", dmArgs(g, `http://127.0.0.1:9/cb?code=abc&state=WRONG`, { thread_ts: f1.ts }));
        expect(g.posts.some((p) => String(p.text).includes("state` mismatch"))).toBe(true);

        // success: paste the correct callback
        const f2 = await connect();
        await g.emit("message", dmArgs(g, `http://127.0.0.1:9/cb?code=abc&state=${f2.state}`, { thread_ts: f2.ts }));
        expect(g.posts.some((p) => String(p.text).includes("`svc` connected"))).toBe(true);

        // exchange failure: token endpoint 500s
        const f3 = await connect();
        idp.state.failToken = true;
        await g.emit("message", dmArgs(g, `http://127.0.0.1:9/cb?code=abc&state=${f3.state}`, { thread_ts: f3.ts }));
        expect(g.posts.some((p) => String(p.text).includes("`svc` connect failed: token exchange failed"))).toBe(true);
        idp.state.failToken = false;

        // expiry: jump time past the 10-minute window — pasted code is dropped, msg flows on
        const f4 = await connect();
        setSystemTime(new Date(Date.now() + 11 * 60_000));
        const sendsBefore = g.sends.length;
        await g.emit("message", dmArgs(g, `http://127.0.0.1:9/cb?code=abc&state=${f4.state}`, { thread_ts: f4.ts }));
        setSystemTime();
        expect(g.sends.length).toBe(sendsBefore + 1); // expired → treated as a normal message
      } finally {
        idp.server.stop(true);
      }
    });
  });

  describe("approver-initiated /cron-add requires manager approval", () => {
    const mention = async (g: any, text: string, user: string) => {
      const ts = nextTs();
      const args = {
        event: { type: "app_mention", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, text: `<@U_SLAUDE> ${text}` },
        client: g.client,
        context: { teamId: "T" },
      };
      return g.emit("app_mention", args);
    };

    it("approved → job created", async () => {
      writeSoulFixture(WORLD);
      db.run("DELETE FROM cron_jobs");
      const g = makeGw();
      const done = mention(g, '/cron-add "0 9 * * 1" "weekly check"', WORLD.approvers[0]!);
      await waitFor(() => g.posts.some((p) => String(p.text).includes("Approval needed")));
      const appr = g.posts.filter((p) => String(p.text).includes("Approval needed")).at(-1);
      const approveId = appr.blocks.find((b: any) => b.type === "actions").elements
        .find((e: any) => e.action_id.includes("approve")).action_id;
      await g.emitAction(approveId, WORLD.approvers[0]!);
      await done;
      expect(CronJobs.listActive().length).toBe(1);
      expect(g.posts.some((p) => String(p.text).includes("cron job created"))).toBe(true);
    });

    it("denied → no job", async () => {
      writeSoulFixture(WORLD);
      db.run("DELETE FROM cron_jobs");
      const g = makeGw();
      const done = mention(g, '/cron-add "0 9 * * 1" "weekly check"', WORLD.approvers[0]!);
      await waitFor(() => g.posts.some((p) => String(p.text).includes("Approval needed")));
      const appr = g.posts.filter((p) => String(p.text).includes("Approval needed")).at(-1);
      const denyId = appr.blocks.find((b: any) => b.type === "actions").elements
        .find((e: any) => e.action_id.includes("deny")).action_id;
      await g.emitAction(denyId, WORLD.approvers[0]!);
      await done;
      expect(CronJobs.listActive().length).toBe(0);
      expect(g.posts.some((p) => String(p.text).includes("cron job denied by manager"))).toBe(true);
    });
  });
});
