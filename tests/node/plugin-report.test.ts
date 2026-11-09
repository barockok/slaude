import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginReport, isPluginSealed, reportNodePlugins } from "../../src/node/plugin-report";
import { NodeClient } from "../../src/node/client";
import { paths } from "../../src/config/home";
import { loadInstalledPluginPaths } from "../../src/config/plugins";
import { loadDotenv } from "../../src/config/env";
import { STATE_INVALID_URL, STATE_NEEDS_HEADERS, STATE_OFFERABLE, STATE_SSE, STATE_URL_SECRETS, STATE_WRITABLE } from "../../src/config/plugin-inventory";

const asRoot = process.getuid?.() === 0;
let tree: string;
let root: string;
let above: string;
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

const chain = () => [above, root, join(root, "plugins"), join(root, "plugins", "cache"), join(root, "plugins", "cache", "market"), join(root, "plugins", "cache", "market", "toolkit")];

/** Make the tree read-only. Tests cannot create root-owned files, so a test also
 *  passes `asRootOwned` to say who owns them; the mode bits are real. */
function seal(dir: string) {
  for (const p of [...chain(), dir]) chmodSync(p, 0o555);
  chmodSync(join(dir, ".mcp.json"), 0o444);
  chmodSync(join(root, "plugins", "installed_plugins.json"), 0o444);
}

function unseal() {
  for (const p of [...chain(), join(root, "plugins", "cache", "market", "toolkit", "1.0.0")]) {
    try { chmodSync(p, 0o755); } catch { /* gone */ }
  }
}

const asRootOwned = () => 0;

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "plugin-tree-"));
  above = join(tree, "above");
  root = join(above, "root");
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

describe("SLAUDE_PLUGIN_ROOT and .env", () => {
  test("a .env file can never set it: only the real process environment", () => {
    delete process.env.SLAUDE_PLUGIN_ROOT;
    const file = join(tree, "agent.env");
    writeFileSync(file, `SLAUDE_PLUGIN_ROOT=${tree}/attacker\nPLUGIN_DOTENV_CONTROL=seen\n`);
    loadDotenv(file);
    expect(process.env.SLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(process.env.PLUGIN_DOTENV_CONTROL).toBe("seen");
    delete process.env.PLUGIN_DOTENV_CONTROL;
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
    const report = buildPluginReport({ instance: "p1", manifest });
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
        withQuery: { type: "http", url: "https://q.example.com/mcp?tenant=one" },
        withUser: { type: "http", url: "https://user:pw@q.example.com/mcp" },
        notHttps: { type: "http", url: "http://h.example.com/mcp" },
        broken: { type: "http", url: "not a url" },
        ess: { type: "sse", url: "https://s.example.com/sse" },
      },
    });
    const byName = Object.fromEntries(buildPluginReport({ instance: "p1", manifest }).plugins[0]!.http.map((h) => [h.name, h.state]));
    expect(byName).toEqual({
      needsHeader: STATE_NEEDS_HEADERS,
      withQuery: STATE_URL_SECRETS,
      withUser: STATE_URL_SECRETS,
      templated: STATE_INVALID_URL,
      notHttps: STATE_INVALID_URL,
      broken: STATE_INVALID_URL,
      ess: STATE_SSE,
    });
    expect(JSON.stringify(buildPluginReport({ instance: "p1", manifest }))).not.toContain("${SECRET_PATH");
  });

  test("counts contents, marks whether the node manifest declares each stdio server", () => {
    plugin({ mcpServers: { "declared-tool": { command: "a" }, unknown: { command: "b" } } });
    const p = buildPluginReport({ instance: "p1", manifest }).plugins[0]!;
    expect(p).toMatchObject({ name: "toolkit", marketplace: "market", commit: "abc1234def", skills: 1, commands: 2, agents: 1, hooks: 3 });
    expect(p.stdio).toEqual([{ name: "declared-tool", declared: true }, { name: "unknown", declared: false }]);
  });

  test("a node without SLAUDE_PLUGIN_ROOT reports, with no HTTP server offered", () => {
    delete process.env.SLAUDE_PLUGIN_ROOT;
    const legacy = join(paths.claudeConfig, "plugins", "cache", "market", "old", "1");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".mcp.json"), JSON.stringify({ mcpServers: { s: { type: "http", url: "https://x.example.com/mcp" } } }));
    writeFileSync(join(paths.claudeConfig, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "old@market": [{ installPath: legacy }] } }));
    expect(buildPluginReport({ instance: "p1", manifest }).plugins[0]!.http).toEqual([{ name: "s", url: "https://x.example.com/mcp", state: STATE_WRITABLE }]);
  });
});

describe("the sealed check", () => {
  const entry = (dir: string, overrides: Record<string, unknown> = {}) => ({
    path: dir,
    listedIn: join(root, "plugins", "installed_plugins.json"),
    imageOwned: true,
    ...overrides,
  });

  const sealedOpts = () => ({ boundary: tree, ownerOf: asRootOwned });

  test.skipIf(asRoot)("a tree a turn owns fails even when chmod read-only: the attack from a writable .env", () => {
    const dir = plugin({ mcpServers: { s: { type: "http", url: "https://x.example.com/mcp" } } });
    seal(dir);
    expect(isPluginSealed(entry(dir), root, { boundary: tree })).toBe(false);
    expect(buildPluginReport({ instance: "p1", manifest, sealed: { boundary: tree } }).plugins[0]!.http[0]!.state).toBe(STATE_WRITABLE);
  });

  test.skipIf(asRoot)("root-owned and read-only passes; root-owned but still writable fails", () => {
    const dir = plugin({ mcpServers: { s: { type: "http", url: "https://x.example.com/mcp" } } });
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(false);
    seal(dir);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(true);
    expect(buildPluginReport({ instance: "p1", manifest, sealed: sealedOpts() }).plugins[0]!.http[0]!.state).toBe(STATE_OFFERABLE);
  });

  test.skipIf(asRoot)("one path not owned by root fails the whole chain", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    const notRootOnly = (needle: string) => (p: string) => (p.endsWith(needle) ? 501 : 0);
    expect(isPluginSealed(entry(dir), root, { boundary: tree, ownerOf: notRootOnly(".mcp.json") })).toBe(false);
    expect(isPluginSealed(entry(dir), root, { boundary: tree, ownerOf: notRootOnly("installed_plugins.json") })).toBe(false);
    expect(isPluginSealed(entry(dir), root, { boundary: tree, ownerOf: notRootOnly("/market") })).toBe(false);
    expect(isPluginSealed(entry(dir), root, { boundary: tree, ownerOf: notRootOnly("/above") })).toBe(false);
  });

  test.skipIf(asRoot)("group or other write fails, even owned by root", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    chmodSync(join(dir, ".mcp.json"), 0o464);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(false);
    chmodSync(join(dir, ".mcp.json"), 0o444);
    chmodSync(join(root, "plugins"), 0o575);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(false);
  });

  test.skipIf(asRoot)("a root-owned sticky directory above the root is safe; not sticky, or inside the root, is not", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    // By the shell: Bun's chmodSync drops the sticky bit.
    execSync(`chmod 1777 "${above}"`);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(true);
    chmodSync(above, 0o777);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(false);
    chmodSync(above, 0o555);
    execSync(`chmod 1777 "${join(root, "plugins")}"`);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(false);
  });

  test.skipIf(asRoot)("a writable ancestor inside the tree fails: it lets a process swap the tree", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    chmodSync(join(root, "plugins", "cache", "market"), 0o755);
    expect(isPluginSealed(entry(dir), root, sealedOpts())).toBe(false);
  });

  test.skipIf(asRoot)("a root process fails, even on a sealed tree", () => {
    const dir = plugin({ mcpServers: {} });
    seal(dir);
    expect(isPluginSealed(entry(dir), root, { ...sealedOpts(), uid: 0 })).toBe(false);
  });

  test("a plugin outside the image-owned root is not sealed", () => {
    const dir = plugin({ mcpServers: {} });
    expect(isPluginSealed(entry(dir, { imageOwned: false }), root, { boundary: tree, ownerOf: asRootOwned })).toBe(false);
    expect(isPluginSealed(entry(dir), null, { boundary: tree, ownerOf: asRootOwned })).toBe(false);
  });

  test.skipIf(asRoot)("a plugin directory that resolves outside the root is not sealed", () => {
    const outside = mkdtempSync(join(tree, "outside-"));
    writeFileSync(join(outside, ".mcp.json"), "{}");
    expect(isPluginSealed(entry(outside), root, { boundary: tree, ownerOf: asRootOwned })).toBe(false);
  });
});

describe("reportNodePlugins", () => {
  test("an older gateway (404) does not stop the node", async () => {
    plugin({});
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, instance: "p1", manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.join()).toContain("predates");
  });

  test("a gateway failure is logged and never thrown", async () => {
    plugin({});
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, instance: "p1", manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.length).toBe(1);
  });

  test("a 409 (this process already reported) is logged, not thrown", async () => {
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("dup", { status: 409 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, instance: "p1", manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.join()).toContain("keeps the first");
  });

  test("a 413 is logged, not thrown", async () => {
    const client = new NodeClient({ baseUrl: "http://gw", token: "t", attempts: 1, fetchImpl: (async () => new Response("big", { status: 413 })) as unknown as typeof fetch });
    const warnings: string[] = [];
    await reportNodePlugins({ client, instance: "p1", manifest, log: () => {}, warn: (m) => warnings.push(m) });
    expect(warnings.join()).toContain("too large");
  });
});
