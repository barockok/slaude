import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FakeRedisClient } from "../../cluster/fake-redis";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import { RedisLeaseStore } from "../../../src/cluster/lease";
import { RedisForwarder } from "../../../src/cluster/forwarder";
import * as Sessions from "../../../src/db/sessions";
import { db } from "../../../src/db/schema";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";

// Injects LeaseStore/Forwarder directly via GatewayOptions (a test seam, same
// shape as the existing outClient override) instead of mock.module("redis", ...):
// dynamic `await import("redis")` inside cluster/lease.ts and cluster/forwarder.ts
// resolves and caches per call site the first time any test enables clustering,
// so a later file's mock.module("redis", ...) registration isn't guaranteed to
// rebind it — direct injection sidesteps that entirely.

function capturingTransport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const t: any = {
    client: {
      auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
      chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { info: async () => ({}), members: async () => ({}), replies: async () => ({}) },
      users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
      search: { messages: async () => ({}) },
    },
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => { handlers.set(name, fn); },
  };
  const emit = async (name: string, args: any) => { await handlers.get(name)?.(args); };
  return { t, emit };
}

const THREAD = { team_id: "T", channel_id: "D_MGR", thread_ts: "500.1" };
const dmEvent = {
  event: { type: "message", channel: "D_MGR", channel_type: "im", user: WORLD.manager, team: "T", ts: "500.1", text: "hello" },
  context: { teamId: "T" },
};

let store: Map<string, string>;
let handlers: Map<string, (message: string) => void>;
let leaseStore: RedisLeaseStore;
let forwarder: RedisForwarder;

beforeEach(() => {
  db.run("DELETE FROM sessions WHERE slack_thread_ts = ?", ["500.1"]);
  writeSoulFixture(WORLD);
  process.env.SLAUDE_CLUSTER = "1";
  process.env.SLAUDE_INSTANCE_ID = "self";
  store = new Map();
  handlers = new Map();
  const client = new FakeRedisClient(store, handlers) as any;
  leaseStore = new RedisLeaseStore(client);
  forwarder = new RedisForwarder(client, client.duplicate() as any);
});

afterEach(() => {
  delete process.env.SLAUDE_CLUSTER;
  delete process.env.SLAUDE_INSTANCE_ID;
});

describe("cluster routing gate", () => {
  it("unclaimed thread: this instance claims the lease and handles the event locally", async () => {
    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    const { t, emit } = capturingTransport();
    createGateway(agent, t, { leaseStore, forwarder });

    await emit("message", { ...dmEvent, client: t.client });

    expect(Sessions.findByThread(THREAD)).not.toBeNull();
    expect(await leaseStore.get(THREAD)).toBe("self");
  });

  it("thread owned by a live peer: event is forwarded, not handled locally", async () => {
    store.set("slaude:lease:T:D_MGR:500.1", "peer");
    handlers.set("slaude:instance:peer", () => {}); // peer is listening — forward succeeds

    const agent = new AgentManager();
    agent.sendMessage = async () => {
      throw new Error("must not run locally — thread belongs to peer");
    };
    const { t, emit } = capturingTransport();
    createGateway(agent, t, { leaseStore, forwarder });

    await emit("message", { ...dmEvent, client: t.client });

    expect(Sessions.findByThread(THREAD)).toBeNull();
    expect(store.get("slaude:lease:T:D_MGR:500.1")).toBe("peer"); // untouched
  });

  it("thread owned by a dead peer (no subscriber): this instance steals the lease and handles locally", async () => {
    store.set("slaude:lease:T:D_MGR:500.1", "peer");
    // No handler registered for slaude:instance:peer — publish() reports 0 receivers.

    const agent = new AgentManager();
    agent.sendMessage = async () => {};
    const { t, emit } = capturingTransport();
    createGateway(agent, t, { leaseStore, forwarder });

    await emit("message", { ...dmEvent, client: t.client });

    expect(Sessions.findByThread(THREAD)).not.toBeNull();
    expect(await leaseStore.get(THREAD)).toBe("self");
  });
});
