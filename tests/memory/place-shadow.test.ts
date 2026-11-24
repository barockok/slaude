import { beforeEach, describe, expect, test } from "bun:test";
import { metrics } from "../../src/metrics";
import { agentSourceId, userSourceId, SHARED_SOURCE, PUBLIC_SOURCE } from "../../src/knowledge/scope";
import { NO_PLACE, placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceShadowForTests, measureWrite, placeDecision, WRITE_SURFACES } from "../../src/memory/place-shadow";

const AGENT = "agent1";
const PLACE: PlaceRef = { kind: "place", source: placeSourceId(AGENT, "b1"), boundaryId: "b1", boundaryKind: "channel" };
const NONE = (reason: "no-boundary" | "no-team" | "lookup-failed" | "unknown-surface" | "node-no-db"): PlaceRef => ({ kind: "none", reason });

const series = (name: string) => metrics.render().split("\n").filter((l) => l.startsWith(name + "{"));
/** `labels` are `k="v"` pairs in any order (the registry sorts them). */
const count = (name: string, labels: string): number => {
  const want = labels.split(",");
  const l = series(name).find((x) => want.every((w) => x.includes(w)));
  return l ? Number(l.split(" ").pop()) : 0;
};

describe("placeDecision", () => {
  test("a write that lands in the agent's own slice today moves to the place when there is one", () => {
    expect(placeDecision({ place: PLACE, todaySource: agentSourceId(AGENT), agentId: AGENT })).toBe("would-write-place");
  });
  test("with no place the same write would be a none (counted and, in a later release, sent to the legacy tier)", () => {
    expect(placeDecision({ place: NONE("no-boundary"), todaySource: agentSourceId(AGENT), agentId: AGENT })).toBe("would-write-none");
    expect(placeDecision({ place: NO_PLACE, todaySource: agentSourceId(AGENT), agentId: AGENT })).toBe("would-write-none");
  });
  test("a person's slice, shared, public and a profile are not the place's business", () => {
    for (const todaySource of [userSourceId("U1"), SHARED_SOURCE, PUBLIC_SOURCE, "profile-t1-u1"]) {
      expect(placeDecision({ place: PLACE, todaySource, agentId: AGENT })).toBe("same-as-today");
      expect(placeDecision({ place: NONE("no-team"), todaySource, agentId: AGENT })).toBe("same-as-today");
    }
  });
  test("another persona's slice is not this agent's own slice", () => {
    expect(placeDecision({ place: PLACE, todaySource: agentSourceId("other"), agentId: AGENT })).toBe("same-as-today");
  });
});

describe("measureWrite", () => {
  beforeEach(() => __resetPlaceShadowForTests());

  test("counts the decision by surface", () => {
    const before = count("slaude_memory_place_total", 'surface="memory_save",decision="would-write-place"');
    measureWrite({ surface: "memory_save", place: PLACE, todaySource: agentSourceId(AGENT), agentId: AGENT });
    expect(count("slaude_memory_place_total", 'surface="memory_save",decision="would-write-place"')).toBe(before + 1);
  });

  test("an unknown place also moves the unknown counter by reason, and logs once per reason", () => {
    const logs: string[] = [];
    const before = count("slaude_memory_place_unknown_total", 'reason="lookup-failed"');
    for (let i = 0; i < 3; i++) measureWrite({ surface: "turn_sync", place: NONE("lookup-failed"), todaySource: agentSourceId(AGENT), agentId: AGENT, log: (l) => logs.push(l) });
    measureWrite({ surface: "turn_sync", place: NONE("no-team"), todaySource: agentSourceId(AGENT), agentId: AGENT, log: (l) => logs.push(l) });
    expect(count("slaude_memory_place_unknown_total", 'reason="lookup-failed"')).toBe(before + 3);
    expect(logs.length).toBe(2);
    expect(logs.join("\n")).not.toMatch(/C0|U0|agent1/);
  });

  test("a write that is the same as today does not touch the unknown counter", () => {
    const before = series("slaude_memory_place_unknown_total").length;
    measureWrite({ surface: "checklist", place: NONE("no-boundary"), todaySource: userSourceId("U1"), agentId: AGENT });
    expect(series("slaude_memory_place_unknown_total").length).toBe(before);
  });

  test("the flag off counts nothing", () => {
    process.env.SLAUDE_MEMORY_BOUNDARIES = "off";
    try {
      const before = count("slaude_memory_place_total", 'surface="commitment"');
      measureWrite({ surface: "commitment", place: PLACE, todaySource: agentSourceId(AGENT), agentId: AGENT });
      expect(count("slaude_memory_place_total", 'surface="commitment"')).toBe(before);
    } finally {
      delete process.env.SLAUDE_MEMORY_BOUNDARIES;
    }
  });

  test("never throws, whatever it is given", () => {
    expect(() => measureWrite({ surface: "memory_save", place: undefined as unknown as PlaceRef, todaySource: undefined as unknown as string, agentId: AGENT, log: () => { throw new Error("x"); } })).not.toThrow();
  });

  test("surface labels are a fixed set", () => {
    expect([...WRITE_SURFACES]).toEqual(["memory_save", "turn_sync", "checklist", "commitment"]);
  });
});
