import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBrainServer, type StartedBrainServer } from "../src/knowledge/server/brain-server";
import type { BrainServerDeps } from "../src/knowledge/server/tools";

let started: StartedBrainServer | undefined;
afterEach(async () => {
  await started?.stop();
  started = undefined;
});

const stubDeps: BrainServerDeps = {
  runScoped: async (name, params, scope) => ({ echoed: { name, params, scope } }),
  runAdmin: async (name, _params, sourceId) => ({ admin: { name, sourceId } }),
};

async function client(url: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

describe("brain server round trip (auth disabled)", () => {
  test("brain_op round-trips through HTTP transport", async () => {
    started = await startBrainServer(
      { port: 0, host: "127.0.0.1", authDisabled: true },
      stubDeps,
    );
    const c = await client(started.url);
    const res: any = await c.callTool({
      name: "brain_op",
      arguments: { op: "think", params: { q: "x" }, clientId: "agent", sourceId: "agent", allowedSources: ["agent"] },
    });
    expect(JSON.parse(res.content[0].text)).toEqual({
      echoed: { name: "think", params: { q: "x" }, scope: { clientId: "agent", sourceId: "agent", allowedSources: ["agent"] } },
    });
    await c.close();
  });

  test("serves protected-resource metadata", async () => {
    started = await startBrainServer(
      { port: 0, host: "127.0.0.1", authDisabled: false, publicUrl: "https://brain.example", issuer: "https://kc.example/realms/r" },
      stubDeps,
    );
    const prmUrl = started.url.replace("/mcp", "/.well-known/oauth-protected-resource");
    // publicUrl is used for url string, but the server binds locally; hit the bound port directly.
    const localPrm = `http://127.0.0.1:${started.port}/.well-known/oauth-protected-resource`;
    const r = await fetch(localPrm);
    const prm = await r.json();
    expect(prm.resource).toBe("https://brain.example");
    expect(prm.authorization_servers).toEqual(["https://kc.example/realms/r"]);
    expect(prmUrl).toContain("oauth-protected-resource");
  });

  test("rejects unauthenticated MCP requests with 401 + WWW-Authenticate", async () => {
    started = await startBrainServer(
      { port: 0, host: "127.0.0.1", authDisabled: false, publicUrl: "https://brain.example", issuer: "https://kc.example/realms/r", audience: "slaude-brain" },
      stubDeps,
    );
    const r = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});
