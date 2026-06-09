import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { oauthKey, writeEntry } from "../../../src/agent/mcp-oauth/store";

describe("mcp-oauth store", () => {
  it("oauthKey reproduces the pinned golden (canary on a2A drift)", () => {
    const key = oauthKey("workbench", { type: "http", url: "https://mcp.example.com/sse", headers: {} });
    expect(key).toBe("workbench|c17ea65c6b709142");
  });

  it("oauthKey ignores undefined headers identically to headers:{}", () => {
    const a = oauthKey("s", { type: "http", url: "https://h/" });
    const b = oauthKey("s", { type: "http", url: "https://h/", headers: {} });
    expect(a).toBe(b);
  });

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slaude-store-")); });

  it("writeEntry sets mcpOAuth[key] and preserves other top-level keys", () => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { keep: 1 } }));
    writeEntry(dir, "workbench", { type: "http", url: "https://mcp.example.com/sse", headers: {} }, {
      clientId: "cid", clientSecret: "csec", accessToken: "atok", refreshToken: "rtok", expiresIn: 3600,
    }, () => 1_000_000);
    const c = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    expect(c.claudeAiOauth).toEqual({ keep: 1 });
    const e = c.mcpOAuth["workbench|c17ea65c6b709142"];
    expect(e).toMatchObject({
      serverName: "workbench", serverUrl: "https://mcp.example.com/sse",
      clientId: "cid", clientSecret: "csec", accessToken: "atok", refreshToken: "rtok",
      expiresAt: 1_000_000 + 3600 * 1000,
    });
  });

  it("writeEntry creates the file when absent and chmods 0600", () => {
    writeEntry(dir, "s", { type: "http", url: "https://h/", headers: {} }, {
      clientId: "c", accessToken: "a", refreshToken: "r", expiresIn: undefined,
    }, () => 0);
    const p = join(dir, ".credentials.json");
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
    const c = JSON.parse(readFileSync(p, "utf8"));
    const key = oauthKey("s", { type: "http", url: "https://h/" });
    expect(c.mcpOAuth[key].expiresAt).toBe(3600 * 1000);
  });
});
