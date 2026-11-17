/**
 * Scenario (plugin inventory design): the full path, real Redis.
 *
 *   node report (real builder over a sealed tree)
 *     -> PUT /v1/node/plugins on a gateway replica (real credential check)
 *     -> stored -> view (real Redis liveness, beaten by a real node worker)
 *     -> portal rows and the bridge's server list;
 *   a dead node's server then leaves the portal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realEnabled, until, cleanupPrefix, setupScenarioEnv, teardownScenarioEnv, bootReplica, bootNode, REAL_URL, testPrefix, type Replica } from "./harness";

const d = describe.skipIf(!realEnabled || process.getuid?.() === 0);

let redis: any;
let keys: any;
let gw: Replica;
let node: { worker: any };
let registry: any;
let tree: string;
let root: string;
let view: { stop(): void } | null = null;
let portal: typeof import("../../src/gateway/portal/integrations");
let externalMcp: typeof import("../../src/gateway/core/external-mcp");
const prefix = testPrefix("plugin-inv");
const savedRole = process.env.SLAUDE_ROLE;
const NODE_KEY = "plugin-inventory-node-key-0123456789abcdef";
const INSTANCE = "scen-plugin-1a2b3c";

/** A sealed image-owned root with one plugin. */
function makeTree() {
  tree = mkdtempSync(join(tmpdir(), "plugin-scen-"));
  root = join(tree, "root");
  const dir = join(root, "plugins", "cache", "market", "toolkit", "1.0.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { web: { type: "http", url: "https://93.184.216.34/mcp" } } }));
  writeFileSync(join(root, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "toolkit@market": [{ installPath: dir, gitCommitSha: "abc1234" }] } }));
  for (const p of [root, join(root, "plugins"), join(root, "plugins", "cache"), join(root, "plugins", "cache", "market"), join(root, "plugins", "cache", "market", "toolkit"), dir]) chmodSync(p, 0o555);
  chmodSync(join(dir, ".mcp.json"), 0o444);
  chmodSync(join(root, "plugins", "installed_plugins.json"), 0o444);
}

function unseal() {
  for (const p of [root, join(root, "plugins"), join(root, "plugins", "cache"), join(root, "plugins", "cache", "market"), join(root, "plugins", "cache", "market", "toolkit"), join(root, "plugins", "cache", "market", "toolkit", "1.0.0")]) {
    try { chmodSync(p, 0o755); } catch { /* gone */ }
  }
}

d("plugin inventory, full path", () => {
  beforeAll(async () => {
    await setupScenarioEnv();
    process.env.SLAUDE_ROLE = "gateway";
    makeTree();
    process.env.SLAUDE_PLUGIN_ROOT = root;
    const { Redis } = await import("ioredis");
    const { makeKeys } = await import("../../src/queue/keys");
    const { makeRegistry } = await import("../../src/queue/registry");
    process.env.SLAUDE_NODE_KEY = NODE_KEY;
    redis = new Redis(REAL_URL);
    keys = makeKeys(prefix);
    registry = makeRegistry({ redis, keys, heartbeatSec: 1, nodeTtlSec: 3 });
    gw = await bootReplica(keys);
    node = await bootNode(keys, gw.url, { nodeId: INSTANCE });
    portal = await import("../../src/gateway/portal/integrations");
    externalMcp = await import("../../src/gateway/core/external-mcp");
    const { startPluginInventory } = await import("../../src/gateway/core/plugin-inventory");
    const { listNodePlugins } = await import("../../src/db/node-plugins");
    view = await startPluginInventory({ rows: listNodePlugins, live: (ids) => registry.liveNodeIds(ids) }, { intervalMs: 100 });
  });

  afterAll(async () => {
    view?.stop();
    await node?.worker?.stop?.().catch?.(() => {});
    await gw?.stop();
    const { db } = await import("../../src/db/schema");
    await db.run(`DELETE FROM node_plugins`).catch(() => {});
    await cleanupPrefix(redis, prefix);
    await redis?.quit();
    unseal();
    rmSync(tree, { recursive: true, force: true });
    teardownScenarioEnv();
    delete process.env.SLAUDE_PLUGIN_ROOT;
    delete process.env.SLAUDE_NODE_KEY;
    if (savedRole === undefined) delete process.env.SLAUDE_ROLE;
    else process.env.SLAUDE_ROLE = savedRole;
  });

  test("a sealed plugin's server reaches the portal and the bridge, and leaves with its node", async () => {
    const { NodeClient } = await import("../../src/node/client");
    const { buildPluginReport } = await import("../../src/node/plugin-report");
    const { STATE_OFFERABLE } = await import("../../src/config/plugin-inventory");
    const { pluginServersFor, refreshPluginInventory } = await import("../../src/gateway/core/plugin-inventory");

    const report = buildPluginReport({ instance: INSTANCE, manifest: { servers: {} }, sealed: { boundary: tree, ownerOf: () => 0 } });
    expect(report.plugins[0]!.http[0]!.state).toBe(STATE_OFFERABLE);

    const { mintNodeCredential } = await import("../../src/gateway/auth/node-credential");
    const token = mintNodeCredential({ id: "scen-plugin", labels: ["default"] }, { key: NODE_KEY });
    const client = new NodeClient({ baseUrl: gw.url, token, baseDelayMs: 5 });
    expect(await client.putPlugins(report)).toBe("ok");

    await until(() => pluginServersFor("default").web?.url === "https://93.184.216.34/mcp", 5000);

    expect(externalMcp.bridgedServerNames(undefined)).toEqual(["web"]);
    const rows = portal.portalServers({ global: { servers: {}, privateServices: [] } });
    expect(rows.map((r) => [r.id, r.plugin, r.cfg.url])).toEqual([["web", "toolkit", "https://93.184.216.34/mcp"]]);
    expect(portal.configuredServer("web", rows)?.cfg.url).toBe("https://93.184.216.34/mcp");

    // The reporting process goes away: the server leaves the portal.
    await node.worker.stop();
    await redis.del(keys.node(INSTANCE));
    await refreshPluginInventory();
    expect(pluginServersFor("default")).toEqual({});
    expect(portal.portalServers({ global: { servers: {}, privateServices: [] } })).toEqual([]);
  });
});
