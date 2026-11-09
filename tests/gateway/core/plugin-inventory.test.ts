import { afterEach, describe, expect, test } from "bun:test";
import { bridgedServerNames, bridgeExternalMcp, connectableServers } from "../../../src/gateway/core/external-mcp";
import {
  __setPluginInventorySnapshot,
  computeSnapshot,
  currentSnapshot,
  EMPTY_SNAPSHOT,
  pluginServersFor,
  refreshPluginInventory,
  STALE_AFTER_MS,
  startPluginInventory,
} from "../../../src/gateway/core/plugin-inventory";
import type { PersonaRegistry } from "../../../src/persona/registry";
import type { NodePluginsRow } from "../../../src/db/node-plugins";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";
import { STATE_NEEDS_HEADERS, STATE_OFFERABLE, STATE_WRITABLE } from "../../../src/config/plugin-inventory";

const server = (name: string, url: string, state = STATE_OFFERABLE) => ({ name, url, state });
const row = (nodeId: string, labels: string[], http: ReturnType<typeof server>[], plugin = "toolkit"): NodePluginsRow => ({
  nodeId,
  labels,
  reportedAt: 1,
  report: { plugins: [{ name: plugin, marketplace: "m", commit: null, skills: 0, commands: 0, agents: 0, hooks: 0, stdio: [], http: http as never }] },
});

const reg = (personas: Record<string, { mcp?: unknown; runsOn?: string | null }>, defaultRunsOn: string | null = null): PersonaRegistry => ({
  lookupByUserId: () => null,
  lookupByName: (n) => (n in personas ? { name: n, slackUserId: "U1", config: { slackUserId: "U1", name: n }, outClient: null, mcp: personas[n]!.mcp ?? null, runsOn: personas[n]!.runsOn ?? null, model: null } : null),
  list: () => Object.keys(personas).map((n) => ({ name: n, slackUserId: "U1", config: { slackUserId: "U1", name: n }, outClient: null, mcp: personas[n]!.mcp ?? null, runsOn: personas[n]!.runsOn ?? null, model: null })),
  isMultiPersonaMode: () => true,
  isManaged: () => true,
  tombstonedPersonaFor: () => null,
  defaultPersona: () => ({ model: null, mcp: null, runsOn: defaultRunsOn }),
});

afterEach(() => __setPluginInventorySnapshot(null));

describe("computeSnapshot", () => {
  test("offers an offerable server to its node's labels only", () => {
    const s = computeSnapshot([row("n1", ["gpu"], [server("web", "https://a.test/mcp")])], new Set(["n1"]));
    expect(s.servers.get("gpu")?.get("web")).toEqual({ type: "http", url: "https://a.test/mcp", fromPlugin: "toolkit" });
    expect(s.servers.get("default")).toBeUndefined();
  });

  test("states other than offerable are not offered", () => {
    const s = computeSnapshot([row("n1", ["gpu"], [server("web", "https://a.test/mcp", STATE_WRITABLE), server("h", "https://b.test/mcp", STATE_NEEDS_HEADERS)])], new Set(["n1"]));
    expect(s.servers.size).toBe(0);
  });

  test("two nodes of a label with different URLs: neither offered nor bridged, conflict shown", () => {
    const s = computeSnapshot(
      [row("n1", ["gpu"], [server("web", "https://a.test/mcp")]), row("n2", ["gpu"], [server("web", "https://b.test/mcp")])],
      new Set(["n1", "n2"]),
    );
    expect(s.servers.get("gpu")?.has("web") ?? false).toBe(false);
    expect([...s.conflicts.get("gpu")!]).toEqual(["web"]);
  });

  test("a URL disagreement from a node that is not offerable still blocks the offer", () => {
    const s = computeSnapshot(
      [row("n1", ["gpu"], [server("web", "https://a.test/mcp")]), row("n2", ["gpu"], [server("web", "https://b.test/mcp", STATE_WRITABLE)])],
      new Set(["n1", "n2"]),
    );
    expect(s.servers.get("gpu")?.has("web") ?? false).toBe(false);
    expect([...s.conflicts.get("gpu")!]).toEqual(["web"]);
  });

  test("a different URL on another label is no conflict", () => {
    const s = computeSnapshot([row("n1", ["gpu"], [server("web", "https://a.test/mcp")]), row("n2", ["cpu"], [server("web", "https://b.test/mcp")])], new Set(["n1", "n2"]));
    expect(s.servers.get("gpu")?.get("web")?.url).toBe("https://a.test/mcp");
    expect(s.servers.get("cpu")?.get("web")?.url).toBe("https://b.test/mcp");
  });

  test("a server leaves when no live node's latest report lists it; a dead node's URL does not conflict", () => {
    const rows = [row("dead", ["gpu"], [server("old", "https://old.test/mcp"), server("web", "https://stale.test/mcp")]), row("live", ["gpu"], [server("web", "https://a.test/mcp")])];
    const s = computeSnapshot(rows, new Set(["live"]));
    expect(s.servers.get("gpu")?.has("old") ?? false).toBe(false);
    expect(s.servers.get("gpu")?.get("web")?.url).toBe("https://a.test/mcp");
    expect(s.conflicts.get("gpu")).toBeUndefined();
  });

  test("a node with no plugins contributes nothing", () => {
    const s = computeSnapshot([row("n1", ["gpu"], [])], new Set(["n1"]));
    expect(s.servers.size).toBe(0);
  });
});

describe("the view", () => {
  test("empty by default: a process that never starts it offers nothing", () => {
    expect(pluginServersFor("default")).toEqual({});
  });

  test("refresh swaps the snapshot; removal follows a dead node", async () => {
    let live = new Set(["n1"]);
    const h = await startPluginInventory({ rows: async () => [row("n1", ["gpu"], [server("web", "https://a.test/mcp")])], live: async () => live }, { intervalMs: 3_600_000 });
    expect(pluginServersFor("gpu").web?.url).toBe("https://a.test/mcp");
    live = new Set();
    await refreshPluginInventory();
    expect(pluginServersFor("gpu")).toEqual({});
    h.stop();
    expect(currentSnapshot().servers.size).toBe(0);
  });

  test("a failed refresh keeps the last good view until it is stale, then empty", () => {
    __setPluginInventorySnapshot({ ...computeSnapshot([row("n1", ["gpu"], [server("web", "https://a.test/mcp")])], new Set(["n1"])), at: 1_000 });
    expect(pluginServersFor("gpu", 2_000).web).toBeDefined();
    expect(pluginServersFor("gpu", 1_000 + STALE_AFTER_MS + 1)).toEqual({});
  });

  test("a first load that fails leaves the view empty and running", async () => {
    const orig = console.warn;
    console.warn = () => {};
    const h = await startPluginInventory({ rows: async () => { throw new Error("no db"); }, live: async () => new Set() }, { intervalMs: 3_600_000 });
    console.warn = orig;
    expect(pluginServersFor("gpu")).toEqual({});
    h.stop();
  });
});

describe("bridge merge", () => {
  const offer = (label: string, ...servers: Array<[string, string]>) => {
    __setPluginInventorySnapshot(computeSnapshot([row("n1", [label], servers.map(([n, u]) => server(n, u)))], new Set(["n1"])));
  };

  test("an agent gets the plugin servers of its own label only", () => {
    offer("gpu", ["web", "https://a.test/mcp"]);
    const r = reg({ onGpu: { runsOn: "gpu" }, onCpu: { runsOn: "cpu" } });
    expect(bridgedServerNames("onGpu", { registry: r })).toEqual(["web"]);
    expect(bridgedServerNames("onCpu", { registry: r })).toEqual([]);
    expect(bridgedServerNames(undefined, { registry: r })).toEqual([]);
  });

  test("the persona's own server of the same name wins", () => {
    offer("default", ["web", "https://plugin.test/mcp"], ["extra", "https://e.test/mcp"]);
    const r = reg({ a: { mcp: { mcpServers: { web: { type: "http", url: "https://own.test/mcp", headers: { x: "1" } } } } } });
    const out = bridgeExternalMcp("a", { registry: r });
    expect((out.servers.web as { url: string }).url).toBe("https://own.test/mcp");
    expect((out.servers.web as { fromPlugin?: string }).fromPlugin).toBeUndefined();
    expect(Object.keys(out.servers).sort()).toEqual(["extra", "web"]);
  });

  test("an unknown or unlisted persona never picks up plugin servers", () => {
    offer("default", ["web", "https://a.test/mcp"]);
    const r = reg({});
    expect(bridgeExternalMcp("ghost", { registry: r })).toEqual({ servers: {}, privateServices: [] });
  });

  test("the plugin copy is fresh per call: a caller's mutation does not reach the view", () => {
    offer("default", ["web", "https://a.test/mcp"]);
    const r = reg({ a: {} });
    (bridgeExternalMcp("a", { registry: r }).servers.web as { url: string }).url = "https://tampered.test";
    expect((bridgeExternalMcp("a", { registry: r }).servers.web as { url: string }).url).toBe("https://a.test/mcp");
  });

  test("connectableServers in the gateway role includes them with the plugin named", () => {
    offer("default", ["web", "https://a.test/mcp"]);
    const r = reg({ a: {} });
    const out = connectableServers("a", { servers: {}, privateServices: [] }, r, { role: "gateway" });
    expect(out.web).toMatchObject({ url: "https://a.test/mcp", fromPlugin: "toolkit" });
    expect(oauthKey("web", out.web!)).toBe(oauthKey("web", { type: "http", url: "https://a.test/mcp" }));
  });

  test("mono does not see plugin servers through connectableServers", () => {
    offer("default", ["web", "https://a.test/mcp"]);
    const r = reg({ a: {} });
    const out = connectableServers("a", { servers: {}, privateServices: [] }, r, { role: "mono" });
    expect(out).toEqual({});
  });

  test("an empty inventory leaves the bridge's answer identical", () => {
    const r = reg({ a: { mcp: { mcpServers: { web: { type: "http", url: "https://own.test/mcp" } } } } });
    expect(bridgeExternalMcp("a", { registry: r })).toEqual({
      servers: { web: { type: "http", url: "https://own.test/mcp" } as never },
      privateServices: [],
    });
    __setPluginInventorySnapshot(EMPTY_SNAPSHOT);
  });

  test("a URL change gives a different credential key: a new connect is needed", () => {
    offer("default", ["web", "https://a.test/mcp"]);
    const r = reg({ a: {} });
    const before = connectableServers("a", { servers: {}, privateServices: [] }, r, { role: "gateway" }).web!;
    offer("default", ["web", "https://other.test/mcp"]);
    const after = connectableServers("a", { servers: {}, privateServices: [] }, r, { role: "gateway" }).web!;
    expect(oauthKey("web", before)).not.toBe(oauthKey("web", after));
  });
});
