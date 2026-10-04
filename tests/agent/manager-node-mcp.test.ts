/**
 * AgentManager's MCP merge on a node (node labels spec §4.10): with a local
 * (node manifest) resolver installed, plugin MCP servers are not read from
 * disk, the transport resolver's servers are merged last and win a collision,
 * strictMcpConfig is set, and the <mcp-servers> block lists exactly the merged
 * map. Without one (mono, gateway) nothing changes.
 * Same SDK-stub approach as manager-remote.test.ts (see the mock.module note
 * in manager-lifecycle.test.ts).
 */
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.SLAUDE_MEMORY = "sqlite";
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
let captured: any[] = [];
let currentQuery: (args: QueryArgs) => any = () => {
  throw new Error("no query installed");
};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => currentQuery(args),
}));

const { AgentManager } = await import("../../src/agent/manager");
const { paths } = await import("../../src/config/home");

/** A query that records its options and ends when the prompt iterable closes. */
function recordingQuery({ prompt, options }: QueryArgs) {
  captured.push(options);
  let done = false;
  const waker: { wake: (() => void) | null } = { wake: null };
  (async () => {
    for await (const _ of prompt) {
      /* drain */
    }
    done = true;
    waker.wake?.();
  })();
  return {
    async *[Symbol.asyncIterator]() {
      while (!done) await new Promise<void>((r) => (waker.wake = r));
    },
    setPermissionMode: async () => ({}),
    mcpServerStatus: async () => [],
    interrupt: async () => {},
  };
}

let seq = 0;
const thread = () => ({ team_id: "T1", channel_id: "C1", thread_ts: `${Date.now()}.${++seq}` });

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}

async function boot(mgr: InstanceType<typeof AgentManager>): Promise<any> {
  const row = await mgr.ensureSession(thread());
  const before = captured.length;
  await mgr.sendMessage(row.id, "hello");
  await until(() => captured.length > before);
  const opts = captured[captured.length - 1];
  mgr.reload(row.id);
  await until(() => !mgr.isLive(row.id));
  return opts;
}

/** The names the <mcp-servers> block lists, and whether it points at other sources. */
function promptBlock(options: any): { names: string[]; mentionsMcpJson: boolean; none: boolean } {
  const m = /<mcp-servers>([\s\S]*?)<\/mcp-servers>/.exec(options.systemPrompt.append);
  const body = m?.[1] ?? "";
  return {
    names: [...body.matchAll(/^- (.+)$/gm)].map((x) => x[1]!),
    mentionsMcpJson: body.includes(".mcp.json"),
    none: /<mcp-servers>none<\/mcp-servers>/.test(options.systemPrompt.append),
  };
}

// An installed plugin that ships a stdio MCP server in its .mcp.json.
const pluginsDir = join(paths.claudeConfig, "plugins");
const pluginPath = join(pluginsDir, "cache", "mp", "tools-plugin", "1.0.0");
function installPlugin() {
  mkdirSync(pluginPath, { recursive: true });
  writeFileSync(join(pluginPath, ".mcp.json"), JSON.stringify({ mcpServers: { "plugin-srv": { command: "plugin-mcp" } } }));
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "tools-plugin@mp": [{ scope: "user", installPath: pluginPath }] } }),
  );
}

const stdio = (command: string) => ({ type: "stdio" as const, command, args: [], env: {} });

beforeEach(() => {
  captured = [];
  currentQuery = recordingQuery;
  rmSync(pluginsDir, { recursive: true, force: true });
  installPlugin();
});
afterAll(() => rmSync(pluginsDir, { recursive: true, force: true }));

describe("node MCP merge (local resolver installed)", () => {
  it("resolver output last wins a collision with a warning; strict; prompt block = merged map", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mgr = new AgentManager();
      mgr.setMcpResolver(() => ({ slaude_session: stdio("gateway-session"), gh: stdio("gateway-gh") }));
      mgr.setLocalMcpResolver(async () => ({ gh: stdio("manifest-gh"), tf: stdio("manifest-tf") }));
      const opts = await boot(mgr);
      expect(Object.keys(opts.mcpServers).sort()).toEqual(["gh", "slaude_session", "tf"]);
      expect(opts.mcpServers.gh.command).toBe("gateway-gh");
      expect(opts.mcpServers.tf.command).toBe("manifest-tf");
      expect(opts.strictMcpConfig).toBe(true);
      const block = promptBlock(opts);
      expect(block.names.sort()).toEqual(Object.keys(opts.mcpServers).sort());
      expect(block.mentionsMcpJson).toBe(false);
      const warned = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("node manifest"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("'gh'");
    } finally {
      warn.mockRestore();
    }
  });

  it("an installed plugin's MCP server is not mounted; the plugin itself still loads, without MCP discovery", async () => {
    const mgr = new AgentManager();
    mgr.setMcpResolver(() => ({ slaude_session: stdio("s") }));
    mgr.setLocalMcpResolver(async () => ({ gh: stdio("manifest-gh") }));
    const opts = await boot(mgr);
    expect(opts.mcpServers["plugin-srv"]).toBeUndefined();
    expect(Object.keys(opts.mcpServers).sort()).toEqual(["gh", "slaude_session"]);
    const plugin = opts.plugins.find((p: any) => p.path === pluginPath);
    expect(plugin).toEqual({ type: "local", path: pluginPath, skipMcpDiscovery: true });
    expect(promptBlock(opts).names).not.toContain("plugin-srv");
  });

  it("a persona the manifest gives nothing: only the resolver's servers", async () => {
    const mgr = new AgentManager();
    mgr.setMcpResolver(() => ({ slaude_session: stdio("s") }));
    mgr.setLocalMcpResolver(async () => ({}));
    const opts = await boot(mgr);
    expect(Object.keys(opts.mcpServers)).toEqual(["slaude_session"]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(promptBlock(opts).names).toEqual(["slaude_session"]);
  });

  it("nothing at all: no mcpServers, still strict, block says none", async () => {
    const mgr = new AgentManager();
    mgr.setLocalMcpResolver(async () => undefined);
    const opts = await boot(mgr);
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.strictMcpConfig).toBe(true);
    expect(promptBlock(opts).none).toBe(true);
  });

  it("the block lists the remote server when the session runs remotely", async () => {
    const mgr = new AgentManager();
    mgr.setMcpResolver(() => ({ slaude_session: stdio("s") }));
    mgr.setLocalMcpResolver(async () => ({}));
    const noopExec = async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false });
    mgr.setRemote(
      async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" }),
      () => ({ exec: noopExec, release: async () => {}, dispose: async () => {} }),
    );
    const opts = await boot(mgr);
    expect(Object.keys(opts.mcpServers).sort()).toEqual(["remote", "slaude_session"]);
    expect(promptBlock(opts).names.sort()).toEqual(["remote", "slaude_session"]);
  });

  it("a local resolver failure fails the boot", async () => {
    const mgr = new AgentManager();
    mgr.setLocalMcpResolver(async () => {
      throw new Error("403 job token is not scoped to this persona");
    });
    const row = await mgr.ensureSession(thread());
    await expect(mgr.sendMessage(row.id, "hi")).rejects.toThrow("403");
    expect(mgr.isLive(row.id)).toBe(false);
  });
});

describe("mono (no local resolver): unchanged", () => {
  it("plugin MCP mounted after the resolver, not strict, block lists the resolver map and mentions .mcp.json", async () => {
    const mgr = new AgentManager();
    mgr.setMcpResolver(() => ({ fake: stdio("gateway-fake"), "plugin-srv": stdio("gateway-plugin") }));
    const opts = await boot(mgr);
    expect(opts.mcpServers["plugin-srv"].command).toBe("plugin-mcp"); // today: plugin wins
    expect(opts.mcpServers.fake).toBeDefined();
    expect(opts.strictMcpConfig).toBeUndefined();
    expect(opts.plugins.find((p: any) => p.path === pluginPath)).toEqual({ type: "local", path: pluginPath });
    const block = promptBlock(opts);
    expect(block.names.sort()).toEqual(["fake", "plugin-srv"]);
    expect(block.mentionsMcpJson).toBe(true);
  });
});
