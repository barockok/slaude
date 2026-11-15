/**
 * The person-slices shadow seam (slice F, task 5). Legacy stays authoritative:
 * with the flag unset or off nothing runs; under shadow the union is computed
 * and compared in the background, counted, and logged redacted. It never
 * throws into a caller.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as Domain from "../../src/db/domain";
import * as PersonSlices from "../../src/knowledge/person-slices";
import { metrics } from "../../src/metrics";
import { MAX_INFLIGHT, __resetSliceDecide, decidePersonSlices, outcomeOf, settlePersonSliceShadows } from "../../src/slices/decide";
import { SLICE_SITES } from "../../src/slices/sites";
import { TEAM, TEAM2, newUser, resetWorld, slack, cleanWorld } from "../helpers/person-world";

function counter(name: string, labels: Record<string, string>): number {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return metrics
    .render()
    .split("\n")
    .filter((l) => (l.startsWith(name + "{") || l.startsWith(name + " ")) && want.every((w) => l.includes(w)))
    .reduce((sum, l) => sum + Number(l.split(" ").pop()), 0);
}
const outcome = (site: string, o: string) => counter("slaude_person_slices_shadow_total", { site, outcome: o });
let warn: ReturnType<typeof spyOn>;
const SITE = "brain.gate_speaker" as const;

beforeEach(async () => {
  await resetWorld();
  __resetSliceDecide();
  delete process.env.SLAUDE_PERSON_SLICES;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SLAUDE_PERSON_SLICES;
  warn.mockRestore();
});

describe("off", () => {
  for (const v of [undefined, "off", "OFF", "garbage", ""]) {
    test(`SLAUDE_PERSON_SLICES=${JSON.stringify(v)} runs no resolver and counts nothing`, async () => {
      if (v !== undefined) process.env.SLAUDE_PERSON_SLICES = v;
      const spy = spyOn(PersonSlices, "personSlicesDetailed");
      const find = spyOn(Domain, "findBinding");
      const before = counter("slaude_person_slices_shadow_total", {});
      try {
        expect(await decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0EXAMPLE" })).toBeUndefined();
        await settlePersonSliceShadows();
        expect(spy).not.toHaveBeenCalled();
        expect(find).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        find.mockRestore();
      }
      expect(counter("slaude_person_slices_shadow_total", {})).toBe(before);
    });
  }
});

describe("shadow", () => {
  beforeEach(() => {
    process.env.SLAUDE_PERSON_SLICES = "shadow";
  });

  test("outcomes: match, would_widen, no_user, error", async () => {
    const solo = await newUser();
    await slack(solo, "U0AEXAMPLE");
    const two = await newUser();
    await slack(two, "U0BEXAMPLE");
    await slack(two, "U1BEXAMPLE");
    const m0 = outcome(SITE, "match");
    const w0 = outcome(SITE, "would_widen");
    const n0 = outcome(SITE, "no_user");
    decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0AEXAMPLE" });
    decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0BEXAMPLE" });
    decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0NOBODY" });
    decidePersonSlices({ site: SITE, teamId: null, slackUserId: "U0AEXAMPLE" });
    await settlePersonSliceShadows();
    expect(outcome(SITE, "match") - m0).toBe(1);
    expect(outcome(SITE, "would_widen") - w0).toBe(1);
    expect(outcome(SITE, "no_user") - n0).toBe(2);
  });

  test("a disagreement is logged once per site and reason per minute with counts only, no id or name", async () => {
    const u = await newUser();
    await slack(u, "U0SECRETEXAMPLE");
    await slack(u, "U1SECRETEXAMPLE");
    for (let i = 0; i < 3; i++) decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0SECRETEXAMPLE" });
    await settlePersonSliceShadows();
    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    const mine = lines.filter((l: string) => l.includes("[slices]"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain("would_widen");
    expect(mine[0]).toContain("verified-second-id");
    for (const l of lines) {
      expect(l.toLowerCase()).not.toContain("secret");
      expect(l).not.toContain("user-");
      expect(l).not.toContain(TEAM);
    }
  });

  test("would_narrow (an own slice missing from the result) is counted and logged", async () => {
    const spy = spyOn(PersonSlices, "personSlicesDetailed").mockResolvedValue({
      slices: { own: "user-a", reads: ["user-b"], via: "union", dropped: { conflict: 0, tombstoned: 0 } },
      status: "ok",
      ms: 1,
    });
    const n0 = outcome(SITE, "would_narrow");
    try {
      decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0EXAMPLE" });
      await settlePersonSliceShadows();
    } finally {
      spy.mockRestore();
    }
    expect(outcome(SITE, "would_narrow") - n0).toBe(1);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("would_narrow"))).toBe(true);
  });

  test("a throwing resolver never throws into the caller; it counts error and a failure", async () => {
    const u = await newUser();
    await slack(u, "U0EXAMPLE");
    await slack(u, "U1EXAMPLE");
    const bad = spyOn(Domain, "bindingsOf").mockRejectedValue(new Error("boom"));
    const e0 = outcome(SITE, "error");
    const f0 = counter("slaude_person_slices_failures_total", {});
    try {
      await expect(decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0EXAMPLE" })).resolves.toBeUndefined();
      await settlePersonSliceShadows();
    } finally {
      bad.mockRestore();
    }
    expect(outcome(SITE, "error") - e0).toBe(1);
    expect(counter("slaude_person_slices_failures_total", {}) - f0).toBe(1);
  });

  test("even a resolver that throws synchronously, or a metrics failure, stays inside the seam", async () => {
    const spy = spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(() => {
      throw new Error("sync boom");
    });
    try {
      await expect(decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0EXAMPLE" })).resolves.toBeUndefined();
      await settlePersonSliceShadows();
    } finally {
      spy.mockRestore();
    }
  });

  test("the caller does not wait: the call returns before a slow resolver finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(async () => {
      await gate;
      return { slices: PersonSlices.legacyPersonSlices("U0EXAMPLE"), status: "ok", ms: 1 };
    });
    try {
      const t0 = Date.now();
      decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0EXAMPLE" });
      expect(Date.now() - t0).toBeLessThan(50);
      release();
      await settlePersonSliceShadows();
    } finally {
      spy.mockRestore();
    }
  });

  test("at most MAX_INFLIGHT shadows run; the rest count dropped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyOn(PersonSlices, "personSlicesDetailed").mockImplementation(async () => {
      await gate;
      return { slices: PersonSlices.legacyPersonSlices("U0EXAMPLE"), status: "ok", ms: 1 };
    });
    const d0 = outcome(SITE, "dropped");
    try {
      for (let i = 0; i < MAX_INFLIGHT + 5; i++) decidePersonSlices({ site: SITE, teamId: TEAM, slackUserId: "U0EXAMPLE" });
      expect(outcome(SITE, "dropped") - d0).toBe(5);
      release();
      await settlePersonSliceShadows();
    } finally {
      spy.mockRestore();
    }
  });

  test("the resolver time histogram is observed", async () => {
    decidePersonSlices({ site: SITE, teamId: TEAM2, slackUserId: "U0EXAMPLE" });
    await settlePersonSliceShadows();
    expect(metrics.render()).toContain("slaude_person_slices_ms_count");
  });
});

describe("outcomeOf and the registry", () => {
  test("the outcome table", () => {
    const base = { slices: { own: "user-a", reads: ["user-a"], via: "legacy" as const, dropped: { conflict: 0, tombstoned: 0 } }, status: "ok" as const, ms: 0 };
    expect(outcomeOf(base)).toBe("match");
    expect(outcomeOf({ ...base, slices: { ...base.slices, reads: ["user-a", "user-b"] } })).toBe("would_widen");
    expect(outcomeOf({ ...base, slices: { ...base.slices, reads: ["user-b"] } })).toBe("would_narrow");
    expect(outcomeOf({ ...base, status: "no_user" })).toBe("no_user");
    expect(outcomeOf({ ...base, status: "error" })).toBe("error");
  });

  test("site ids are unique and well formed", () => {
    const ids = SLICE_SITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });
});

afterAll(async () => {
  await cleanWorld();
});
