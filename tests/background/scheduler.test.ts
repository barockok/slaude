import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { claimSlot } from "../../src/db/background-slots";
import { runningLoops, stopRunningLoops } from "../../src/gateway/core/running-loops";
import { setAgentId, resetAgentId } from "../../src/knowledge/agent-identity";
import { __resetPersonaRegistry, setPersonaRegistry, type PersonaRegistry } from "../../src/persona/registry";
import type { PassName } from "../../src/background/budget";
import {
  createBackgroundScheduler,
  defaultAgentGroups,
  defaultSchedulerDeps,
  leaderElect,
  dueSlots,
  isoWeekSlot,
  previousDay,
  startBackgroundScheduler,
  TICK_MS,
  type AgentGroup,
  type SchedulerDeps,
  type SlotRun,
} from "../../src/background/scheduler";

const NY = "America/New_York";

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM background_slots");
  await db.run("DELETE FROM background_runs");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  debugSpy.mockRestore();
  stopRunningLoops();
});

const daily = (at: string, tz: string, last = {}) =>
  dueSlots(new Date(at), tz, last).filter((d) => d.pass === "nightly-review" || d.pass === "lessons-upkeep");

describe("dueSlots", () => {
  test("nightly review then lessons upkeep fall due at 02:30 persona-local, not UTC", () => {
    // 2026-10-26 is a Monday; New York is UTC-4 until 1 November.
    expect(daily("2026-10-26T06:29:00Z", NY, { "nightly-review": "2026-10-25", "lessons-upkeep": "2026-10-25" })).toEqual([]);
    expect(daily("2026-10-26T06:30:00Z", NY, { "nightly-review": "2026-10-25", "lessons-upkeep": "2026-10-25" })).toEqual([
      { pass: "nightly-review", slot: "2026-10-26" },
      { pass: "lessons-upkeep", slot: "2026-10-26" },
    ]);
    // 02:30 UTC is 22:30 the evening before in New York: that day's slot already ran.
    const done = { "nightly-review": "2026-10-25", "lessons-upkeep": "2026-10-25" };
    expect(daily("2026-10-26T02:30:00Z", NY, done)).toEqual([]);
    expect(daily("2026-10-26T02:30:00Z", "UTC", done)).toEqual([
      { pass: "nightly-review", slot: "2026-10-26" },
      { pass: "lessons-upkeep", slot: "2026-10-26" },
    ]);
  });

  test("a slot already taken is not due again; a missed one is due later the same period", () => {
    const at = new Date("2026-10-26T20:00:00Z");
    const taken = { "nightly-review": "2026-10-26", "lessons-upkeep": "2026-10-26", digest: "2026-W44" };
    expect(dueSlots(at, NY, taken)).toEqual([]);
    expect(dueSlots(at, NY, { ...taken, "lessons-upkeep": "2026-10-25" })).toEqual([{ pass: "lessons-upkeep", slot: "2026-10-26" }]);
  });

  test("skill review Sunday 04:00 and digest Monday 09:00, slotted by ISO week", () => {
    const daily = { "nightly-review": "x", "lessons-upkeep": "x" };
    const passes = (at: string, last = {}) => dueSlots(new Date(at), NY, { ...daily, ...last }).filter((d) => d.pass === "skill-review" || d.pass === "digest");
    // Monday 26 Oct, 08:59 / 09:00 New York (EDT).
    expect(passes("2026-10-26T12:59:00Z")).toEqual([]);
    expect(passes("2026-10-26T13:00:00Z")).toEqual([{ pass: "digest", slot: "2026-W44" }]);
    // Missed on Monday: still due on Saturday of the same week.
    expect(passes("2026-10-31T13:00:00Z")).toEqual([{ pass: "digest", slot: "2026-W44" }]);
    // Sunday 1 Nov 03:59 / 04:00 New York (EST from 02:00 that day).
    expect(passes("2026-11-01T08:59:00Z", { digest: "2026-W44" })).toEqual([]);
    expect(passes("2026-11-01T09:00:00Z", { digest: "2026-W44" })).toEqual([{ pass: "skill-review", slot: "2026-W44" }]);
  });

  test("ISO weeks and calendar days across year ends", () => {
    expect(isoWeekSlot("2026-10-26")).toBe("2026-W44");
    expect(isoWeekSlot("2027-01-01")).toBe("2026-W53");
    expect(isoWeekSlot("2027-01-04")).toBe("2027-W01");
    expect(isoWeekSlot("2025-12-29")).toBe("2026-W01");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
  });
});

describe("claimSlot", () => {
  test("the second claim of one slot returns false", async () => {
    expect(await claimSlot("UAG", "nightly-review", "2026-10-26")).toBe(true);
    expect(await claimSlot("UAG", "nightly-review", "2026-10-26")).toBe(false);
    // Another agent, pass or slot is its own claim.
    expect(await claimSlot("UAG2", "nightly-review", "2026-10-26")).toBe(true);
    expect(await claimSlot("UAG", "lessons-upkeep", "2026-10-26")).toBe(true);
    expect(await claimSlot("UAG", "nightly-review", "2026-10-27")).toBe(true);
  });
});

const AGENT: AgentGroup = { agentId: "UAGENT1", personaId: "default", personaIds: ["default"], timeZone: "UTC" };

function deps(over: Partial<SchedulerDeps> & { at?: string } = {}): SchedulerDeps & { ran: Array<{ pass: PassName; slot: string }>; swept: number } {
  const ran: Array<{ pass: PassName; slot: string }> = [];
  const record = async (r: SlotRun) => void ran.push({ pass: r.pass, slot: r.slot });
  const d = {
    now: () => new Date(over.at ?? "2026-10-26T02:30:00Z"),
    brainReady: () => true,
    agents: async () => [AGENT],
    handlers: { "nightly-review": record, "lessons-upkeep": record },
    ran,
    swept: 0,
    ...over,
  };
  d.sweep = over.sweep ?? (async () => void d.swept++);
  return d as never;
}

describe("scheduler tick", () => {
  test("two schedulers on one database run a slot once", async () => {
    const shared = deps();
    const a = createBackgroundScheduler(shared);
    const b = createBackgroundScheduler(shared);
    await Promise.all([a.tick(), b.tick()]);
    await a.tick();
    expect(shared.ran).toEqual([
      { pass: "nightly-review", slot: "2026-10-26" },
      { pass: "lessons-upkeep", slot: "2026-10-26" },
    ]);
  });

  test("a leader dying mid-pass does not get its slot re-run by the next leader", async () => {
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    const first = deps({ handlers: { "nightly-review": () => hung } });
    const a = createBackgroundScheduler(first);
    const ticking = a.tick(); // claims the nightly slot, then never finishes
    await new Promise((r) => setTimeout(r, 10));
    const next = deps();
    await createBackgroundScheduler(next).tick();
    // The nightly is not re-run; the upkeep slot nobody took runs.
    expect(next.ran).toEqual([{ pass: "lessons-upkeep", slot: "2026-10-26" }]);
    release();
    await ticking;
  });

  test("a slot that throws records an error run and the tick goes on", async () => {
    const d = deps({
      handlers: {
        "nightly-review": async () => {
          throw new Error("brain went away");
        },
        "lessons-upkeep": async (r) => void d.ran.push({ pass: r.pass, slot: r.slot }),
      },
    });
    await createBackgroundScheduler(d).tick();
    expect(d.ran).toEqual([{ pass: "lessons-upkeep", slot: "2026-10-26" }]);
    const rows = await Runs.listBetween("UAGENT1", "2026-10-26", "2026-10-26");
    expect(rows.map((r) => [r.pass, r.outcome])).toEqual([["nightly-review", "error"]]);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("brain went away");
  });

  test("every tick sweeps stale skill checks; with the brain closed nothing else runs", async () => {
    const d = deps({ brainReady: () => false });
    const s = createBackgroundScheduler(d);
    await s.tick();
    await s.tick();
    expect(d.swept).toBe(2);
    expect(d.ran).toEqual([]);
    expect(debugSpy).toHaveBeenCalled();
    // The slot was never claimed: it runs once the brain is open.
    await createBackgroundScheduler({ ...d, brainReady: () => true }).tick();
    expect(d.ran.map((r) => r.pass)).toEqual(["nightly-review", "lessons-upkeep"]);
  });

  test("a pass with no handler is never claimed, so a later handler still gets this period's slot", async () => {
    const at = "2026-10-26T13:00:00Z"; // Monday 13:00 UTC: digest due
    const d = deps({ at });
    await createBackgroundScheduler(d).tick();
    expect(d.ran.map((r) => r.pass)).toEqual(["nightly-review", "lessons-upkeep"]);
    const digest: string[] = [];
    await createBackgroundScheduler(deps({ at, handlers: { digest: async (r) => void digest.push(r.slot) } })).tick();
    expect(digest).toEqual(["2026-W44"]);
  });

  test("an agent list or sweep failure is logged and the tick survives", async () => {
    const d = deps({
      sweep: async () => {
        throw new Error("sweep failed");
      },
      agents: async () => {
        throw new Error("no registry");
      },
    });
    await createBackgroundScheduler(d).tick();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(lines).toContain("sweep failed");
    expect(lines).toContain("no registry");
  });

  test("an aborted tick starts no further slot", async () => {
    const ac = new AbortController();
    const d = deps({
      handlers: {
        "nightly-review": async () => ac.abort(),
        "lessons-upkeep": async (r) => void d.ran.push({ pass: r.pass, slot: r.slot }),
      },
    });
    await createBackgroundScheduler(d).tick(ac.signal);
    expect(d.ran).toEqual([]);
  });
});

const untilAborted = (signal: AbortSignal) =>
  signal.aborted ? Promise.resolve() : new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));

describe("startBackgroundScheduler", () => {
  test("mono: ticks every TICK_MS until stopped, registered as a running loop", async () => {
    const sleeps: number[] = [];
    let ticks = 0;
    const d = deps({
      sweep: async () => void ticks++,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (ticks >= 3) await untilAborted(signal);
      },
    });
    const h = startBackgroundScheduler(d);
    expect(runningLoops()).toBeGreaterThan(0);
    while (ticks < 3) await new Promise((r) => setTimeout(r, 1));
    await h.stop();
    expect(ticks).toBe(3);
    expect(sleeps.every((ms) => ms === TICK_MS)).toBe(true);
    expect(runningLoops()).toBe(0);
  });

  test("gateway: runs only while elected, and stops when leadership ends", async () => {
    let ticks = 0;
    let term: AbortController | null = null;
    let running: Promise<void> = Promise.resolve();
    const elect = (fn: (signal: AbortSignal) => Promise<void>) => {
      term = new AbortController();
      running = fn(term.signal);
      return {
        async stop() {
          term?.abort();
          await running;
        },
      };
    };
    const d = deps({
      sweep: async () => void ticks++,
      sleep: (_ms, signal) => untilAborted(signal),
    });
    const h = startBackgroundScheduler(d, { elect });
    while (ticks < 1) await new Promise((r) => setTimeout(r, 1));
    // Losing the lock aborts the term: the loop ends.
    term!.abort();
    await running;
    expect(ticks).toBe(1);
    await h.stop();
  });
});

describe("startBackgroundScheduler defaults", () => {
  test("the default sleep is a timer that stop() cuts short", async () => {
    let ticks = 0;
    const h = startBackgroundScheduler(deps({ sweep: async () => void ticks++ }));
    while (ticks < 1) await new Promise((r) => setTimeout(r, 1));
    const t0 = Date.now();
    await h.stop();
    await h.stop(); // idempotent
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ticks).toBe(1);
  });

  test("leaderElect: the loop runs once this replica holds the background lock", async () => {
    const keys: string[] = [];
    const redis = {
      set: async (key: string) => (keys.push(key), "OK"),
      eval: async () => 1,
    };
    let ticks = 0;
    const h = startBackgroundScheduler(deps({ sweep: async () => void ticks++ }), { elect: leaderElect(redis as never) });
    while (ticks < 1) await new Promise((r) => setTimeout(r, 1));
    await h.stop();
    expect(keys[0]).toContain("background");
  });

  test("defaultSchedulerDeps wires the nightly review and lessons upkeep", () => {
    const d = defaultSchedulerDeps();
    expect(Object.keys(d.handlers).sort()).toEqual(["lessons-upkeep", "nightly-review"]);
    expect(d.now()).toBeInstanceOf(Date);
    expect(typeof d.brainReady()).toBe("boolean");
  });
});

describe("defaultAgentGroups", () => {
  test("named personas group by agent id: one without its own Slack user shares the process agent", async () => {
    setAgentId("UPROC1");
    const personas = [
      { name: "beta", slackUserId: "UBETA1" },
      { name: "alpha", slackUserId: "" },
    ];
    const reg = {
      list: () => personas,
      lookupByName: (n: string) => personas.find((p) => p.name === n) ?? null,
      lookupByUserId: () => null,
      isMultiPersonaMode: () => true,
      isManaged: () => false,
      tombstonedPersonaFor: () => null,
    } as unknown as PersonaRegistry;
    setPersonaRegistry(reg);
    try {
      expect(await defaultAgentGroups()).toEqual([
        { agentId: "UPROC1", personaId: "default", personaIds: ["default", "alpha"], timeZone: "UTC" },
        { agentId: "UBETA1", personaId: "beta", personaIds: ["beta"], timeZone: "UTC" },
      ]);
    } finally {
      __resetPersonaRegistry();
      resetAgentId();
    }
  });

  test("a persona that cannot be resolved is left out", async () => {
    setAgentId("UPROC1");
    const reg = {
      list: () => [{ name: "gone", slackUserId: "UGONE1" }],
      lookupByName: () => null,
      lookupByUserId: () => null,
      isMultiPersonaMode: () => true,
      isManaged: () => true,
      tombstonedPersonaFor: () => null,
    } as unknown as PersonaRegistry;
    setPersonaRegistry(reg);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await defaultAgentGroups()).map((g) => g.agentId)).toEqual(["UPROC1"]);
      expect(String(warn.mock.calls[0]?.[0])).toContain("persona=gone");
    } finally {
      warn.mockRestore();
      __resetPersonaRegistry();
      resetAgentId();
    }
  });

  test("without named personas: one group, the process agent, in the default persona's timezone", async () => {
    setAgentId("UPROC1");
    try {
      expect(await defaultAgentGroups()).toEqual([{ agentId: "UPROC1", personaId: "default", personaIds: ["default"], timeZone: "UTC" }]);
    } finally {
      resetAgentId();
    }
  });
});
