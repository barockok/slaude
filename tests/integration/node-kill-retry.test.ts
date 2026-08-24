/**
 * Scenario (spec §8): node killed mid-turn — BullMQ recovers the claimed job
 * onto the surviving node, the turn completes, and no duplicate Slack posts.
 *
 * SIGKILL emulation (in-process): the claiming node's worker is force-closed
 * (drain grace 0) while its stub turn hangs, so the BullMQ job lock stops
 * being renewed. The surviving worker's stalled checker (shrunk via the
 * `bull` seam) moves the job back to wait, claims it, and replies exactly
 * once. The victim never posted, so the retry produces the one and only
 * reply for the inbound ts.
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

const CH = "D0NODEKILL";
const TS = "8200.1";

let redis: any;
let keys: any;
let gw: Replica;
let nodes: Array<{ agent: any; worker: any }> = [];

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  const { makeKeys } = await import("../../src/queue/keys");
  const { Redis } = await import("ioredis");
  keys = makeKeys(testPrefix("nodekill"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  gw = await bootReplica(keys);
  // Short BullMQ job lock + aggressive stalled checks so the surviving worker
  // recovers the dead node's claim within test time.
  const bull = { lockDuration: 1500, stalledInterval: 500 };
  nodes = [
    await bootNode(keys, gw.url, { nodeId: "scen-nk-A", worker: { bull } }),
    await bootNode(keys, gw.url, { nodeId: "scen-nk-B", worker: { bull } }),
  ];
});

afterAll(async () => {
  if (!realEnabled) return;
  for (const n of nodes) await n.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  teardownScenarioEnv();
});

d("node kill mid-turn → BullMQ retry on the survivor (real Redis)", () => {
  test("claimed job is recovered by node B, turn completes, exactly one reply", async () => {
    // Both stubs hang on first claim (recording who claimed); once we know the
    // victim, the survivor is switched to a replying behavior for the retry.
    let claimedBy: { agent: any; worker: any } | undefined;
    const hangForever = (self: { agent: any; worker: any }) => async (_a: any) => {
      claimedBy ??= self;
      await new Promise(() => {}); // never resolves — mid-turn "kill" window
    };
    nodes[0]!.agent.run = hangForever(nodes[0]!);
    nodes[1]!.agent.run = hangForever(nodes[1]!);

    await gw.transport.feedMessage(dm(CH, TS, "long task about to die"));
    await until(() => claimedBy !== undefined, 15_000);
    const victim = claimedBy!;
    const survivor = nodes.find((n) => n !== victim)!;
    survivor.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "nk-reply after retry" });

    // SIGKILL: sever the victim's connections mid-turn — no drain, no
    // deregistration. Its BullMQ job lock and session lock stop renewing.
    victim.worker.kill();

    // The survivor's stalled checker moves the job back to wait and claims it.
    await until(() => replies(gw.transport, "nk-reply").length >= 1, 25_000);

    // Turn completed: done ✅ lands on the inbound ts (via the events follower).
    await until(
      () =>
        gw.transport.outbound.some(
          (c: any) => c.kind === "reaction" && c.text === ":white_check_mark:" && c.threadTs === TS,
        ),
      15_000,
    );

    // No duplicate Slack posts: exactly one reply for this turn, none from the
    // victim (it died before posting).
    expect(replies(gw.transport, "nk-reply").length).toBe(1);
    // And the inbound event ran exactly one visible turn — a single ✅ on ts.
    const checks = gw.transport.outbound.filter(
      (c: any) => c.kind === "reaction" && c.text === ":white_check_mark:" && c.threadTs === TS,
    );
    expect(checks.length).toBe(1);
  }, 60_000);
});
