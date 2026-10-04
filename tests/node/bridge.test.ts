/**
 * The MCP bridge, node side (WS-C §4.2.2, §4.2.5):
 *
 *   1. Against a stub gateway: the list is fetched ONCE at boot and served
 *      unchanged however often the client lists; each call relays with the job
 *      token read at call time (so a later turn's identity reaches the gateway
 *      while the list stays the boot one); results are returned unchanged;
 *      instructions are mirrored; GateDenied is a tool error that marks the
 *      session; a built-in name is never shadowed.
 *   2. End to end, model-free: in-process server → NodeClient → the real /v1
 *      router → the gateway's bridge → a real streamable-HTTP MCP server, with
 *      definitions byte-equal, image / isError / structuredContent intact, and
 *      an abort reaching the upstream.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { buildBridgeServers, GATE_DENIED_TEXT } from "../../src/node/bridge";
import { GateDenied, NodeApiError, NodeClient } from "../../src/node/client";
import { createV1Api } from "../../src/gateway/api";
import { mintJobToken } from "../../src/gateway/api/auth";
import { InMemoryPendingSource } from "../../src/gateway/api/pending-source";
import { createMcpBridge } from "../../src/gateway/core/mcp-bridge";
import { INSTRUCTIONS, PNG_1PX, TOOLS, startUpstream } from "../gateway/mcp-bridge/upstream";

const Loose = z.object({}).passthrough();

async function connect(cfg: McpServerConfig): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (cfg as McpSdkServerConfigWithInstance).instance.connect(a);
  const client = new Client({ name: "test-cli", version: "0" });
  await client.connect(b);
  return client;
}
const raw = (c: Client, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) =>
  (c.request as any).call(c, { method, params }, Loose, signal ? { signal } : {}) as Promise<any>;

const LIST = {
  tools: [{ name: "t1", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } }],
  instructions: "use t1",
  serverInfo: { name: "up", version: "1.2.3" },
};

function stubGateway(o: { list?: () => unknown; call?: (body: any, token: string) => unknown } = {}) {
  const calls: { server: string; op: string; body: any; token: string; signal?: AbortSignal }[] = [];
  const client = {
    async postMcpx(server: string, op: "list" | "call", body: Record<string, unknown>, token: string, signal?: AbortSignal) {
      calls.push({ server, op, body, token, ...(signal ? { signal } : {}) });
      if (op === "list") return (o.list ?? (() => LIST))() as Record<string, unknown>;
      return (o.call ?? (() => ({ content: [{ type: "text", text: "ok" }] })))(body, token) as Record<string, unknown>;
    },
  };
  return { client, calls };
}

describe("node bridge against a stub gateway", () => {
  test("the list is fetched once at boot and served unchanged; instructions mirrored", async () => {
    const gw = stubGateway();
    const servers = await buildBridgeServers("S1", ["example"], { client: gw.client, tokenFor: () => "tok-boot" });
    expect(Object.keys(servers)).toEqual(["example"]);
    expect(servers.example).toMatchObject({ type: "sdk", name: "example" });
    const c = await connect(servers.example!);
    expect(c.getInstructions()).toBe("use t1");
    expect(c.getServerVersion()).toMatchObject({ name: "example", version: "1.2.3" });
    expect(c.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    expect((await raw(c, "tools/list")).tools).toEqual(LIST.tools);
    expect((await raw(c, "tools/list")).tools).toEqual(LIST.tools);
    expect(gw.calls.filter((x) => x.op === "list")).toEqual([{ server: "example", op: "list", body: {}, token: "tok-boot" }]);
  });

  test("each call reads the job token NOW: a later identity reaches the gateway, the list stays the boot one", async () => {
    const gw = stubGateway();
    let token = "tok-agent-turn";
    const c = await connect((await buildBridgeServers("S1", ["example"], { client: gw.client, tokenFor: () => token })).example!);
    await raw(c, "tools/call", { name: "t1", arguments: { a: "1" } });
    token = "tok-user-turn";
    await raw(c, "tools/call", { name: "t1", arguments: { a: "2" } });
    expect((await raw(c, "tools/list")).tools).toEqual(LIST.tools);
    expect(gw.calls.filter((x) => x.op === "call").map((x) => [x.token, x.body])).toEqual([
      ["tok-agent-turn", { name: "t1", arguments: { a: "1" } }],
      ["tok-user-turn", { name: "t1", arguments: { a: "2" } }],
    ]);
    expect(gw.calls.filter((x) => x.op === "list")).toHaveLength(1);
  });

  test("results come back unchanged", async () => {
    const result = {
      content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "text", text: "t", annotations: { audience: ["user"] } }],
      structuredContent: { k: [1, 2] },
      isError: false,
      _meta: { "x/y": 1 },
    };
    const gw = stubGateway({ call: () => result });
    const c = await connect((await buildBridgeServers("S1", ["example"], { client: gw.client, tokenFor: () => "t" })).example!);
    expect(await raw(c, "tools/call", { name: "t1", arguments: {} })).toEqual(result);
  });

  test("GateDenied on a call: a tool error, and the session is marked", async () => {
    const denied: string[] = [];
    const gw = stubGateway({ call: () => { throw new GateDenied("{}"); } });
    const c = await connect((await buildBridgeServers("S9", ["example"], { client: gw.client, tokenFor: () => "t", onGateDenied: (s) => denied.push(s) })).example!);
    expect(await raw(c, "tools/call", { name: "t1", arguments: {} })).toEqual({ content: [{ type: "text", text: GATE_DENIED_TEXT }], isError: true });
    expect(denied).toEqual(["S9"]);
  });

  test("GateDenied on the boot list: the server is not mounted and the session is marked", async () => {
    const denied: string[] = [];
    const gw = stubGateway({ list: () => { throw new GateDenied("{}"); } });
    const out = await buildBridgeServers("S9", ["example"], { client: gw.client, tokenFor: () => "t", onGateDenied: (s) => denied.push(s), warn: () => {} });
    expect(out).toEqual({});
    expect(denied).toEqual(["S9"]);
  });

  test("a gateway failure on a call is a tool error with no gateway body", async () => {
    const gw = stubGateway({ call: () => { throw new NodeApiError(502, "internal detail token=leak"); } });
    const c = await connect((await buildBridgeServers("S1", ["example"], { client: gw.client, tokenFor: () => "t" })).example!);
    const r = await raw(c, "tools/call", { name: "t1", arguments: {} });
    expect(r).toEqual({ content: [{ type: "text", text: "example is unreachable through the gateway (status 502)" }], isError: true });
  });

  test("an unavailable server mounts with no tools and the gateway's fixed reason as instructions", async () => {
    const gw = stubGateway({ list: () => ({ tools: [], instructions: "connect example: ...", unavailable: true }) });
    const c = await connect((await buildBridgeServers("S1", ["example"], { client: gw.client, tokenFor: () => "t" })).example!);
    expect((await raw(c, "tools/list")).tools).toEqual([]);
    expect(c.getInstructions()).toBe("connect example: ...");
  });

  test("a server whose list fails is left out; a built-in name is never shadowed; no token mounts nothing", async () => {
    const warns: string[] = [];
    const gw = stubGateway({ list: () => { throw new NodeApiError(404, "{}"); } });
    expect(await buildBridgeServers("S1", ["a"], { client: gw.client, tokenFor: () => "t", warn: (m) => warns.push(m) })).toEqual({});
    const ok = stubGateway();
    const out = await buildBridgeServers("S1", ["slaude_surface", "fine"], { client: ok.client, tokenFor: () => "t", warn: (m) => warns.push(m) }, new Set(["slaude_surface"]));
    expect(Object.keys(out)).toEqual(["fine"]);
    expect(ok.calls.map((x) => x.server)).toEqual(["fine"]);
    expect(await buildBridgeServers("S1", ["fine"], { client: ok.client, tokenFor: () => undefined })).toEqual({});
    expect(warns.length).toBe(2);
  });

  test("an older gateway's bundle (no mcpServers) mounts nothing", async () => {
    const gw = stubGateway();
    expect(await buildBridgeServers("S1", [], { client: gw.client, tokenFor: () => "t" })).toEqual({});
    expect(gw.calls).toEqual([]);
  });
});

describe("node bridge end to end (model-free): node → /v1 → gateway bridge → real MCP server", () => {
  const up = startUpstream();
  const bridge = createMcpBridge({
    servers: () => ({ servers: { example: { type: "http", url: up.url } as never }, privateServices: [] }),
    accountFor: async () => null,
    credentialsFor: async () => ({}),
    policy: { allowLoopback: true, allowedHosts: [], internalHosts: [] },
    limits: () => ({ timeoutMs: 5000, ownerConcurrency: 4, maxRequestBytes: 1 << 20, maxResultBytes: 1 << 20 }),
  });
  const saved = { node: process.env.SLAUDE_NODE_TOKEN, job: process.env.SLAUDE_JOB_SECRET };
  let http: ReturnType<typeof Bun.serve>;
  let node: NodeClient;
  let client: Client;
  const token = () =>
    mintJobToken({ tenant: "default", persona: "default", session: "S-e2e", team: "T1", channel: "C1", thread: "1.0", initiator: "U1", scope: "turn", runAs: "agent" });

  beforeAll(async () => {
    process.env.SLAUDE_NODE_TOKEN = "bridge-node-token";
    process.env.SLAUDE_JOB_SECRET = "bridge-job-secret";
    const v1 = createV1Api({ tools: { mcpBridge: bridge } as never, pendingSource: new InMemoryPendingSource() });
    http = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: async (req) => (await v1.fetch(req)) ?? new Response("", { status: 404 }) });
    node = new NodeClient({ baseUrl: `http://127.0.0.1:${http.port}`, token: "bridge-node-token", attempts: 1 });
    const t = token();
    const servers = await buildBridgeServers("S-e2e", ["example"], { client: node, tokenFor: () => t });
    client = await connect(servers.example!);
  });
  afterAll(async () => {
    await bridge.close();
    http.stop(true);
    up.stop();
    if (saved.node === undefined) delete process.env.SLAUDE_NODE_TOKEN;
    else process.env.SLAUDE_NODE_TOKEN = saved.node;
    if (saved.job === undefined) delete process.env.SLAUDE_JOB_SECRET;
    else process.env.SLAUDE_JOB_SECRET = saved.job;
  });

  test("definitions byte-equal to the upstream's, and its instructions", async () => {
    expect(JSON.stringify((await raw(client, "tools/list")).tools)).toBe(JSON.stringify(TOOLS));
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  test("image, isError, structuredContent and complex arguments survive both hops", async () => {
    expect(await raw(client, "tools/call", { name: "image", arguments: {} })).toEqual({
      content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "text", text: "a pixel" }],
    });
    expect(await raw(client, "tools/call", { name: "fail", arguments: {} })).toEqual({
      content: [{ type: "text", text: "the example service said no" }],
      isError: true,
    });
    expect(await raw(client, "tools/call", { name: "structured", arguments: { n: 4 } })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ doubled: 8 }) }],
      structuredContent: { doubled: 8 },
    });
    const args = { shape: { kind: "circle", r: 2 }, mode: "slow" };
    expect((await raw(client, "tools/call", { name: "nested", arguments: args })).content[0].text).toBe(JSON.stringify(args));
  });

  test("an unknown tool is a tool error", async () => {
    const r = await raw(client, "tools/call", { name: "no_such_tool", arguments: {} });
    expect(r.isError).toBe(true);
  });

  test("an abort on the node cancels the call at the upstream", async () => {
    const before = up.slowAborted;
    const seen = up.methods.filter((m) => m === "tools/call").length;
    const ac = new AbortController();
    const p = raw(client, "tools/call", { name: "slow", arguments: {} }, ac.signal).catch((e: Error) => e);
    const end = Date.now() + 3000;
    while (up.methods.filter((m) => m === "tools/call").length === seen && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await p;
    while (up.slowAborted === before && Date.now() < end + 2000) await new Promise((r) => setTimeout(r, 10));
    expect(up.slowAborted).toBe(before + 1);
  });

  test("the job token is required: the gateway's 401 is a tool error, not a crash", async () => {
    const servers = await buildBridgeServers("S-x", ["example"], { client: node, tokenFor: () => "not-a-token", warn: () => {} });
    expect(servers).toEqual({});
  });
});

