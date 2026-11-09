/**
 * The plugin inventory's path through the gateway, without Redis: PUT report
 * over the real /v1 route into the real table, the view, then portal rows,
 * connect resolution and the bridge list. (tests/integration/plugin-inventory
 * runs the same path against real Redis with a node worker.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createV1Api } from "../../src/gateway/api";
import { __setNodeVerifier } from "../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../src/gateway/api/pending-source";
import { startPluginInventory, __setPluginInventorySnapshot, pluginServersFor } from "../../src/gateway/core/plugin-inventory";
import { listNodePlugins } from "../../src/db/node-plugins";
import { db } from "../../src/db/schema";
import { bridgedServerNames } from "../../src/gateway/core/external-mcp";
import { configuredServer, integrationsFor, portalServers } from "../../src/gateway/portal/integrations";
import { NodeClient } from "../../src/node/client";
import { STATE_OFFERABLE, STATE_REFUSED_POLICY, type PluginReport } from "../../src/config/plugin-inventory";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";

const policy = { resolver: async () => [{ address: "93.184.216.34", family: 4 }] };
const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_ROLE", "SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY"];
const saved: Record<string, string | undefined> = {};

const managed = (personas: Record<string, string | null>): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: (n) => (n in personas ? ({ name: n, slackUserId: "U1", config: { slackUserId: "U1", name: n }, outClient: null, mcp: null, runsOn: personas[n], model: null } as never) : null),
  list: () => Object.keys(personas).map((n) => ({ name: n, slackUserId: "U1", config: { slackUserId: "U1", name: n }, outClient: null, mcp: null, runsOn: personas[n], model: null })) as never,
  isMultiPersonaMode: () => true,
  isManaged: () => true,
  tombstonedPersonaFor: () => null,
  defaultPersona: () => ({ model: null, mcp: null, runsOn: null }) as never,
});

let v1: ReturnType<typeof createV1Api>;
let view: { stop(): void } | null = null;
let live = new Set<string>();

const client = (id: string, labels: string[]) =>
  new NodeClient({
    baseUrl: "http://gw",
    token: mintNodeCredential({ id, labels }),
    attempts: 1,
    fetchImpl: (async (url: string, init: RequestInit) => (await v1.fetch(new Request(String(url), init)))!) as unknown as typeof fetch,
  });

const reportOf = (servers: Array<[string, string, string?]>, plugin = "toolkit"): PluginReport => ({
  plugins: [{ name: plugin, marketplace: "market", commit: "abcdef0", skills: 0, commands: 0, agents: 0, hooks: 0, stdio: [], http: servers.map(([name, url, state]) => ({ name, url, state: (state ?? STATE_OFFERABLE) as never })) }],
});

beforeAll(() => {
  for (const k of VARS) saved[k] = process.env[k];
  delete process.env.SLAUDE_NODE_TOKEN;
  delete process.env.SLAUDE_NODE_LEGACY;
  process.env.SLAUDE_NODE_KEY = "flow-node-key";
  process.env.SLAUDE_ROLE = "gateway";
  __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
  v1 = createV1Api({ tools: {} as never, pendingSource: new InMemoryPendingSource(), memory: null, nodePlugins: { policy } });
  setPersonaRegistry(managed({ onGpu: "gpu", onCpu: "cpu", onDefault: null }));
});

beforeEach(async () => {
  await db.run(`DELETE FROM node_plugins`);
});

afterAll(() => {
  __setNodeVerifier(null);
  __resetPersonaRegistry();
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(async () => {
  view?.stop();
  view = null;
  __setPluginInventorySnapshot(null);
  await db.run(`DELETE FROM node_plugins`);
});

async function startView() {
  live = new Set();
  view = await startPluginInventory({ rows: listNodePlugins, live: async () => live }, { intervalMs: 3_600_000 });
}

describe("report to portal", () => {
  test("a live node's offerable server reaches the portal row and connect, for its own label's agents", async () => {
    await startView();
    expect(await client("node-gpu", ["gpu"]).putPlugins(reportOf([["web", "https://mcp.example.com/x"]]))).toBe("ok");
    expect((await listNodePlugins())[0]).toMatchObject({ nodeId: "node-gpu", labels: ["gpu"] });

    live = new Set(["node-gpu"]);
    await new Promise((r) => setTimeout(r, 0)); // the report already refreshed; refresh again with it live
    const { refreshPluginInventory } = await import("../../src/gateway/core/plugin-inventory");
    await refreshPluginInventory();

    expect(pluginServersFor("gpu").web?.url).toBe("https://mcp.example.com/x");
    expect(pluginServersFor("cpu")).toEqual({});

    const rows = portalServers();
    expect(rows.map((r) => ({ id: r.id, plugin: r.plugin, usedBy: r.usedBy }))).toEqual([{ id: "web", plugin: "toolkit", usedBy: ["onGpu"] }]);
    const view2 = await integrationsFor("no-account", rows);
    expect(view2[0]).toMatchObject({ id: "web", name: "web", host: "mcp.example.com", plugin: "toolkit", connected: false });
    expect(configuredServer("web", rows)?.cfg.url).toBe("https://mcp.example.com/x");

    expect(bridgedServerNames("onGpu")).toEqual(["web"]);
    expect(bridgedServerNames("onCpu")).toEqual([]);
    expect(bridgedServerNames(undefined)).toEqual([]);
  });

  test("a report for a private address is stored as refused and never offered", async () => {
    await startView();
    await client("node-gpu", ["gpu"]).putPlugins(reportOf([["web", "https://10.1.2.3/mcp"]]));
    live = new Set(["node-gpu"]);
    const { refreshPluginInventory } = await import("../../src/gateway/core/plugin-inventory");
    await refreshPluginInventory();
    expect((await listNodePlugins())[0]!.report.plugins[0]!.http[0]!.state).toBe(STATE_REFUSED_POLICY);
    expect(pluginServersFor("gpu")).toEqual({});
    expect(portalServers()).toEqual([]);
  });

  test("the next report replaces the node's previous one", async () => {
    await startView();
    const c = client("node-gpu", ["gpu"]);
    await c.putPlugins(reportOf([["web", "https://mcp.example.com/x"]]));
    await c.putPlugins(reportOf([["other", "https://mcp.example.com/y"]]));
    live = new Set(["node-gpu"]);
    const { refreshPluginInventory } = await import("../../src/gateway/core/plugin-inventory");
    await refreshPluginInventory();
    expect(Object.keys(pluginServersFor("gpu"))).toEqual(["other"]);
    expect(await listNodePlugins()).toHaveLength(1);
  });
});
