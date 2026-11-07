/**
 * Memory tool names (spec "Memory (rebrand of kb)"): every memory tool mounts
 * under its memory_* name and keeps its old kb_* name as an alias with the
 * same schema and handler, because a resumed session keeps calling the names
 * it saw before. The allowlists that name a memory tool (auto-allow, the
 * profile write guard, the built-in skill gate) treat both names alike.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  canonicalMemoryTool,
  kbContract,
  MEMORY_TOOL_ALIASES,
  memoryToolIdTwin,
  memoryToolTwin,
} from "../../src/tools/contracts/kb";
import { createKbMcp, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { autoAllowFromEnv, permissionPolicy } from "../../src/gateway/slack/permission-gate";
import {
  denySyntheticProfileWrite,
  KB_MEMOIZE_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_WRITE_TOOLS,
  SYNTHETIC_PROFILE_DENIAL,
} from "../../src/agent/profile-write-guard";
import { builtinGoverning } from "../../src/soul/builtin";
import { wakeAllows, wakeDeniedToolIds } from "../../src/proactive/wake-guard";

const PAIRS = Object.entries(MEMORY_TOOL_ALIASES) as Array<[keyof typeof MEMORY_TOOL_ALIASES, string]>;
const tools = kbContract.tools as Record<string, { name: string; description: string; schema: unknown }>;
const OLD_NAMES = /\b(kb_search|kb_think|kb_get_page|kb_list_pages|kb_memoize|kb_delete_page|kb_graph|kb_thread_history|list_kbs|search_kbs)\b/;

describe("memory tool contract", () => {
  test("the alias table is the spec's ten pairs; memory_about has no alias", () => {
    expect(MEMORY_TOOL_ALIASES).toEqual({
      memory_search: "kb_search",
      memory_think: "kb_think",
      memory_get: "kb_get_page",
      memory_list: "kb_list_pages",
      memory_save: "kb_memoize",
      memory_delete: "kb_delete_page",
      memory_graph: "kb_graph",
      memory_thread_history: "kb_thread_history",
      memory_stores: "list_kbs",
      memory_search_stores: "search_kbs",
    });
    expect(memoryToolTwin("memory_about")).toBeNull();
    expect(Object.keys(kbContract.tools).sort()).toEqual(
      [...PAIRS.flat(), "memory_about"].sort(),
    );
  });

  test("both names are declared, keyed by their own name, with the same schema object", () => {
    for (const [memory, alias] of PAIRS) {
      expect(tools[memory]!.name).toBe(memory);
      expect(tools[alias]!.name).toBe(alias);
      expect(tools[alias]!.schema).toBe(tools[memory]!.schema);
    }
  });

  test("an alias says it is a deprecated alias of its memory name", () => {
    for (const [memory, alias] of PAIRS) {
      expect(tools[alias]!.description.startsWith(`Alias of ${memory} (deprecated).`)).toBe(true);
    }
  });

  test("the memory_* descriptions never name an old tool name", () => {
    for (const [memory] of PAIRS) expect(tools[memory]!.description).not.toMatch(OLD_NAMES);
    expect(tools.memory_about!.description).not.toMatch(OLD_NAMES);
  });

  test("name helpers map both ways, bare and as a CLI tool id", () => {
    for (const [memory, alias] of PAIRS) {
      expect(canonicalMemoryTool(alias)).toBe(memory);
      expect(canonicalMemoryTool(memory)).toBe(memory);
      expect(memoryToolTwin(memory)).toBe(alias);
      expect(memoryToolTwin(alias)).toBe(memory);
      expect(memoryToolIdTwin(`mcp__slaude_kb__${memory}`)).toBe(`mcp__slaude_kb__${alias}`);
      expect(memoryToolIdTwin(`mcp__slaude_kb__${alias}`)).toBe(`mcp__slaude_kb__${memory}`);
    }
    expect(canonicalMemoryTool("memory_about")).toBe("memory_about");
    expect(memoryToolIdTwin("mcp__other__kb_memoize")).toBeNull();
    expect(memoryToolIdTwin("mcp__slaude_kb__memory_about")).toBeNull();
    // Own keys only: a prototype member is not a tool name.
    expect(memoryToolTwin("constructor")).toBeNull();
    expect(canonicalMemoryTool("toString")).toBe("toString");
  });
});

async function connect(cfg: McpSdkServerConfigWithInstance): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "alias-test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

describe("the slaude_kb MCP server", () => {
  const prev = process.env.SLAUDE_BRAIN_DISABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.SLAUDE_BRAIN_DISABLED;
    else process.env.SLAUDE_BRAIN_DISABLED = prev;
  });

  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const deps: BrainToolDeps = {
    scope: () => ({ clientId: "c", sourceId: "agent-test", allowedSources: ["agent-test"] }) as any,
    gate: () => ({ userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: true, agentId: "A", threadKey: "C1:1.0" }) as any,
    managers: () => ["U1"],
    requestApproval: async () => ({ approved: true, by: "U1" }) as any,
    call: async (name, params) => {
      calls.push({ name, params });
      if (name === "get_page") return { slug: params.slug, content: "page body" };
      if (name === "list_pages") return [{ slug: "notes/a" }];
      return null;
    },
  };

  test("mounts every memory name and its alias with the same input schema", async () => {
    delete process.env.SLAUDE_BRAIN_DISABLED;
    const client = await connect(createKbMcp(deps));
    try {
      const listed = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
      for (const [memory, alias] of PAIRS) {
        expect(listed.has(memory)).toBe(true);
        expect(listed.has(alias)).toBe(true);
        expect(listed.get(alias)!.inputSchema).toEqual(listed.get(memory)!.inputSchema);
      }
      expect(listed.has("memory_about")).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("an old-name call runs the same handler as the new name", async () => {
    delete process.env.SLAUDE_BRAIN_DISABLED;
    const client = await connect(createKbMcp(deps));
    try {
      calls.length = 0;
      const viaNew = await client.callTool({ name: "memory_get", arguments: { slug: "notes/x" } });
      const viaOld = await client.callTool({ name: "kb_get_page", arguments: { slug: "notes/x" } });
      expect(viaOld).toEqual(viaNew);
      expect(calls).toEqual([
        { name: "get_page", params: { slug: "notes/x" } },
        { name: "get_page", params: { slug: "notes/x" } },
      ]);
      const listNew = await client.callTool({ name: "memory_list", arguments: {} });
      const listOld = await client.callTool({ name: "kb_list_pages", arguments: {} });
      expect(listOld).toEqual(listNew);
    } finally {
      await client.close();
    }
  });

  test("brain disabled: the store tools mount under both names", async () => {
    process.env.SLAUDE_BRAIN_DISABLED = "1";
    const client = await connect(createKbMcp(deps));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(["list_kbs", "memory_search_stores", "memory_stores", "search_kbs"]);
      const a = await client.callTool({ name: "memory_stores", arguments: {} });
      const b = await client.callTool({ name: "list_kbs", arguments: {} });
      expect(b).toEqual(a);
    } finally {
      await client.close();
    }
  });
});

describe("SLAUDE_AUTO_ALLOW_TOOLS expands memory aliases both ways", () => {
  const prev = process.env.SLAUDE_AUTO_ALLOW_TOOLS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SLAUDE_AUTO_ALLOW_TOOLS;
    else process.env.SLAUDE_AUTO_ALLOW_TOOLS = prev;
  });

  test("the new name allows the alias", () => {
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "mcp__slaude_kb__memory_save";
    expect(autoAllowFromEnv()).toEqual(new Set(["mcp__slaude_kb__memory_save", "mcp__slaude_kb__kb_memoize"]));
  });

  test("the alias allows the new name", () => {
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "Bash, mcp__slaude_kb__list_kbs";
    expect(autoAllowFromEnv()).toEqual(new Set(["Bash", "mcp__slaude_kb__list_kbs", "mcp__slaude_kb__memory_stores"]));
  });

  test("bare names expand too; other names are left alone", () => {
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "kb_think,memory_about,mcp__other__kb_search";
    expect(autoAllowFromEnv()).toEqual(new Set(["kb_think", "memory_think", "memory_about", "mcp__other__kb_search"]));
  });

  test("the expanded set allows either name in the static policy", () => {
    process.env.SLAUDE_AUTO_ALLOW_TOOLS = "mcp__slaude_kb__kb_delete_page";
    const allow = autoAllowFromEnv();
    for (const t of ["mcp__slaude_kb__kb_delete_page", "mcp__slaude_kb__memory_delete"]) {
      expect(permissionPolicy(t, { slug: "s" }, allow)).toEqual({ behavior: "allow", updatedInput: { slug: "s" } });
    }
  });
});

describe("allowlists name both memory names", () => {
  const hookCall = (hook: ReturnType<typeof denySyntheticProfileWrite>, input: Record<string, unknown>) =>
    hook({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/t", cwd: "/w", ...input } as any, "tu", { signal: new AbortController().signal });

  test("the profile write guard denies a synthetic profile write under either name", async () => {
    expect(MEMORY_SAVE_TOOL).toBe("mcp__slaude_kb__memory_save");
    expect(KB_MEMOIZE_TOOL).toBe("mcp__slaude_kb__kb_memoize");
    expect([...MEMORY_WRITE_TOOLS].sort()).toEqual([KB_MEMOIZE_TOOL, MEMORY_SAVE_TOOL].sort());
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: SYNTHETIC_PROFILE_DENIAL } };
    for (const tool_name of [MEMORY_SAVE_TOOL, KB_MEMOIZE_TOOL]) {
      expect(await hookCall(denySyntheticProfileWrite(() => true), { tool_name, tool_input: { target: "profile" } })).toEqual(deny);
      expect(await hookCall(denySyntheticProfileWrite(() => false), { tool_name, tool_input: { target: "profile" } })).toEqual({});
      expect(await hookCall(denySyntheticProfileWrite(() => true), { tool_name, tool_input: { target: "mine" } })).toEqual({});
    }
  });

  test("the memory skill governs memory_save and its alias", () => {
    expect(builtinGoverning("mcp__slaude_kb__memory_save")?.qualified).toBe("slaude:memory");
    expect(builtinGoverning("mcp__slaude_kb__kb_memoize")?.qualified).toBe("slaude:memory");
    expect(builtinGoverning("mcp__slaude_kb__memory_search")).toBeNull();
    expect(builtinGoverning("mcp__slaude_kb__kb_search")).toBeNull();
  });

  test("a wake may call every memory tool under either name", () => {
    for (const [memory, alias] of PAIRS) {
      expect(wakeAllows("kb", memory)).toBe(true);
      expect(wakeAllows("kb", alias)).toBe(true);
    }
    expect(wakeDeniedToolIds().filter((id) => id.startsWith("mcp__slaude_kb__"))).toEqual([]);
  });
});
