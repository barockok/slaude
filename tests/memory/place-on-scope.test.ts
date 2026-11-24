/** Memory places under `on` (rc.46): the scope, the memory scope, the gate and the registry check. */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { classifyBrainOp, type GateInput } from "../../src/knowledge/gated-dispatch";
import { AGENT_SOURCE, PUBLIC_SOURCE, SHARED_SOURCE, agentSourceId, resolveBrainScope, speakerProfileSource, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { NO_PLACE, placeSourceId, type PlaceRef } from "../../src/memory/place";
import { PLACE_UNBOUND_ERROR, __resetPlaceBindingForTests, assertPlacesBound, bindPlace, placeBound } from "../../src/memory/place-binding";
import { memoryScopeFor } from "../../src/memory/scope";

const AGENT = "AGENT1";
const A = agentSourceId(AGENT);
const place = (b: string, kind = "channel"): PlaceRef => ({ kind: "place", source: placeSourceId(AGENT, b), boundaryId: b, boundaryKind: kind });
const P1 = place("b1");
const P2 = place("b2");
const DM = place("bdm", "dm");
const src = (p: PlaceRef): string => (p.kind === "place" ? p.source : "");

const gate = (o: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", teamId: "T1", interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: AGENT, place: P1, placesOn: true, ...o,
});
const scopeOf = (o: Partial<GateInput> = {}, kb: string[] = ["kb-x"]) => resolveBrainScope({ ...gate(o), kbSources: kb });

beforeEach(async () => {
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});

describe("scope under on", () => {
  test("a trusted turn writes the place and reads place, tiers and the speaker's profile", async () => {
    const s = await scopeOf();
    const profile = speakerProfileSource("T1", "U1")!;
    expect(s.sourceId).toBe(src(P1));
    expect(s.allowedSources).toEqual([src(P1), A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-x", profile]);
    expect(s.placeAgent).toBe(AGENT);
    expect(await placeBound(AGENT, src(P1))).toBe(true);
  });

  test("a manager in a public or unknown channel writes that channel's place and reads place plus tiers", async () => {
    for (const channelTrust of ["public", "unknown"] as const) {
      const s = await scopeOf({ channelTrust, isManager: true });
      expect(s.sourceId).toBe(src(P1));
      expect(s.allowedSources.slice(0, 3)).toEqual([src(P1), A, AGENT_SOURCE]);
    }
  });

  test("a non-manager in a public channel is unchanged: public only", async () => {
    const s = await scopeOf({ channelTrust: "public" });
    expect(s).toEqual({ clientId: "U1", sourceId: PUBLIC_SOURCE, allowedSources: [PUBLIC_SOURCE, speakerProfileSource("T1", "U1")!], profileSource: speakerProfileSource("T1", "U1")! });
  });

  test("a wake or cron (no person) writes and reads the place stored with it", async () => {
    const s = await scopeOf({ userId: null, teamId: null });
    expect(s.sourceId).toBe(src(P1));
    expect(s.allowedSources).toEqual([src(P1), A, AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, "kb-x"]);
  });

  test("two boundaries of one agent never share a readable place source", async () => {
    const a = await scopeOf({ place: P1 });
    const b = await scopeOf({ place: P2 });
    const placeOnly = (s: BrainScope) => s.allowedSources.filter((x) => x === src(P1) || x === src(P2));
    expect(placeOnly(a)).toEqual([src(P1)]);
    expect(placeOnly(b)).toEqual([src(P2)]);
  });

  test("no place (placeFor said none) keeps the legacy persona-wide scope", async () => {
    const s = await scopeOf({ place: { kind: "none", reason: "lookup-failed" } });
    expect(s.sourceId).toBe(A);
    expect(s.placeAgent).toBeUndefined();
  });

  test("a place the registry binds to another source stays unknown: persona-wide", async () => {
    await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", ["mb-other", AGENT, "b1", "channel", 1]);
    const s = await scopeOf();
    expect(s.sourceId).toBe(A);
  });

  test("a /1on1 and a non-manager DM stay on the user slice and never read a place", async () => {
    const own = await scopeOf({ lockedUser: "U1", channelTrust: "public" });
    expect(own.sourceId).toBe(userSourceId("U1"));
    expect(own.allowedSources.some((x) => x === src(P1))).toBe(false);
    const other = await scopeOf({ lockedUser: "U2", channelTrust: "public" });
    expect(other.sourceId).toBe(PUBLIC_SOURCE);
  });

  test("a /1on1 a manager holds also reads that manager's DM place, once it is bound; nobody else's", async () => {
    await bindPlace(AGENT, DM as Extract<PlaceRef, { kind: "place" }>);
    const mgr = await scopeOf({ lockedUser: "U1", isManager: true, dmPlace: DM });
    expect(mgr.sourceId).toBe(userSourceId("U1"));
    expect(mgr.allowedSources.slice(0, 2)).toEqual([userSourceId("U1"), src(DM)]);
    expect(mgr.allowedSources).not.toContain(src(P1));
    const nonMgr = await scopeOf({ lockedUser: "U1", isManager: false, dmPlace: DM });
    expect(nonMgr.allowedSources).not.toContain(src(DM));
    const unbound = await scopeOf({ lockedUser: "U1", isManager: true, dmPlace: place("bother", "dm") });
    expect(unbound.allowedSources.some((x) => x.startsWith("mb-"))).toBe(false);
  });
});

describe("memoryScopeFor under on keeps the transcript in the persona slice", () => {
  test("a trusted turn", async () => {
    const s = await memoryScopeFor(gate());
    expect(s.write).toEqual({ clientId: AGENT, sourceId: A, allowedSources: [A] });
    expect(s.read).toEqual({ clientId: AGENT, sourceId: A, allowedSources: [A, AGENT_SOURCE] });
  });
});

describe("the gate under on", () => {
  const scope = (sourceId: string): BrainScope => ({ clientId: AGENT, sourceId, allowedSources: [sourceId] });
  test("a write to the turn's own place is automatic, to any other place it is denied", async () => {
    expect(await classifyBrainOp("put_page", scope(src(P1)), gate())).toBe("auto");
    expect(await classifyBrainOp("put_page", scope(src(P1)), gate({ userId: null }))).toBe("auto");
    expect(await classifyBrainOp("put_page", scope(src(P2)), gate())).toBe("deny");
    expect(await classifyBrainOp("put_page", scope(src(P1)), gate({ placesOn: false }))).toBe("deny");
  });
  test("a promotion is manager tier for a person and denied for a wake, however the scope reads", async () => {
    const w = { slugs: ["x"], exists: async () => false, promote: true };
    expect(await classifyBrainOp("put_page", scope(A), gate(), w)).toBe("manager");
    expect(await classifyBrainOp("put_page", scope(A), gate({ userId: null }), w)).toBe("deny");
  });
  test("with the mode not on, a plain write is classified as before", async () => {
    expect(await classifyBrainOp("put_page", scope(A), gate({ placesOn: false, place: NO_PLACE }))).toBe("auto");
  });
});

describe("the registry check", () => {
  test("a scope naming a place source not bound to its agent is refused; an unbound place or a missing agent too", async () => {
    const s: BrainScope = { clientId: AGENT, sourceId: src(P1), allowedSources: [src(P1)], placeAgent: AGENT };
    await expect(assertPlacesBound(s)).rejects.toThrow(PLACE_UNBOUND_ERROR);
    await bindPlace(AGENT, P1 as Extract<PlaceRef, { kind: "place" }>);
    await expect(assertPlacesBound(s)).resolves.toBeUndefined();
    await expect(assertPlacesBound({ ...s, placeAgent: "AGENT2" })).rejects.toThrow(PLACE_UNBOUND_ERROR);
    const { placeAgent: _p, ...bare } = s;
    await expect(assertPlacesBound(bare)).rejects.toThrow(PLACE_UNBOUND_ERROR);
  });
  test("a scope with no place source needs no read", async () => {
    await expect(assertPlacesBound({ clientId: "x", sourceId: A, allowedSources: [A, SHARED_SOURCE] })).resolves.toBeUndefined();
  });
});

describe("off, shadow and a persona outside the canary", () => {
  const cases: Array<[string, Partial<GateInput>]> = [
    ["trusted", {}], ["manager in a public channel", { channelTrust: "public", isManager: true }], ["public non-manager", { channelTrust: "public" }],
    ["own lock", { lockedUser: "U1" }], ["someone else's lock", { lockedUser: "U2" }], ["wake", { userId: null }],
  ];
  for (const [name, o] of cases) {
    test(`with no place bound the scope is rc.45's, byte for byte: ${name}`, async () => {
      const off = await scopeOf({ ...o, placesOn: false });
      const none = await scopeOf({ ...o, placesOn: false, place: NO_PLACE });
      const absent = await resolveBrainScope({ ...gate(o), placesOn: undefined, kbSources: ["kb-x"] });
      expect(JSON.stringify(off)).toBe(JSON.stringify(none));
      expect(JSON.stringify(absent)).toBe(JSON.stringify(none));
    });
    test(`memoryScopeFor is unchanged: ${name}`, async () => {
      for (const channel of ["C1", "D1"]) {
        expect(await memoryScopeFor(gate({ ...o, placesOn: false }), { channel })).toEqual(await memoryScopeFor(gate({ ...o, placesOn: false, place: NO_PLACE }), { channel }));
      }
    });
  }

  test("a place bound while the flag was on is read, never written, where it was written (rollback)", async () => {
    await scopeOf(); // on: binds P1
    const off = await scopeOf({ placesOn: false });
    expect(off.sourceId).toBe(A);
    expect(off.allowedSources.slice(0, 3)).toEqual([src(P1), A, AGENT_SOURCE]);
    // another place of the same agent stays invisible
    const other = await scopeOf({ placesOn: false, place: P2 });
    expect(other.allowedSources).not.toContain(src(P1));
    expect(other.allowedSources).not.toContain(src(P2));
    // a non-manager public turn never reads it
    expect((await scopeOf({ placesOn: false, channelTrust: "public" })).allowedSources).not.toContain(src(P1));
  });
});
