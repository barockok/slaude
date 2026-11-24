/** memory_about with place sources (rc.47): under `on` a note about the person in the turn's place is listed; otherwise unchanged. */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { resetStandingGrants, type GateInput } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, resolveBrainScope } from "../../src/knowledge/scope";
import { composePage } from "../../src/knowledge/memory-pages";
import { fakeBrain } from "../memory/fake-brain";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";

const TEAM = "T0TEAM";
const AGENT = "AGENT1";
const PS = placeSourceId(AGENT, "b1");
const OTHER = placeSourceId(AGENT, "b2");
const P1: PlaceRef = { kind: "place", source: PS, boundaryId: "b1", boundaryKind: "channel" };

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(async () => {
  resetStandingGrants();
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});

const page = (body: string) => {
  const c = composePage({ slug: "x", content: body, type: "person-note" }, new Date("2026-10-21T12:00:00Z"));
  if ("error" in c) throw new Error(c.error);
  return c.content;
};
const put = (b: ReturnType<typeof fakeBrain>, source: string, slug: string, content: string) => b.call("put_page", { slug, content }, { clientId: "seed", sourceId: source, allowedSources: [source] });

async function run(placesOn: boolean) {
  const b = fakeBrain();
  const reads: string[] = [];
  await put(b, PS, "people/u0alice", page("In this channel Alice owns the release."));
  await put(b, OTHER, "people/u0alice", page("In another channel Alice is on leave."));
  await put(b, agentSourceId(AGENT), "people/u0alice", page("Prefers a diff."));
  const g: GateInput = { userId: "U0ALICE", teamId: TEAM, interactive: true, origin: "slack", lockedUser: null, channelTrust: "trusted", isManager: false, place: P1, placesOn, agentId: AGENT, threadKey: "C0CHAN:1.1", turnSenders: [{ userId: "U0ALICE", teamId: TEAM, origin: "slack" }] };
  const scope = await resolveBrainScope({ ...g, kbSources: [] });
  const deps: BrainToolDeps = { scope: () => scope, gate: () => g, managers: () => [], requestApproval: async () => ({ approved: true, by: "M" }), call: async (n, p, sc) => (reads.push(sc.sourceId), b.call(n, p, sc)) };
  const r = await brainHandlers.memory_about({ userId: "U0ALICE" }, deps);
  return { text: r.content[0]!.text, touched: new Set(reads) };
}

describe("memory_about", () => {
  test("under on it lists the person's note in this place, labelled, and never another place's", async () => {
    const r = await run(true);
    expect(r.text).toContain("In this channel Alice owns the release.");
    expect(r.text).toContain("this place's notes");
    expect(r.text).toContain("Prefers a diff.");
    expect(r.text).not.toContain("on leave");
    expect(r.touched.has(OTHER)).toBe(false);
  });
  test("with the mode not on the place source is not listed, as in rc.46", async () => {
    // a place bound while on is in the read set (rollback), but memory_about does not list it
    await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", [PS, AGENT, "b1", "channel", 1]);
    const off = await run(false);
    expect(off.text).not.toContain("owns the release");
    expect(off.text).toContain("Prefers a diff.");
    expect(off.touched.has(PS)).toBe(false);
  });
});
