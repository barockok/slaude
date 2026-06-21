import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBrainTools } from "../src/knowledge/server/tools";
import type { BrainScope } from "../src/knowledge/scope";

async function connectedClient(deps: Parameters<typeof registerBrainTools>[1]) {
  const server = new McpServer({ name: "brain-test", version: "0.0.0" });
  registerBrainTools(server, deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

function decode(res: any): unknown {
  return JSON.parse(res.content[0].text);
}

describe("brain server tools", () => {
  test("brain_op forwards op, params and scope; returns JSON result", async () => {
    let seen: { name: string; params: unknown; scope: BrainScope } | undefined;
    const { client } = await connectedClient({
      runScoped: async (name, params, scope) => {
        seen = { name, params, scope };
        return { pages: [{ slug: "x" }] };
      },
      runAdmin: async () => ({}),
    });
    const res = await client.callTool({
      name: "brain_op",
      arguments: {
        op: "think",
        params: { q: "hello" },
        clientId: "agent",
        sourceId: "agent",
        allowedSources: ["agent", "shared"],
      },
    });
    expect(seen).toEqual({
      name: "think",
      params: { q: "hello" },
      scope: { clientId: "agent", sourceId: "agent", allowedSources: ["agent", "shared"] },
    });
    expect(decode(res)).toEqual({ pages: [{ slug: "x" }] });
  });

  test("brain_admin_op forwards op, params and sourceId", async () => {
    let seen: { name: string; params: unknown; sourceId: string } | undefined;
    const { client } = await connectedClient({
      runScoped: async () => ({}),
      runAdmin: async (name, params, sourceId) => {
        seen = { name, params, sourceId };
        return { sources: [] };
      },
    });
    const res = await client.callTool({
      name: "brain_admin_op",
      arguments: { op: "sources_list", params: {}, sourceId: "default" },
    });
    expect(seen).toEqual({ name: "sources_list", params: {}, sourceId: "default" });
    expect(decode(res)).toEqual({ sources: [] });
  });

  test("brain_op surfaces engine errors as tool errors", async () => {
    const { client } = await connectedClient({
      runScoped: async () => {
        throw new Error("boom");
      },
      runAdmin: async () => ({}),
    });
    const res: any = await client.callTool({
      name: "brain_op",
      arguments: { op: "think", params: {}, clientId: "a", sourceId: "a", allowedSources: ["a"] },
    });
    expect(res.isError).toBe(true);
    expect(decode(res)).toEqual({ error: "boom" });
  });
});
