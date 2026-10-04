/**
 * The bridge inside a real gateway: the mcpx routes resolve the persona's
 * servers the way the runtime bundle names them, and a server that needs
 * re-authorising answers fixed text and posts the existing `/mcp` connect card
 * (a pending_gates row + a "Connect <server>" button) in the turn's thread,
 * once per (session, server) per window, never carrying the upstream's body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.SLAUDE_BRAIN_DISABLED = "1";

import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { JOB_HEADER, mintJobToken } from "../../../src/gateway/api/auth";
import { ensureHome, paths } from "../../../src/config/home";
import * as PendingGates from "../../../src/db/pending-gates";
import { reauthText } from "../../../src/gateway/core/mcp-bridge";
import { handleTenantRuntime } from "../../../src/gateway/api/tenants";
import { LEAKY_BODY, TOOLS, startUpstream } from "./upstream";

const up = startUpstream();
const posts: any[] = [];
const transport: Transport = {
  client: {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async (a: any) => { posts.push(a); return { ok: true, ts: "1.1" }; }, update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
  } as any,
  action: () => {}, event: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
};

const saved: Record<string, string | undefined> = {};
const VARS = ["SLAUDE_NODE_TOKEN", "SLAUDE_JOB_SECRET", "SLAUDE_OUTBOUND_DEV_LOOPBACK", "SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG", "ANTHROPIC_API_KEY"];
let gw: GatewayHandle;
const mcpJson = () => join(paths.home, ".mcp.json");

beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  process.env.SLAUDE_NODE_TOKEN = "card-node-token";
  process.env.SLAUDE_JOB_SECRET = "card-job-secret";
  // The upstream listens on loopback: admitted for this test only.
  process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
  // These servers come from the global .mcp.json: bridged only with the opt-in.
  process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG = "1";
  process.env.ANTHROPIC_API_KEY = "provider-key-value";
  ensureHome();
  writeSoulFixture(WORLD);
  writeFileSync(
    mcpJson(),
    JSON.stringify({
      mcpServers: {
        open: { type: "http", url: up.url },
        locked: { type: "http", url: up.url, headers: { authorization: "Bearer refused-static" } },
        leaky: { type: "http", url: up.url, headers: { "x-api-key": "${ANTHROPIC_API_KEY}" } },
        local: { command: "some-binary" },
      },
    }),
  );
  up.refuse.add("refused-static");
  gw = createGateway(new AgentManager(), transport);
});

afterAll(async () => {
  await gw.stop().catch(() => {});
  rmSync(mcpJson(), { force: true });
  up.stop();
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.SLAUDE_BRAIN_DISABLED;
});

const job = (session = "S-card") =>
  mintJobToken({
    tenant: "default", persona: "default", session, team: "T1", channel: "C0TEAM", thread: "500.0",
    initiator: "U0ALICE", scope: "turn", runAs: "agent",
  });

async function mcpx(path: string, body: unknown, session?: string) {
  const res = (await gw.fetchV1(
    new Request(`http://gw/v1/tools/mcpx/${path}`, {
      method: "POST",
      headers: { authorization: "Bearer card-node-token", [JOB_HEADER]: job(session), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as any };
}

describe("the bridge in the gateway", () => {
  test("the bundle names exactly the servers the routes serve", async () => {
    const bundle = (await (await handleTenantRuntime(new Request("http://gw/"), "default", "default")).json()) as { mcpServers: string[] };
    expect(bundle.mcpServers).toEqual(["leaky", "locked", "open"]);
    const listed = await mcpx("open/list", {});
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body.tools)).toBe(JSON.stringify(TOOLS));
    expect((await mcpx("local/list", {})).status).toBe(404);
  });

  test("review M1 repro: a file placeholder naming gateway env reaches the upstream unexpanded", async () => {
    const before = up.seen.length;
    const r = await mcpx("leaky/call", { name: "whoami", arguments: {} });
    expect(r.status).toBe(200);
    expect(up.seen.slice(before).at(-1)?.apiKey).toBe("${ANTHROPIC_API_KEY}");
    expect(JSON.stringify(up.seen)).not.toContain("provider-key-value");
  });

  test("without the opt-in no file-defined server is served or named", async () => {
    delete process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG;
    try {
      const bundle = (await (await handleTenantRuntime(new Request("http://gw/"), "default", "default")).json()) as { mcpServers: string[] };
      expect(bundle.mcpServers).toEqual([]);
      const seen = up.paths.length;
      expect((await mcpx("open/list", {})).status).toBe(404);
      expect(up.paths.length).toBe(seen);
    } finally {
      process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG = "1";
    }
  });

  test("a refused credential: fixed text, one connect card for the manager, no upstream body", async () => {
    posts.length = 0;
    const r = await mcpx("locked/call", { name: "whoami", arguments: {} });
    expect(r).toEqual({ status: 200, body: { content: [{ type: "text", text: reauthText("locked") }], isError: true } });
    // The card is posted off the request path.
    for (let i = 0; i < 100 && posts.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    expect(posts).toHaveLength(1);
    const card = posts[0];
    expect(card).toMatchObject({ channel: "C0TEAM", thread_ts: "500.0" });
    expect(JSON.stringify(card)).not.toContain(LEAKY_BODY);
    const button = card.blocks[1].elements[0];
    expect(button.text.text).toBe("Connect locked");
    const gate = await PendingGates.get(String(button.action_id).replace("slaude_mcp:connect:", ""));
    expect(gate).toMatchObject({ kind: "mcp_connect", sessionId: "S-card", status: "pending" });
    expect(gate!.payload).toMatchObject({ serverName: "locked", scope: "global", userId: WORLD.manager, channelId: "C0TEAM", threadTs: "500.0" });
    // Once per (session, server) per window.
    await mcpx("locked/call", { name: "whoami", arguments: {} });
    await new Promise((res) => setTimeout(res, 50));
    expect(posts).toHaveLength(1);
  });
});
