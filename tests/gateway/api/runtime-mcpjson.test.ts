/**
 * The runtime bundle never carries mcpJson. Nodes never read it, and on the
 * disk tiers it was the shared, node-writable $SLAUDE_HOME/.mcp.json with
 * ${VAR} placeholders expanded against the GATEWAY's environment: an agent turn
 * on a node could plant ${SLAUDE_MASTER_KEY} there and read the value back from
 * the next bundle.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../src/config/home";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { handleTenantRuntime } from "../../../src/gateway/api/tenants";

const PLANTED = { mcpServers: { x: { type: "http", url: "https://x.test/mcp", headers: { a: "${SLAUDE_MASTER_KEY}" } } } };
const savedKey = process.env.SLAUDE_MASTER_KEY;

afterEach(() => {
  rmSync(join(paths.home, ".mcp.json"), { force: true });
  rmSync(paths.personas, { recursive: true, force: true });
  __resetPersonaRegistry();
  if (savedKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = savedKey;
});

describe.skipIf(process.env.SLAUDE_DB === "pg")("runtime bundle mcpJson (disk tiers)", () => {
  test("the filesystem persona tier ships mcpJson null", async () => {
    process.env.SLAUDE_MASTER_KEY = "planted-master-key-value";
    writeFileSync(join(paths.home, ".mcp.json"), JSON.stringify(PLANTED));
    const dir = join(paths.personas, "ghost");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ slackUserId: "UGHOST", name: "ghost" }));
    writeFileSync(join(dir, "SOUL.md"), "ghost soul");
    __resetPersonaRegistry(); // re-read the persona directory written above
    const res = await handleTenantRuntime(new Request("https://x/"), "default", "ghost");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).personaId).toBe("ghost");
    expect(JSON.parse(text).mcpJson).toBeNull();
    expect(text).not.toContain("planted-master-key-value");
  });

  test("the default tier ships mcpJson null", async () => {
    process.env.SLAUDE_MASTER_KEY = "planted-master-key-value";
    writeFileSync(join(paths.home, ".mcp.json"), JSON.stringify(PLANTED));
    const res = await handleTenantRuntime(new Request("https://x/"), "default", "default");
    const text = await res.text();
    expect(JSON.parse(text).mcpJson).toBeNull();
    expect(text).not.toContain("planted-master-key-value");
  });
});

describe.skipIf(process.env.SLAUDE_DB === "pg")("runtime bundle mcpServers (the MCP bridge, WS-C §4.2)", () => {
  const MIXED = {
    mcpServers: {
      web: { type: "http", url: "https://mcp.example.com/mcp?key=qs-secret", headers: { authorization: "Bearer header-secret" } },
      local: { command: "some-binary", env: { TOKEN: "env-secret" } },
      legacy: { type: "sse", url: "https://sse.example.com/sse" },
    },
  };

  const savedOptIn = process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG;
  beforeEach(() => {
    process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG = "1";
  });
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG;
    else process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG = savedOptIn;
  });

  test("file-defined servers are not bridged without the operator's opt-in", async () => {
    delete process.env.SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG;
    writeFileSync(join(paths.home, ".mcp.json"), JSON.stringify(MIXED));
    const res = await handleTenantRuntime(new Request("https://x/"), "default", "default");
    expect(((await res.json()) as any).mcpServers).toEqual([]);
  });

  test("names only: the http servers the bridge serves, no URL, header or env value", async () => {
    writeFileSync(join(paths.home, ".mcp.json"), JSON.stringify(MIXED));
    const res = await handleTenantRuntime(new Request("https://x/"), "default", "default");
    const text = await res.text();
    expect(JSON.parse(text).mcpServers).toEqual(["web"]);
    for (const leak of ["mcp.example.com", "qs-secret", "header-secret", "env-secret", "some-binary"]) expect(text).not.toContain(leak);
  });

  test("a filesystem persona gets its own servers, and none is an empty list", async () => {
    const dir = join(paths.personas, "ghost");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ slackUserId: "UGHOST", name: "ghost" }));
    writeFileSync(join(dir, "SOUL.md"), "ghost soul");
    __resetPersonaRegistry();
    const none = await handleTenantRuntime(new Request("https://x/"), "default", "ghost");
    expect(((await none.json()) as any).mcpServers).toEqual([]);
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(MIXED));
    const some = await handleTenantRuntime(new Request("https://x/"), "default", "ghost");
    expect(((await some.json()) as any).mcpServers).toEqual(["web"]);
  });
});
