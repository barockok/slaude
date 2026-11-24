/**
 * A node's boxes (box plan, Phase 6) with a fake sandbox driver: admission
 * before a sandbox starts, parking an idle session for room, the claim gate
 * of a full node, the pressure rule, drain, the two independent pause
 * reasons, and the node's refusal to start without a driver or with a pod
 * too small for its boxes.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { BootFailure } from "../../src/gateway/core/failure-codes";
import { noDriverRefusal, setupNodeBoxes, type NodeBoxContext } from "../../src/node/box-node";
import { makeBoxRuntime, type BoxCapacityConfig, type RuntimeBox } from "../../src/node/box-runtime";
import { makeClaimPause } from "../../src/node/claim-pause";
import { fakeBox, fakeDriver, fakeSpec } from "../helpers/fake-sandbox";

const CAP: BoxCapacityConfig = { maxBoxes: 2, memoryBudgetMb: 2 * (1024 + 150), overheadMb: 150, pressureIdleSec: 60, memoryLimitMb: 16384 };

function setup(o: { capacity?: Partial<BoxCapacityConfig>; boxes?: Record<string, RuntimeBox | null>; freeDiskMb?: number | null } = {}) {
  const driver = fakeDriver();
  const clock = { now: 1_000_000 };
  const state = {
    boxes: new Map<string, RuntimeBox | null>(Object.entries(o.boxes ?? {})),
    turns: new Set<string>(),
    parked: [] as string[],
    claiming: [] as boolean[],
    memoryUsedMb: null as number | null,
    freeDiskMb: o.freeDiskMb === undefined ? 50_000 : o.freeDiskMb,
    ensured: [] as string[],
    status: [] as string[],
    metrics: { admission: [] as string[], evictions: 0, full: [] as number[], phases: [] as string[] },
    logs: [] as string[],
  };
  const runtime = makeBoxRuntime({
    driver,
    capacity: { ...CAP, ...o.capacity },
    boxOf: async (id) => (state.boxes.has(id) ? state.boxes.get(id)! : fakeBox()),
    specFor: (id, box) => fakeSpec(id, box),
    ensureImage: async (box, x) => {
      state.ensured.push(box.digest);
      x.onStatus?.("preparing the box");
    },
    park: async (id) => void state.parked.push(id),
    turnRunning: (id) => state.turns.has(id),
    setClaiming: (on) => void state.claiming.push(on),
    freeDiskMb: () => state.freeDiskMb,
    memoryUsedMb: () => state.memoryUsedMb,
    digests: () => ["sha256:" + "a".repeat(64)],
    metrics: { admission: (r) => void state.metrics.admission.push(r), pressureEviction: () => void state.metrics.evictions++, full: (v) => void state.metrics.full.push(v), startPhase: (phase, result, seconds) => void state.metrics.phases.push(`${phase} ${result} ${seconds >= 0 ? "timed" : "untimed"}`) },
    now: () => clock.now,
    log: (l) => void state.logs.push(l),
  });
  /** Run one turn of a session: prepare, mark it running, end it. */
  const turn = async (id: string) => {
    const r = await runtime.prepare(id);
    if (r !== "full") {
      state.turns.add(id);
      state.turns.delete(id);
      runtime.turnEnded(id);
    }
    return r;
  };
  return { runtime, driver, state, clock, turn };
}

describe("admission before a sandbox starts", () => {
  test("an unboxed session is none of this module's business", async () => {
    const s = setup({ boxes: { plain: null } });
    expect(await s.runtime.prepare("plain")).toBe("unboxed");
    expect(await s.runtime.sandboxFor("plain")).toBeNull();
    expect(s.driver.events).toEqual([]);
    expect(s.state.metrics.admission).toEqual([]);
  });

  test("a new session is admitted, its image is made present, and its sandbox starts", async () => {
    const s = setup();
    expect(await s.runtime.prepare("a", { onStatus: (t) => void s.state.status.push(t) })).toBe("started");
    expect(s.driver.events).toEqual(["create a", "start a"]);
    expect(s.state.ensured).toHaveLength(1);
    expect(s.state.status).toEqual(["preparing the box"]);
    expect(await s.runtime.sandboxFor("a")).not.toBeNull();
    expect(s.runtime.has("a")).toBe(true);
    expect(s.state.metrics.admission).toEqual(["admit"]);
  });

  test("a warm session's next turn is always served, with no admission, on a node that is full", async () => {
    const s = setup({ capacity: { maxBoxes: 1, memoryBudgetMb: 1174 } });
    expect(await s.turn("a")).toBe("started");
    s.state.turns.add("a");
    // Full: a second session finds no room, and a's own turn still runs.
    expect(await s.runtime.prepare("b")).toBe("full");
    expect(await s.runtime.prepare("a")).toBe("warm");
    expect(s.driver.running).toEqual(["a"]);
    expect(s.state.metrics.admission).toEqual(["admit", "full"]);
  });

  test("a node at capacity parks its longest-idle session to admit a new one", async () => {
    const s = setup();
    await s.turn("old");
    s.clock.now += 30_000;
    await s.turn("newer");
    s.clock.now += 61_000;
    expect(await s.runtime.prepare("c")).toBe("started");
    // The worker was asked to park the one idle longest, then its sandbox was stopped; the other was not touched.
    expect(s.state.parked).toEqual(["old"]);
    expect(s.driver.events).toContain("stop old pressure");
    expect(s.driver.running.sort()).toEqual(["c", "newer"]);
    expect(s.state.metrics.admission.at(-1)).toBe("make-room");
    expect(s.runtime.claimsPaused()).toBe(false);
  });

  test("with none idle long enough the node is full: it pauses its label queues and starts nothing", async () => {
    const s = setup();
    await s.turn("a");
    await s.turn("b");
    s.clock.now += 10_000;
    expect(await s.runtime.prepare("c")).toBe("full");
    expect(s.state.parked).toEqual([]);
    expect(s.state.claiming).toEqual([false]);
    expect(s.runtime.claimsPaused()).toBe(true);
    expect(s.driver.running.sort()).toEqual(["a", "b"]);
    // Nothing was started for c, and nothing would be spawned unboxed for it.
    await expect(s.runtime.sandboxFor("c")).rejects.toBeInstanceOf(BootFailure);
    expect((await s.runtime.report()).free).toBe(0);
  });

  test("a session in a turn is never parked for room, however long ago its sandbox started", async () => {
    const s = setup({ capacity: { maxBoxes: 1, memoryBudgetMb: 1174 } });
    await s.turn("a");
    s.clock.now += 600_000;
    s.state.turns.add("a");
    expect(await s.runtime.prepare("b")).toBe("full");
    expect(s.state.parked).toEqual([]);
  });

  test("two starts at once cannot both take the last slot", async () => {
    const s = setup({ capacity: { maxBoxes: 1, memoryBudgetMb: 1174 } });
    const results = await Promise.all([s.runtime.prepare("a"), s.runtime.prepare("b")]);
    expect(results.sort()).toEqual(["full", "started"]);
    expect(s.driver.running).toHaveLength(1);
  });

  test("memory is a limit of its own: a heavy box finds no room though a slot is free", async () => {
    const s = setup({ capacity: { maxBoxes: 4 }, boxes: { heavy: fakeBox({ reserveMb: 2048 }) } });
    await s.turn("a");
    s.state.turns.add("a");
    expect(await s.runtime.prepare("heavy")).toBe("full");
    expect(s.state.logs.join("\n")).toContain("(memory)");
  });

  test("too little free disk admits nothing", async () => {
    const s = setup({ freeDiskMb: 500 });
    expect(await s.runtime.prepare("a")).toBe("full");
    expect(s.state.logs.join("\n")).toContain("(disk)");
  });

  test("a start is timed by phase: the image, then the sandbox; a warm session times nothing", async () => {
    const s = setup();
    expect(await s.runtime.prepare("a")).toBe("started");
    expect(s.state.metrics.phases).toEqual(["pull ok timed", "start ok timed"]);
    s.runtime.turnEnded("a");
    expect(await s.runtime.prepare("a")).toBe("warm");
    expect(s.state.metrics.phases).toHaveLength(2);
  });

  test("a sandbox that does not start is a boot failure, and its slot is given back", async () => {
    const s = setup({ capacity: { maxBoxes: 1, memoryBudgetMb: 1174 } });
    s.driver.failStart.add("a");
    const e = await s.runtime.prepare("a").catch((x) => x);
    expect(s.state.metrics.phases).toEqual(["pull ok timed", "start error timed"]);
    expect(e).toBeInstanceOf(BootFailure);
    expect((e as BootFailure).code).toBe("BOX_UNAVAILABLE");
    expect(s.runtime.has("a")).toBe(false);
    await expect(s.runtime.sandboxFor("a")).rejects.toBeInstanceOf(BootFailure);
    expect(await s.runtime.prepare("b")).toBe("started");
  });

  test("an image that cannot be made present fails the turn and starts nothing", async () => {
    const driver = fakeDriver();
    const runtime = makeBoxRuntime({
      driver, capacity: CAP, boxOf: async () => fakeBox(), specFor: (id, box) => fakeSpec(id, box),
      ensureImage: async () => {
        throw new BootFailure("BOX_IMAGE_UNAVAILABLE", "not fetched");
      },
      park: async () => {}, turnRunning: () => false, setClaiming: () => {}, log: () => {},
    });
    expect(((await runtime.prepare("a").catch((x) => x)) as BootFailure).code).toBe("BOX_IMAGE_UNAVAILABLE");
    expect(driver.events).toEqual([]);
    expect(runtime.has("a")).toBe(false);
  });

  test("a session moved to another image: the old sandbox stops and the new one is a start like any other", async () => {
    const s = setup();
    await s.turn("a");
    s.state.boxes.set("a", fakeBox({ digestChar: "b" }));
    await expect(s.runtime.sandboxFor("a")).rejects.toBeInstanceOf(BootFailure);
    expect(await s.runtime.prepare("a")).toBe("started");
    expect(s.driver.events).toEqual(["create a", "start a", "stop a refresh", "create a", "start a"]);
    expect([...s.runtime.digestsInUse()]).toEqual(["sha256:" + "b".repeat(64)]);
  });
});

describe("the claim gate and the heartbeat report", () => {
  test("a full node resumes its label queues only after room has held for 5 s", async () => {
    const s = setup({ capacity: { maxBoxes: 1, memoryBudgetMb: 1174 } });
    await s.turn("a");
    s.state.turns.add("a");
    expect(await s.runtime.prepare("b")).toBe("full");
    expect(s.state.claiming).toEqual([false]);
    // Still full.
    await s.runtime.tick();
    expect(s.state.claiming).toEqual([false]);
    // The session goes idle and its sandbox is stopped: room, but not yet for 5 s.
    s.state.turns.delete("a");
    await s.runtime.stop("a", "idle");
    await s.runtime.tick();
    expect(s.runtime.claimsPaused()).toBe(true);
    expect((await s.runtime.report()).free).toBe(0);
    s.clock.now += 4_000;
    await s.runtime.tick();
    expect(s.state.claiming).toEqual([false]);
    s.clock.now += 1_500;
    await s.runtime.tick();
    expect(s.state.claiming).toEqual([false, true]);
    expect(s.runtime.claimsPaused()).toBe(false);
    expect(s.state.metrics.full.at(-1)).toBe(0);
  });

  test("the report: images held, sandboxes running, capacity and free slots", async () => {
    const s = setup({ capacity: { maxBoxes: 4, memoryBudgetMb: 4 * 1174 } });
    expect(await s.runtime.report()).toEqual({ digests: ["sha256:" + "a".repeat(64)], running: 0, capacity: 4, free: 4 });
    await s.turn("a");
    await s.turn("b");
    expect(await s.runtime.report()).toMatchObject({ running: 2, capacity: 4, free: 2 });
  });
});

describe("memory pressure", () => {
  test("above 90 percent the node stops admitting and parks idle sessions, longest idle first, until under 80", async () => {
    const s = setup({ capacity: { maxBoxes: 4, memoryBudgetMb: 4 * 1174 } });
    await s.turn("a");
    s.clock.now += 1_000;
    await s.turn("b");
    s.clock.now += 1_000;
    await s.turn("busy");
    s.state.turns.add("busy");
    s.clock.now += 61_000;
    s.state.memoryUsedMb = 0.93 * 16384;
    await s.runtime.tick();
    expect(s.runtime.admitting()).toBe(false);
    expect(s.state.parked).toEqual(["a"]);
    expect(s.state.metrics.evictions).toBe(1);
    // No new sandbox while it holds, though a slot is free.
    expect(await s.runtime.prepare("new")).toBe("full");
    expect(s.state.logs.join("\n")).toContain("(pressure)");
    // Still between the marks: keep parking.
    s.state.memoryUsedMb = 0.85 * 16384;
    await s.runtime.tick();
    expect(s.state.parked).toEqual(["a", "b"]);
    // Only the session in a turn is left: nothing more to park, and it is not touched.
    await s.runtime.tick();
    expect(s.state.parked).toEqual(["a", "b"]);
    expect(s.driver.running).toEqual(["busy"]);
    // Under the low mark: admitting again.
    s.state.memoryUsedMb = 0.7 * 16384;
    await s.runtime.tick();
    expect(s.runtime.admitting()).toBe(true);
    s.clock.now += 6_000;
    await s.runtime.tick();
    expect(await s.runtime.prepare("new")).toBe("started");
  });

  test("with no memory reading the rule does nothing", async () => {
    const s = setup();
    await s.turn("a");
    s.clock.now += 600_000;
    await s.runtime.tick();
    expect(s.state.parked).toEqual([]);
    expect(s.runtime.admitting()).toBe(true);
  });
});

describe("drain", () => {
  test("every warm box is stopped, and nothing is admitted afterwards", async () => {
    const s = setup({ capacity: { maxBoxes: 8, memoryBudgetMb: 8 * 1174 } });
    for (const id of ["a", "b", "c", "d", "e"]) await s.turn(id);
    await s.runtime.drain();
    expect(s.driver.running).toEqual([]);
    expect(s.driver.events.filter((e) => e.endsWith(" drain")).sort()).toEqual(["stop a drain", "stop b drain", "stop c drain", "stop d drain", "stop e drain"]);
    expect(s.runtime.sessions()).toEqual([]);
    expect(await s.runtime.prepare("late")).toBe("full");
  });

  test("a sandbox whose stop fails does not keep the others from stopping", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setup({ capacity: { maxBoxes: 8, memoryBudgetMb: 8 * 1174 } });
      await s.turn("a");
      await s.turn("b");
      const sandbox = (await s.runtime.sandboxFor("a"))!;
      sandbox.stop = async () => {
        throw new Error("boxd gone");
      };
      await s.runtime.drain();
      expect(s.driver.running).toEqual(["a"]);
      expect(s.runtime.sessions()).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
});

describe("two reasons to pause claiming, independent of each other", () => {
  function workers() {
    const log: string[] = [];
    const mk = (name: string) => ({ name, paused: false, worker: { pause: async () => void (log.push(`pause ${name}`)), resume: () => void log.push(`resume ${name}`) } });
    const all = [mk("label-default"), mk("label-heavy"), mk("own")];
    const pause = makeClaimPause(all.map((w, i) => ({ worker: w.worker, label: i < 2 })));
    return { pause, log };
  }

  test("capacity pauses the label queues only; the node's own queue keeps running", async () => {
    const { pause, log } = workers();
    await pause.pause("capacity", "labels");
    expect(log).toEqual(["pause label-default", "pause label-heavy"]);
    pause.resume("capacity");
    expect(log.slice(2)).toEqual(["resume label-default", "resume label-heavy"]);
  });

  test("a refused credential pauses every queue", async () => {
    const { pause, log } = workers();
    await pause.pause("auth", "all");
    expect(log).toEqual(["pause label-default", "pause label-heavy", "pause own"]);
  });

  test("the capacity pause does not release the credential pause, and the reverse", async () => {
    const { pause, log } = workers();
    await pause.pause("auth", "all");
    await pause.pause("capacity", "labels");
    // Already paused: no second pause call.
    expect(log).toHaveLength(3);
    // Room again: the label queues stay paused, because the credential is still refused.
    pause.resume("capacity");
    expect(log).toHaveLength(3);
    expect(pause.has("auth")).toBe(true);
    expect(pause.has("capacity")).toBe(false);
    // The credential is accepted again: everything resumes.
    pause.resume("auth");
    expect(log.slice(3)).toEqual(["resume label-default", "resume label-heavy", "resume own"]);

    // The other order: the credential comes back while the node is still full.
    const b = workers();
    await b.pause.pause("capacity", "labels");
    await b.pause.pause("auth", "all");
    b.pause.resume("auth");
    // Only the own queue resumes: the label queues are still paused for capacity.
    expect(b.log.slice(3)).toEqual(["resume own"]);
    b.pause.resume("capacity");
    expect(b.log.slice(4)).toEqual(["resume label-default", "resume label-heavy"]);
  });

  test("resuming a reason that was never set does nothing", () => {
    const { pause, log } = workers();
    pause.resume("capacity");
    pause.resume("auth");
    expect(log).toEqual([]);
  });
});

describe("a node on a sandbox tier: what it checks before it starts", () => {
  const ctx = (): NodeBoxContext => ({
    nodeId: "n1",
    turnConcurrency: 4,
    sessionBoxes: { boxOf: async () => null, egressOf: async () => ({ allow: [], deny: [] }) },
    listBoxes: async () => [],
    park: async () => {},
    turnRunning: () => false,
    setClaiming: () => {},
  });
  const limits = (memoryLimitMb: number | null, diskMb: number | null) => () => ({ memoryLimitMb, diskMb });
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  };

  test("tier none: nothing is built", async () => {
    expect(await setupNodeBoxes({ tier: "none" }, ctx())).toBeNull();
    expect(await setupNodeBoxes({ tier: "none", driver: fakeDriver() }, ctx())).toBeNull();
  });

  test("a sandbox tier with no driver refuses to start: it would advertise a sandbox it cannot run", async () => {
    await expect(setupNodeBoxes({ tier: "gvisor" }, ctx())).rejects.toThrow(noDriverRefusal("gvisor"));
    expect(noDriverRefusal("gvisor")).toContain("Set SLAUDE_BOX_TIER=none");
    await expect(setupNodeBoxes({ tier: "gvisor", driver: fakeDriver("bwrap") }, ctx())).rejects.toThrow("the sandbox driver is for tier bwrap");
  });

  test("a driver whose probe fails refuses to start, with the driver's reason", async () => {
    const driver = fakeDriver();
    driver.probeResult = { ok: false, reason: "runsc is not installed" };
    await expect(setupNodeBoxes({ tier: "gvisor", driver, images: null }, ctx())).rejects.toThrow("cannot run sandbox tier gvisor: runsc is not installed");
  });

  test("a pod too small for its boxes refuses to start and names the numbers", async () => {
    const e = await setupNodeBoxes({ tier: "gvisor", driver: fakeDriver(), images: null, limits: limits(4096, 200_000), capacity: { maxBoxes: 10, overheadMb: 150 } }, ctx()).catch((x) => x);
    expect((e as Error).message).toContain("this pod is too small for its boxes");
    expect((e as Error).message).toContain("10 boxes need the supervisor's memory limit to be at least 13812 MB");
    expect((e as Error).message).toContain("it is 4096 MB");
  });

  test("a pod that fits starts, with the budget derived from the limit and the park budget from the volume", async () => {
    const boxes = await quiet(() => setupNodeBoxes({ tier: "gvisor", driver: fakeDriver(), images: null, limits: limits(16384, 81920), capacity: { maxBoxes: 10, overheadMb: 150 } }, ctx()));
    expect(boxes).not.toBeNull();
    expect(boxes!.tier).toBe("gvisor");
    // Half of 80 Gi would not fit beside the images and the live sessions: what is left is used.
    expect(boxes!.parkBudgetMb).toBe(81920 - 15360 - 10 * 3072);
    expect(await boxes!.report()).toMatchObject({ running: 0, capacity: 10, free: 10 });
    // No image cache: ready at once.
    await boxes!.ready();
  });

  test("fewer boxes than turns at once starts with a warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const boxes = await setupNodeBoxes({ tier: "gvisor", driver: fakeDriver(), images: null, limits: limits(16384, 81920), capacity: { maxBoxes: 2 } }, { ...ctx(), turnConcurrency: 8 });
      expect(boxes).not.toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("SLAUDE_NODE_MAX_BOXES (2) is below this node's turn concurrency (8)");
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test("a driver with nothing that builds a spec fails the boot of a boxed session; it does not run it unboxed", async () => {
    const boxes = await quiet(() =>
      setupNodeBoxes(
        { tier: "gvisor", driver: fakeDriver(), images: null, limits: limits(16384, 81920), capacity: { maxBoxes: 2 } },
        { ...ctx(), sessionBoxes: { boxOf: async () => fakeBox(), egressOf: async () => ({ allow: [], deny: [] }) } },
      ),
    );
    const e = await quiet(() => boxes!.runtime.prepare("a").catch((x) => x));
    expect(e).toBeInstanceOf(BootFailure);
    await expect(boxes!.runtime.sandboxFor("a")).rejects.toBeInstanceOf(BootFailure);
  });

  test("the file sync's box facts come from the session's box: the pinned digest, the home, the limits", async () => {
    const box = fakeBox();
    box.policy.durable.exclude = [".cache/big"];
    const boxes = await quiet(() =>
      setupNodeBoxes(
        { tier: "gvisor", driver: fakeDriver(), images: null, limits: limits(16384, 81920), capacity: { maxBoxes: 2 }, homeDirOf: (id) => `/var/lib/slaude-box/sessions/${id}/home` },
        { ...ctx(), sessionBoxes: { boxOf: async (id) => (id === "boxed" ? box : null), egressOf: async () => ({ allow: [], deny: [] }) } },
      ),
    );
    expect(await boxes!.syncFacts("plain")).toBeUndefined();
    expect(await boxes!.syncFacts("boxed")).toEqual({ digest: box.digest, homeDir: "/var/lib/slaude-box/sessions/boxed/home", exclude: [".cache/big"], homeMb: 4096, extrasMb: 4096 });
  });
});
