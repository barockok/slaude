import { afterEach, describe, expect, test } from "bun:test";
import { bridgedServerNames, bridgeExternalMcp, connectableServers } from "../../../src/gateway/core/external-mcp";
import {
  __setPluginInventorySnapshot,
  computeSnapshot,
  currentSnapshot,
  EMPTY_SNAPSHOT,
  loadInventory,
  pluginServersFor,
  noteReported,
  prunableInstances,
  PRUNE_DEAD_MS,
  REPORT_REFRESH_MIN_MS,
  TOUCH_EVERY_MS,
  refreshPluginInventory,
  STALE_AFTER_MS,
  startPluginInventory,
} from "../../../src/gateway/core/plugin-inventory";
import { revokeNodeCredential } from "../../../src/gateway/auth/node-credential";
import type { PersonaRegistry } from "../../../src/persona/registry";
import type { NodePluginsRow } from "../../../src/db/node-plugins";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";
import { STATE_DNS_PENDING, STATE_NEEDS_HEADERS, STATE_OFFERABLE, STATE_REFUSED_POLICY, STATE_WRITABLE } from "../../../src/config/plugin-inventory";

const server = (name: string, url: string, state = STATE_OFFERABLE) => ({ name, url, state });
const row = (nodeId: string, labels: string[], http: ReturnType<typeof server>[], plugin = "toolkit", instance = nodeId, reportedAt = 1, credentialIat = 1_000): NodePluginsRow => ({
  nodeId,
  instance,
  labels,
  reportedAt,
  lastSeenAt: reportedAt,
  credentialIat,
  report: { instance, plugins: [{ name: plugin, marketplace: "m", commit: null, skills: 0, commands: 0, agents: 0, hooks: 0, stdio: [], http: http as never }] },
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

  test("an unsealed disagreement cannot veto a sealed server: offered, with a warning", () => {
    const s = computeSnapshot(
      [row("n1", ["gpu"], [server("web", "https://a.test/mcp")]), row("n2", ["gpu"], [server("web", "https://attacker.test/mcp", STATE_WRITABLE)])],
      new Set(["n1", "n2"]),
    );
    expect(s.servers.get("gpu")?.get("web")?.url).toBe("https://a.test/mcp");
    expect(s.conflicts.get("gpu")).toBeUndefined();
    expect([...s.unsealedDisagreements.get("gpu")!]).toEqual(["web"]);
  });

  test("an unsealed report alone offers nothing and warns of nothing", () => {
    const s = computeSnapshot([row("n2", ["gpu"], [server("web", "https://attacker.test/mcp", STATE_WRITABLE)])], new Set(["n2"]));
    expect(s.servers.size).toBe(0);
    expect(s.unsealedDisagreements.size).toBe(0);
  });

  test("two processes sharing a credential are compared and live separately", () => {
    const rows = [row("shared", ["gpu"], [server("web", "https://a.test/mcp")], "toolkit", "p1"), row("shared", ["gpu"], [server("web", "https://b.test/mcp")], "toolkit", "p2")];
    expect([...computeSnapshot(rows, new Set(["p1", "p2"])).conflicts.get("gpu")!]).toEqual(["web"]);
    expect(computeSnapshot(rows, new Set(["p1"])).servers.get("gpu")?.get("web")?.url).toBe("https://a.test/mcp");
    expect(computeSnapshot(rows, new Set()).servers.size).toBe(0);
  });

  test("a new process whose report failed does not inherit the previous process's row", () => {
    // The credential is alive through p2, but p2 has no report; p1 (dead) does.
    const rows = [row("n1", ["gpu"], [server("web", "https://old.test/mcp")], "toolkit", "p1")];
    expect(computeSnapshot(rows, new Set(["p2"])).servers.size).toBe(0);
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

describe("loadInventory and refresh", () => {
  const rows = [row("n1", ["gpu"], [server("web", "https://a.test/mcp")], "toolkit", "p1", 5_000)];

  test("a row is void when its credential was issued before the revocation, however recent the report", async () => {
    // Reported long after the revocation time, with a credential minted before it.
    const late = [row("n1", ["gpu"], [server("web", "https://a.test/mcp")], "toolkit", "p1", 9_000_000, 5)];
    const h = await startPluginInventory({ rows: async () => late, live: async () => new Set(["p1"]), revokedBefore: async () => 10 }, { intervalMs: 3_600_000 });
    expect(pluginServersFor("gpu")).toEqual({});
    h.stop();
  });

  test("a credential issued after the revocation still counts", async () => {
    const fresh = [row("n1", ["gpu"], [server("web", "https://a.test/mcp")], "toolkit", "p1", 5_000, 20)];
    const out = await loadInventory({ rows: async () => fresh, live: async () => new Set(["p1"]), revokedBefore: async () => 10 });
    expect(out.rows).toHaveLength(1);
  });

  test("sqlite cannot revoke (undefined): rows are kept", async () => {
    const out = await loadInventory({ rows: async () => rows, live: async () => new Set(["p1"]), revokedBefore: async () => undefined });
    expect(out.rows).toHaveLength(1);
  });

  test("a revocation source that fails keeps the last view rather than offering unchecked", async () => {
    await expect(loadInventory({ rows: async () => rows, live: async () => new Set(["p1"]), revokedBefore: async () => { throw new Error("db down"); } })).rejects.toThrow("db down");
  });

  test("a DNS failure is re-evaluated at refresh, without a new report", async () => {
    let resolves = false;
    const pending = [row("n1", ["gpu"], [server("web", "https://a.example.com/mcp", STATE_DNS_PENDING)], "toolkit", "p1")];
    const src = {
      rows: async () => pending,
      live: async () => new Set(["p1"]),
      policy: { resolver: async () => { if (!resolves) throw new Error("SERVFAIL"); return [{ address: "93.184.216.34", family: 4 }]; } },
    };
    const h = await startPluginInventory(src, { intervalMs: 3_600_000 });
    expect(pluginServersFor("gpu")).toEqual({});
    resolves = true;
    await refreshPluginInventory();
    expect(pluginServersFor("gpu").web?.url).toBe("https://a.example.com/mcp");
    h.stop();
  });

  test("a pending host that now resolves private is refused", async () => {
    const pending = [row("n1", ["gpu"], [server("web", "https://a.example.com/mcp", STATE_DNS_PENDING)], "toolkit", "p1")];
    const out = await loadInventory({ rows: async () => pending, live: async () => new Set(["p1"]), policy: { resolver: async () => [{ address: "10.0.0.1", family: 4 }] } });
    expect(out.rows[0]!.report.plugins[0]!.http[0]!.state).toBe(STATE_REFUSED_POLICY);
  });

  test("pruning needs a long dead period; live rows and an offline credential's last report stay", () => {
    const now = PRUNE_DEAD_MS * 10;
    const old = 1;
    const recent = now - PRUNE_DEAD_MS + 1;
    const mk = (id: string, inst: string, at: number) => row(id, ["gpu"], [], "toolkit", inst, at);
    const out = prunableInstances(
      [mk("a", "a-live", old), mk("a", "a-dead", old), mk("a", "a-recent", recent), mk("b", "b-old", old), mk("b", "b-newest", old + 1)],
      new Set(["a-live"]),
      now,
    );
    expect(out.sort()).toEqual(["a-dead", "b-old"]);
  });

  test("a live process's row is never removed, even a very old one, so its id stays taken", async () => {
    const rows2 = [row("a", ["gpu"], [], "toolkit", "old-live", 1), row("a", ["gpu"], [], "toolkit", "gone", 1), row("a", ["gpu"], [], "toolkit", "newest", 2)];
    const removed: string[] = [];
    let reads = 0;
    // The first read misses "old-live" (a blip); the check before deleting sees it.
    const live = async (ids: readonly string[]) => (++reads === 1 ? new Set(["newest"]) : new Set(ids.filter((i) => i === "old-live" || i === "newest")));
    const h = await startPluginInventory({ rows: async () => rows2, live, remove: async (i) => void removed.push(...i) }, { intervalMs: 3_600_000 });
    expect(removed).toEqual(["gone"]);
    h.stop();
  });

  test("a live process's last-seen is written, and at most hourly", async () => {
    const now = Date.now();
    const rows2 = [
      { ...row("a", ["gpu"], [], "toolkit", "stale", now - TOUCH_EVERY_MS - 1), lastSeenAt: now - TOUCH_EVERY_MS - 1 },
      { ...row("a", ["gpu"], [], "toolkit", "fresh", now), lastSeenAt: now },
      { ...row("a", ["gpu"], [], "toolkit", "dead", now - TOUCH_EVERY_MS - 1), lastSeenAt: now - TOUCH_EVERY_MS - 1 },
    ];
    const touched: string[] = [];
    const h = await startPluginInventory({ rows: async () => rows2, live: async () => new Set(["stale", "fresh"]), touch: async (i) => void touched.push(...i) }, { intervalMs: 3_600_000 });
    expect(touched).toEqual(["stale"]);
    h.stop();
  });

  test("reports refresh at most once per window", async () => {
    let loads = 0;
    const h = await startPluginInventory({ rows: async () => { loads++; return []; }, live: async () => new Set() }, { intervalMs: 3_600_000 });
    __setPluginInventorySnapshot(null); // also resets the window
    loads = 0;
    const t0 = 1_000_000;
    noteReported(t0);
    noteReported(t0 + 1);
    noteReported(t0 + REPORT_REFRESH_MIN_MS - 1);
    await Bun.sleep(5);
    expect(loads).toBe(1);
    noteReported(t0 + REPORT_REFRESH_MIN_MS);
    await Bun.sleep(5);
    expect(loads).toBe(2);
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

  test("a job's signed label decides, not the persona's current one", () => {
    offer("gpu", ["web", "https://a.test/mcp"]);
    const r = reg({ moved: { runsOn: "cpu" } });
    expect(bridgedServerNames("moved", { registry: r })).toEqual([]);
    expect(bridgedServerNames("moved", { registry: r, label: "gpu" })).toEqual(["web"]);
    const stillGpu = reg({ left: { runsOn: "gpu" } });
    expect(bridgedServerNames("left", { registry: stillGpu, label: "cpu" })).toEqual([]);
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

describe("revokeNodeCredential", () => {
  test("deletes the credential's plugin rows", async () => {
    const sql: string[] = [];
    await revokeNodeCredential("n1", { run: async (q: string) => void sql.push(q) });
    expect(sql.some((q) => q.includes("DELETE FROM node_plugins"))).toBe(true);
  });
});
