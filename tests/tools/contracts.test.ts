/**
 * Contract snapshot tests (spec §3 "Shared contracts", §8).
 *
 * What these tests guarantee — and what they don't:
 *
 *   GUARANTEED: mount/omission/import drift. A fully-capable server must
 *   register exactly the contract's tool list (no forgotten tool, no extra
 *   tool, conditional gating verified), and each registered tool's
 *   description + JSON schema must be byte-identical to registering the
 *   contract entry through the same SDK `tool()` pipeline — which catches a
 *   builder that stops importing from the contract (e.g. reverts to a local
 *   inline schema that then drifts).
 *
 *   NOT the job of this file: contract-vs-handler field renames/retypes.
 *   Because the builders and REST executors pass schema-inferred args
 *   straight into the handlers, tsc catches those at compile time (see
 *   parseToolArgs in src/tools/contracts/types.ts).
 *
 * The expected side is produced by registering the contract itself through
 * the same SDK pipeline over an in-memory MCP transport, so both sides use
 * the identical zod → JSON-schema serializer: any diff is genuine drift,
 * never a serializer difference.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

import { surfaceContract } from "../../src/tools/contracts/surface";
import { slackContract } from "../../src/tools/contracts/slack";
import { runtimeContract } from "../../src/tools/contracts/runtime";
import { connectContract } from "../../src/tools/contracts/connect";
import { skillsContract } from "../../src/tools/contracts/skills";
import { kbContract } from "../../src/tools/contracts/kb";
import { mcpMountedTools, type ServerContract } from "../../src/tools/contracts/types";

import { createSurfaceMcp } from "../../src/gateway/core/surface-mcp";
import { createSlackMcp, createRuntimeMcp, createConnectMcp, type SlackContext } from "../../src/gateway/slack/mcp-tools";
import { createSkillsMcp } from "../../src/skills/mcp-tools";
import { createKbMcp, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import type { Surface, SurfaceCapability } from "../../src/gateway/core/surface";

type ListedTool = { name: string; description?: string; inputSchema: unknown };

async function listRegistered(cfg: McpSdkServerConfigWithInstance): Promise<Map<string, ListedTool>> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  await client.connect(clientT);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema }]));
  } finally {
    await client.close();
  }
}

/** Register the contract itself through the same SDK pipeline → expected shapes.
 *  restOnly tools are REST-plane plumbing (node internals) — never MCP-mounted. */
function referenceServer(contract: ServerContract): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: `${contract.server}-contract-ref`,
    version: "0.0.0",
    tools: mcpMountedTools(contract).map((t) =>
      tool(t.name, t.description, t.schema, async () => ({ content: [] })),
    ),
  });
}

async function assertMatchesContract(real: McpSdkServerConfigWithInstance, contract: ServerContract) {
  const registered = await listRegistered(real);
  const expected = await listRegistered(referenceServer(contract));

  // Tool list: the fully-capable server mounts exactly the contract's
  // MCP-mounted tools (restOnly entries live on the REST plane only).
  expect([...registered.keys()].sort()).toEqual(mcpMountedTools(contract).map((t) => t.name).sort());

  // Shape: description + JSON schema identical for every tool.
  for (const [name, exp] of expected) {
    const got = registered.get(name)!;
    expect(got.description).toEqual(exp.description);
    expect(got.inputSchema).toEqual(exp.inputSchema);
  }
}

function fullSurface(): Surface {
  const cap = new Set<SurfaceCapability>(["edit", "react", "upload", "typing"]);
  const s: any = {
    id: "contract-fake",
    capabilities: cap,
    reply: async () => ({ ref: "R1" }),
    getHistory: async () => ({ messages: [], hasMore: false }),
    requestApproval: async () => ({ approved: true, by: "U1" }),
    edit: async () => {},
    react: async () => {},
    unreact: async () => {},
    upload: async () => {},
    typing: async () => {},
  };
  return s as Surface;
}

function fakeCtx(): SlackContext {
  return {
    client: {} as any,
    channel: "C1",
    threadTs: "1.0",
    inboundTs: "1.0",
    userId: "U1",
  };
}

const fakeBrainDeps: BrainToolDeps = {
  scope: () => ({ sourceId: "agent-test", searchSourceIds: [] }) as any,
  gate: () => ({ userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: true, agentId: "A", threadKey: "C1:1.0" }) as any,
  managers: () => ["U1"],
  requestApproval: async () => ({ approved: true, by: "U1" }) as any,
};

describe("contract snapshots — MCP servers register exactly what the contracts declare", () => {
  test("slaude_surface", async () => {
    const real = createSurfaceMcp(fullSurface(), {
      initiator: () => "U1",
      setOneOnOne: async () => "ok",
      setMentionOnly: async () => "ok",
    });
    await assertMatchesContract(real, surfaceContract);
  });

  test("slaude_slack", async () => {
    await assertMatchesContract(createSlackMcp(fakeCtx()), slackContract);
  });

  test("slaude_runtime", async () => {
    await assertMatchesContract(createRuntimeMcp(fakeCtx()), runtimeContract);
  });

  test("slaude_connect", async () => {
    await assertMatchesContract(createConnectMcp({ connect: async () => "ok" }), connectContract);
  });

  test("slaude_skills", async () => {
    await assertMatchesContract(createSkillsMcp(), skillsContract);
  });

  test("slaude_kb (brain enabled + deps)", async () => {
    const prev = process.env.SLAUDE_BRAIN_DISABLED;
    delete process.env.SLAUDE_BRAIN_DISABLED;
    try {
      await assertMatchesContract(createKbMcp(fakeBrainDeps), kbContract);
    } finally {
      if (prev !== undefined) process.env.SLAUDE_BRAIN_DISABLED = prev;
    }
  });

  test("slaude_kb (brain disabled) mounts only the KB catalog tools", async () => {
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    try {
      const registered = await listRegistered(createKbMcp(fakeBrainDeps));
      expect([...registered.keys()].sort()).toEqual(["list_kbs", "search_kbs"]);
    } finally {
      delete process.env.SLAUDE_BRAIN_DISABLED;
    }
  });
});
