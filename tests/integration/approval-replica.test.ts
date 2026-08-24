/**
 * Scenario (spec §8): approval click lands on gateway replica 2.
 *
 * Two gateway replicas share Postgres/sqlite (process-global DB) and Redis
 * (same key prefix). A node turn opens an approval gate through replica 1's
 * /v1 (request_approval shim → pending_gates row + Block Kit card) and
 * long-polls replica 1. The approver's button click arrives at REPLICA 2,
 * which resolves the shared row and publishes the gate-bus wake; replica 1's
 * long-poll returns and the node's turn proceeds to the verdict reply.
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
  testPrefix,
  type Replica,
} from "./harness";

const d = describe.skipIf(!realEnabled);

const CH = "D0APPROVAL";
const TS = "8300.1";

let redis: any;
let keys: any;
let gw1: Replica;
let gw2: Replica;
let node: { agent: any; worker: any };
let PendingGates: any;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys } = await import("../../src/queue/keys");
  const { Redis } = await import("ioredis");
  PendingGates = await import("../../src/db/pending-gates");
  keys = makeKeys(testPrefix("apprrep"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  gw1 = await bootReplica(keys);
  gw2 = await bootReplica(keys);
  node = await bootNode(keys, gw1.url, { nodeId: "scen-appr" });
  node.agent.behavior = "request_approval"; // sim behavior over the shim tool plane
});

afterAll(async () => {
  if (!realEnabled) return;
  await node?.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw1?.stop().catch(() => {});
  await gw2?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

d("approval across gateway replicas (real Redis)", () => {
  test("gate opened via replica 1, click on replica 2 resolves it and the node proceeds", async () => {
    await gw1.transport.feedMessage(dm(CH, TS, "deploy the thing"));

    // The node's request_approval shim opened the gate: card on replica 1.
    await until(
      () => gw1.transport.outbound.some((c: any) => c.kind === "approval" && !c.resolved && c.actionIds.length > 0),
      20_000,
    );
    const card = gw1.transport.outbound.find(
      (c: any) => c.kind === "approval" && !c.resolved && c.actionIds.length > 0,
    )!;
    const approveId = card.actionIds.find((id: string) => id.split(":")[1] === "approve")!;
    const pendingId = approveId.split(":")[2]!;
    expect((await PendingGates.get(pendingId))?.status).toBe("pending");

    // The approver clicks on REPLICA 2 — different process role, same DB+bus.
    await gw2.transport.feedAction(approveId, "U0APP");

    // Row resolved, bus woke replica 1's long-poll, node finished the turn.
    await until(() => replies(gw1.transport, "approved by <@U0APP>").length >= 1, 20_000);
    const row = await PendingGates.get(pendingId);
    expect(row?.status).toBe("approved");
    expect(row?.resolvedBy).toBe("U0APP");

    // Turn completed on the node (done ✅ via the events follower).
    await until(
      () =>
        gw1.transport.outbound.some(
          (c: any) => c.kind === "reaction" && c.text === ":white_check_mark:" && c.threadTs === TS,
        ),
      15_000,
    );
    // Replica 2 never dispatched anything — it only resolved the click.
    expect(gw2.dispatches()).toBe(0);
    expect(gw1.dispatches()).toBe(1);
  }, 60_000);
});
