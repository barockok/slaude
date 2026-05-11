import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExternalMcp } from "../src/config/mcp";

function tmp() {
  return mkdtempSync(join(tmpdir(), "slaude-mcp-"));
}

describe("config/mcp loadExternalMcp", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = tmp();
    path = join(dir, "mcp.json");
    delete process.env.SLAUDE_MCP_CONFIG;
    delete process.env.MCP_FS_ROOT;
    delete process.env.MCP_GITHUB_TOKEN;
    delete process.env.MCP_REMOTE_URL;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file → {}", () => {
    expect(loadExternalMcp(join(dir, "missing.json"))).toEqual({});
  });

  test("malformed JSON throws", () => {
    writeFileSync(path, "{ not json");
    expect(() => loadExternalMcp(path)).toThrow(/invalid JSON/);
  });

  test("missing mcpServers root throws", () => {
    writeFileSync(path, JSON.stringify({ other: true }));
    expect(() => loadExternalMcp(path)).toThrow(/mcpServers/);
  });

  test("stdio server (no type) loads, env+args expanded", () => {
    process.env.MCP_FS_ROOT = "/tmp/foo";
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          fs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "${MCP_FS_ROOT}"],
            env: { EXTRA: "${MCP_FS_ROOT}-x" },
          },
        },
      }),
    );
    const out = loadExternalMcp(path);
    expect(out.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/foo"],
      env: { EXTRA: "/tmp/foo-x" },
    });
  });

  test("http server loads with header expansion", () => {
    process.env.MCP_GITHUB_TOKEN = "ghp_secret";
    process.env.MCP_REMOTE_URL = "https://example.com/mcp";
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          gh: {
            type: "http",
            url: "${MCP_REMOTE_URL}",
            headers: { Authorization: "Bearer ${MCP_GITHUB_TOKEN}" },
          },
        },
      }),
    );
    const out = loadExternalMcp(path);
    expect(out.gh).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ghp_secret" },
    });
  });

  test("sse server loads", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          live: { type: "sse", url: "https://example.com/sse" },
        },
      }),
    );
    const out = loadExternalMcp(path);
    expect(out.live).toEqual({ type: "sse", url: "https://example.com/sse" });
  });

  test("missing ${VAR} expands to empty string", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          fs: { command: "echo", args: ["${MCP_DOES_NOT_EXIST}"] },
        },
      }),
    );
    const out = loadExternalMcp(path);
    expect((out.fs as any).args).toEqual([""]);
  });

  test("stdio missing command throws", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: { args: ["x"] } } }));
    expect(() => loadExternalMcp(path)).toThrow(/missing "command"/);
  });

  test("http missing url throws", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: { type: "http" } } }));
    expect(() => loadExternalMcp(path)).toThrow(/missing "url"/);
  });

  test("non-object server entry throws", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { bad: "nope" } }));
    expect(() => loadExternalMcp(path)).toThrow(/must be an object/);
  });

  test("args not array throws", () => {
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { bad: { command: "x", args: "y" } } }),
    );
    expect(() => loadExternalMcp(path)).toThrow(/args must be a string array/);
  });

  test("reserved slaude_slack name dropped silently", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          slaude_slack: { command: "evil" },
          ok: { command: "echo" },
        },
      }),
    );
    const out = loadExternalMcp(path);
    expect(out.slaude_slack).toBeUndefined();
    expect(out.ok).toBeDefined();
  });

  test("reserved slaude_skills name dropped silently", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { slaude_skills: { command: "evil" } },
      }),
    );
    expect(loadExternalMcp(path)).toEqual({});
  });

  test("SLAUDE_MCP_CONFIG override path honoured", () => {
    const altDir = tmp();
    const altPath = join(altDir, "alt.json");
    writeFileSync(
      altPath,
      JSON.stringify({ mcpServers: { fs: { command: "alt" } } }),
    );
    process.env.SLAUDE_MCP_CONFIG = altPath;
    try {
      const out = loadExternalMcp();
      expect((out.fs as any).command).toBe("alt");
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});
