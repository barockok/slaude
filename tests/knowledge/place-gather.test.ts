/** gather under memory places (rc.47): the place first, ties by locality, the source kind on every hit; other scopes unchanged. */
import { describe, expect, test } from "bun:test";
import { gather, sourceKindOf, type GatherHit } from "../../src/knowledge/gather";
import type { BrainScope } from "../../src/knowledge/scope";
import { placeSourceId } from "../../src/memory/place";

const AGENT = "AGENT1";
const PL = placeSourceId(AGENT, "b1");
const hit = (slug: string, score: number, extra: Partial<GatherHit> = {}): GatherHit => ({ slug, score, ...extra });

function brain(per: Record<string, GatherHit[]>) {
  const order: string[] = [];
  const call = async (_n: string, _p: Record<string, unknown>, scope: BrainScope) => {
    order.push(scope.sourceId);
    return per[scope.sourceId] ?? [];
  };
  return { call, order };
}
const all = ["agent-agent1", "agent", "shared", "public", "kb-wiki", "user-u1", "profile-t1-u1"];

describe("sourceKindOf", () => {
  test("place, person, persona, shared, public, library", () => {
    expect(sourceKindOf(PL)).toBe("place");
    expect(sourceKindOf("user-u1")).toBe("person");
    expect(sourceKindOf("profile-t1-u1")).toBe("person");
    expect(sourceKindOf("agent-agent1")).toBe("persona");
    expect(sourceKindOf("agent")).toBe("persona");
    expect(sourceKindOf("shared")).toBe("shared");
    expect(sourceKindOf("public")).toBe("public");
    expect(sourceKindOf("kb-wiki")).toBe("library");
  });
});

describe("gather in a scope that writes a place", () => {
  const scope: BrainScope = { clientId: AGENT, sourceId: PL, allowedSources: [...all.slice(0, 1), PL, ...all.slice(1)], placeAgent: AGENT };
  test("searches the place first and breaks equal scores by locality", async () => {
    const b = brain({
      [PL]: [hit("p/local", 0.5)],
      "agent-agent1": [hit("p/persona", 0.5)],
      shared: [hit("p/shared", 0.5)],
      public: [hit("p/public", 0.5)],
      "kb-wiki": [hit("p/lib", 0.5)],
      "user-u1": [hit("p/person", 0.5)],
    });
    const hits = await gather("q", scope, { call: b.call });
    expect(b.order[0]).toBe(PL);
    expect(hits.map((h) => h.slug)).toEqual(["p/local", "p/person", "p/persona", "p/shared", "p/public", "p/lib"]);
    expect(hits.map((h) => h.source_kind)).toEqual(["place", "person", "persona", "shared", "public", "library"]);
    expect(hits.map((h) => h.source_id)).toEqual([PL, "user-u1", "agent-agent1", "shared", "public", "kb-wiki"]);
  });
  test("a higher score still wins over locality", async () => {
    const hits = await gather("q", scope, { call: brain({ [PL]: [hit("a", 0.2)], "kb-wiki": [hit("b", 0.9)] }).call });
    expect(hits.map((h) => h.slug)).toEqual(["b", "a"]);
  });
  test("a promoted copy and its origin dedup by slug, and the local page wins a tie", async () => {
    const hits = await gather("q", scope, { call: brain({ [PL]: [hit("same", 0.5, { note: "local" })], "agent-agent1": [hit("same", 0.5, { note: "copy" })] }).call });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ note: "local", source_kind: "place" });
  });
  test("elsewhere the copy is the only hit and says it is persona-wide", async () => {
    const hits = await gather("q", { ...scope, sourceId: placeSourceId(AGENT, "b2"), allowedSources: [placeSourceId(AGENT, "b2"), "agent-agent1"] }, { call: brain({ "agent-agent1": [hit("same", 0.5)] }).call });
    expect(hits.map((h) => h.source_kind)).toEqual(["persona"]);
  });
});

describe("gather in any other scope is unchanged", () => {
  // the persona slice writes (mode off or shadow, even when a place is bound and read)
  const scope: BrainScope = { clientId: AGENT, sourceId: "agent-agent1", allowedSources: [PL, "agent-agent1", "shared"], placeAgent: AGENT };
  test("source order, merge order and hits as before: no source_kind, no added fields", async () => {
    const b = brain({ [PL]: [hit("x", 0.5)], "agent-agent1": [hit("y", 0.5)], shared: [hit("z", 0.5)] });
    const hits = await gather("q", scope, { call: b.call });
    expect(hits).toEqual([hit("x", 0.5), hit("y", 0.5), hit("z", 0.5)]);
    for (const h of hits) expect("source_kind" in h).toBe(false);
  });
  test("a tie keeps the first source's hit, not the more local one", async () => {
    const hits = await gather("q", { ...scope, allowedSources: ["shared", PL] }, { call: brain({ shared: [hit("s", 0.5, { n: 1 })], [PL]: [hit("s", 0.5, { n: 2 })] }).call });
    expect(hits[0]).toMatchObject({ n: 1 });
  });
});
