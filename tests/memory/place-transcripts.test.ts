/** Transcripts under `on` (rc.47): the conversation page lives in the turn's place and history is read place then persona slice. */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { AGENT_SOURCE, PUBLIC_SOURCE, agentSourceId, userSourceId } from "../../src/knowledge/scope";
import { BrainMemoryProvider, conversationSlug, readTimeline } from "../../src/memory/brain-provider";
import { NO_PLACE, placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";
import { memoryScopeFor } from "../../src/memory/scope";
import { fakeBrain } from "../background/fake-brain";

const AGENT = "AGENT1";
const A = agentSourceId(AGENT);
const place = (b: string, kind = "channel"): PlaceRef => ({ kind: "place", source: placeSourceId(AGENT, b), boundaryId: b, boundaryKind: kind });
const P1 = place("b1");
const P1S = placeSourceId(AGENT, "b1");

const gate = (o: Partial<GateInput> = {}): GateInput => ({
  userId: "U1", teamId: "T1", interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: AGENT, place: P1, placesOn: true, ...o,
});

beforeEach(async () => {
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});

describe("memoryScopeFor under on", () => {
  test("a trusted turn writes the transcript to its place and reads place, then the persona slice", async () => {
    const s = await memoryScopeFor(gate());
    expect(s.write).toEqual({ clientId: AGENT, sourceId: P1S, allowedSources: [P1S], placeAgent: AGENT });
    expect(s.read).toEqual({ clientId: AGENT, sourceId: P1S, allowedSources: [P1S, A, AGENT_SOURCE], placeAgent: AGENT });
  });
  test("a manager in a public channel and a wake write the place too", async () => {
    expect((await memoryScopeFor(gate({ channelTrust: "public", isManager: true }), { channel: "C1" })).write?.sourceId).toBe(P1S);
    expect((await memoryScopeFor(gate({ userId: null, teamId: null }))).write?.sourceId).toBe(P1S);
  });
  test("a non-manager in a public or unknown channel has the transcript written to that channel's place, not agent-<id>", async () => {
    for (const channelTrust of ["public", "unknown"] as const) {
      const s = await memoryScopeFor(gate({ channelTrust }), { channel: "C1" });
      expect(s.write?.sourceId).toBe(P1S);
      expect(s.read?.allowedSources).toEqual([P1S, A]);
      expect(s.read?.allowedSources).not.toContain(PUBLIC_SOURCE);
    }
  });
  test("a non-manager DM stays on the user slice, a /1on1 stays on the user slice, someone else's lock gets nothing", async () => {
    const dm = await memoryScopeFor(gate({ channelTrust: "public" }), { channel: "D1" });
    expect(dm.write?.sourceId).toBe(userSourceId("U1"));
    const own = await memoryScopeFor(gate({ lockedUser: "U1" }), { channel: "C1" });
    expect(own.write?.sourceId).toBe(userSourceId("U1"));
    expect(await memoryScopeFor(gate({ lockedUser: "U2" }), { channel: "C1" })).toEqual({ read: null, write: null });
  });
  test("no place keeps the persona slice", async () => {
    const s = await memoryScopeFor(gate({ place: { kind: "none", reason: "lookup-failed" } }), { channel: "C1" });
    expect(s.write?.sourceId).toBe(A);
    const pub = await memoryScopeFor(gate({ place: NO_PLACE, channelTrust: "public" }), { channel: "C1" });
    expect(pub.write).toEqual({ clientId: AGENT, sourceId: A, allowedSources: [A] });
  });
  test("a place the registry cannot bind leaves a public non-manager turn on the persona slice", async () => {
    await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", ["mb-other", AGENT, "b1", "channel", 1]);
    const s = await memoryScopeFor(gate({ channelTrust: "public" }), { channel: "C1" });
    expect(s.write?.sourceId).toBe(A);
  });
});

describe("memoryScopeFor with the mode not on is rc.46's, place or no place", () => {
  const cases: Array<[string, Partial<GateInput>, string]> = [
    ["trusted", {}, "C1"], ["manager in a public channel", { channelTrust: "public", isManager: true }, "C1"], ["public non-manager", { channelTrust: "public" }, "C1"],
    ["public non-manager DM", { channelTrust: "public" }, "D1"], ["wake", { userId: null }, "C1"],
  ];
  for (const [name, o, channel] of cases) {
    test(name, async () => {
      const off = await memoryScopeFor(gate({ ...o, placesOn: false }), { channel });
      const bare = await memoryScopeFor(gate({ ...o, placesOn: false, place: NO_PLACE }), { channel });
      expect(off).toEqual(bare);
      expect(JSON.stringify(off)).not.toContain("mb-");
    });
  }
});

describe("history is read place first, then the persona slice", () => {
  const SESSION = "Sess-1";
  const slug = conversationSlug(SESSION);
  const row = (id: number, text: string) => ({ id, date: "2026-11-24", summary: text, detail: `<user>${text}</user>\n<assistant>ok</assistant>` });

  test("a session that began before the switch keeps its history, older turns first", async () => {
    const b = fakeBrain();
    b.seedTimeline(A, slug, [row(1, "before one"), row(2, "before two")]);
    b.seedTimeline(P1S, slug, [row(1, "after one")]);
    const read = (await memoryScopeFor(gate())).read!;
    const rows = await readTimeline(b.call, slug, read);
    expect(rows?.map((r) => r.summary)).toEqual(["before one", "before two", "after one"]);
    expect(rows?.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(b.calls.every((c) => c.scope.allowedSources.length === 1)).toBe(true);
  });
  test("a place-only session is one read and no legacy rows", async () => {
    const b = fakeBrain();
    b.seedTimeline(P1S, slug, [row(1, "only")]);
    const rows = await readTimeline(b.call, slug, (await memoryScopeFor(gate())).read!);
    expect(rows?.map((r) => r.summary)).toEqual(["only"]);
  });
  test("a scope that is not a place is one call with the whole scope, as before", async () => {
    const b = fakeBrain();
    b.seedTimeline(A, slug, [row(1, "x")]);
    const scope = { clientId: AGENT, sourceId: A, allowedSources: [A, AGENT_SOURCE] };
    await readTimeline(b.call, slug, scope);
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]!.scope).toEqual(scope);
  });
  test("prefetch shows the merged recent turns and a sync lands in the place", async () => {
    const b = fakeBrain();
    b.seedTimeline(A, slug, [row(1, "legacy turn")]);
    const p = new BrainMemoryProvider({ call: b.call, ready: async () => {} });
    const s = await memoryScopeFor(gate());
    await p.syncTurnIn({ sessionId: SESSION, user: "new turn", assistant: "a" }, s.write!);
    const out = await p.prefetchIn(SESSION, s.read!);
    expect(out).toContain("legacy turn");
    expect(out).toContain("new turn");
    expect(b.timelines.get(P1S)?.get(slug)).toHaveLength(1);
    expect(b.timelines.get(A)?.get(slug)).toHaveLength(1);
  });
});
