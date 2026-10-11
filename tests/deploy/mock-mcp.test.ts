/**
 * The local mock MCP server (deploy/k8s-local/mock-mcp/server.ts) is the MCP
 * bridge's upstream in the local cluster, so it must speak enough MCP over
 * streamable HTTP for the gateway's real client (the SDK's Client and
 * StreamableHTTPClientTransport, as src/gateway/core/mcp-bridge.ts uses them)
 * to open a session, list tools and call one. Its revoke switch lets the
 * runbook show the bridge's re-authorise error and connect card.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { join } from "node:path";

const server = join(import.meta.dir, "../../deploy/k8s-local/mock-mcp/server.ts");
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", server], {
    env: { ...process.env, MOCK_MCP_PORT: String(port), MOCK_MCP_ORIGIN: base },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/healthz`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("mock MCP server did not start");
});
afterAll(() => proc?.kill());

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(transport);
  return c;
}

test("the SDK client opens a session, lists the echo tool and calls it", async () => {
  const c = await connect("local-test");
  const { tools } = await c.listTools();
  expect(tools.map((t) => t.name)).toEqual(["echo"]);
  const r: any = await c.callTool({ name: "echo", arguments: { text: "hello" } });
  expect(r.isError ?? false).toBe(false);
  expect(r.content[0].text).toContain("hello");
  await c.close();
});

test("an unknown tool is a JSON-RPC error, not a crash", async () => {
  const c = await connect("local-test");
  await expect(c.callTool({ name: "nope", arguments: {} })).rejects.toThrow();
  await c.close();
});

test("without a bearer it answers 401 with the protected-resource pointer", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
});

test("revoke makes every bearer fail with 401 until restore", async () => {
  expect((await fetch(`${base}/control/revoke`, { method: "POST" })).status).toBe(200);
  await expect(connect("local-test")).rejects.toThrow();
  expect((await fetch(`${base}/control/restore`, { method: "POST" })).status).toBe(200);
  const c = await connect("local-test");
  expect((await c.listTools()).tools.length).toBe(1);
  await c.close();
});
