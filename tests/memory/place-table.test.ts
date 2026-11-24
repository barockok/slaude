/**
 * One row per kind of turn or surface in the places design (spec section 1, "Defaults per turn").
 * Each row runs the REAL scope code for today's write source, the REAL resolver (with fake reads)
 * for the place, and the shadow decision. Adding a kind to PLACE_TURN_KINDS without a row here
 * fails (and so does the compiler, in designDefaultWrite).
 */
import { describe, expect, test } from "bun:test";
import { classifyBrainOp, type GateInput } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { createPlaceResolver, placeSourceId, type PlaceDeps, type PlaceRef } from "../../src/memory/place";
import { placeDecision, type WriteDecision } from "../../src/memory/place-shadow";
import { designDefaultWrite, PLACE_TURN_KINDS, type PlaceTurnKind } from "../../src/memory/place-surface";
import { memoryScopeFor } from "../../src/memory/scope";

const AGENT = "agent1";
const TEAM = "T1";
const gate = (o: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", teamId: TEAM, interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, place: { kind: "none", reason: "no-boundary" }, agentId: AGENT, ...o,
});
const deps = (o: Partial<PlaceDeps> = {}): PlaceDeps => ({
  role: () => "mono", timeoutMs: () => 50, sessionBoundary: async () => null, jobBoundary: async () => null,
  channelBoundary: async () => "b-chan", channelLookupFailed: () => false, kindOf: async () => "channel", ...o,
});

interface Row {
  gate: GateInput;
  channel: string;
  deps: PlaceDeps;
  input?: { sessionId?: string; cronJobId?: string; teamId?: string | null; channel?: string | null };
  place: PlaceRef | { kind: "none"; reason: string };
  /** Today's source for the per-turn transcript and for a default memory_save. */
  todaySource: string;
  decision: WriteDecision;
  /** A durable memory_save (put_page) on today's scope: its gate tier. */
  durableTier?: "auto" | "deny";
}

const place = (boundaryId: string, boundaryKind: string): PlaceRef => ({ kind: "place", source: placeSourceId(AGENT, boundaryId), boundaryId, boundaryKind });

const ROWS: Record<PlaceTurnKind, Row> = {
  "slack-channel": {
    gate: gate(), channel: "C1", deps: deps(), place: place("b-chan", "channel"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "auto",
  },
  "dm-manager": {
    gate: gate({ isManager: true }), channel: "D1", deps: deps({ channelBoundary: async () => "b-dm", kindOf: async () => "dm" }), place: place("b-dm", "dm"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "auto",
  },
  "dm-other": {
    gate: gate({ channelTrust: "public" }), channel: "D1", deps: deps({ channelBoundary: async () => "b-dm", kindOf: async () => "dm" }), place: place("b-dm", "dm"), todaySource: userSourceId("U1"), decision: "same-as-today",
  },
  "one-on-one": {
    gate: gate({ lockedUser: "U1" }), channel: "C1", deps: deps(), place: place("b-chan", "channel"), todaySource: userSourceId("U1"), decision: "same-as-today", durableTier: "auto",
  },
  "public-channel-other": {
    // Durable saves are denied (the write target is `public`); the transcript is the one write, and it goes to the place.
    gate: gate({ channelTrust: "public" }), channel: "C1", deps: deps(), place: place("b-chan", "channel"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "deny",
  },
  "public-channel-manager": {
    gate: gate({ channelTrust: "public", isManager: true }), channel: "C1", deps: deps(), place: place("b-chan", "channel"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "auto",
  },
  "wake-with-place": {
    // A wake has no user; its session row (or the job row) carries the boundary.
    gate: gate({ userId: null, interactive: false }), channel: "C1", deps: deps({ sessionBoundary: async () => "b-wake" }), input: { sessionId: "s1" }, place: place("b-wake", "channel"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "auto",
  },
  "job-no-place": {
    // A console-made job: no channel, no team, no boundary on its row.
    gate: gate({ userId: null, interactive: false, teamId: null }), channel: "", deps: deps(), input: { teamId: null, channel: null, cronJobId: "j1" }, place: { kind: "none", reason: "no-team" }, todaySource: agentSourceId(AGENT), decision: "would-write-none", durableTier: "auto",
  },
  "nightly-pass": {
    // One run per place from the registry: the place is given, there is no turn to resolve; it writes nothing today but the persona's slice.
    gate: gate({ userId: null, interactive: false }), channel: "C1", deps: deps({ jobBoundary: async () => "b-night" }), input: { cronJobId: "j2" }, place: place("b-night", "channel"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "auto",
  },
  "voice-in-thread": {
    // Voice uses the thread's session, so its place is the thread's boundary.
    gate: gate(), channel: "C1", deps: deps({ sessionBoundary: async () => "b-thread" }), input: { sessionId: "voice-thread-session" }, place: place("b-thread", "channel"), todaySource: agentSourceId(AGENT), decision: "would-write-place", durableTier: "auto",
  },
};

describe("the table has exactly one row per turn kind", () => {
  test("every kind has a row and every row is a kind", () => {
    expect(Object.keys(ROWS).sort()).toEqual([...PLACE_TURN_KINDS].sort());
  });
  test("the design default is defined for every kind", () => {
    for (const k of PLACE_TURN_KINDS) expect(designDefaultWrite(k)).toBeDefined();
  });
});

describe("each row: place, today's write source, the shadow decision", () => {
  for (const kind of PLACE_TURN_KINDS) {
    const row = ROWS[kind];
    test(kind, async () => {
      const resolve = createPlaceResolver(row.deps);
      const input = { agentId: AGENT, teamId: TEAM, channel: row.channel || null, ...row.input };
      const got = await resolve(input);
      expect(got).toEqual(row.place as PlaceRef);

      // Today's source for the transcript sync (memoryScopeFor) and its decision.
      const scope = await memoryScopeFor({ ...row.gate, place: got }, { channel: row.channel });
      expect(scope.write?.sourceId).toBe(row.todaySource);
      expect(placeDecision({ place: got, todaySource: scope.write!.sourceId, agentId: AGENT })).toBe(row.decision);

      // The design says where the default write goes; the decision must agree with it.
      const design = designDefaultWrite(kind);
      if (design === "person") expect(row.decision).toBe("same-as-today");
      if (design === "none") expect(row.decision).toBe("would-write-none");
      if (design === "place" || design === "place-transcript-only") expect(row.decision).toBe("would-write-place");

      // A durable save in this turn: its tier on today's KB scope.
      if (row.durableTier) {
        const kb = await resolveBrainScope({ ...row.gate, place: got, kbSources: [] });
        expect(await classifyBrainOp("put_page", kb, { ...row.gate, place: got })).toBe(row.durableTier);
      }
    });
  }
});
