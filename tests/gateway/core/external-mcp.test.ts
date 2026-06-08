import { describe, it, expect } from "bun:test";
import { clearCredentials } from "../../../src/gateway/core/external-mcp";
import { parseExternalMcp } from "../../../src/gateway/core/external-mcp";
import { privateOverrides } from "../../../src/gateway/core/external-mcp";

describe("clearCredentials", () => {
  it("empties env on a stdio server, preserving command + args", () => {
    const cfg = { command: "npx", args: ["-y", "srv"], env: { WB_TOKEN: "secret" } };
    const out = clearCredentials(cfg as any) as any;
    expect(out.command).toBe("npx");
    expect(out.args).toEqual(["-y", "srv"]);
    expect(out.env).toEqual({});
  });

  it("empties headers + strips url userinfo/query on an http server, preserving host/path", () => {
    const cfg = { type: "http", url: "https://user:pass@api.example.com/mcp?token=x#access_token=abc", headers: { Authorization: "Bearer s" } };
    const out = clearCredentials(cfg as any) as any;
    expect(out.headers).toEqual({});
    const u = new URL(out.url);
    expect(u.username).toBe("");
    expect(u.password).toBe("");
    expect(u.search).toBe("");
    expect(u.hash).toBe("");
    expect(u.host).toBe("api.example.com");
    expect(u.pathname).toBe("/mcp");
  });

  it("does not mutate the input object", () => {
    const cfg = { command: "x", env: { A: "1" } };
    clearCredentials(cfg as any);
    expect(cfg.env).toEqual({ A: "1" });
  });
});

describe("parseExternalMcp", () => {
  it("returns servers and privateServices, expanding ${VAR} from the env map", () => {
    const parsed = {
      mcpServers: { composio: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${KEY}" } } },
      privateServices: ["composio"],
    };
    const out = parseExternalMcp(parsed, { KEY: "abc" });
    expect((out.servers.composio as any).headers.Authorization).toBe("Bearer abc");
    expect(out.privateServices).toEqual(["composio"]);
  });

  it("defaults privateServices to [] when absent", () => {
    const out = parseExternalMcp({ mcpServers: { a: { command: "x" } } }, {});
    expect(out.privateServices).toEqual([]);
  });

  it("drops a privateServices name that is not a configured server (warns)", () => {
    const out = parseExternalMcp({ mcpServers: { a: { command: "x" } }, privateServices: ["a", "ghost"] }, {});
    expect(out.privateServices).toEqual(["a"]);
  });

  it("returns empty maps for an empty/garbage object", () => {
    const out = parseExternalMcp({}, {});
    expect(out.servers).toEqual({});
    expect(out.privateServices).toEqual([]);
  });

  it("expands ${VAR} inside a stdio server's args array", () => {
    const out = parseExternalMcp({ mcpServers: { a: { command: "x", args: ["--token", "${TOK}"] } } }, { TOK: "t1" });
    expect((out.servers.a as any).args).toEqual(["--token", "t1"]);
  });
});

describe("privateOverrides", () => {
  const servers = {
    composio: { type: "http", url: "https://x", headers: { Authorization: "Bearer s" } },
    jira: { command: "npx", env: { T: "secret" } },
  } as any;

  it("returns cleared copies of whitelisted servers when locked", () => {
    const out = privateOverrides(servers, new Set(["composio"]), true) as any;
    expect(Object.keys(out)).toEqual(["composio"]);
    expect(out.composio.headers).toEqual({});
    expect(servers.composio.headers).toEqual({ Authorization: "Bearer s" }); // source untouched
  });

  it("returns {} when not locked", () => {
    expect(privateOverrides(servers, new Set(["composio"]), false)).toEqual({});
  });

  it("ignores whitelist names with no matching server", () => {
    const out = privateOverrides(servers, new Set(["ghost"]), true);
    expect(out).toEqual({});
  });
});
