/**
 * The property of memory places, through the real tools (rc.46): two boundaries of one agent never
 * share a readable place source, so a turn in channel A cannot read what channel B saved through
 * memory_search, memory_get, memory_list or memory_think, and a wake in B finds nothing from A.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { gather } from "../../src/knowledge/gather";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { resetStandingGrants, turnBrainScope, type GateInput } from "../../src/knowledge/gated-dispatch";
import { resolveBrainScope, type BrainScope } from "../../src/knowledge/scope";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests, assertPlacesBound, bindPlace } from "../../src/memory/place-binding";
import { hasPlacePrefix } from "../../src/memory/place-id";
import { fakeBrain } from "./fake-brain";

const AGENT = "AGENT1";
const ref = (b: string, kind = "channel"): Extract<PlaceRef, { kind: "place" }> => ({ kind: "place", source: placeSourceId(AGENT, b), boundaryId: b, boundaryKind: kind });
const A = ref("chan-a");
const B = ref("chan-b");
const DM = ref("dm-mgr", "dm");

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(async () => {
  resetStandingGrants();
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});

/** One brain shared by every turn; search finds pages whose text holds the query's words, in the sources the call may read. */
function world() {
  const brain = fakeBrain();
  const call: NonNullable<BrainToolDeps["call"]> = async (name, params, scope) => {
    await assertPlacesBound(scope); // what brainCall does before the engine
    if (name === "search") {
      const q = String(params.query).toLowerCase();
      return [...brain.contents.entries()]
        .map(([k, v]) => ({ source: k.split("\0")[0]!, slug: k.split("\0")[1]!, text: v }))
        .filter((p) => scope.allowedSources.includes(p.source) && p.text.toLowerCase().includes(q))
        .map((p) => ({ slug: p.slug, source_id: p.source, score: 1 }));
    }
    return brain.call(name, params, scope);
  };
  const turn = (place: PlaceRef, over: Partial<GateInput> = {}) => {
    const g: GateInput = {
      userId: "U0ALICE", teamId: "T0TEAM", interactive: true, origin: "slack", lockedUser: null, channelTrust: "trusted", isManager: false,
      place, placesOn: true, agentId: AGENT, threadKey: "C0CHAN:1.1", turnSenders: [{ userId: "U0ALICE", teamId: "T0TEAM", origin: "slack" }], ...over,
    };
    const deps: BrainToolDeps = {
      scope: async () => turnBrainScope(g, ["kb-x"]),
      gate: () => g,
      managers: () => ["U0MGR"],
      requestApproval: async () => ({ approved: true, by: "U0MGR" }),
      call,
      think: async (q, scope) => {
        const hits = await gather(q, scope as BrainScope, { call });
        return { answer: hits.length ? "found" : "nothing", citations: hits.map((h) => ({ page_slug: h.slug })), pagesGathered: hits.length };
      },
    };
    return deps;
  };
  return { brain, turn };
}
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("a page saved in channel A", () => {
  test("is found in A and invisible in B through search, get, list and think", async () => {
    const w = world();
    const a = w.turn(A);
    const b = w.turn(B);
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/zebra", content: "the zebra plan", summary: "s" }] }, a);

    expect(text(await brainHandlers.kb_search({ query: "zebra" }, a))).toContain("notes/zebra");
    expect(text(await brainHandlers.kb_get_page({ slug: "notes/zebra" }, a))).toContain("zebra plan");
    expect(text(await brainHandlers.kb_list_pages({}, a))).toContain("notes/zebra");
    expect(text(await brainHandlers.kb_think({ question: "zebra" }, a))).toContain("notes/zebra");

    expect(text(await brainHandlers.kb_search({ query: "zebra" }, b))).not.toContain("zebra");
    expect(text(await brainHandlers.kb_get_page({ slug: "notes/zebra" }, b))).toBe("null");
    expect(text(await brainHandlers.kb_list_pages({}, b))).not.toContain("zebra");
    const thought = text(await brainHandlers.kb_think({ question: "zebra" }, b));
    expect(thought).not.toContain("notes/zebra");
    expect(thought).toContain("nothing");
  });

  test("a wake in B finds nothing from A, and a wake in A finds it", async () => {
    const w = world();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/zebra", content: "the zebra plan", summary: "s" }] }, w.turn(A));
    const wake = (p: PlaceRef) => w.turn(p, { userId: null, teamId: null, interactive: false, turnSenders: undefined, origin: "cron" });
    expect(text(await brainHandlers.kb_search({ query: "zebra" }, wake(B)))).not.toContain("zebra");
    expect(text(await brainHandlers.kb_search({ query: "zebra" }, wake(A)))).toContain("notes/zebra");
  });

  test("a wake's own save lands in its place only", async () => {
    const w = world();
    const wake = w.turn(B, { userId: null, teamId: null, interactive: false, turnSenders: undefined, origin: "cron" });
    expect((await brainHandlers.kb_memoize({ pages: [{ slug: "notes/b-only", content: "kiwi", summary: "s" }] }, wake)).isError).toBeUndefined();
    expect(text(await brainHandlers.kb_search({ query: "kiwi" }, w.turn(A)))).not.toContain("kiwi");
    expect(text(await brainHandlers.kb_search({ query: "kiwi" }, w.turn(B)))).toContain("notes/b-only");
  });

  test("a promoted copy is the one thing that crosses, and only after the manager approves", async () => {
    const w = world();
    const a = w.turn(A);
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/lesson", content: "always rinse the cup", summary: "s" }], target: "persona" }, a);
    expect(text(await brainHandlers.kb_search({ query: "rinse" }, w.turn(B)))).toContain("notes/lesson");
  });

  test("with the mode off a place bound while on is still read where it was written, and nowhere else", async () => {
    const w = world();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/zebra", content: "the zebra plan", summary: "s" }] }, w.turn(A));
    const offA = w.turn(A, { placesOn: false });
    const offB = w.turn(B, { placesOn: false });
    expect(text(await brainHandlers.kb_search({ query: "zebra" }, offA))).toContain("notes/zebra");
    expect(text(await brainHandlers.kb_search({ query: "zebra" }, offB))).not.toContain("zebra");
    // a save while off lands persona-wide, as before, and is readable in both
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/off-save", content: "walrus", summary: "s" }] }, offA);
    expect(text(await brainHandlers.kb_search({ query: "walrus" }, offB))).toContain("notes/off-save");
    // and on again: the place page is still there, the persona-wide one too
    expect(text(await brainHandlers.kb_search({ query: "zebra" }, w.turn(A)))).toContain("notes/zebra");
    expect(text(await brainHandlers.kb_search({ query: "walrus" }, w.turn(A)))).toContain("notes/off-save");
  });

  test("a manager's DM place is read in that manager's /1on1 and in no channel", async () => {
    const w = world();
    await bindPlace(AGENT, DM);
    const mgrDm = w.turn(DM, { userId: "U0MGR", isManager: true, channelTrust: "unknown", turnSenders: [{ userId: "U0MGR", teamId: "T0TEAM", origin: "slack" }] });
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/dm-secret", content: "quince", summary: "s" }] }, mgrDm);
    const oneOnOne = w.turn(A, { userId: "U0MGR", isManager: true, lockedUser: "U0MGR", dmPlace: DM, channelTrust: "public", turnSenders: [{ userId: "U0MGR", teamId: "T0TEAM", origin: "slack" }] });
    expect(text(await brainHandlers.kb_search({ query: "quince" }, oneOnOne))).toContain("notes/dm-secret");
    const other = w.turn(A, { userId: "U0BOB", lockedUser: "U0BOB", dmPlace: DM, channelTrust: "public", turnSenders: [{ userId: "U0BOB", teamId: "T0TEAM", origin: "slack" }] });
    expect(text(await brainHandlers.kb_search({ query: "quince" }, other))).not.toContain("quince");
    expect(text(await brainHandlers.kb_search({ query: "quince" }, w.turn(A, { isManager: true })))).not.toContain("quince");
  });
});

describe("the property over every kind of turn", () => {
  const kinds: Array<[string, Partial<GateInput>]> = [
    ["trusted", {}], ["manager, public channel", { channelTrust: "public", isManager: true }], ["manager, unknown channel", { channelTrust: "unknown", isManager: true }],
    ["public", { channelTrust: "public" }], ["wake", { userId: null }], ["own /1on1", { lockedUser: "U0ALICE" }], ["other's /1on1", { lockedUser: "U0BOB" }],
    ["manager /1on1", { isManager: true, lockedUser: "U0ALICE", dmPlace: DM }],
  ];
  for (const [name, o] of kinds) {
    for (const on of [true, false]) {
      test(`${name}, places ${on ? "on" : "off"}: at most the turn's own place is readable, and never the other channel's`, async () => {
        await bindPlace(AGENT, A);
        await bindPlace(AGENT, B);
        await bindPlace(AGENT, DM);
        const base: GateInput = { userId: "U0ALICE", teamId: "T0TEAM", interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: AGENT, place: A, placesOn: on, ...o };
        const sa = await resolveBrainScope({ ...base, place: A, kbSources: [] });
        const sb = await resolveBrainScope({ ...base, place: B, kbSources: [] });
        const placesA = [sa.sourceId, ...sa.allowedSources].filter(hasPlacePrefix);
        const placesB = [sb.sourceId, ...sb.allowedSources].filter(hasPlacePrefix);
        expect(placesA.every((p) => p !== B.source)).toBe(true);
        expect(placesB.every((p) => p !== A.source)).toBe(true);
        expect(new Set(placesA).size).toBeLessThanOrEqual(1);
        expect(new Set(placesB).size).toBeLessThanOrEqual(1);
      });
    }
  }
});
