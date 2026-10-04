/**
 * The panel's persona read model (WS-C §4.4.1), as pure functions: what each
 * field shows, and that no secret a persona's configuration can hold reaches it.
 */
import { describe, expect, test } from "bun:test";
import {
  kbView,
  mcpServersView,
  personaNodes,
  providerView,
  secretRefView,
  soulView,
} from "../../src/gateway/panel/persona-view";

const SECRETS = [
  "QS-SECRET-1", "HDR-SECRET-2", "HDR-SECRET-3", "ARG-SECRET-4", "ENV-SECRET-5", "PW-SECRET-6", "FRAG-SECRET-7",
];
const MCP = {
  mcpServers: {
    docs: {
      type: "http",
      url: "https://docs.example.com/mcp?token=QS-SECRET-1",
      headers: { Authorization: "Bearer HDR-SECRET-2", "x-api-key": "HDR-SECRET-3" },
    },
    local: { type: "stdio", command: "/opt/tools/bin/run", args: ["--key", "ARG-SECRET-4"], env: { API_TOKEN: "ENV-SECRET-5" } },
    implicit: { command: "/opt/tools/bin/other", env: { K: "ENV-SECRET-5" } },
    legacy: { type: "sse", url: "https://user:PW-SECRET-6@legacy.example.com:8443/sse#FRAG-SECRET-7" },
    odd: { type: "websocket-PW-SECRET-6", url: "not a url QS-SECRET-1" },
  },
  privateServices: ["docs"],
};

describe("mcpServersView", () => {
  test("names, transport, route and hostname only, sorted by name", () => {
    const view = mcpServersView(MCP, () => false);
    expect(view).toEqual([
      { name: "docs", via: "bridge", type: "http", host: "docs.example.com", oauth: false },
      { name: "implicit", via: "stdio", type: "stdio", host: null, oauth: false },
      { name: "legacy", via: "none", type: "sse", host: "legacy.example.com", oauth: false },
      { name: "local", via: "stdio", type: "stdio", host: null, oauth: false },
      { name: "odd", via: "none", type: "other", host: null, oauth: false },
    ]);
  });

  test("no header, env, argument, query, userinfo or fragment survives", () => {
    const text = JSON.stringify(mcpServersView(MCP, () => true));
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain("/opt/tools");
    expect(text).not.toContain("8443");
  });

  test("oauth asks about the bridged server's exact config, and only for bridged servers", () => {
    const asked: Array<[string, unknown]> = [];
    const view = mcpServersView(MCP, (name, cfg) => { asked.push([name, cfg]); return name === "docs"; });
    expect(asked).toEqual([["docs", { type: "http", url: MCP.mcpServers.docs.url, headers: MCP.mcpServers.docs.headers }]]);
    expect(view.find((s) => s.name === "docs")!.oauth).toBe(true);
  });

  test("absent, malformed or empty config is an empty list", () => {
    for (const v of [null, undefined, "x", [], {}, { mcpServers: null }, { mcpServers: [] }]) {
      expect(mcpServersView(v, () => true)).toEqual([]);
    }
    expect(mcpServersView({ mcpServers: { a: null, b: "x" } }, () => true)).toEqual([
      { name: "a", via: "none", type: "other", host: null, oauth: false },
      { name: "b", via: "none", type: "other", host: null, oauth: false },
    ]);
  });
});

describe("providerView", () => {
  test("references are shown by path; a non-reference value is only 'stored'; absent is 'none'", () => {
    expect(secretRefView("vault://kv/agents/ana#api_key")).toBe("vault://kv/agents/ana#api_key");
    expect(secretRefView("env://PERSONA_ANA_KEY")).toBe("env://PERSONA_ANA_KEY");
    expect(secretRefView("RAW-SECRET-VALUE")).toBe("stored");
    // Ref-shaped but not a valid reference (a query string): never echoed.
    expect(secretRefView("vault://kv/a?x=RAW-SECRET-VALUE#f")).toBe("stored");
    expect(secretRefView(undefined)).toBe("none");
    expect(secretRefView("")).toBe("none");
  });

  test("every credential field and the base URL, with no value leaking", () => {
    const v = providerView({
      apiKey: "vault://kv/agents/ana#api_key",
      authToken: "RAW-SECRET-VALUE",
      baseUrl: "https://u:PW-SECRET-6@llm.example.com/v1?k=QS-SECRET-1#FRAG-SECRET-7",
    });
    expect(v).toEqual({
      apiKey: "vault://kv/agents/ana#api_key",
      authToken: "stored",
      oauthToken: "none",
      baseUrl: "https://llm.example.com/v1",
    });
    expect(JSON.stringify(v)).not.toMatch(/SECRET/);
  });

  test("a baseUrl reference is shown as one; an unparseable baseUrl is not echoed", () => {
    expect(providerView({ apiKey: "env://PERSONA_A", baseUrl: "env://PERSONA_URL" }).baseUrl).toBe("env://PERSONA_URL");
    expect(providerView({ apiKey: "env://PERSONA_A", baseUrl: "QS-SECRET-1" }).baseUrl).toBe("stored");
  });

  test("no provider is all 'none' and a null base URL", () => {
    expect(providerView(null)).toEqual({ apiKey: "none", authToken: "none", oauthToken: "none", baseUrl: null });
    expect(providerView(undefined)).toEqual({ apiKey: "none", authToken: "none", oauthToken: "none", baseUrl: null });
  });
});

describe("kbView", () => {
  const installed = ["kb-handbook", "kb-runbooks", "kb-finance"];
  test("null is every installed KB", () => {
    expect(kbView(null, installed)).toEqual({
      mode: "all",
      sources: installed.map((id) => ({ id, installed: true })),
    });
    expect(kbView(undefined, installed).mode).toBe("all");
  });
  test("[] is none", () => {
    expect(kbView([], installed)).toEqual({ mode: "none", sources: [] });
  });
  test("a list names each id and whether it is installed", () => {
    expect(kbView(["kb-runbooks", "kb-missing"], installed)).toEqual({
      mode: "list",
      sources: [{ id: "kb-runbooks", installed: true }, { id: "kb-missing", installed: false }],
    });
  });
  test("an id installed twice (two labels normalise to it) is listed once", () => {
    expect(kbView(null, ["kb-a", "kb-a"]).sources).toEqual([{ id: "kb-a", installed: true }]);
  });
});

describe("soulView", () => {
  test("length, overridden and the first 200 characters", () => {
    const text = "x".repeat(150) + "y".repeat(100);
    expect(soulView(text, true)).toEqual({ length: 250, overridden: true, preview: "x".repeat(150) + "y".repeat(50) });
    expect(soulView("short", false)).toEqual({ length: 5, overridden: false, preview: "short" });
  });
});

describe("personaNodes", () => {
  const labels: Record<string, string[]> = { "node-b": ["finance", "engineering"], "node-a": ["engineering"], "node-d": ["default"] };
  const registry = {
    async nodesWithLabel(label: string) {
      return Object.keys(labels).filter((n) => labels[n]!.includes(label));
    },
    async nodeLabels(node: string) {
      return new Set(labels[node] ?? ["default"]);
    },
  };
  test("the live nodes holding the label, sorted, with their labels sorted", async () => {
    expect(await personaNodes(registry, "engineering")).toEqual([
      { id: "node-a", alive: true, labels: ["engineering"] },
      { id: "node-b", alive: true, labels: ["engineering", "finance"] },
    ]);
  });
  test("a persona with no runsOn runs on `default`", async () => {
    expect(await personaNodes(registry, null)).toEqual([{ id: "node-d", alive: true, labels: ["default"] }]);
  });
  test("no registry (mono, no node queue) is null, not an empty fleet", async () => {
    expect(await personaNodes(null, "engineering")).toBeNull();
  });
});
