import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { FakeRedisClient } from "./fake-redis";

mock.module("redis", () => ({
  createClient: () => new FakeRedisClient(sharedStore, sharedHandlers),
}));

const { getForwarder, resetForwarder, LocalForwarder } = await import("../../src/cluster/forwarder");

let sharedStore = new Map<string, string>();
let sharedHandlers = new Map<string, (message: string) => void>();

beforeEach(() => {
  process.env.SLAUDE_REDIS_URL = "redis://fake";
});

afterEach(() => {
  resetForwarder();
  sharedStore = new Map();
  sharedHandlers = new Map();
  delete process.env.SLAUDE_CLUSTER;
  delete process.env.SLAUDE_INSTANCE_ID;
  delete process.env.SLAUDE_REDIS_URL;
});

describe("LocalForwarder", () => {
  it("publish always reports zero receivers — never on the hot path when unclustered", async () => {
    const fwd = new LocalForwarder();
    await fwd.start(() => {
      throw new Error("should never be invoked");
    });
    expect(await fwd.publish("someone", { eventName: "message", event: {}, context: {} })).toBe(0);
    await fwd.stop();
  });
});

describe("RedisForwarder (via getForwarder, backed by a fake redis)", () => {
  it("delivers a published envelope to the subscribed instance and reports 1 receiver", async () => {
    process.env.SLAUDE_CLUSTER = "1";
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const fwdA = await getForwarder();
    let received: unknown = null;
    await fwdA.start((envelope) => {
      received = envelope;
    });

    process.env.SLAUDE_INSTANCE_ID = "instance-c";
    resetForwarder();
    const fwdC = await getForwarder();
    const envelope = { eventName: "message" as const, event: { text: "hi" }, context: { teamId: "T1" } };
    const receivers = await fwdC.publish("instance-a", envelope);

    expect(receivers).toBe(1);
    expect(received).toEqual(envelope);
  });

  it("publishing to an instance with nobody subscribed reports zero receivers", async () => {
    process.env.SLAUDE_CLUSTER = "1";
    process.env.SLAUDE_INSTANCE_ID = "instance-c";
    const fwd = await getForwarder();
    const receivers = await fwd.publish("instance-nobody", { eventName: "message", event: {}, context: {} });
    expect(receivers).toBe(0);
  });

  it("stop unsubscribes — a live instance no longer receives forwards", async () => {
    process.env.SLAUDE_CLUSTER = "1";
    process.env.SLAUDE_INSTANCE_ID = "instance-a";
    const fwdA = await getForwarder();
    let calls = 0;
    await fwdA.start(() => {
      calls += 1;
    });
    await fwdA.stop();

    process.env.SLAUDE_INSTANCE_ID = "instance-c";
    resetForwarder();
    const fwdC = await getForwarder();
    const receivers = await fwdC.publish("instance-a", { eventName: "message", event: {}, context: {} });
    expect(receivers).toBe(0);
    expect(calls).toBe(0);
  });
});
