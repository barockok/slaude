/**
 * The worker's manifest default is gated on the role (node labels spec §4.10):
 * with no explicit `manifest` option, SLAUDE_ROLE=node reads SLAUDE_NODE_MANIFEST
 * (an invalid file stops the worker before any connection) and installs the
 * manifest MCP resolver; any other role reads no manifest and installs none.
 * Real Redis, gated: a worker that passes the manifest step connects.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_URL, cleanupPrefix, realEnabled, sweepTag, testPrefix } from "../queue/real";

const d = describe.skipIf(!realEnabled);

const dir = mkdtempSync(join(tmpdir(), "slaude-wmanifest-"));
const invalid = join(dir, "invalid.json");
const valid = join(dir, "valid.json");
writeFileSync(invalid, JSON.stringify({ version: 1, mcpServers: { web: { command: "x", type: "http" } } }));
writeFileSync(valid, JSON.stringify({ version: 1, mcpServers: { gh: { command: "gh-mcp" } }, allow: { default: ["gh"] } }));

let redis: any;
let keys: any;
let start: (role: string, manifestPath: string, extra?: Record<string, unknown>) => Promise<{ installed: unknown[]; handle: any }>;
const handles: any[] = [];
const saved = { role: process.env.SLAUDE_ROLE, manifest: process.env.SLAUDE_NODE_MANIFEST };

function restoreEnv() {
  if (saved.role === undefined) delete process.env.SLAUDE_ROLE;
  else process.env.SLAUDE_ROLE = saved.role;
  if (saved.manifest === undefined) delete process.env.SLAUDE_NODE_MANIFEST;
  else process.env.SLAUDE_NODE_MANIFEST = saved.manifest;
}

beforeAll(async () => {
  if (!realEnabled) return;
  const { AgentManager } = await import("../../src/agent/manager");
  const { startNodeWorker } = await import("../../src/node/worker");
  const { NodeClient } = await import("../../src/node/client");
  const { makeKeys } = await import("../../src/queue/keys");
  const { Redis } = await import("ioredis");
  keys = makeKeys(testPrefix("wmanifest"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  await sweepTag(redis, "wmanifest");

  let n = 0;
  start = async (role, manifestPath, extra = {}) => {
    process.env.SLAUDE_ROLE = role;
    process.env.SLAUDE_NODE_MANIFEST = manifestPath;
    const installed: unknown[] = [];
    const agent = new (class extends AgentManager {
      override setLocalMcpResolver(r: any) {
        installed.push(r);
        super.setLocalMcpResolver(r);
      }
    })();
    try {
      const handle = await startNodeWorker({
        nodeId: `wm-${++n}`,
        client: new NodeClient({ baseUrl: "http://127.0.0.1:1", token: "unused", attempts: 1, baseDelayMs: 1 }),
        redisUrl: REAL_URL,
        keys,
        agent,
        heartbeatSec: 1,
        drainSec: 1,
        port: null,
        configRoot: dir,
        ...extra,
      });
      handles.push(handle);
      return { installed, handle };
    } finally {
      restoreEnv();
    }
  };
});

afterEach(async () => {
  while (handles.length) await handles.pop().stop({ drainSec: 1 }).catch(() => {});
});

afterAll(async () => {
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
  if (!realEnabled) return;
  await cleanupPrefix(redis, keys.prefix);
  await redis.quit();
});

d("startNodeWorker — the manifest default follows the role", () => {
  test("role node: an invalid manifest stops the worker", async () => {
    const { NodeManifestError } = await import("../../src/node/manifest");
    await expect(start("node", invalid)).rejects.toBeInstanceOf(NodeManifestError);
  });

  test("role node: a valid manifest installs the manifest MCP resolver", async () => {
    const { installed } = await start("node", valid);
    expect(installed).toHaveLength(1);
    expect(typeof installed[0]).toBe("function");
  });

  test("role mono: no manifest is read (an invalid file is ignored) and no resolver is installed", async () => {
    const { installed, handle } = await start("mono", invalid);
    expect(handle.state()).not.toBe("stopped");
    expect(installed).toEqual([]);
  });

  test("an explicit manifest: null wins over the node role", async () => {
    const { installed } = await start("node", invalid, { manifest: null });
    expect(installed).toEqual([]);
  });
});
