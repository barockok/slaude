/**
 * Boxes at dispatch (box plan, Phase 3): a boxed persona's session is pinned
 * once, a new box version does not re-pin it, its turns go only to a node that
 * offers the box's tier, a box that cannot be resolved refuses the turn, and
 * with SLAUDE_BOX off nothing changes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeQueueDispatch } from "../../src/gateway/core/dispatch";
import type { SessionRow } from "../../src/db/schema";
import { BOX_CAPABILITY, boxTierCapability, nodeBoxCapabilities, requiredBoxCapabilities } from "../../src/box/capability";
import { defaultBoxPolicy, tierSatisfies, type BoxTier } from "../../src/box/policy";
import { BoxUnavailableError, __resetBoxPinForTests, defaultBoxPinDeps, sessionBoxPin, type BoxPinDeps } from "../../src/gateway/core/box-pin";
import type { BoxVersion } from "../../src/gateway/core/box-registry";
import { GUARDRAILS_CAPABILITY } from "../../src/guardrails/capability";
import { failureText } from "../../src/gateway/core/failure-codes";
import { NODE_CAPS, nodeCapabilities } from "../../src/node/worker";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const version = (n: number, c: string, tier: BoxTier = "gvisor", name = "ruby-dev"): BoxVersion => ({
  name, version: n, image: `ghcr.io/example/boxes/${name}@${digest(c)}`, digest: digest(c), policy: { ...defaultBoxPolicy(), tier }, forced: false,
});

describe("box capabilities", () => {
  test("tiers are ordered none < bwrap < gvisor", () => {
    expect(tierSatisfies("gvisor", "bwrap")).toBe(true);
    expect(tierSatisfies("gvisor", "gvisor")).toBe(true);
    expect(tierSatisfies("bwrap", "gvisor")).toBe(false);
    expect(tierSatisfies("none", "bwrap")).toBe(false);
    expect(tierSatisfies("none", "none")).toBe(true);
  });

  test("a node advertises box/1 and every sandbox tier at or below its own; tier none advertises nothing", () => {
    expect(BOX_CAPABILITY).toBe("box/1");
    expect(boxTierCapability("gvisor")).toBe("box-tier/gvisor");
    expect(nodeBoxCapabilities("none")).toEqual([]);
    expect(nodeBoxCapabilities("bwrap")).toEqual(["box/1", "box-tier/bwrap"]);
    expect(nodeBoxCapabilities("gvisor")).toEqual(["box/1", "box-tier/bwrap", "box-tier/gvisor"]);
  });

  test("a box requires box/1 and its weakest accepted tier, so a stronger node serves it and a weaker one does not", () => {
    expect(requiredBoxCapabilities("none")).toEqual([]);
    expect(requiredBoxCapabilities("bwrap")).toEqual(["box/1", "box-tier/bwrap"]);
    const serves = (node: BoxTier, box: BoxTier) => requiredBoxCapabilities(box).every((c) => nodeBoxCapabilities(node).includes(c));
    expect(serves("gvisor", "bwrap")).toBe(true);
    expect(serves("gvisor", "gvisor")).toBe(true);
    expect(serves("bwrap", "gvisor")).toBe(false);
    expect(serves("none", "bwrap")).toBe(false);
    expect(serves("none", "none")).toBe(true);
  });

  test("a node on tier none (the default) advertises exactly what it did before", () => {
    const saved = process.env.SLAUDE_BOX_TIER;
    try {
      delete process.env.SLAUDE_BOX_TIER;
      expect(nodeCapabilities()).toEqual([...NODE_CAPS]);
      expect(nodeCapabilities("none")).toEqual([...NODE_CAPS]);
      process.env.SLAUDE_BOX_TIER = "gvisor";
      expect(nodeCapabilities()).toEqual([...NODE_CAPS, "box/1", "box-tier/bwrap", "box-tier/gvisor"]);
      process.env.SLAUDE_BOX_TIER = "docker";
      expect(() => nodeCapabilities()).toThrow(/SLAUDE_BOX_TIER must be one of none, bwrap, gvisor/);
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_BOX_TIER;
      else process.env.SLAUDE_BOX_TIER = saved;
    }
  });
});

/** An in-memory box store standing in for the signed set and the session rows. */
function store(o: { enabled?: boolean; box?: string | null; unboxable?: string[] } = {}) {
  const versions: BoxVersion[] = [version(1, "a")];
  const pins = new Map<string, { name: string; digest: string }>();
  const audits: any[] = [];
  let pinCalls = 0;
  const deps: BoxPinDeps = {
    enabled: () => o.enabled ?? true,
    boxNameFor: () => (o.box === undefined ? "ruby-dev" : o.box),
    unboxableForms: () => o.unboxable ?? [],
    current: async (_t, name) => versions.filter((v) => v.name === name).at(-1) ?? null,
    pinned: async (_t, name, d) => {
      const at = [...versions].reverse().find((v) => v.name === name && v.digest === d);
      const cur = versions.filter((v) => v.name === name).at(-1);
      return at && cur ? { ...at, policy: cur.policy } : null;
    },
    read: async (id) => pins.get(id) ?? null,
    pin: async (id, box) => {
      pinCalls++;
      const had = pins.get(id);
      if (!had) pins.set(id, box);
      return { ...(had ?? box), pinned: !had };
    },
    audit: (e) => void audits.push(e),
  };
  return { deps, versions, pins, audits, pinCalls: () => pinCalls };
}
const CTX = { tenant: "default", persona: "ana", sessionId: "S-box" };

describe("sessionBoxPin", () => {
  beforeEach(() => __resetBoxPinForTests());

  test("SLAUDE_BOX off: null, and nothing is read", async () => {
    const s = store({ enabled: false });
    s.deps.boxNameFor = () => {
      throw new Error("must not be read");
    };
    expect(await sessionBoxPin(CTX, s.deps)).toBeNull();
    expect(s.pinCalls()).toBe(0);
  });

  test("the real switch is off by default", async () => {
    const saved = process.env.SLAUDE_BOX;
    try {
      delete process.env.SLAUDE_BOX;
      expect(defaultBoxPinDeps.enabled()).toBe(false);
      expect(await sessionBoxPin(CTX)).toBeNull();
      process.env.SLAUDE_BOX = "on";
      expect(defaultBoxPinDeps.enabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_BOX;
      else process.env.SLAUDE_BOX = saved;
    }
  });

  test("a persona that names no box is not boxed", async () => {
    const s = store({ box: null });
    expect(await sessionBoxPin(CTX, s.deps)).toBeNull();
    expect(s.pins.size).toBe(0);
  });

  test("pinned once at the first dispatch, with an audit row", async () => {
    const s = store();
    expect(await sessionBoxPin(CTX, s.deps)).toEqual({ name: "ruby-dev", digest: digest("a"), tier: "gvisor" });
    expect(s.pins.get("S-box")).toEqual({ name: "ruby-dev", digest: digest("a") });
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({ action: "box.pinned", targetId: "S-box", details: { box: "ruby-dev", version: 1, digest: digest("a") } });
    expect(await sessionBoxPin(CTX, s.deps)).toEqual({ name: "ruby-dev", digest: digest("a"), tier: "gvisor" });
    expect(s.pinCalls()).toBe(1);
    expect(s.audits).toHaveLength(1);
  });

  test("a new version does not re-pin an open session; a new session gets it", async () => {
    const s = store();
    await sessionBoxPin(CTX, s.deps);
    s.versions.push(version(2, "b"));
    expect((await sessionBoxPin(CTX, s.deps))!.digest).toBe(digest("a"));
    expect((await sessionBoxPin({ ...CTX, sessionId: "S-new" }, s.deps))!.digest).toBe(digest("b"));
    expect(s.pins.get("S-box")!.digest).toBe(digest("a"));
  });

  test("a policy-only version reaches a pinned session: the tier is the current policy's", async () => {
    const s = store();
    await sessionBoxPin(CTX, s.deps);
    s.versions.push(version(2, "a", "bwrap"));
    expect(await sessionBoxPin(CTX, s.deps)).toEqual({ name: "ruby-dev", digest: digest("a"), tier: "bwrap" });
  });

  test("losing the pin race takes the winner's digest and writes no audit row", async () => {
    const s = store();
    s.deps.read = async () => null; // both dispatches read before either pinned
    s.pins.set("S-box", { name: "ruby-dev", digest: digest("a") });
    s.versions.push(version(2, "b"));
    expect((await sessionBoxPin(CTX, s.deps))!.digest).toBe(digest("a"));
    expect(s.audits).toHaveLength(0);
  });

  test("a box that is not defined, a pinned digest that is gone and a missing session row all throw", async () => {
    const undefinedBox = store({ box: "nope" });
    await expect(sessionBoxPin(CTX, undefinedBox.deps)).rejects.toBeInstanceOf(BoxUnavailableError);
    const gone = store();
    gone.pins.set("S-box", { name: "ruby-dev", digest: digest("z") });
    await expect(sessionBoxPin(CTX, gone.deps)).rejects.toThrow(/a digest the gateway no longer has/);
    const raced = store();
    raced.deps.read = async () => null;
    raced.pins.set("S-box", { name: "ruby-dev", digest: digest("z") });
    await expect(sessionBoxPin(CTX, raced.deps)).rejects.toThrow(/a digest the gateway no longer has/);
    const noRow = store();
    noRow.deps.pin = async () => null;
    await expect(sessionBoxPin(CTX, noRow.deps)).rejects.toThrow(/could not be pinned/);
  });

  test("a credential form a box cannot serve: unboxed, never pinned, warned once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = store({ unboxable: ["oauth-token"] });
      expect(await sessionBoxPin(CTX, s.deps)).toBeNull();
      expect(await sessionBoxPin(CTX, s.deps)).toBeNull();
      expect(s.pins.size).toBe(0);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("runs unboxed"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

function harness(o: {
  box?: (ctx: { tenant: string; persona: string; sessionId: string }) => Promise<{ name: string; digest: string; tier: BoxTier } | null>;
  needs?: boolean;
  warm?: { node: string; caps: string[] };
  nodes?: (cap: string) => Array<{ node: string; has: boolean }>;
}) {
  const enqueued: { job: any; target: any }[] = [];
  const events: any[] = [];
  const asked: string[] = [];
  const dispatch = makeQueueDispatch({ emit: (_n: string, e: any) => (events.push(e), true), resolveEffectiveIdentity: async () => undefined } as any, {
    needsGuardrails: async () => o.needs ?? false,
    ...(o.box ? { box: o.box } : {}),
    guardrailWaitMs: 40,
    guardrailPollMs: 5,
    infra: {
      turns: {
        enqueueTurn: async (job: any, target: any) => {
          enqueued.push({ job, target });
          return { queue: "turns", jobId: "J1", coalesced: false };
        },
        queue: () => ({ getJob: async () => ({ getState: async () => "active" }) }),
        movedTo: async () => null,
        close: async () => {},
      } as any,
      registry: {
        lookup: async () => (o.warm ? { node: o.warm.node, since: 1, lastBeat: Date.now(), fresh: true } : null),
        nodeCarries: async () => true,
        nodeCaps: async (node: string) => new Set(node === o.warm?.node ? o.warm.caps : []),
        liveNodesWithCap: async (_label: string, cap: string) => {
          asked.push(cap);
          return o.nodes ? o.nodes(cap) : [];
        },
        close: async () => {},
      } as any,
      pubsub: { consumeAbortFlag: async () => null, lastEventId: async () => null, appendEvent: async () => {}, readEvents: async () => [], close: async () => {} } as any,
    },
  });
  return { enqueued, events, asked, dispatch };
}

const META = { teamId: "T1", channelId: "C1", threadTs: "1.1", eventTs: "1.1", userId: "U1", personaId: "ana" };
const S = { id: "S-box" } as unknown as SessionRow;
const GVISOR_NODE = [...NODE_CAPS, ...nodeBoxCapabilities("gvisor")];
const pin = (tier: BoxTier = "gvisor") => async () => ({ name: "ruby-dev", digest: digest("a"), tier });

describe("dispatch and boxes", () => {
  const savedBox = process.env.SLAUDE_BOX;
  beforeEach(() => {
    process.env.SLAUDE_JOB_SECRET = "test-secret";
    delete process.env.SLAUDE_BOX;
  });
  afterEach(() => {
    if (savedBox === undefined) delete process.env.SLAUDE_BOX;
    else process.env.SLAUDE_BOX = savedBox;
  });

  test("SLAUDE_BOX off (no seam): routing and the job are exactly as before", async () => {
    const h = harness({ warm: { node: "old-node", caps: [] } });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued[0]!.target).toEqual({ node: "old-node" });
    expect(h.enqueued[0]!.job.requiresCaps).toBeUndefined();
    expect(h.asked).toEqual([]);
  });

  test("an unboxed session: routing is unchanged", async () => {
    const h = harness({ box: async () => null, warm: { node: "old-node", caps: [] } });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued[0]!.target).toEqual({ node: "old-node" });
    expect(h.enqueued[0]!.job.requiresCaps).toBeUndefined();
  });

  test("a boxed session is asked for once per dispatch, with its tenant, persona and session", async () => {
    const seen: any[] = [];
    const h = harness({ box: async (ctx) => (seen.push(ctx), { name: "ruby-dev", digest: digest("a"), tier: "gvisor" }), warm: { node: "box-node", caps: GVISOR_NODE } });
    await h.dispatch.dispatch(S, "hi", META);
    expect(seen).toEqual([{ tenant: "default", persona: "ana", sessionId: "S-box" }]);
  });

  test("a warm node that offers the tier keeps the session, and the job says what its node needs", async () => {
    const h = harness({ box: pin(), warm: { node: "box-node", caps: GVISOR_NODE } });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued[0]!.target).toEqual({ node: "box-node" });
    expect(h.enqueued[0]!.job.requiresCaps).toEqual([GUARDRAILS_CAPABILITY, "box/1", "box-tier/gvisor"]);
  });

  test("a gvisor node serves a box that accepts bwrap; a bwrap node does not serve a gvisor box", async () => {
    const ok = harness({ box: pin("bwrap"), warm: { node: "box-node", caps: GVISOR_NODE } });
    await ok.dispatch.dispatch(S, "hi", META);
    expect(ok.enqueued[0]!.target).toEqual({ node: "box-node" });
    const weak = harness({ box: pin("gvisor"), warm: { node: "bwrap-node", caps: [...NODE_CAPS, ...nodeBoxCapabilities("bwrap")] }, nodes: () => [{ node: "g1", has: true }] });
    await weak.dispatch.dispatch(S, "hi", META);
    expect(weak.enqueued[0]!.target).toEqual({ label: "default" });
    expect(weak.asked).toEqual(["box-tier/gvisor"]);
  });

  test("a warm node on tier none is skipped, and a mixed fleet pins the turn to a node that offers the tier", async () => {
    const h = harness({ box: pin(), warm: { node: "plain-node", caps: [...NODE_CAPS] }, nodes: () => [{ node: "plain-node", has: false }, { node: "box-1", has: true }, { node: "box-2", has: true }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(["box-1", "box-2"]).toContain(h.enqueued[0]!.target.node);
  });

  test("no node offers the tier within the wait: not dispatched, the thread is told, never run unboxed", async () => {
    const h = harness({ box: pin(), nodes: () => [{ node: "plain-node", has: false }] });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued).toHaveLength(0);
    expect(h.events).toEqual([{ type: "error", sessionId: "S-box", error: "no box-capable node", code: "BOX_UNSUPPORTED" }]);
    expect(failureText("BOX_UNSUPPORTED")).toContain("sandbox");
  });

  test("a box whose weakest tier is none needs no capability", async () => {
    const h = harness({ box: pin("none"), warm: { node: "plain-node", caps: [] } });
    await h.dispatch.dispatch(S, "hi", META);
    expect(h.enqueued[0]!.target).toEqual({ node: "plain-node" });
    expect(h.enqueued[0]!.job.requiresCaps).toBeUndefined();
  });

  test("a box that cannot be resolved refuses the turn: nothing is enqueued", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness({
        box: async () => {
          throw new BoxUnavailableError("persona names box 'ruby-dev', which is not defined");
        },
        warm: { node: "box-node", caps: GVISOR_NODE },
      });
      await h.dispatch.dispatch(S, "hi", META);
      expect(h.enqueued).toHaveLength(0);
      expect(h.events).toEqual([{ type: "error", sessionId: "S-box", error: "the agent's box is unavailable", code: "BOX_UNAVAILABLE" }]);
      expect(failureText("BOX_UNAVAILABLE")).toContain("sandbox");
    } finally {
      err.mockRestore();
    }
  });

  test("the pin survives a new version across dispatches (the store is asked each time and answers the same digest)", async () => {
    const s = store();
    const h = harness({ box: (ctx) => sessionBoxPin(ctx, s.deps), warm: { node: "box-node", caps: GVISOR_NODE } });
    await h.dispatch.dispatch(S, "one", META);
    s.versions.push(version(2, "b"));
    await h.dispatch.dispatch(S, "two", META);
    expect(h.enqueued).toHaveLength(2);
    expect(s.pins.get("S-box")).toEqual({ name: "ruby-dev", digest: digest("a") });
    expect(s.audits.filter((a) => a.action === "box.pinned")).toHaveLength(1);
  });
});
