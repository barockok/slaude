/**
 * Scenario (node labels spec §4.6, §4.8): label routing end to end through a
 * gateway replica, the /v1 gate and two node workers.
 *
 *   scen-lr-eng  signed credential, labels {engineering}
 *   scen-lr-def  the legacy shared token, {default}
 *
 * The default persona is relabelled between turns (a managed registry
 * snapshot whose default row says `runs_on`):
 *
 *   1. runs_on engineering → every turn runs on the engineering node, and the
 *      session goes warm there;
 *   2. runs_on cleared (default) → the next turn runs on the default node even
 *      though the session is warm on the engineering node, which lacks the
 *      label: warm routing is ignored, and the gate would have refused the
 *      engineering node anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  realEnabled,
  until,
  cleanupPrefix,
  setupScenarioEnv,
  teardownScenarioEnv,
  bootReplica,
  bootNode,
  dm,
  replies,
  REAL_URL,
  NODE_TOKEN,
  testPrefix,
  type Replica,
} from "./harness";

const d = describe.skipIf(!realEnabled);

const CH = "D0LABELS";
const T1 = "8600.1";
const NODE_KEY = "label-routing-node-key-0123456789abcdef";

let redis: any;
let keys: any;
let registry: any;
let gw: Replica;
let nodes: Array<{ agent: any; worker: any }> = [];
let sessions: any;
let setRegistry: (r: any) => void = () => {};
let resetRegistry: () => void = () => {};

/** A managed registry snapshot whose default persona runs on `label`. */
const managedDefault = (label: string | null) => ({
  lookupByUserId: () => null,
  lookupByName: () => null,
  list: () => [],
  isMultiPersonaMode: () => false,
  isManaged: () => true,
  tombstonedPersonaFor: () => null,
  defaultPersona: () => ({ model: null, mcp: null, runsOn: label }),
});

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  process.env.SLAUDE_NODE_KEY = NODE_KEY;
  // With a node key set, the legacy door opens only on its own variable.
  process.env.SLAUDE_NODE_LEGACY_TOKEN = NODE_TOKEN;
  const { makeKeys } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { mintNodeCredential } = await import("../../src/gateway/auth/node-credential");
  const { NodeClient } = await import("../../src/node/client");
  const reg = await import("../../src/persona/registry");
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");
  setRegistry = reg.setPersonaRegistry as any;
  resetRegistry = reg.__resetPersonaRegistry;

  keys = makeKeys(testPrefix("labelroute"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
  gw = await bootReplica(keys);
  const cred = mintNodeCredential({ id: "scen-lr-eng", labels: ["engineering"] }, { key: NODE_KEY });
  nodes = [
    await bootNode(keys, gw.url, {
      nodeId: "scen-lr-eng",
      worker: { labels: ["engineering"], client: new NodeClient({ baseUrl: gw.url, token: cred, baseDelayMs: 5 }) },
    }),
    await bootNode(keys, gw.url, { nodeId: "scen-lr-def" }),
  ];
  nodes[0]!.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "lr-reply via=scen-lr-eng" });
  nodes[1]!.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "lr-reply via=scen-lr-def" });
});

afterAll(async () => {
  if (!realEnabled) return;
  resetRegistry();
  for (const n of nodes) await n.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_NODE_KEY;
  delete process.env.SLAUDE_NODE_LEGACY_TOKEN;
  teardownScenarioEnv();
});

const viaOf = (text: string) => text.match(/via=(\S+)/)?.[1];

d("label routing through gateway, gate and nodes (real Redis)", () => {
  test("a persona on engineering runs only on the engineering node, and goes warm there", async () => {
    setRegistry(managedDefault("engineering"));
    await gw.transport.feedMessage(dm(CH, T1, "first"));
    await until(() => replies(gw.transport, "lr-reply").length >= 1, 20_000);
    await gw.transport.feedMessage({ ...dm(CH, "8600.2", "second"), thread_ts: T1 });
    await until(() => replies(gw.transport, "lr-reply").length >= 2, 20_000);
    expect(replies(gw.transport, "lr-reply").map((r) => viaOf(r.text))).toEqual(["scen-lr-eng", "scen-lr-eng"]);
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    await until(async () => (await registry.lookup(row!.id))?.node === "scen-lr-eng", 10_000);
  }, 45_000);

  test("after a relabel to default, warm routing to the engineering node is ignored", async () => {
    setRegistry(managedDefault(null));
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    expect((await registry.lookup(row!.id))?.node).toBe("scen-lr-eng"); // still warm there
    await gw.transport.feedMessage({ ...dm(CH, "8600.3", "third"), thread_ts: T1 });
    await until(() => replies(gw.transport, "lr-reply").length >= 3, 20_000);
    expect(viaOf(replies(gw.transport, "lr-reply")[2]!.text)).toBe("scen-lr-def");
  }, 45_000);
});
