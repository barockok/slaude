/**
 * Pull, prewarm, inventory and routing (box plan, Phase 4): what a node
 * reports on its heartbeat, which node a cold boxed session is sent to, the
 * list a node prewarms from, the prewarm loop itself, and the console's
 * derived view of which node holds which image.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBoxCapabilities, requiredBoxCapabilities } from "../../src/box/capability";
import { makeImageStore } from "../../src/box/image";
import { defaultBoxPolicy } from "../../src/box/policy";
import { boxesForLabels, handleNodeBoxes, PINNED_WINDOW_MS } from "../../src/gateway/api/node-boxes";
import { createV1Api } from "../../src/gateway/api";
import { __setNodeVerifier } from "../../src/gateway/api/auth";
import { mintNodeCredential, NodeCredentialVerifier } from "../../src/gateway/auth/node-credential";
import { InMemoryPendingSource } from "../../src/gateway/api/pending-source";
import {
  __resetBoxInventoryForTests, BOX_INVENTORY_STALE_MS, currentBoxInventory, deriveBoxInventory, labelOccupancy, refreshBoxInventory,
} from "../../src/gateway/core/box-inventory";
import { BoxIntegrityError, type BoxEntry, type BoxSnapshot, type BoxVersion } from "../../src/gateway/core/box-registry";
import { makeQueueDispatch } from "../../src/gateway/core/dispatch";
import { boxesView } from "../../src/gateway/panel/boxes-view";
import type { SessionRow } from "../../src/db/schema";
import { makeBoxPrewarm, type WantedImage } from "../../src/node/box-images";
import { NODE_CAPS } from "../../src/node/worker";
import { makeKeys } from "../../src/queue/keys";
import { makeRegistry } from "../../src/queue/registry";
import { BootFailure } from "../../src/gateway/core/failure-codes";
import { memRedis } from "../helpers/mem-redis";
import { fakeRunner, goodRootfs, writeOciLayout } from "../helpers/oci-layout";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (c: string, name = "ruby-dev") => `ghcr.io/example/boxes/${name}@${digest(c)}`;
const version = (name: string, n: number, c: string): BoxVersion => ({ name, version: n, image: image(c, name), digest: digest(c), policy: defaultBoxPolicy(), forced: false });
const entry = (name: string, versions: BoxVersion[]): BoxEntry => ({ name, description: "", current: versions.at(-1)!, versions });
const snapshot = (entries: BoxEntry[], setVersion = 3): BoxSnapshot => ({ setVersion, boxes: new Map(entries.map((e) => [e.name, e])) });
const GVISOR = [...NODE_CAPS, ...nodeBoxCapabilities("gvisor")];

describe("registry: what a node reports about boxes", () => {
  const setup = () => {
    const redis = memRedis();
    const keys = makeKeys("t-boxes");
    return { redis, keys, reg: makeRegistry({ redis: redis as never, keys, heartbeatSec: 10, nodeTtlSec: 30 }) };
  };

  test("written beside the capabilities with the node TTL, and read back", async () => {
    const { redis, keys, reg } = setup();
    await reg.nodeUp("n1", ["default"], GVISOR, { digests: [digest("b"), digest("a")], running: 2, capacity: 8, free: 6 });
    expect(await reg.nodeBoxes("n1")).toEqual({ digests: [digest("a"), digest("b")], running: 2, capacity: 8, free: 6 });
    expect(Object.keys(redis.dump())).toContain(keys.nodeBoxes("n1"));
    await reg.beatNode("n1", ["default"], GVISOR, { digests: [digest("a")], running: 8, capacity: 8, free: 0 });
    expect(await reg.nodeBoxes("n1")).toEqual({ digests: [digest("a")], running: 8, capacity: 8, free: 0 });
    // A dead node's key expired: its images and its free slots go with it.
    redis.advance(31_000);
    expect(await reg.nodeBoxes("n1")).toBeNull();
    expect(await reg.liveNodesWithBox("default", [], digest("a"))).toEqual([]);
  });

  test("a node that offers no sandbox writes nothing, and a beat without a report leaves no key", async () => {
    const { redis, keys, reg } = setup();
    await reg.nodeUp("plain", ["default"], [...NODE_CAPS]);
    await reg.beatNode("plain", ["default"], [...NODE_CAPS]);
    expect(Object.keys(redis.dump())).not.toContain(keys.nodeBoxes("plain"));
    expect(await reg.nodeBoxes("plain")).toBeNull();
  });

  test("what is stored is data: anything that is not a digest or a small count is dropped", async () => {
    const { redis, keys, reg } = setup();
    await reg.nodeUp("n1", ["default"], GVISOR, { digests: [digest("a"), "latest", "sha256:short", "../../etc"], running: -1, capacity: 1.5, free: 3 });
    expect(await reg.nodeBoxes("n1")).toEqual({ digests: [digest("a")], free: 3 });
    await redis.set(keys.nodeBoxes("n1"), "not json");
    expect(await reg.nodeBoxes("n1")).toBeNull();
    await redis.set(keys.nodeBoxes("n1"), JSON.stringify({ digests: "all" }));
    expect(await reg.nodeBoxes("n1")).toBeNull();
  });

  test("liveNodesWithBox: the label, every capability, the digest and the free slots", async () => {
    const { reg } = setup();
    const need = requiredBoxCapabilities("gvisor");
    await reg.nodeUp("has-it", ["default"], GVISOR, { digests: [digest("a")], running: 1, capacity: 8, free: 7 });
    await reg.nodeUp("full", ["default"], GVISOR, { digests: [digest("a")], running: 8, capacity: 8, free: 0 });
    await reg.nodeUp("other-image", ["default"], GVISOR, { digests: [digest("b")], running: 0, capacity: 8, free: 8 });
    await reg.nodeUp("no-report", ["default"], GVISOR);
    await reg.nodeUp("no-sandbox", ["default"], [...NODE_CAPS], { digests: [digest("a")], free: 4 });
    await reg.nodeUp("other-label", ["heavy"], GVISOR, { digests: [digest("a")], free: 4 });
    expect(await reg.liveNodesWithBox("default", need, digest("a"))).toEqual([
      { node: "full", hasDigest: true, free: 0 },
      { node: "has-it", hasDigest: true, free: 7 },
      { node: "no-report", hasDigest: false, free: null },
      { node: "other-image", hasDigest: false, free: 8 },
    ]);
    expect((await reg.liveNodesWithBox("heavy", need, digest("a"))).map((n) => n.node)).toEqual(["other-label"]);
    await reg.nodeDown("has-it");
    expect((await reg.liveNodesWithBox("default", need, digest("a"))).map((n) => n.node)).not.toContain("has-it");
    expect(await reg.nodeBoxes("has-it")).toBeNull();
  });
});

describe("dispatch: where a boxed session's turn goes", () => {
  const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "ana" };
  const S = { id: "S-box" } as unknown as SessionRow;

  function harness(o: {
    warm?: { node: string; caps?: string[] } | null;
    holders?: Array<{ node: string; hasDigest: boolean; free: number | null }>;
    capable?: Array<{ node: string; has: boolean }>;
    random?: number;
    boxed?: boolean;
    withoutInventory?: boolean;
  }) {
    const enqueued: { job: any; target: any }[] = [];
    const asked: Array<{ label: string; caps: string[]; digest: string }> = [];
    const dispatch = makeQueueDispatch({ emit: () => true, resolveEffectiveIdentity: async () => undefined } as any, {
      needsGuardrails: async () => false,
      box: async () => (o.boxed === false ? null : { name: "ruby-dev", digest: digest("a"), tier: "gvisor" as const }),
      random: () => o.random ?? 0,
      guardrailWaitMs: 20,
      guardrailPollMs: 5,
      infra: {
        turns: {
          enqueueTurn: async (job: any, target: any) => (enqueued.push({ job, target }), { queue: "turns", jobId: "J1", coalesced: false }),
          queue: () => ({ getJob: async () => ({ getState: async () => "active" }) }),
          movedTo: async () => null,
          close: async () => {},
        } as any,
        registry: {
          lookup: async () => (o.warm ? { node: o.warm.node, since: 1, lastBeat: Date.now(), fresh: true } : null),
          nodeCarries: async () => true,
          nodeCaps: async (node: string) => new Set(node === o.warm?.node ? (o.warm.caps ?? GVISOR) : []),
          liveNodesWithCap: async () => o.capable ?? [{ node: "any", has: true }],
          ...(o.withoutInventory
            ? {}
            : {
                liveNodesWithBox: async (label: string, caps: string[], d: string) => {
                  asked.push({ label, caps: [...caps], digest: d });
                  return o.holders ?? [];
                },
              }),
          close: async () => {},
        } as any,
        pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {}, readEvents: async () => [], close: async () => {} } as any,
      },
    });
    return { dispatch, enqueued, asked, target: () => enqueued[0]?.target };
  }
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
  });

  test("a warm node wins: the image inventory is not even asked", async () => {
    const h = harness({ warm: { node: "warm-node" }, holders: [{ node: "has-image", hasDigest: true, free: 5 }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.target()).toEqual({ node: "warm-node" });
    expect(h.asked).toEqual([]);
  });

  test("cold: a node that holds the image and reported a free slot is next", async () => {
    const h = harness({ holders: [{ node: "has-image", hasDigest: true, free: 3 }, { node: "no-image", hasDigest: false, free: 8 }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.target()).toEqual({ node: "has-image" });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ label: "default", digest: digest("a") });
    expect(h.asked[0]!.caps).toEqual(expect.arrayContaining(requiredBoxCapabilities("gvisor")));
  });

  test("several hold it: one of them at random", async () => {
    const holders = [{ node: "a", hasDigest: true, free: 1 }, { node: "b", hasDigest: true, free: 1 }, { node: "c", hasDigest: true, free: 1 }];
    const picks = new Set<string>();
    for (const r of [0, 0.34, 0.67, 0.999]) {
      const h = harness({ holders, random: r });
      await h.dispatch.dispatch(S, "hi", META);
      picks.add(h.target().node);
    }
    expect([...picks].sort()).toEqual(["a", "b", "c"]);
  });

  test("the label queue is last: nobody holds the image, the holder is full, or the holder reports no slots", async () => {
    for (const holders of [
      [],
      [{ node: "no-image", hasDigest: false, free: 8 }],
      [{ node: "full", hasDigest: true, free: 0 }],
      [{ node: "silent", hasDigest: true, free: null }],
    ]) {
      const h = harness({ holders });
      await h.dispatch.dispatch(S, "hi", META);
      expect(h.target()).toEqual({ label: "default" });
    }
  });

  test("a dead node is not a candidate: its key expired, so it is not in the listing", async () => {
    const redis = memRedis();
    const reg = makeRegistry({ redis: redis as never, keys: makeKeys("t-route"), nodeTtlSec: 30 });
    await reg.nodeUp("dead", ["default"], GVISOR, { digests: [digest("a")], free: 4 });
    redis.advance(31_000);
    await reg.nodeUp("alive", ["default"], GVISOR, { digests: [digest("a")], free: 4 });
    const h = harness({ holders: await reg.liveNodesWithBox("default", requiredBoxCapabilities("gvisor"), digest("a")) });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.target()).toEqual({ node: "alive" });
  });

  test("an unboxed session is routed exactly as before, and nothing is asked", async () => {
    const h = harness({ boxed: false, holders: [{ node: "has-image", hasDigest: true, free: 3 }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.target()).toEqual({ label: "default" });
    expect(h.asked).toEqual([]);
  });

  test("a registry that predates the inventory: the capability routing stands", async () => {
    const h = harness({ withoutInventory: true, capable: [{ node: "box-node", has: true }, { node: "old-node", has: false }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.target()).toEqual({ node: "box-node" });
  });
});

describe("GET /v1/node/boxes: what a node prewarms", () => {
  const personas = [
    { label: "default", box: "ruby-dev" },
    { label: "default", box: null },
    { label: "heavy", box: "py-dev" },
    { label: "default", box: "ruby-dev" },
  ];
  const snap = snapshot([entry("ruby-dev", [version("ruby-dev", 1, "a"), version("ruby-dev", 2, "b")]), entry("py-dev", [version("py-dev", 1, "c")])]);
  const deps = (over: Record<string, unknown> = {}) => ({ enabled: () => true, personas: () => personas, snapshot: async () => snap, pinned: async () => [], now: () => 1_000_000_000, ...over });

  test("the current version of each box a persona of the node's labels names; another label's box is not listed", async () => {
    const r = await boxesForLabels(new Set(["default"]), "default", deps());
    expect(r).toEqual({ setVersion: 3, boxes: [{ name: "ruby-dev", image: image("b"), digest: digest("b"), current: true }] });
    expect((await boxesForLabels(new Set(["heavy"]), "default", deps())).boxes.map((b) => b.name)).toEqual(["py-dev"]);
    expect((await boxesForLabels(new Set(["default", "heavy"]), "default", deps())).boxes.map((b) => b.name)).toEqual(["py-dev", "ruby-dev"]);
  });

  test("plus every older digest a recent session is pinned to, with the repository of the version that has it", async () => {
    let since = 0;
    const r = await boxesForLabels(new Set(["default"]), "default", deps({
      pinned: async (s: number) => ((since = s), [
        { name: "ruby-dev", digest: digest("a") },
        { name: "ruby-dev", digest: digest("b") },
        { name: "ruby-dev", digest: digest("z") },
        { name: "py-dev", digest: digest("c") },
      ]),
    }));
    expect(since).toBe(1_000_000_000 - PINNED_WINDOW_MS);
    expect(r.boxes).toEqual([
      { name: "ruby-dev", image: image("b"), digest: digest("b"), current: true },
      { name: "ruby-dev", image: image("a"), digest: digest("a"), current: false },
    ]);
  });

  test("no persona of these labels names a box: empty, and the box set is not read", async () => {
    let read = 0;
    const r = await boxesForLabels(new Set(["nobody"]), "default", deps({ snapshot: async () => (read++, snap) }));
    expect(r).toEqual({ setVersion: 0, boxes: [] });
    expect(read).toBe(0);
  });

  test("the handler: SLAUDE_BOX off answers empty and reads nothing; a set that does not verify is an error, never a shorter list", async () => {
    const node = { id: "n1", labels: new Set(["default"]), legacy: false } as never;
    let read = 0;
    const off = await handleNodeBoxes(new Request("https://x/v1/node/boxes"), node, deps({ enabled: () => false, personas: () => (read++, personas) }));
    expect(await off.json()).toEqual({ setVersion: 0, boxes: [] });
    expect(read).toBe(0);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const bad = await handleNodeBoxes(new Request("https://x/v1/node/boxes"), node, deps({ snapshot: async () => Promise.reject(new BoxIntegrityError("rolled back")) }));
      expect(bad.status).toBe(503);
      expect(await bad.json()).toEqual({ error: "box set unavailable", code: "BOX_UNAVAILABLE", transient: false });
    } finally {
      err.mockRestore();
    }
    expect((await handleNodeBoxes(new Request("https://x/v1/node/boxes?tenant=../x"), node, deps())).status).toBe(400);
  });

  test("the answer carries image references and digests only: no policy, no persona, no session", async () => {
    const r = await boxesForLabels(new Set(["default"]), "default", deps({ pinned: async () => [{ name: "ruby-dev", digest: digest("a") }] }));
    for (const b of r.boxes) expect(Object.keys(b).sort()).toEqual(["current", "digest", "image", "name"]);
  });

  describe("through the route", () => {
    const KEY = "box-routes-node-key";
    const VARS = ["SLAUDE_NODE_KEY", "SLAUDE_NODE_TOKEN", "SLAUDE_NODE_LEGACY", "SLAUDE_NODE_LEGACY_TOKEN", "SLAUDE_JOB_SECRET"] as const;
    const saved: Record<string, string | undefined> = {};
    afterAll(() => {
      __setNodeVerifier(null);
      for (const k of VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    test("the label gate is the caller's own verified credential; no credential is a 401", async () => {
      for (const k of VARS) saved[k] = process.env[k];
      delete process.env.SLAUDE_NODE_TOKEN;
      delete process.env.SLAUDE_NODE_LEGACY;
      delete process.env.SLAUDE_NODE_LEGACY_TOKEN;
      process.env.SLAUDE_NODE_KEY = KEY;
      process.env.SLAUDE_JOB_SECRET = "box-routes-job-secret";
      __setNodeVerifier(new NodeCredentialVerifier({ revocations: async () => null }));
      const v1 = createV1Api({ tools: {} as never, pendingSource: new InMemoryPendingSource(), nodeBoxes: deps() });
      const call = async (labels: string[] | null) => {
        const headers: Record<string, string> = labels ? { authorization: `Bearer ${mintNodeCredential({ id: "n1", labels }, { key: KEY })}` } : {};
        return (await v1.fetch(new Request("http://gw/v1/node/boxes", { headers })))!;
      };
      expect((await call(null)).status).toBe(401);
      expect(((await (await call(["default"])).json()) as any).boxes.map((b: any) => b.name)).toEqual(["ruby-dev"]);
      expect(((await (await call(["heavy"])).json()) as any).boxes.map((b: any) => b.name)).toEqual(["py-dev"]);
      expect(((await (await call(["elsewhere"])).json()) as any).boxes).toEqual([]);
      // Only GET.
      expect((await v1.fetch(new Request("http://gw/v1/node/boxes", { method: "POST", headers: { authorization: `Bearer ${mintNodeCredential({ id: "n1", labels: ["default"] }, { key: KEY })}` } })))!.status).toBe(405);
    });
  });
});

describe("the node's prewarm loop", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });
  function setup(o: { delayMs?: number; budgetMb?: number } = {}) {
    const root = mkdtempSync(join(tmpdir(), "slaude-prewarm-"));
    roots.push(root);
    const registry: Record<string, string> = {};
    const img = (extra: string, name = "ruby-dev"): WantedImage & { layout: string } => {
      const layout = join(root, `layout-${Object.keys(registry).length}`);
      mkdirSync(layout, { recursive: true });
      const d = writeOciLayout(layout, goodRootfs({ marker: extra }));
      const ref = `ghcr.io/example/boxes/${name}@${d}`;
      registry[ref] = layout;
      return { name, image: ref, digest: d, current: true, layout };
    };
    const runner = fakeRunner(registry, { delayMs: o.delayMs });
    const images = makeImageStore({ dir: join(root, "boxdir"), runner, budgetMb: o.budgetMb ?? 0, log: () => {} });
    const state = { list: [] as WantedImage[] | null, inUse: new Set<string>(), warnings: [] as string[], listCalls: 0, listFails: false };
    const prewarm = makeBoxPrewarm({
      images,
      list: async () => {
        state.listCalls++;
        if (state.listFails) throw new Error("gateway down");
        return state.list;
      },
      inUse: () => state.inUse,
      pullTimeoutMs: 5_000,
      log: () => {},
      warn: (l) => void state.warnings.push(l),
    });
    return { prewarm, images, runner, state, img, registry };
  }

  test("a pass fetches what is missing, current images first, and reports ready when the current ones are present", async () => {
    const s = setup();
    const cur = s.img("current");
    const old = { ...s.img("old"), current: false };
    s.state.list = [old, cur];
    expect(s.prewarm.currentReady()).toBe(false);
    await s.prewarm.refresh();
    expect(s.runner.calls.filter((c) => c.startsWith("pull"))).toEqual([`pull ${cur.image}`, `pull ${old.image}`]);
    expect(s.prewarm.digests().sort()).toEqual([cur.digest, old.digest].sort());
    expect(s.prewarm.currentReady()).toBe(true);
    // Nothing to do the second time.
    await s.prewarm.refresh();
    expect(s.runner.calls.filter((c) => c.startsWith("pull"))).toHaveLength(2);
  });

  test("one image that cannot be fetched does not stop the others, and readiness says so", async () => {
    const s = setup();
    const good = s.img("good");
    const missing: WantedImage = { name: "py-dev", image: image("c", "py-dev"), digest: digest("c"), current: true };
    s.state.list = [missing, good];
    await s.prewarm.refresh();
    expect(s.images.has(good.digest)).toBe(true);
    expect(s.prewarm.currentReady()).toBe(false);
    expect(s.state.warnings.join("\n")).toContain("of box py-dev was not fetched");
    expect(await s.prewarm.waitReady(30, 5)).toBe("timeout");
    expect(s.state.warnings.at(-1)).toContain("1 current image(s) still missing; they are pulled on demand");
  });

  test("readiness waits for the images, up to the timeout", async () => {
    const s = setup({ delayMs: 40 });
    s.state.list = [s.img("slow")];
    const pass = s.prewarm.refresh();
    expect(await s.prewarm.waitReady(2_000, 5)).toBe("ready");
    await pass;
    // A gateway that cannot be asked: ready after the timeout, with nothing claimed about images.
    const t = setup();
    t.state.listFails = true;
    await t.prewarm.refresh();
    expect(await t.prewarm.waitReady(20, 5)).toBe("timeout");
    expect(t.state.warnings.at(-1)).toContain("the image list not read yet");
  });

  test("a gateway that predates the route: nothing is prewarmed, and it is said once per pass", async () => {
    const s = setup();
    s.state.list = null;
    await s.prewarm.refresh();
    expect(s.state.warnings.join("\n")).toContain("does not serve the image list");
    expect(s.prewarm.digests()).toEqual([]);
  });

  test("a reload during a pass queues exactly one more pass", async () => {
    const s = setup({ delayMs: 20 });
    s.state.list = [s.img("a")];
    const first = s.prewarm.refresh();
    void s.prewarm.refresh();
    void s.prewarm.refresh();
    await first;
    expect(s.state.listCalls).toBe(2);
  });

  test("after a pass the cache is trimmed, never an image that is wanted or in use on this node", async () => {
    const s = setup({ budgetMb: 1 });
    const big = (tag: string) => {
      const w = s.img(tag.repeat(450_000));
      return w;
    };
    const a = big("a");
    const b = big("b");
    const c = big("c");
    s.state.list = [a, b, c];
    await s.prewarm.refresh();
    // All three are wanted: all three stay, though the cache is above its budget.
    expect(s.prewarm.digests()).toHaveLength(3);
    // The gateway no longer lists a and b; a session on this node still runs on a.
    s.state.list = [c];
    s.state.inUse = new Set([a.digest]);
    await s.prewarm.refresh();
    expect(s.prewarm.digests().sort()).toEqual([a.digest, c.digest].sort());
  });

  test("at claim time: present is a no-op, missing is fetched under the deadline with one status line", async () => {
    const s = setup();
    const w = s.img("claim");
    const status: string[] = [];
    await s.prewarm.ensureFor(w, { deadlineMs: 5_000, onStatus: (t) => void status.push(t) });
    expect(status).toEqual(["preparing the box"]);
    expect(s.images.has(w.digest)).toBe(true);
    await s.prewarm.ensureFor(w, { deadlineMs: 5_000, onStatus: (t) => void status.push(t) });
    expect(status).toHaveLength(1);
  });

  test("at claim time: a pull that fails or times out fails the turn with BOX_IMAGE_UNAVAILABLE", async () => {
    const s = setup();
    const gone = { image: image("c"), digest: digest("c") };
    const e = await s.prewarm.ensureFor(gone, { deadlineMs: 1_000 }).catch((x) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect((e as BootFailure).code).toBe("BOX_IMAGE_UNAVAILABLE");
    const slow = setup({ delayMs: 300 });
    const w = slow.img("slow");
    const late = await slow.prewarm.ensureFor(w, { deadlineMs: 15 }).catch((x) => x);
    expect((late as BootFailure).code).toBe("BOX_IMAGE_UNAVAILABLE");
    expect((late as Error).message).toContain("was not fetched within");
  });
});

describe("the console's view: which node holds which image", () => {
  beforeEach(() => __resetBoxInventoryForTests());
  const live = [
    { node: "n2", labels: ["heavy", "default"], boxes: { digests: [digest("b"), digest("a")], running: 3, capacity: 8, free: 5 } },
    { node: "n1", labels: ["default"], boxes: { digests: [digest("a"), digest("x")], running: 8, capacity: 8, free: 0 } },
    { node: "n3", labels: ["default"], boxes: { digests: [] } },
  ];

  test("derived from the nodes' reports: rows sorted, holders per digest, occupancy per label", () => {
    const inv = deriveBoxInventory(live, 1000);
    expect(inv.nodes.map((n) => n.node)).toEqual(["n1", "n2", "n3"]);
    expect(inv.nodes[1]).toEqual({ node: "n2", labels: ["default", "heavy"], digests: [digest("a"), digest("b")], running: 3, capacity: 8, free: 5 });
    expect(inv.nodes[2]).toMatchObject({ running: null, capacity: null, free: null });
    expect(inv.holders.get(digest("a"))).toEqual(["n1", "n2"]);
    expect(inv.holders.get(digest("b"))).toEqual(["n2"]);
    expect(labelOccupancy(inv, "default")).toEqual({ nodes: 2, running: 11, capacity: 16, full: 1 });
    expect(labelOccupancy(inv, "heavy")).toEqual({ nodes: 1, running: 3, capacity: 8, full: 0 });
    expect(labelOccupancy(inv, "none")).toEqual({ nodes: 0, running: 0, capacity: 0, full: 0 });
  });

  test("the snapshot is empty until refreshed, and reads as empty again when it is too old", async () => {
    expect(currentBoxInventory().nodes).toEqual([]);
    await refreshBoxInventory(async () => live, 10_000);
    expect(currentBoxInventory(10_001).nodes).toHaveLength(3);
    expect(currentBoxInventory(10_000 + BOX_INVENTORY_STALE_MS + 1).nodes).toEqual([]);
    await expect(refreshBoxInventory(async () => Promise.reject(new Error("redis down")))).rejects.toThrow("redis down");
    // A failed refresh keeps the last good one, until it is too old.
    expect(currentBoxInventory(10_002).nodes).toHaveLength(3);
  });

  test("the boxes route shows who holds each version, and counts (never lists) images the set does not know", async () => {
    const out = await boxesView("default", {
      enabled: true,
      load: async () => snapshot([entry("ruby-dev", [version("ruby-dev", 1, "a"), version("ruby-dev", 2, "b")])]),
      inventory: () => deriveBoxInventory(live, 1000),
    });
    const versions = out.boxes[0]!.versions;
    expect(versions.map((v) => [v.version, v.heldBy])).toEqual([[2, ["n2"]], [1, ["n1", "n2"]]]);
    expect(out.nodes).toEqual([
      { node: "n1", labels: ["default"], images: 2, knownImages: 1, running: 8, capacity: 8, free: 0 },
      { node: "n2", labels: ["default", "heavy"], images: 2, knownImages: 2, running: 3, capacity: 8, free: 5 },
      { node: "n3", labels: ["default"], images: 0, knownImages: 0, running: null, capacity: null, free: null },
    ]);
    expect(JSON.stringify(out)).not.toContain(digest("x"));
  });
});
