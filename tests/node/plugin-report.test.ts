import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginReport, isPluginSealed, reportNodePlugins } from "../../src/node/plugin-report";
import { NodeClient } from "../../src/node/client";
import { paths } from "../../src/config/home";
import { loadInstalledPluginPaths } from "../../src/config/plugins";
import { STATE_INVALID_URL, STATE_NEEDS_HEADERS, STATE_OFFERABLE, STATE_SSE, STATE_WRITABLE } from "../../src/config/plugin-inventory";

const asRoot = process.getuid?.() === 0;
let tree: string;
let root: string;
const manifest = { servers: { "declared-tool": { command: "x", args: [], env: {} } } };

function plugin(mcp: unknown, name = "toolkit") {
  const dir = join(root, "plugins", "cache", "market", name, "1.0.0");
  mkdirSync(join(dir, "skills", "greet"), { recursive: true });
  writeFileSync(join(dir, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\n");
  mkdirSync(join(dir, "commands", "sub"), { recursive: true });
  writeFileSync(join(dir, "commands", "one.md"), "x");
  writeFileSync(join(dir, "commands", "sub", "two.md"), "x");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "helper.md"), "x");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{}, {}], PreToolUse: [{}] } }));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp));
  writeFileSync(
    join(root, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { [`${name}@market`]: [{ scope: "user", installPath: dir, version: "1.0.0", gitCommitSha: "abc1234def" }] } }),
  );
  return dir;
}

/** Seal the tree read-only (what an image-owned root is to a non-root user). */
function seal(dir: string) {
  const walk = (d: string) => {
    chmodSync(d, 0o555);
  };
  for (const p of [root, join(root, "plugins"), join(root, "plugins", "cache"), join(root, "plugins", "cache", "market"), join(root, "plugins", "cache", "market", "toolkit"), dir]) walk(p);
  chmodSync(join(dir, ".mcp.json"), 0o444);
  chmodSync(join(root, "plugins", "installed_plugins.json"), 0o444);
}

function unseal() {
  const walk = (d: string) => {
    try { chmodSync(d, 0o755); } catch { /* gone */ }
  };
  walk(root);
  walk(join(root, "plugins"));
  walk(join(root, "plugins", "cache"));
  walk(join(root, "plugins", "cache", "market"));
  walk(join(root, "plugins", "cache", "market", "toolkit"));
  walk(join(root, "plugins", "cache", "market", "toolkit", "1.0.0"));
}

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "plugin-tree-"));
  root = join(tree, "root");
  mkdirSync(join(root, "plugins"), { recursive: true });
  process.env.SLAUDE_PLUGIN_ROOT = root;
});

afterEach(() => {
  unseal();
  delete process.env.SLAUDE_PLUGIN_ROOT;
  rmSync(tree, { recursive: true, force: true });
  rmSync(join(paths.claudeConfig, "plugins"), { recursive: true, force: true });
});

describe("loader", () => {
  test("plugins under SLAUDE_PLUGIN_ROOT are mounted", () => {
    const dir = plugin({});
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path: dir }]);
  });

  test("the root shadows the same plugin key in $SLAUDE_HOME", () => {
    const dir = plugin({});
    const legacy = join(paths.claudeConfig, "plugins", "cache", "market", "toolkit", "9");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(paths.claudeConfig, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "toolkit@market": [{ installPath: legacy }] } }),
    );
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path: dir }]);
  });

  test("the existing location keeps working when the root is unset", () => {
    delete process.env.SLAUDE_PLUGIN_ROOT;
    const legacy = join(paths.claudeConfig, "plugins", "cache", "market", "old", "1");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(paths.claudeConfig, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "old@market": [{ installPath: legacy }] } }));
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path: legacy }]);
  });
});

describe("the report carries no secrets", () => {
  test("no header or env value, no URL userinfo, query or fragment", () => {
    plugin({
      mcpServers: {
        secured: { type: "http", url: "https://u:PASSWORD@mcp.example.com/path?key=QUERY_SECRET#FRAGMENT", headers: { Authorization: "Bearer HEADER_SECRET" } },
        plain: { type: "http", url: "https://user:PW2@open.example.com/mcp?x=QUERY2" },
        local: { command: "x", env: { TOKEN: "ENV_SECRET" }, args: ["--key", "ARG_SECRET"] },
      },
    });
    const report = buildPluginReport({ manifest });
    const text = JSON.stringify(report);
    for (const secret of ["PASSWORD", "QUERY_SECRET", "FRAGMENT", "HEADER_SECRET", "ENV_SECRET", "ARG_SECRET", "PW2", "QUERY2"]) {
      expect(text).not.toContain(secret);
    }
    const p = report.plugins[0]!;
    expect(p.http.map((h) => [h.name, h.url])).toEqual([
      ["plain", "https://open.example.com/mcp"],
      ["secured", "https://mcp.example.com/path"],
    ]);
  });

  test("a URL holding a placeholder is not offered, and a server with headers needs them", () => {
    plugin({
      mcpServers: {
        needsHeader: { type: "http", url: "https://h.example.com/mcp", headers: { "X-Key": "${KEY}" } },
        templated: { type: "http", url: "https://t.example.com/${SECRET_PATH}/mcp" },
        notHttps: { type: "http", url: "http://h.example.com/mcp" },
        broken: { type: "http", url: "not a url" },
        ess: { type: "sse", url: "https://s.example.com/sse" },
      },
    });
    const byName = Object.fromEntries(buildPluginReport({ manifest }).plugins[0]!.http.map((h) => [h.name, h.state]));
    expect(byName).toEqual({
      needsHeader: STATE_NEEDS_HEADERS,
      templated: STATE_INVALID_URL,
      notHttps: STATE_INVALID_URL,
      broken: STATE_INVALID_URL,
      ess: STATE_SSE,
    });
    expect(JSON.stringify(buildPluginReport({ manifest }))).not.toContain("${SECRET_PATH");
  });

  test("counts contents, marks whether the node manifest declares each stdio server", () => {
    plugin({ mcpServers: { "declared-tool": { command: "a" }, unknown: { command: "b" } } });
    const p = buildPluginReport({ manifest }).plugins[0]!;
    expect(p).toMatchObject({ name: "toolkit", marketplace: "market", commit: "abc1234def", skills: 1, commands: 2, agents: 1, hooks: 3 });
    expect(p.stdio).toEqual([{ name: "declared-tool", declared: true }, { name: "unknown", declared: false }]);
  });

  test("a node without SLAUDE_PLUGIN_ROOT reports, with no HTTP server offered", () => {
    delete process.env.SLAUDE_PLUGIN_ROOT;
    const legacy = join(paths.claudeConfig, "plugins", "cache", "market", "old", "1");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".mcp.json"), JSON.stringify({ mcpServers: { s: { type: "http", url: "https://x.example.com/mcp" } } }));
    writeFileSync(join(paths.claudeConfig, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "old@market": [{ installPath: legacy }] } }));
    expect(buildPluginReport({ manifest }).plugins[0]!.http).toEqual([{ name: "s", url: "https://x.example.com/mcp", state: STATE_WRITABLE }]);
  });
});

describe("the sealed check", () => {
  const entry = (dir: string, overrides: Record<string, unknown> = {}) => ({
    path: dir,
    listedIn: join(root, "plugins", "installed_plugins.json"),
    imageOwned: true,
    ...overrides,
  });

  test.skipIf(asRoot)("a read-only tree passes, a writable tree fails", () => {
    const dir = plugin({ mcpServers: { s: { type: "http", url: "https://x.example.com/mcp" } } });
    expect(isPluginSealed(entry(dir), root, { boundary: tree })).toBe(false); // still writable
    seal(dir);
    expect(isPluginSealed(entry(dir), root, { boundary: tree })).toBe(true);
    const report = buildPluginReport({ manifest, sealed: { boundary: tree } });
    expect(report.plugins[0]!.http[0]!.state).toBe(STATE_OFFERABLE);
  });

  test.skipIf(asRoot)("a writable .mcp.json fails even in a read-only directory", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    chmodSync(join(dir, ".mcp.json"), 0o644);
    expect(isPluginSealed(entry(dir), root, { boundary: tree })).toBe(false);
  });

  test.skipIf(asRoot)("a writable installed_plugins.json fails", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    chmodSync(join(root, "plugins", "installed_plugins.json"), 0o644);
    expect(isPluginSealed(entry(dir), root, { boundary: tree })).toBe(false);
  });

  test.skipIf(asRoot)("a writable ancestor directory fails: it lets a process swap the tree", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    chmodSync(join(root, "plugins", "cache", "market"), 0o755);
    expect(isPluginSealed(entry(dir), root, { boundary: tree })).toBe(false);
  });

  test.skipIf(asRoot)("a root process fails, even on a read-only tree", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    expect(isPluginSealed(entry(dir), root, { uid: 0, boundary: tree })).toBe(false);
  });

  test("a plugin outside the image-owned root is not sealed", () => {
    const dir = plugin({ mcpServers: {} });
    expect(isPluginSealed(entry(dir, { imageOwned: false }), root, { boundary: tree })).toBe(false);
    expect(isPluginSealed(entry(dir), null, { boundary: tree })).toBe(false);
  });

  test.skipIf(asRoot)("a plugin directory that resolves outside the root is not sealed", () => {
    const outside = mkdtempSync(join(tree, "outside-"));
    writeFileSync(join(outside, ".mcp.json"), "{}");
    expect(isPluginSealed(entry(outside), root, { boundary: tree })).toBe(false);
  });
});

describe("reportNodePlugins", () => {
  test("an older gateway (404) does not stop the node", async () => {
    plugin({});
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.join()).toContain("predates");
  });

  test("a gateway failure is logged and never thrown", async () => {
    plugin({});
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.length).toBe(1);
  });

  test("a 413 is logged, not thrown", async () => {
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("big", { status: 413 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.join()).toContain("too large");
  });
});
