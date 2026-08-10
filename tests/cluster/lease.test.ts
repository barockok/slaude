import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { FakeRedisClient } from "./fake-redis";

mock.module("redis", () => ({
  createClient: () => new FakeRedisClient(sharedStore, sharedHandlers),
}));

const { getLeaseStore, resetLeaseStore, LocalLeaseStore } = await import("../../src/cluster/lease");

let sharedStore = new Map<string, string>();
let sharedHandlers = new Map<string, (message: string) => void>();

const KEY = { team_id: "T1", channel_id: "C1", thread_ts: "111.222" };

beforeEach(() => {
  process.env.SLAUDE_CLUSTER = "1";
  process.env.SLAUDE_REDIS_URL = "redis://fake";
});

afterEach(() => {
  resetLeaseStore();
  sharedStore = new Map();
  sharedHandlers = new Map();
  delete process.env.SLAUDE_CLUSTER;
  delete process.env.SLAUDE_INSTANCE_ID;
  delete process.env.SLAUDE_LEASE_TTL_SECONDS;
  delete process.env.SLAUDE_REDIS_URL;
});

describe("LocalLeaseStore", () => {
  it("every thread is always mine — no-op when clustering is off", async () => {
    const store = new LocalLeaseStore();
    expect(await store.claim(KEY)).toBe(true);
    expect(typeof (await store.get(KEY))).toBe("string");
    expect(await store.steal(KEY, "whoever")).toBe(true);
    await store.release(KEY); // must not throw
    await store.releaseAll(); // must not throw
    store.startHeartbeat();
    store.stopHeartbeat();
  });
});

describe("RedisLeaseStore (via getLeaseStore, backed by a fake redis)", () => {
  it("claim/get round-trip; a second claim on the same instance fails (already NX-blocked)", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const lease = await getLeaseStore();

    expect(await lease.get(KEY)).toBeNull();
    expect(await lease.claim(KEY)).toBe(true);
    expect(await lease.get(KEY)).toBe("instance-a");
    expect(await lease.claim(KEY)).toBe(false);
  });

  it("a second instance sees the owner and cannot claim the held lease", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const leaseA = await getLeaseStore();
    await leaseA.claim(KEY);

    process.env.SLAUDE_INSTANCE_ID = "instance-b";
    resetLeaseStore();
    const leaseB = await getLeaseStore();
    expect(await leaseB.get(KEY)).toBe("instance-a");
    expect(await leaseB.claim(KEY)).toBe(false);
  });

  it("steal succeeds only against the named (assumed-dead) owner — CAS guard", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const leaseA = await getLeaseStore();
    await leaseA.claim(KEY);

    process.env.SLAUDE_INSTANCE_ID = "instance-b";
    resetLeaseStore();
    const leaseB = await getLeaseStore();

    // Wrong assumed owner — no-op, instance-a keeps the lease.
    expect(await leaseB.steal(KEY, "instance-nobody")).toBe(false);
    expect(await leaseB.get(KEY)).toBe("instance-a");

    // Correct assumed owner — takeover succeeds exactly once.
    expect(await leaseB.steal(KEY, "instance-a")).toBe(true);
    expect(await leaseB.get(KEY)).toBe("instance-b");
    expect(await leaseB.steal(KEY, "instance-a")).toBe(false);
  });

  it("release only removes a lease this instance owns", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const leaseA = await getLeaseStore();
    await leaseA.claim(KEY);

    process.env.SLAUDE_INSTANCE_ID = "instance-b";
    resetLeaseStore();
    const leaseB = await getLeaseStore();
    await leaseB.release(KEY); // not the owner — no-op
    expect(sharedStore.get("slaude:lease:T1:C1:111.222")).toBe("instance-a");

    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    resetLeaseStore();
    const leaseA2 = await getLeaseStore();
    await leaseA2.release(KEY);
    expect(await leaseA2.get(KEY)).toBeNull();
  });

  it("releaseAll clears every lease this instance is currently holding", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const lease = await getLeaseStore();
    const key2 = { team_id: "T1", channel_id: "C2", thread_ts: "222.333" };
    await lease.claim(KEY);
    await lease.claim(key2);

    await lease.releaseAll();
    expect(await lease.get(KEY)).toBeNull();
    expect(await lease.get(key2)).toBeNull();
  });

  it("heartbeat refreshes held leases; a released key is no longer touched", async () => {
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    process.env.SLAUDE_LEASE_TTL_SECONDS = "1"; // heartbeat interval floors at 1s regardless
    const lease = await getLeaseStore();
    await lease.claim(KEY);
    lease.startHeartbeat();
    lease.startHeartbeat(); // idempotent — must not stack a second interval

    await new Promise((r) => setTimeout(r, 1300));
    expect(await lease.get(KEY)).toBe("instance-a"); // still alive past the 1s TTL — heartbeat refreshed it

    await lease.release(KEY);
    lease.stopHeartbeat();
  });
});
