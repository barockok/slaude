/**
 * The remote brain authenticates with an MCP credential owned by the agent. On a
 * gateway that credential lives in the store like every other one; leaving it
 * on disk would keep one credential on the mechanism phase 3 retires. mono keeps
 * reading its config directory, and needs no master key for it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/db/schema";
import * as Creds from "../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../src/db/crypto";
import { oauthKey } from "../../src/agent/mcp-oauth/store";
import { agentConfigDir } from "../../src/agent/oauth-home";
import { RemoteBackend } from "../../src/knowledge/remote/brain-client";
import { __resetDefaultCredentialRefresher } from "../../src/gateway/core/credential-refresh";

let server: ReturnType<typeof Bun.serve>;
let url = "";
const bearers: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const auth = req.headers.get("authorization") ?? "";
      bearers.push(auth);
      // Like a real brain server: nothing without a bearer.
      if (!auth.startsWith("Bearer ")) return new Response(null, { status: 401 });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const body: any = await req.json().catch(() => null);
      if (body?.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "brain", version: "0" } },
        });
      }
      if (body?.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (body?.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: body?.id, result: {} });
    },
  });
  url = `http://127.0.0.1:${server.port}/mcp`;
});
afterAll(() => server.stop(true));

const saved = { role: process.env.SLAUDE_ROLE, token: process.env.SLAUDE_BRAIN_TOKEN };
beforeEach(async () => {
  bearers.length = 0;
  delete process.env.SLAUDE_BRAIN_TOKEN;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  __resetDefaultCredentialRefresher();
  await db.run("DELETE FROM mcp_credentials");
});
afterEach(() => {
  for (const [k, v] of [["SLAUDE_ROLE", saved.role], ["SLAUDE_BRAIN_TOKEN", saved.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const scope = { clientId: "c", sourceId: "s", allowedSources: ["s"] } as any;
const key = () => oauthKey("slaude_brain", { type: "http", url });

describe("brain client credentials", () => {
  test("on a gateway, the bearer comes from the agent's entry in the store", async () => {
    process.env.SLAUDE_ROLE = "gateway";
    await Creds.putCredential({ kind: "agent", tenant: "default", persona: "default" }, key(), {
      serverName: "slaude_brain", serverUrl: url, accessToken: "tok-brain-store", expiresAt: Date.now() + 3600_000,
    });

    await new RemoteBackend(url).call("get_page", {}, scope);

    expect(bearers[0]).toBe("Bearer tok-brain-store");
  });

  // A file left on the shared volume must not be what a gateway authenticates
  // with once the store is the authority.
  test("on a gateway, a file on disk is not consulted", async () => {
    process.env.SLAUDE_ROLE = "gateway";
    const dir = agentConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      mcpOAuth: { [key()]: { serverName: "slaude_brain", serverUrl: url, accessToken: "tok-brain-disk", expiresAt: Date.now() + 3600_000 } },
    }));

    await expect(new RemoteBackend(url).call("get_page", {}, scope)).rejects.toThrow(/not authenticated/);
    expect(bearers.join(" ")).not.toContain("tok-brain-disk");
  });

  test("in mono, the bearer still comes from the agent's config directory", async () => {
    process.env.SLAUDE_ROLE = "mono";
    const dir = agentConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      mcpOAuth: { [key()]: { serverName: "slaude_brain", serverUrl: url, accessToken: "tok-brain-disk", expiresAt: Date.now() + 3600_000 } },
    }));

    await new RemoteBackend(url).call("get_page", {}, scope);

    expect(bearers[0]).toBe("Bearer tok-brain-disk");
  });

  test("the SLAUDE_BRAIN_TOKEN override still wins, for bootstrap and tests", async () => {
    process.env.SLAUDE_ROLE = "gateway";
    process.env.SLAUDE_BRAIN_TOKEN = "tok-from-env";
    await new RemoteBackend(url).call("get_page", {}, scope);
    expect(bearers[0]).toBe("Bearer tok-from-env");
  });
});
