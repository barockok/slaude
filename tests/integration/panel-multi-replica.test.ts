/**
 * Control-panel cross-replica correctness (adversarial-review regressions
 * F1/F2/F3). Two gateway replicas share one Redis prefix + the process-global
 * DB — the real multi-replica topology. The operator drives via replica A while
 * the node's /v1 posts land on replica B, so per-process panel state (held /
 * defer / notice) can NOT stand in for the cross-replica invariant.
 *
 *   F1 — a Slack inbound deferred on the non-owning replica B must still replay
 *        when the lock releases on A (resume is broadcast over Redis pub/sub).
 *   F2 — the node's /v1 reply, executed on non-holding replica B, must be
 *        suppressed (held-check consults Redis, not just B's local map).
 *   F3 — exactly ONE "handled in ops panel" notice across BOTH replicas
 *        (Redis SET NX dedup, not a per-process guard).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  realEnabled,
  until,
  sleep,
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

const CH = "D0MULTI";
const T1 = "9500.1";
const OP = { "x-auth-request-email": "op@example.com", "x-panel-csrf": "1" };

let redis: any;
let keys: any;
let pubsub: any;
let sessions: any;
let gwA: Replica; // operator drives here (lock/chat/release)
let gwB: Replica; // node posts /v1 here (non-holding replica)
let node: { agent: any; worker: any };
let sessionId: string;

const notices = (t: any) =>
  t.outbound.filter((c: any) => typeof c.text === "string" && c.text.includes("handled in ops panel")).length;

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  process.env.SLAUDE_PANEL_TRUST_HEADER = "1";
  const { makeKeys } = await import("../../src/queue/keys");
  const { makePubSub } = await import("../../src/queue/pubsub");
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");

  keys = makeKeys(testPrefix("panelmulti"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const sub = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  pubsub = makePubSub({ redis, sub, keys });

  gwA = await bootReplica(keys, { panel: true });
  gwB = await bootReplica(keys, { panel: true });
  // Node's /v1 (session lookup + tool-plane posts) targets replica B — so the
  // agent's reply is executed on B, the replica that does NOT hold the lock.
  node = await bootNode(keys, gwB.url, { nodeId: "multi-node" });
  node.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "mr-reply" });

  // Create the session with a first turn (reply lands on gwB.transport).
  await gwB.transport.feedMessage(dm(CH, T1, "boot the session"));
  await until(() => replies(gwB.transport, "mr-reply").length >= 1, 20_000);
  const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
  sessionId = row!.id;
});

afterAll(async () => {
  if (!realEnabled) return;
  await node?.worker.stop({ drainSec: 1 }).catch(() => {});
  await gwA?.stop().catch(() => {});
  await gwB?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_PANEL_TRUST_HEADER;
  teardownScenarioEnv();
});

d("panel across two replicas (real Redis)", () => {
  test("F3 + F1: one notice across both replicas; inbound deferred on the non-owning replica replays on release", async () => {
    const repliesBefore = replies(gwB.transport, "mr-reply").length;
    const noticesBefore = notices(gwA.transport) + notices(gwB.transport);

    // Operator takes control via replica A.
    const lock = await fetch(`${gwA.url}/panel/api/sessions/${sessionId}/lock`, { method: "POST", headers: OP });
    expect(lock.status).toBe(200);
    expect(await redis.get(keys.panelLock(sessionId))).toBe("op@example.com");

    // One Slack inbound to A (owner replica), one to B (non-owning replica).
    // Both must defer; exactly one notice total (Redis NX dedup — F3).
    await gwA.transport.feedMessage({ ...dm(CH, "9500.2", "inbound on A while locked"), thread_ts: T1 });
    await gwB.transport.feedMessage({ ...dm(CH, "9500.3", "inbound on B while locked"), thread_ts: T1 });
    await sleep(500);
    expect(notices(gwA.transport) + notices(gwB.transport)).toBe(noticesBefore + 1); // F3: one, not two
    expect(replies(gwB.transport, "mr-reply").length).toBe(repliesBefore); // both deferred, nothing ran

    // Release on A → resume broadcast → BOTH replicas drain their own queue.
    // The message deferred on B must NOT be orphaned (F1): both replay → 2 turns.
    const rel = await fetch(`${gwA.url}/panel/api/sessions/${sessionId}/release`, { method: "POST", headers: OP });
    expect(rel.status).toBe(200);
    await until(() => replies(gwB.transport, "mr-reply").length >= repliesBefore + 2, 25_000);
  }, 45_000);

  test("F2: the node's /v1 reply on the non-holding replica B is suppressed while A holds the lock", async () => {
    // Take control on A again.
    await fetch(`${gwA.url}/panel/api/sessions/${sessionId}/lock`, { method: "POST", headers: OP });
    const repliesBefore = replies(gwB.transport, "mr-reply").length;
    const eventsBefore = (await pubsub.readEvents(sessionId)).length;

    // Operator drives via A → dispatched to the shared queue → node executes the
    // reply via B's /v1. B is NOT the lock owner; without the Redis-backed
    // held-check it would post (F2 double-post). It must suppress.
    const chat = await fetch(`${gwA.url}/panel/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { ...OP, "content-type": "application/json" },
      body: JSON.stringify({ text: "driven from replica A" }),
    });
    expect(chat.status).toBe(202);

    // The turn runs (event stream grows)…
    await until(async () => (await pubsub.readEvents(sessionId)).length > eventsBefore, 20_000);
    await sleep(500); // let any (wrongly) posted reply surface
    // …but B suppressed the Slack echo.
    expect(replies(gwB.transport, "mr-reply").length).toBe(repliesBefore);

    // Hand back to Slack.
    await fetch(`${gwA.url}/panel/api/sessions/${sessionId}/release`, { method: "POST", headers: OP });
  }, 40_000);
});
