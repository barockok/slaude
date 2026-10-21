/**
 * Node MCP shims:
 *   1. Schema identity — every shim server registers exactly the contract's
 *      MCP-mounted tools with byte-identical descriptions + JSON schemas
 *      (same snapshot technique as tests/tools/contracts.test.ts, so the
 *      model sees no difference between a shim and the in-process server).
 *   2. Live round-trip — a shim tool call travels MCP → REST /v1 → the real
 *      gateway tool plane and back.
 *   3. Blocking tools — request_approval and can_use_tool return via the
 *      {pendingId} + long-poll loop, resolved by a Block Kit click on the
 *      gateway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

process.env.SLAUDE_BRAIN_DISABLED = "1";

import { surfaceContract } from "../../src/tools/contracts/surface";
import { slackContract } from "../../src/tools/contracts/slack";
import { runtimeContract } from "../../src/tools/contracts/runtime";
import { connectContract } from "../../src/tools/contracts/connect";
import { skillsContract } from "../../src/tools/contracts/skills";
import { kbContract } from "../../src/tools/contracts/kb";
import { mcpMountedTools, type ServerContract } from "../../src/tools/contracts/types";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { AgentManager } from "../../src/agent/manager";
import type { Transport } from "../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { mintJobToken } from "../../src/gateway/api/auth";
import { NodeClient } from "../../src/node/client";
import { buildShimServers, REST_SERVER_SEGMENT } from "../../src/node/shims";
import { makeNodeOwnerGuard, makeNodePermissionResolver } from "../../src/node/shims/permission";
import * as OneOnOne from "../../src/db/one-on-one";
import { ensureHome } from "../../src/config/home";

const NODE_TOKEN = "shim-node-token";
const JOB_SECRET = "shim-job-secret";
const SESSION = "S-shim";

type Handler = (a: any) => Promise<void>;

function recordingTransport() {
  const handlers: { matcher: RegExp; fn: Handler }[] = [];
  const posts: any[] = [];
  const t: Transport = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: {
        postMessage: async (m: any) => {
          posts.push(m);
          return { ok: true, ts: `${posts.length}.1` };
        },
        update: async () => ({ ok: true }),
      },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({ messages: { matches: [], total: 0 } }) },
      files: { uploadV2: async () => ({ files: [] }) },
    } as any,
    action: (matcher: RegExp, fn: any) => handlers.push({ matcher, fn }),
    event: () => {},
    use: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const fire = async (action_id: string, userId: string) => {
    for (const h of handlers) {
      if (h.matcher.test(action_id)) {
        await h.fn({
          ack: async () => {},
          action: { action_id },
          body: { user: { id: userId } },
          respond: async () => {},
        });
      }
    }
  };
  return { t, posts, fire };
}

type ListedTool = { name: string; description?: string; inputSchema: unknown };

async function listRegistered(cfg: McpSdkServerConfigWithInstance): Promise<Map<string, ListedTool>> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "shim-test", version: "0.0.0" });
  await client.connect(clientT);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema }]));
  } finally {
    await client.close();
  }
}

function referenceServer(contract: ServerContract): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `${contract.server}-ref`,
    version: "0.0.0",
    tools: mcpMountedTools(contract).map((t) => tool(t.name, t.description, t.schema, async () => ({ content: [] }))),
  });
}

async function callShim(cfg: McpSdkServerConfigWithInstance, toolName: string, args: Record<string, unknown>) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "shim-call", version: "0.0.0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close();
  }
}

const CONTRACTS = [surfaceContract, slackContract, runtimeContract, connectContract, skillsContract, kbContract];

let handle: GatewayHandle;
let server: ReturnType<typeof Bun.serve>;
let fire: (action_id: string, userId: string) => Promise<void>;
let posts: any[];
let nodeClient: NodeClient;
let shims: ReturnType<typeof buildShimServers>;

const jobToken = () =>
  mintJobToken({
    tenant: "default", persona: "default", session: SESSION,
    team: "T1", channel: "C0TEAM", thread: "600.0", initiator: WORLD.manager, scope: "turn",
  });

beforeAll(async () => {
  process.env.SLAUDE_NODE_TOKEN = NODE_TOKEN;
  process.env.SLAUDE_JOB_SECRET = JOB_SECRET;
  ensureHome();
  writeSoulFixture(WORLD);
  const rec = recordingTransport();
  fire = rec.fire;
  posts = rec.posts;
  handle = createGateway(new AgentManager(), rec.t);
  server = Bun.serve({
    port: 0,
    idleTimeout: 0, // /v1/pending long-polls exceed Bun's 10s default
    fetch: async (req) => (await handle.fetchV1(req)) ?? new Response("nf", { status: 404 }),
  });
  nodeClient = new NodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: NODE_TOKEN, baseDelayMs: 1 });
  shims = buildShimServers(SESSION, { client: nodeClient, tokenFor: () => jobToken() });
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_JOB_SECRET;
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

describe("shim schema identity", () => {
  for (const contract of CONTRACTS) {
    test(`${contract.server} registers the contract's MCP-mounted tools byte-identically`, async () => {
      const shim = shims[contract.server] as McpSdkServerConfigWithInstance;
      const registered = await listRegistered(shim);
      const expected = await listRegistered(referenceServer(contract));
      expect([...registered.keys()].sort()).toEqual(mcpMountedTools(contract).map((t) => t.name).sort());
      for (const [name, exp] of expected) {
        const got = registered.get(name)!;
        expect(got.description).toEqual(exp.description);
        expect(got.inputSchema).toEqual(exp.inputSchema);
      }
    });
  }
  test("REST segment map covers every contract", () => {
    expect(Object.keys(REST_SERVER_SEGMENT).sort()).toEqual(CONTRACTS.map((c) => c.server).sort());
  });
});

describe("shim round-trips over live /v1", () => {
  test("surface/reply lands on the gateway's Slack client", async () => {
    const before = posts.length;
    const res: any = await callShim(shims[surfaceContract.server] as any, "reply", { text: "hello from the node" });
    expect(res.content[0].text).toContain("posted ref=");
    expect(posts.length).toBe(before + 1);
    expect(posts[posts.length - 1].channel).toBe("C0TEAM");
  });

  test("skills write→read→delete through the tool plane", async () => {
    const shim = shims[skillsContract.server] as any;
    const w: any = await callShim(shim, "write_skill", { slug: "shimskill", name: "S", description: "d", body: "b" });
    expect(w.isError).toBeFalsy();
    const r: any = await callShim(shim, "read_skill", { slug: "shimskill" });
    expect(r.content[0].text).toContain("b");
    await callShim(shim, "delete_skill", { slug: "shimskill" });
  });

  test("request_approval long-polls until the gateway click", async () => {
    const before = posts.length;
    const pending = callShim(shims[surfaceContract.server] as any, "request_approval", { summary: "shim plan" });
    // Wait for the card, extract the gate id, click approve as the manager.
    for (let i = 0; i < 200 && posts.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    const card = posts[posts.length - 1];
    const actions = card.blocks.find((b: any) => b.type === "actions");
    const id = String(actions.elements[0].action_id).replace("slaude_appr:approve:", "");
    await fire(`slaude_appr:approve:${id}`, WORLD.approvers[0]!);
    const res: any = await pending;
    expect(res.content[0].text).toBe(`approved by <@${WORLD.approvers[0]}>`);
  }, 15_000);
});

describe("node permission resolver", () => {
  test("static policy short-circuits locally (no card posted)", async () => {
    const before = posts.length;
    const resolver = makeNodePermissionResolver({ client: nodeClient, tokenFor: () => jobToken() });
    const ac = new AbortController();
    const d: any = await resolver(SESSION, "mcp__slaude_surface__reply", {}, {
      toolUseID: "shim_perm_0", signal: ac.signal, suggestions: undefined, decisionReason: undefined,
    } as any);
    expect(d.behavior).toBe("allow");
    expect(posts.length).toBe(before);
  });

  test("full loop: card → click always → allow with updatedPermissions", async () => {
    const resolver = makeNodePermissionResolver({ client: nodeClient, tokenFor: () => jobToken() });
    const ac = new AbortController();
    const before = posts.length;
    const pending = resolver(SESSION, "Bash", { command: "ls" }, {
      toolUseID: "shim_perm_1", signal: ac.signal, suggestions: undefined, decisionReason: undefined,
    } as any);
    for (let i = 0; i < 200 && posts.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    await fire("slaude_perm:always:shim_perm_1", WORLD.approvers[0]!);
    const d: any = await pending;
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toEqual({ command: "ls" });
    expect(d.updatedPermissions?.length).toBe(1);
  }, 15_000);

  test("abort mid-poll fails closed", async () => {
    const resolver = makeNodePermissionResolver({ client: nodeClient, tokenFor: () => jobToken() });
    const ac = new AbortController();
    const pending = resolver(SESSION, "Bash", { command: "rm" }, {
      toolUseID: "shim_perm_2", signal: ac.signal, suggestions: undefined, decisionReason: undefined,
    } as any);
    setTimeout(() => ac.abort(), 150);
    const d: any = await pending;
    expect(d.behavior).toBe("deny");
    expect(d.message).toBe("aborted");
  }, 15_000);
});

describe("node /1on1 owner guard", () => {
  // The job token's thread (C0TEAM / 600.0) is a 1on1 owned by U0OWNER with a guest.
  const guard = () => makeNodeOwnerGuard({ client: nodeClient, tokenFor: () => jobToken() });
  const req = (toolUseId: string, signal = new AbortController().signal) => ({
    sessionId: SESSION, toolName: "mcp__sandbox__git_push", input: { remote: "origin" }, toolUseId, rule: "mcp__*__git_push", signal,
  });

  test("no 1on1 in the thread → denied at once, no card", async () => {
    await OneOnOne.unlock("C0TEAM", "600.0");
    const before = posts.length;
    const d = await guard()(req("shim_owner_0"));
    expect(d.allow).toBe(false);
    expect(posts.length).toBe(before);
  });

  test("full loop: owner card → the guest's click is refused → the owner's click allows", async () => {
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: "600.0", lockedUser: "U0OWNER", createdBy: "U0OWNER" });
    await OneOnOne.setGuests("C0TEAM", "600.0", ["U0QA"]);
    try {
      const before = posts.length;
      let done = false;
      const pending = guard()(req("shim_owner_1")).then((d) => ((done = true), d));
      for (let i = 0; i < 200 && posts.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      expect(JSON.stringify(posts[posts.length - 1].blocks)).toContain("Only <@U0OWNER> can allow it");
      await fire("slaude_perm:allow:owner:shim_owner_1", "U0QA");
      await fire("slaude_perm:allow:owner:shim_owner_1", WORLD.manager);
      await new Promise((r) => setTimeout(r, 50));
      expect(done).toBe(false);
      await fire("slaude_perm:allow:owner:shim_owner_1", "U0OWNER");
      expect(await pending).toEqual({ allow: true });
    } finally {
      await OneOnOne.unlock("C0TEAM", "600.0");
    }
  }, 15_000);

  test("the owner's Deny is a deny; abort mid-poll fails closed", async () => {
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: "600.0", lockedUser: "U0OWNER", createdBy: "U0OWNER" });
    try {
      const before = posts.length;
      const pending = guard()(req("shim_owner_2"));
      for (let i = 0; i < 200 && posts.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      await fire("slaude_perm:deny:owner:shim_owner_2", "U0OWNER");
      const d = await pending;
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toContain("Denied by <@U0OWNER>");

      const ac = new AbortController();
      const p2 = guard()(req("shim_owner_3", ac.signal));
      setTimeout(() => ac.abort(), 150);
      const d2 = await p2;
      expect(d2.allow).toBe(false);
      if (!d2.allow) expect(d2.reason).toContain("aborted");
    } finally {
      await OneOnOne.unlock("C0TEAM", "600.0");
    }
  }, 15_000);
});

describe("voice turn suppression", () => {
  const fake = (posted: string[]) =>
    ({ postTool: async (seg: string, name: string) => { posted.push(`${seg}/${name}`); return { content: [{ type: "text", text: "{}" }] }; } }) as any;
  const handlers = (servers: any, name: string) => servers[name].instance._registeredTools;

  test("suppresses surface writes locally and still forwards other tools", async () => {
    const posted: string[] = [];
    const servers = buildShimServers("sv1", { client: fake(posted), tokenFor: () => "tok", voiceActive: (id) => id === "sv1" });
    const surface = handlers(servers, "slaude_surface");
    const r = await surface["reply"].handler({ text: "x" });
    expect(JSON.parse(r.content[0].text)).toEqual({ ref: "voice-suppressed" });
    await surface["get_history"].handler({});
    expect(posted).toEqual(["surface/get_history"]);
  });

  test("suppresses the deprecated slaude_slack reply and post_message, forwards reads", async () => {
    const posted: string[] = [];
    const servers = buildShimServers("sv1", { client: fake(posted), tokenFor: () => "tok", voiceActive: () => true });
    const slack = handlers(servers, "slaude_slack");
    for (const [name, args] of [["reply", { text: "x" }], ["post_message", { channel: "C1", text: "x" }]] as const) {
      const r = await slack[name].handler(args);
      expect(JSON.parse(r.content[0].text)).toEqual({ ref: "voice-suppressed" });
    }
    await slack["get_channel_info"].handler({});
    expect(posted).toEqual(["slack/get_channel_info"]);
  });

  test("other sessions are not suppressed", async () => {
    const posted: string[] = [];
    const servers = buildShimServers("sv2", { client: fake(posted), tokenFor: () => "tok", voiceActive: (id) => id === "sv1" });
    await handlers(servers, "slaude_surface")["reply"].handler({ text: "x" });
    expect(posted).toEqual(["surface/reply"]);
  });
});
