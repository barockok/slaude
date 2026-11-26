/**
 * Parking, seen from the gateway (box plan, Phases 5 and 6): the parked hint
 * in the registry, dispatch preferring the node that holds a session's parked
 * copies, and the storage sweeper removing a closed session's home.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { nodeBoxCapabilities } from "../../src/box/capability";
import { makeQueueDispatch } from "../../src/gateway/core/dispatch";
import { runStorageSweep } from "../../src/gateway/core/storage-sweeper";
import type { SessionRow } from "../../src/db/schema";
import { NODE_CAPS } from "../../src/node/worker";
import { makeKeys } from "../../src/queue/keys";
import { PARKED_TTL_MS, makeRegistry } from "../../src/queue/registry";
import type { ObjectInfo, ObjectStore, PutBody } from "../../src/storage";
import { sweepClosedHomes } from "../../src/storage/sweep";
import { hmUnitId } from "../../src/storage/units";
import { memRedis } from "../helpers/mem-redis";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const GVISOR = [...NODE_CAPS, ...nodeBoxCapabilities("gvisor")];

describe("the parked hint", () => {
  test("set when a session is parked, read by dispatch, cleared only by the node that set it", async () => {
    const redis = memRedis();
    const keys = makeKeys("t-parked");
    const reg = makeRegistry({ redis: redis as never, keys });
    expect(await reg.parkedNode("S1")).toBeNull();
    await reg.setParked("S1", "node-a");
    expect(await reg.parkedNode("S1")).toBe("node-a");
    expect(Object.keys(redis.dump())).toEqual([keys.parked("S1")]);
    // Another node's drain must not remove a hint that is not its own.
    await reg.clearParked("S1", "node-b");
    expect(await reg.parkedNode("S1")).toBe("node-a");
    await reg.clearParked("S1", "node-a");
    expect(await reg.parkedNode("S1")).toBeNull();
    // Parked again elsewhere replaces it; without a node named, it is removed whoever set it.
    await reg.setParked("S1", "node-a");
    await reg.setParked("S1", "node-b");
    expect(await reg.parkedNode("S1")).toBe("node-b");
    await reg.clearParked("S1");
    expect(await reg.parkedNode("S1")).toBeNull();
  });

  test("a node that dies with its disk: the hint lapses on its own", async () => {
    const redis = memRedis();
    const reg = makeRegistry({ redis: redis as never, keys: makeKeys("t-parked") });
    await reg.setParked("S1", "node-a");
    redis.advance(PARKED_TTL_MS + 1);
    expect(await reg.parkedNode("S1")).toBeNull();
  });
});

describe("dispatch prefers the node that holds a session's parked copies", () => {
  const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "ana" };
  const S = { id: "S-box" } as unknown as SessionRow;

  function harness(o: { warm?: string; parkedOn?: string | null; holders: Array<{ node: string; hasDigest: boolean; free: number | null }> }) {
    const enqueued: { target: any }[] = [];
    const dispatch = makeQueueDispatch({ emit: () => true, resolveEffectiveIdentity: async () => undefined } as any, {
      needsGuardrails: async () => false,
      box: async () => ({ name: "ruby-dev", digest: digest("a"), tier: "gvisor" as const }),
      random: () => 0,
      guardrailWaitMs: 20,
      guardrailPollMs: 5,
      infra: {
        turns: { enqueueTurn: async (_job: any, target: any) => (enqueued.push({ target }), { queue: "turns", jobId: "J1", coalesced: false }), queue: () => ({ getJob: async () => ({ getState: async () => "active" }) }), movedTo: async () => null, close: async () => {} } as any,
        registry: {
          lookup: async () => (o.warm ? { node: o.warm, since: 1, lastBeat: Date.now(), fresh: true } : null),
          nodeCarries: async () => true,
          nodeCaps: async () => new Set(GVISOR),
          liveNodesWithCap: async () => [{ node: "any", has: true }],
          liveNodesWithBox: async () => o.holders,
          parkedNode: async () => o.parkedOn ?? null,
          close: async () => {},
        } as any,
        pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {}, readEvents: async () => [], close: async () => {} } as any,
      },
    });
    return { dispatch, target: () => enqueued[0]?.target };
  }
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });

  test.each<[string, Parameters<typeof harness>[0], unknown]>([
    ["warm first: the parked hint is not even needed", { warm: "warm-node", parkedOn: "parked-node", holders: [{ node: "parked-node", hasDigest: true, free: 3 }] }, { node: "warm-node" }],
    ["then the parked node, over another node that also holds the image", { parkedOn: "parked-node", holders: [{ node: "a-holder", hasDigest: true, free: 5 }, { node: "parked-node", hasDigest: true, free: 1 }] }, { node: "parked-node" }],
    ["the parked node is full: a node with the image and room", { parkedOn: "parked-node", holders: [{ node: "a-holder", hasDigest: true, free: 5 }, { node: "parked-node", hasDigest: true, free: 0 }] }, { node: "a-holder" }],
    ["the parked node is gone (not in the live listing): a node with the image and room", { parkedOn: "dead-node", holders: [{ node: "a-holder", hasDigest: true, free: 5 }] }, { node: "a-holder" }],
    ["the parked node reports no slots at all: not routed to on a guess", { parkedOn: "parked-node", holders: [{ node: "parked-node", hasDigest: true, free: null }] }, { label: "default" }],
    ["not parked anywhere, nobody holds the image: the label queue", { parkedOn: null, holders: [{ node: "x", hasDigest: false, free: 9 }] }, { label: "default" }],
    ["the parked node lost the image but has room: its local files are still worth more than a cold node", { parkedOn: "parked-node", holders: [{ node: "parked-node", hasDigest: false, free: 2 }, { node: "a-holder", hasDigest: true, free: 2 }] }, { node: "parked-node" }],
  ])("%s", async (_what, o, expected) => {
    const h = harness(o);
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.target()).toEqual(expected);
  });
});

/** An in-memory store: keys only. */
class MemStore implements ObjectStore {
  readonly keys = new Set<string>();
  deleted: string[] = [];
  add(...keys: string[]): this {
    for (const k of keys) this.keys.add(k);
    return this;
  }
  async get(): Promise<null> {
    return null;
  }
  async put(_k: string, _b: PutBody): Promise<{ etag: string }> {
    return { etag: "x" };
  }
  async head(): Promise<null> {
    return null;
  }
  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    for (const k of [...this.keys].sort()) if (k.startsWith(prefix)) yield { key: k, size: 1, etag: "x", modified: Date.now() };
  }
  async delete(keys: string[]): Promise<void> {
    for (const k of keys) {
      this.keys.delete(k);
      this.deleted.push(k);
    }
  }
}

describe("the storage sweeper removes a closed session's home", () => {
  const unit = (sessionId: string) => `sessions/${hmUnitId(sessionId)}`;
  const seeded = () =>
    new MemStore().add(
      `${unit("open-1")}/manifests/1.json`, `${unit("open-1")}/blobs/aa`,
      `${unit("closed-1")}/manifests/1.json`, `${unit("closed-1")}/blobs/bb`, `${unit("closed-1")}/blobs/cc`,
      `${unit("closed-busy")}/manifests/1.json`,
      "sessions/ws-0123abcd/manifests/1.json",
      "sessions/wx-0123abcd-9876/manifests/1.json",
      "sessions/tx-0123abcd/manifests/1.json",
    );
  const closed = async (id: string) => id.startsWith("closed");

  test("only the home of a closed session goes; an open session's home and every other unit stay", async () => {
    const store = seeded();
    const r = await sweepClosedHomes(store, { closed, skip: async (u) => u.endsWith("closed-busy") });
    expect(r).toEqual({ unitsDeleted: ["hm-closed-1"], objectsDeleted: 3 });
    expect(store.deleted.sort()).toEqual([`${unit("closed-1")}/blobs/bb`, `${unit("closed-1")}/blobs/cc`, `${unit("closed-1")}/manifests/1.json`]);
    expect([...store.keys].some((k) => k.startsWith(unit("open-1")))).toBe(true);
    // A home a node still holds open, or owes a flush for, is kept even though its session is closed.
    expect(store.keys.has(`${unit("closed-busy")}/manifests/1.json`)).toBe(true);
    for (const k of ["sessions/ws-0123abcd/manifests/1.json", "sessions/wx-0123abcd-9876/manifests/1.json", "sessions/tx-0123abcd/manifests/1.json"]) expect(store.keys.has(k)).toBe(true);
  });

  test("a dry run deletes nothing and reports what it would", async () => {
    const store = seeded();
    const r = await sweepClosedHomes(store, { closed, dryRun: true });
    expect(r.unitsDeleted.sort()).toEqual(["hm-closed-1", "hm-closed-busy"]);
    expect(store.deleted).toEqual([]);
  });

  test("a home whose unit id is a hash cannot be traced to a session and is left to the age rule", async () => {
    const odd = "a session/with spaces";
    expect(hmUnitId(odd)).toMatch(/^hm-[a-f0-9]{32}$/);
    const store = new MemStore().add(`sessions/${hmUnitId(odd)}/manifests/1.json`);
    const asked: string[] = [];
    const r = await sweepClosedHomes(store, { closed: async (id) => (asked.push(id), true) });
    // The hash is a valid id shape, so the question is asked for it; no session has that id, so a real answer is "not closed".
    expect(asked).toEqual([hmUnitId(odd).slice(3)]);
    expect(r.unitsDeleted).toHaveLength(1);
    const real = await sweepClosedHomes(new MemStore().add(`sessions/${hmUnitId(odd)}/manifests/1.json`), { closed: async () => false });
    expect(real.unitsDeleted).toEqual([]);
  });

  test("the sweep tick does it when told which sessions are closed, in the same lock as the age sweep; without that nothing changes", async () => {
    const keys = makeKeys("t-sweep");
    const cfg = { mode: "on" as const, retainMs: 365 * 86_400_000, inboxTtlMs: 86_400_000 };
    const redis = memRedis();
    const store = seeded();
    const r = await runStorageSweep({ store, redis: redis as never, keys, cfg, sessionClosed: closed });
    expect(r!.homes!.unitsDeleted.sort()).toEqual(["hm-closed-1", "hm-closed-busy"]);
    // A unit marked in use is skipped.
    const redis2 = memRedis();
    await redis2.set(keys.fsInUse("hm-closed-busy"), "node-a");
    const store2 = seeded();
    const r2 = await runStorageSweep({ store: store2, redis: redis2 as never, keys, cfg, sessionClosed: closed });
    expect(r2!.homes!.unitsDeleted).toEqual(["hm-closed-1"]);
    // No question asked: homes are left to the age rule, as before.
    const store3 = seeded();
    const r3 = await runStorageSweep({ store: store3, redis: memRedis() as never, keys, cfg });
    expect(r3!.homes).toBeUndefined();
    expect(store3.deleted).toEqual([]);
    // A failing answer costs only this tick's home removal.
    const store4 = seeded();
    const r4 = await runStorageSweep({ store: store4, redis: memRedis() as never, keys, cfg, sessionClosed: async () => Promise.reject(new Error("db down")) });
    expect(r4!.homes).toEqual({ unitsDeleted: [], objectsDeleted: 0 });
  });
});
