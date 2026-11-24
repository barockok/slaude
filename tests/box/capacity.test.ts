/**
 * Capacity of a node pod for boxes (box plan, Phase 6): the boot sizing
 * check, admission, the pressure rule and the claim gate, as tables. The
 * functions are pure, so every row is an input and an answer.
 */
import { describe, expect, test } from "bun:test";
import {
  DISK_FLOOR_MB, MEMORY_BUDGET_SHARE, PRESSURE_HIGH, PRESSURE_LOW, RESUME_HOLD_MS, TYPICAL_LIVE_DISK_MB,
  admit, checkSizing, defaultParkBudgetMb, drainGraceSec, freeSlots, nextClaimGate, parkable, pressure, reservedMb,
  type AdmissionState, type RunningBox, type SizingInput,
} from "../../src/box/capacity";

const GI = 1024;

/** The spec's worked example: 16 Gi supervisor, 10 boxes, the default box (reserve 1024), overhead 150, an 80 Gi volume. */
const EXAMPLE: SizingInput = {
  maxBoxes: 10,
  memoryBudgetMb: null,
  memoryLimitMb: 16 * GI,
  overheadMb: 150,
  smallestReserveMb: 1024,
  diskMb: 80 * GI,
  imageBudgetMb: 15 * GI,
  parkBudgetMb: 30 * GI,
  turnConcurrency: 8,
};
const sizing = (over: Partial<SizingInput> = {}) => checkSizing({ ...EXAMPLE, ...over });

describe("checkSizing: the rule a pod must satisfy at boot", () => {
  test("the worked example passes, with the budget at 85 percent of the limit", () => {
    const r = sizing();
    expect(r).toEqual({ ok: true, errors: [], warnings: [], memoryBudgetMb: Math.floor(16 * GI * MEMORY_BUDGET_SHARE) });
    expect(r.memoryBudgetMb).toBe(13926);
    // 10 x (1024 + 150) = 11740 MB reserved, under the budget.
    expect(10 * (1024 + 150)).toBeLessThanOrEqual(r.memoryBudgetMb);
  });

  test.each<[string, Partial<SizingInput>, RegExp]>([
    ["one more box than the limit can hold", { maxBoxes: 12 }, /12 boxes need the supervisor's memory limit to be at least 16575 MB \(12 x \(1024 reserve \+ 150 overhead\) \/ 0\.85\), and it is 16384 MB/],
    ["a smaller limit", { memoryLimitMb: 8 * GI }, /10 boxes need the supervisor's memory limit to be at least 13812 MB .* and it is 8192 MB/],
    ["a larger overhead", { overheadMb: 400 }, /10 x \(1024 reserve \+ 400 overhead\)/],
    ["a box with a larger reserve", { smallestReserveMb: 2048 }, /10 x \(2048 reserve \+ 150 overhead\)/],
    ["no boxes at all", { maxBoxes: 0 }, /SLAUDE_NODE_MAX_BOXES must be at least 1 \(it is 0\)/],
    ["a fraction of a box", { maxBoxes: 2.5 }, /SLAUDE_NODE_MAX_BOXES must be at least 1/],
    ["a volume too small for images, live sessions and parked ones", { diskMb: 60 * GI }, /the box data volume is 61440 MB and must hold at least 76800 MB \(15360 for images \+ 10 x 3072 for live sessions \+ 30720 for parked sessions\)/],
    ["a park budget the volume cannot hold", { parkBudgetMb: 40 * GI }, /must hold at least 87040 MB/],
    ["no limit and no budget", { memoryLimitMb: null }, /no readable memory limit, so the memory budget cannot be derived/],
    ["a budget above the limit", { memoryBudgetMb: 20 * GI }, /SLAUDE_BOX_MEMORY_BUDGET_MB \(20480 MB\) is above the supervisor's memory limit \(16384 MB\)/],
    ["a budget too small for the boxes", { memoryBudgetMb: 8 * GI }, /10 boxes need 11740 MB reserved .* and SLAUDE_BOX_MEMORY_BUDGET_MB is 8192 MB/],
    ["a budget of nothing", { memoryBudgetMb: 0 }, /SLAUDE_BOX_MEMORY_BUDGET_MB must be at least 1/],
  ])("a violation stops the node and names the numbers: %s", (_what, over, message) => {
    const r = sizing(over);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(message);
  });

  test("exactly at the boundary passes; one megabyte under fails", () => {
    // 10 x 1174 = 11740 = floor(limit x 0.85) needs limit >= 13812 (13811.76...).
    expect(sizing({ memoryLimitMb: 13812 }).ok).toBe(true);
    expect(sizing({ memoryLimitMb: 13811 }).ok).toBe(false);
    expect(sizing({ diskMb: 76800 }).ok).toBe(true);
    expect(sizing({ diskMb: 76799 }).ok).toBe(false);
    expect(sizing({ maxBoxes: 1, memoryLimitMb: 1382 }).ok).toBe(true);
  });

  test("an explicit budget is used as it is", () => {
    const r = sizing({ memoryBudgetMb: 12 * GI });
    expect(r).toMatchObject({ ok: true, memoryBudgetMb: 12 * GI });
  });

  test("an explicit budget with no readable limit starts, and says what is then not protected", () => {
    const r = sizing({ memoryLimitMb: null, memoryBudgetMb: 12 * GI });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toContain("the pressure rule cannot run");
  });

  test("an unreadable volume size skips the disk half, with a warning", () => {
    const r = sizing({ diskMb: null });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toContain("the disk half of the sizing rule was not checked");
  });

  test("fewer boxes than turns running at once is a warning, not a refusal", () => {
    const r = sizing({ maxBoxes: 4, turnConcurrency: 8 });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.stringContaining("SLAUDE_NODE_MAX_BOXES (4) is below this node's turn concurrency (8)")]);
    expect(sizing({ maxBoxes: 8, turnConcurrency: 8 }).warnings).toEqual([]);
  });

  test("several violations are all reported", () => {
    const r = sizing({ maxBoxes: 40, diskMb: 10 * GI });
    expect(r.errors).toHaveLength(2);
  });

  test("the default park budget is half the volume, but never one that fails this check", () => {
    // Half of 80 Gi is 40 Gi, and images 15 + live 30 leave 35: the default is 35, which passes.
    const d = defaultParkBudgetMb({ diskMb: 80 * GI, imageBudgetMb: 15 * GI, maxBoxes: 10 });
    expect(d).toBe(80 * GI - 15 * GI - 10 * TYPICAL_LIVE_DISK_MB);
    expect(d).toBeLessThan(40 * GI);
    expect(sizing({ parkBudgetMb: d }).ok).toBe(true);
    // A roomy volume: half of it.
    expect(defaultParkBudgetMb({ diskMb: 400 * GI, imageBudgetMb: 15 * GI, maxBoxes: 10 })).toBe(200 * GI);
    // A volume with nothing left, and one whose size is not known: no budget.
    expect(defaultParkBudgetMb({ diskMb: 20 * GI, imageBudgetMb: 15 * GI, maxBoxes: 10 })).toBe(0);
    expect(defaultParkBudgetMb({ diskMb: null, imageBudgetMb: 15 * GI, maxBoxes: 10 })).toBe(0);
  });
});

const NOW = 1_000_000;
const box = (id: string, o: { reserve?: number; idleSec?: number | null } = {}): RunningBox => ({
  sessionId: id,
  reserveMb: o.reserve ?? 1024,
  idleSince: o.idleSec === null ? null : NOW - (o.idleSec ?? 0) * 1000,
});
const state = (running: RunningBox[], over: Partial<AdmissionState> = {}): AdmissionState => ({
  maxBoxes: 4,
  memoryBudgetMb: 4 * (1024 + 150),
  overheadMb: 150,
  running,
  freeDiskMb: 50 * GI,
  admitting: true,
  now: NOW,
  pressureIdleSec: 60,
  ...over,
});
const busy = (id: string, reserve?: number) => box(id, { idleSec: null, reserve });

describe("admit: before a sandbox starts", () => {
  test.each<[string, AdmissionState, number, ReturnType<typeof admit>]>([
    ["an empty node", state([]), 1024, { kind: "admit" }],
    ["one slot left", state([busy("a"), busy("b"), busy("c")]), 1024, { kind: "admit" }],
    ["no slot, every session in a turn", state([busy("a"), busy("b"), busy("c"), busy("d")]), 1024, { kind: "full", reason: "slots" }],
    ["no slot, one session idle long enough", state([busy("a"), busy("b"), box("c", { idleSec: 61 }), busy("d")]), 1024, { kind: "make-room", park: ["c"] }],
    ["no slot, the only idle session not idle long enough", state([busy("a"), busy("b"), box("c", { idleSec: 59 }), busy("d")]), 1024, { kind: "full", reason: "slots" }],
    ["idle exactly the threshold counts", state([busy("a"), busy("b"), box("c", { idleSec: 60 }), busy("d")]), 1024, { kind: "make-room", park: ["c"] }],
    ["several idle: the longest idle goes", state([box("a", { idleSec: 100 }), box("b", { idleSec: 900 }), box("c", { idleSec: 300 }), busy("d")]), 1024, { kind: "make-room", park: ["b"] }],
    ["a slot but not the memory", state([busy("a", 2048), busy("b", 2048)]), 1024, { kind: "full", reason: "memory" }],
    ["memory short: parking one heavy idle session is enough", state([box("a", { idleSec: 500, reserve: 2048 }), busy("b", 2048)]), 1024, { kind: "make-room", park: ["a"] }],
    ["memory short: two light ones must go, longest idle first", state([box("a", { idleSec: 100, reserve: 1024 }), box("b", { idleSec: 200, reserve: 1024 }), busy("c", 1024), busy("d", 1024)], { maxBoxes: 8 }), 2000, { kind: "make-room", park: ["b", "a"] }],
    ["memory short and parking everything idle is still not enough", state([box("a", { idleSec: 500, reserve: 512 }), busy("b", 2048), busy("c", 1500)]), 2048, { kind: "full", reason: "memory" }],
    ["a box whose reserve alone is above the budget", state([]), 9000, { kind: "full", reason: "memory" }],
    ["free disk under the floor", state([], { freeDiskMb: DISK_FLOOR_MB - 1 }), 1024, { kind: "full", reason: "disk" }],
    ["free disk exactly at the floor", state([], { freeDiskMb: DISK_FLOOR_MB }), 1024, { kind: "admit" }],
    ["free disk not readable: the floor is not checked", state([], { freeDiskMb: null }), 1024, { kind: "admit" }],
    ["under memory pressure nothing is admitted, room or not", state([], { admitting: false }), 1024, { kind: "full", reason: "pressure" }],
    ["under pressure an idle session is not parked to admit either", state([box("a", { idleSec: 900 })], { admitting: false }), 1024, { kind: "full", reason: "pressure" }],
  ])("%s", (_what, s, reserve, expected) => {
    expect(admit(s, { reserveMb: reserve })).toEqual(expected);
  });

  test("exactly the budget is admitted; one megabyte over is not", () => {
    const three = [busy("a"), busy("b"), busy("c")];
    expect(admit(state(three), { reserveMb: 1024 }).kind).toBe("admit");
    expect(admit(state(three, { memoryBudgetMb: 4 * (1024 + 150) - 1 }), { reserveMb: 1024 }).kind).toBe("full");
  });

  test("a session in a turn is never offered for parking, however long ago its last turn was", () => {
    const s = state([busy("a"), busy("b"), busy("c"), busy("d")]);
    expect(parkable(s)).toEqual([]);
    expect(parkable(state([box("x", { idleSec: 300 }), busy("y"), box("z", { idleSec: 600 })])).map((b) => b.sessionId)).toEqual(["z", "x"]);
  });

  test("the reserve counted is the reserve plus the overhead, per box", () => {
    expect(reservedMb([busy("a", 1024), busy("b", 512)], 150)).toBe(1024 + 150 + 512 + 150);
    expect(reservedMb([], 150)).toBe(0);
  });

  test("the example node admits exactly the 10 boxes it is sized for, overcommitting the ceilings", () => {
    const budget = checkSizing(EXAMPLE).memoryBudgetMb;
    const running: RunningBox[] = [];
    for (let i = 0; i < 10; i++) {
      expect(admit(state(running, { maxBoxes: 10, memoryBudgetMb: budget }), { reserveMb: 1024 })).toEqual({ kind: "admit" });
      running.push(busy(`s${i}`));
    }
    expect(admit(state(running, { maxBoxes: 10, memoryBudgetMb: budget }), { reserveMb: 1024 })).toEqual({ kind: "full", reason: "slots" });
    // Ceilings would be 10 x 3072 = 30 GB on a 16 GB limit: that is what the pressure rule is for.
    expect(10 * 3072).toBeGreaterThan(16 * GI);
  });
});

describe("freeSlots: what the heartbeat reports", () => {
  test.each<[string, AdmissionState, number, number]>([
    ["empty", state([]), 1024, 4],
    ["two running", state([busy("a"), busy("b")]), 1024, 2],
    ["full", state([busy("a"), busy("b"), busy("c"), busy("d")]), 1024, 0],
    ["memory is the limit before slots are", state([busy("a", 2048)], { maxBoxes: 8 }), 1024, 2],
    ["under pressure", state([], { admitting: false }), 1024, 0],
    ["no disk", state([], { freeDiskMb: 100 }), 1024, 0],
    ["over the budget already", state([busy("a", 4096), busy("b", 4096)], { maxBoxes: 8 }), 1024, 0],
  ])("%s", (_what, s, typical, expected) => {
    expect(freeSlots(s, typical)).toBe(expected);
  });
});

describe("pressure: the supervisor's memory against its limit", () => {
  const LIMIT = 16 * GI;
  test.each<[string, number, boolean, { admitting: boolean; evict: boolean }]>([
    ["well under", 0.5, true, { admitting: true, evict: false }],
    ["just under the low mark", PRESSURE_LOW - 0.001, true, { admitting: true, evict: false }],
    ["between the marks, coming from below: still admitting", 0.85, true, { admitting: true, evict: false }],
    ["at the high mark: stop admitting and park", PRESSURE_HIGH, true, { admitting: false, evict: true }],
    ["above it", 0.97, true, { admitting: false, evict: true }],
    ["between the marks, coming from above: keep parking", 0.85, false, { admitting: false, evict: true }],
    ["exactly at the low mark, coming from above: not yet", PRESSURE_LOW, false, { admitting: false, evict: true }],
    ["under the low mark, coming from above: admit again", PRESSURE_LOW - 0.001, false, { admitting: true, evict: false }],
  ])("%s", (_what, share, wasAdmitting, expected) => {
    const r = pressure(share * LIMIT, LIMIT, { admitting: wasAdmitting });
    expect({ admitting: r.admitting, evict: r.evict }).toEqual(expected);
    expect(r.ratio).toBeCloseTo(share, 6);
  });

  test("a full cycle: rise, hold, park down, admit", () => {
    let p = { admitting: true };
    const steps: Array<[number, boolean]> = [[0.7, true], [0.88, true], [0.91, false], [0.86, false], [0.81, false], [0.79, true], [0.88, true]];
    for (const [share, admitting] of steps) {
      p = pressure(share * LIMIT, LIMIT, p);
      expect(p.admitting).toBe(admitting);
    }
  });

  test("no readable limit decides nothing", () => {
    expect(pressure(99_999, null, { admitting: false })).toEqual({ admitting: true, evict: false, ratio: null });
    expect(pressure(99_999, 0, { admitting: true })).toEqual({ admitting: true, evict: false, ratio: null });
  });
});

describe("the claim gate: a full node stops claiming new work", () => {
  test("pauses the moment there is no room", () => {
    expect(nextClaimGate({ paused: false, roomSince: null }, false, 1000)).toEqual({ paused: true, roomSince: null });
  });

  test("resumes only after room has held for 5 s without a break", () => {
    let g = nextClaimGate({ paused: false, roomSince: null }, false, 0);
    g = nextClaimGate(g, true, 1000);
    expect(g).toEqual({ paused: true, roomSince: 1000 });
    g = nextClaimGate(g, true, 1000 + RESUME_HOLD_MS - 1);
    expect(g.paused).toBe(true);
    // Room is lost again: the clock starts over.
    g = nextClaimGate(g, false, 5000);
    expect(g).toEqual({ paused: true, roomSince: null });
    g = nextClaimGate(g, true, 6000);
    g = nextClaimGate(g, true, 6000 + RESUME_HOLD_MS);
    expect(g).toEqual({ paused: false, roomSince: null });
  });

  test("a node that was never full stays unpaused, and RESUME_HOLD_MS is the 5 s of the design", () => {
    expect(nextClaimGate({ paused: false, roomSince: null }, true, 1)).toEqual({ paused: false, roomSince: null });
    expect(RESUME_HOLD_MS).toBe(5000);
  });
});

describe("drain arithmetic", () => {
  test("the grace a pod needs: the drain window plus its warm boxes' flushes, several at a time", () => {
    expect(drainGraceSec({ drainSec: 120, warmBoxes: 0 })).toBe(120);
    // 10 boxes, 15 s each, 4 at a time: 37.5 s on top of the 120.
    expect(drainGraceSec({ drainSec: 120, warmBoxes: 10 })).toBe(158);
    expect(drainGraceSec({ drainSec: 120, warmBoxes: 10, flushParallelism: 1 })).toBe(270);
    // The overlay's 300 s covers the defaults with room to spare.
    expect(drainGraceSec({ drainSec: 120, warmBoxes: 10 })).toBeLessThan(300);
    expect(drainGraceSec({ drainSec: 120, warmBoxes: 40 })).toBe(270);
  });
});
