import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/home";
import { loadInstalledPluginMcps, loadInstalledPluginPaths } from "../src/config/plugins";

const pluginsDir = join(paths.claudeConfig, "plugins");
const pluginsFile = join(pluginsDir, "installed_plugins.json");

function writeInstalled(json: unknown) {
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(pluginsFile, JSON.stringify(json));
}

beforeEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

describe("loadInstalledPluginPaths", () => {
  test("missing file → empty", () => {
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("malformed JSON → empty", () => {
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(pluginsFile, "{not json");
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("missing plugins root → empty", () => {
    writeInstalled({ version: 2 });
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("translates installPath → { type:'local', path }", () => {
    const path = mkdirSync(join(paths.claudeConfig, "plugins", "cache", "mp", "p", "v"), { recursive: true })!;
    writeInstalled({
      version: 2,
      plugins: {
        "p@mp": [{ scope: "user", installPath: path }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path }]);
  });

  test("skips records whose installPath does not exist", () => {
    writeInstalled({
      version: 2,
      plugins: {
        "missing@mp": [{ scope: "user", installPath: "/nonexistent/path" }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([]);
  });

  test("dedupes repeated installPath across plugin keys", () => {
    const path = mkdirSync(join(paths.claudeConfig, "plugins", "cache", "mp", "dup", "v"), { recursive: true })!;
    writeInstalled({
      version: 2,
      plugins: {
        "a@mp": [{ scope: "user", installPath: path }],
        "b@mp": [{ scope: "user", installPath: path }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([{ type: "local", path }]);
  });

  test("skips entries missing installPath", () => {
    writeInstalled({
      version: 2,
      plugins: {
        "bare@mp": [{ scope: "user" }],
      },
    });
    expect(loadInstalledPluginPaths()).toEqual([]);
  });
});

function installPlugin(name: string, mcpJson?: unknown): string {
  const path = mkdirSync(join(paths.claudeConfig, "plugins", "cache", "mp", name, "v"), { recursive: true })!;
  writeInstalled({
    version: 2,
    plugins: {
      [`${name}@mp`]: [{ scope: "user", installPath: path }],
    },
  });
  if (mcpJson !== undefined) {
    writeFileSync(join(path, ".mcp.json"), JSON.stringify(mcpJson));
  }
  return path;
}

describe("loadInstalledPluginMcps", () => {
  test("no plugins → empty", () => {
    expect(loadInstalledPluginMcps()).toEqual({});
  });

  test("plugin without .mcp.json → empty", () => {
    installPlugin("plain");
    expect(loadInstalledPluginMcps()).toEqual({});
  });

  test("stdio shape under mcpServers key", () => {
    installPlugin("exc", {
      mcpServers: {
        excalidraw: { command: "uvx", args: ["drawmode", "--stdio"] },
      },
    });
    expect(loadInstalledPluginMcps()).toEqual({
      excalidraw: { type: "stdio", command: "uvx", args: ["drawmode", "--stdio"] },
    });
  });

  test("http shape", () => {
    installPlugin("h", {
      mcpServers: {
        api: { type: "http", url: "https://example/mcp", headers: { Authorization: "x" } },
      },
    });
    expect(loadInstalledPluginMcps()).toEqual({
      api: { type: "http", url: "https://example/mcp", headers: { Authorization: "x" } },
    });
  });

  test("sse shape", () => {
    installPlugin("s", {
      mcpServers: { live: { type: "sse", url: "https://example/sse" } },
    });
    expect(loadInstalledPluginMcps()).toEqual({
      live: { type: "sse", url: "https://example/sse" },
    });
  });

  test("flat shape (no mcpServers wrapper) accepted", () => {
    installPlugin("flat", {
      excalidraw: { command: "uvx", args: ["drawmode"] },
    });
    expect(loadInstalledPluginMcps()).toEqual({
      excalidraw: { type: "stdio", command: "uvx", args: ["drawmode"] },
    });
  });

  test("malformed JSON → skip", () => {
    const p = installPlugin("bad");
    writeFileSync(join(p, ".mcp.json"), "{not json");
    expect(loadInstalledPluginMcps()).toEqual({});
  });

  test("entries missing command/url → skipped", () => {
    installPlugin("invalid", {
      mcpServers: { broken: { foo: "bar" } },
    });
    expect(loadInstalledPluginMcps()).toEqual({});
  });

  test("env is preserved on stdio entries", () => {
    installPlugin("envy", {
      mcpServers: {
        srv: { command: "x", args: ["y"], env: { A: "1" } },
      },
    });
    expect(loadInstalledPluginMcps()).toEqual({
      srv: { type: "stdio", command: "x", args: ["y"], env: { A: "1" } },
    });
  });

  test("npx command is rewritten to bunx (no node toolchain in bun image)", () => {
    installPlugin("npxy", {
      mcpServers: {
        drawmode: { command: "npx", args: ["drawmode", "--stdio"] },
      },
    });
    expect(loadInstalledPluginMcps()).toEqual({
      drawmode: { type: "stdio", command: "bunx", args: ["drawmode", "--stdio"] },
    });
  });
});
