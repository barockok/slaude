import { describe, it, expect, beforeAll, afterAll } from "bun:test";

// Real-Redis coverage for src/cluster/{lease,forwarder}.ts. The unit tests in
// this directory exercise the same logic against a hand-written FakeRedisClient
// — useful for fast, deterministic CAS/TTL assertions, but they only prove the
// code is internally consistent, not that the real `redis` npm client's option
// shapes (`condition`/`expiration`), EVAL/Lua execution, and pub/sub actually
// behave the way this code assumes. This file closes that gap.
//
// Gated on SLAUDE_TEST_REDIS_URL so `bun test` stays redis-free locally and in
// any environment without the service container — CI provides it via the
// `redis:` service block in .github/workflows/ci.yml.
const REDIS_URL = process.env.SLAUDE_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("cluster/lease + cluster/forwarder against a real Redis", () => {
  let RedisLeaseStore: typeof import("../../src/cluster/lease").RedisLeaseStore;
  let RedisForwarder: typeof import("../../src/cluster/forwarder").RedisForwarder;
  let createClient: typeof import("redis").createClient;
  let client: import("redis").RedisClientType;

  beforeAll(async () => {
    ({ RedisLeaseStore } = await import("../../src/cluster/lease"));
    ({ RedisForwarder } = await import("../../src/cluster/forwarder"));
    ({ createClient } = await import("redis"));
    client = createClient({ url: REDIS_URL });
    client.on("error", (err) => console.error("[redis-integration] client error:", err));
    await client.connect();
    await client.flushDb();
  });

  afterAll(async () => {
    await client.flushDb();
    await client.quit();
  });

  const KEY = { team_id: "T1", channel_id: "C1", thread_ts: "111.222" };

  it("claim/get/steal/release round-trip with real CAS semantics", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    process.env.SLAUDE_LEASE_TTL_SECONDS = "900";
    const leaseA = new RedisLeaseStore(client);

    expect(await leaseA.get(KEY)).toBeNull();
    expect(await leaseA.claim(KEY)).toBe(true);
    expect(await leaseA.get(KEY)).toBe("instance-a");
    expect(await leaseA.claim(KEY)).toBe(false); // NX blocks a second claim

    process.env.SLAUDE_INSTANCE_ID = "instance-b";
    const leaseB = new RedisLeaseStore(client);
    expect(await leaseB.steal(KEY, "instance-nobody")).toBe(false); // wrong assumed owner
    expect(await leaseB.steal(KEY, "instance-a")).toBe(true); // correct assumed owner
    expect(await leaseB.get(KEY)).toBe("instance-b");

    await leaseA.release(KEY); // not the owner anymore — no-op
    expect(await leaseB.get(KEY)).toBe("instance-b");
    await leaseB.release(KEY);
    expect(await leaseB.get(KEY)).toBeNull();

    delete process.env.SLAUDE_INSTANCE_ID;
    delete process.env.SLAUDE_LEASE_TTL_SECONDS;
  });

  it("TTL expires a lease with no heartbeat; heartbeat keeps it alive past TTL", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    process.env.SLAUDE_LEASE_TTL_SECONDS = "1";
    const key2 = { team_id: "T1", channel_id: "C2", thread_ts: "222.333" };
    const lease = new RedisLeaseStore(client);

    await lease.claim(key2);
    await new Promise((r) => setTimeout(r, 1300));
    expect(await lease.get(key2)).toBeNull(); // no heartbeat — TTL expired

    await lease.claim(key2);
    lease.startHeartbeat();
    await new Promise((r) => setTimeout(r, 1300));
    expect(await lease.get(key2)).toBe("instance-a"); // heartbeat refreshed past the 1s TTL
    lease.stopHeartbeat();
    await lease.release(key2);

    delete process.env.SLAUDE_INSTANCE_ID;
    delete process.env.SLAUDE_LEASE_TTL_SECONDS;
  }, 10_000);

  it("forwarder delivers to a subscribed instance and reports 0 receivers for a dead one", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const sub = client.duplicate();
    await sub.connect();
    const fwdA = new RedisForwarder(client, sub);

    let received: unknown = null;
    await fwdA.start((envelope) => {
      received = envelope;
    });

    process.env.SLAUDE_INSTANCE_ID = "instance-c";
    const pubOnly = client.duplicate();
    await pubOnly.connect();
    const fwdC = new RedisForwarder(pubOnly, pubOnly.duplicate());
    const envelope = { eventName: "message" as const, event: { text: "hi" }, context: { teamId: "T1" } };

    const receivers = await fwdC.publish("instance-a", envelope);
    expect(receivers).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual(envelope);

    expect(await fwdC.publish("instance-nobody", envelope)).toBe(0);

    await fwdA.stop();
    await sub.quit();
    await pubOnly.quit();
    delete process.env.SLAUDE_INSTANCE_ID;
  });
});
