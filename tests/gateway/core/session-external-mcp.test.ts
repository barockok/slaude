// R42 (I3): a managed tenant never reads personas/<name>/mcp.json. A named
// persona's external MCP is its effective mcp (null → none); the default
// persona's is its effective mcp when set, else the global .mcp.json. A
// filesystem (unmanaged) registry keeps today's per-persona disk read.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../src/config/home";
import { sessionExternalMcp, type ExternalMcp } from "../../../src/gateway/core/external-mcp";
import type { PersonaRegistry } from "../../../src/persona/registry";

const DISK = { mcpServers: { "disk-srv": { command: "disk-server", args: [] } } };
const GLOBAL: ExternalMcp = { servers: { "global-srv": { type: "http", url: "https://global.test/mcp" } as any }, privateServices: [] };

function writeDiskMcp(name: string) {
  const dir = join(paths.personas, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(DISK));
}

const reg = (managed: boolean, personas: Record<string, unknown>, defaultMcp: unknown = null): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: (n) => (n in personas
    ? { name: n, slackUserId: "UTESTUSER1", config: { slackUserId: "UTESTUSER1", name: n }, outClient: null, ...(managed ? { mcp: personas[n], model: null } : {}) }
    : null),
  list: () => [],
  isMultiPersonaMode: () => true,
  isManaged: () => managed,
  tombstonedPersonaFor: () => null,
  ...(managed ? { defaultPersona: () => ({ model: null, mcp: defaultMcp }) } : {}),
});

afterEach(() => rmSync(paths.personas, { recursive: true, force: true }));

describe("sessionExternalMcp", () => {
  test("managed: a named persona ignores personas/<name>/mcp.json and uses its effective mcp", () => {
    writeDiskMcp("ana");
    const eff = { mcpServers: { "eff-srv": { type: "http", url: "https://eff.test/mcp", headers: { A: "resolved" } } }, privateServices: ["eff-srv"] };
    const out = sessionExternalMcp("ana", GLOBAL, reg(true, { ana: eff }));
    expect(Object.keys(out.servers)).toEqual(["eff-srv"]);
    expect(out.privateServices).toEqual(["eff-srv"]);
    // The registry's object is never mutated or shared.
    (out.servers["eff-srv"] as any).headers.A = "changed";
    expect(eff.mcpServers["eff-srv"].headers.A).toBe("resolved");
  });

  test("managed: a named persona with no effective mcp mounts nothing — not the disk file, not the global", () => {
    writeDiskMcp("ana");
    const out = sessionExternalMcp("ana", GLOBAL, reg(true, { ana: null }));
    expect(out).toEqual({ servers: {}, privateServices: [] });
  });

  test("managed: a named persona the registry does not list mounts nothing", () => {
    writeDiskMcp("ghost");
    expect(sessionExternalMcp("ghost", GLOBAL, reg(true, {}))).toEqual({ servers: {}, privateServices: [] });
  });

  test("managed: the default persona uses its effective mcp when set, else the global .mcp.json", () => {
    const eff = { mcpServers: { "def-srv": { type: "http", url: "https://def.test/mcp" } } };
    expect(Object.keys(sessionExternalMcp(undefined, GLOBAL, reg(true, {}, eff)).servers)).toEqual(["def-srv"]);
    expect(Object.keys(sessionExternalMcp("default", GLOBAL, reg(true, {}, eff)).servers)).toEqual(["def-srv"]);
    expect(sessionExternalMcp("default", GLOBAL, reg(true, {}, null))).toBe(GLOBAL);
  });

  test("managed: effective values are not ${VAR}-expanded again (the sync already resolved them)", () => {
    process.env.SESSION_MCP_TEST_VAR = "from-env";
    try {
      const eff = { mcpServers: { s: { type: "http", url: "https://s.test/mcp", headers: { A: "${SESSION_MCP_TEST_VAR}" } } } };
      const out = sessionExternalMcp("ana", GLOBAL, reg(true, { ana: eff }));
      expect((out.servers.s as any).headers.A).toBe("${SESSION_MCP_TEST_VAR}");
    } finally {
      delete process.env.SESSION_MCP_TEST_VAR;
    }
  });

  test("unmanaged: unchanged — a named persona reads personas/<name>/mcp.json, the default uses the global", () => {
    writeDiskMcp("ana");
    expect(Object.keys(sessionExternalMcp("ana", GLOBAL, reg(false, { ana: null })).servers)).toEqual(["disk-srv"]);
    expect(sessionExternalMcp("default", GLOBAL, reg(false, {}))).toBe(GLOBAL);
    expect(sessionExternalMcp(undefined, GLOBAL, reg(false, {}))).toBe(GLOBAL);
  });
});
