import { describe, expect, test } from "bun:test";
import {
  parseAudience, audienceVisible, setPageAudience, pageAudience, hiddenSlugs, hasHiddenPages,
} from "../src/knowledge/audience";
import { gather } from "../src/knowledge/gather";
import { brainHandlers, type BrainToolDeps } from "../src/knowledge/mcp-tools";
import type { AudienceGrant, BrainScope } from "../src/knowledge/scope";

describe("parseAudience", () => {
  test("no frontmatter / no key → null (team default)", () => {
    expect(parseAudience("# just a page")).toEqual({ audience: null });
    expect(parseAudience("---\ntype: note\n---\nbody")).toEqual({ audience: null });
  });
  test("valid tiers, case-insensitive, quotes stripped", () => {
    expect(parseAudience("---\naudience: manager\n---\nx").audience).toBe("manager");
    expect(parseAudience("---\naudience: PRIVATE\n---\nx").audience).toBe("private");
    expect(parseAudience('---\naudience: "public"\n---\nx').audience).toBe("public");
    expect(parseAudience("---\ntype: note\naudience: team\n---\nx").audience).toBe("team");
  });
  test("user:<id> keeps the id verbatim", () => {
    expect(parseAudience("---\naudience: user:UEXAMPLE42\n---\nx").audience).toBe("user:UEXAMPLE42");
  });
  test("invalid value → error, no audience", () => {
    const r = parseAudience("---\naudience: everyone\n---\nx");
    expect(r.audience).toBeNull();
    expect(r.error).toContain("everyone");
  });
  test("audience key outside frontmatter is ignored", () => {
    expect(parseAudience("body\naudience: manager")).toEqual({ audience: null });
  });
});

describe("audienceVisible", () => {
  const g = (level: AudienceGrant["level"], userId: string | null = "U1"): AudienceGrant => ({ level, userId });
  test('"all" sees everything, including private', () => {
    for (const a of [null, "private", "manager", "team", "public", "user:U9"]) {
      expect(audienceVisible(a, g("all", null))).toBe(true);
    }
  });
  test("manager level: manager/team/public yes, private no", () => {
    expect(audienceVisible("manager", g("manager"))).toBe(true);
    expect(audienceVisible("team", g("manager"))).toBe(true);
    expect(audienceVisible(null, g("manager"))).toBe(true);
    expect(audienceVisible("public", g("manager"))).toBe(true);
    expect(audienceVisible("private", g("manager"))).toBe(false);
  });
  test("team level: team(default)/public yes, manager/private no", () => {
    expect(audienceVisible(null, g("team"))).toBe(true);
    expect(audienceVisible("team", g("team"))).toBe(true);
    expect(audienceVisible("public", g("team"))).toBe(true);
    expect(audienceVisible("manager", g("team"))).toBe(false);
    expect(audienceVisible("private", g("team"))).toBe(false);
  });
  test("public level: only public (unlabeled=team is hidden)", () => {
    expect(audienceVisible("public", g("public"))).toBe(true);
    expect(audienceVisible(null, g("public"))).toBe(false);
    expect(audienceVisible("team", g("public"))).toBe(false);
  });
  test("user:<id> visible only to that speaker (case-insensitive), at any level", () => {
    expect(audienceVisible("user:U1", g("public", "U1"))).toBe(true);
    expect(audienceVisible("user:u1", g("team", "U1"))).toBe(true);
    expect(audienceVisible("user:U1", g("manager", "U2"))).toBe(false);
    expect(audienceVisible("user:U1", g("team", null))).toBe(false);
  });
});

describe("audience index store", () => {
  test("set / read / clear round-trip", () => {
    setPageAudience("src-store", "p/one", "manager");
    expect(pageAudience("src-store", "p/one")).toBe("manager");
    setPageAudience("src-store", "p/one", "public");
    expect(pageAudience("src-store", "p/one")).toBe("public");
    setPageAudience("src-store", "p/one", null);
    expect(pageAudience("src-store", "p/one")).toBeNull();
  });
  test("hiddenSlugs: explicit entries the grant can't see", () => {
    setPageAudience("src-hid", "a", "private");
    setPageAudience("src-hid", "b", "team");
    setPageAudience("src-hid", "c", "user:U9");
    const hidden = hiddenSlugs(["src-hid"], { level: "team", userId: "U1" });
    expect(hidden).toEqual(new Set(["a", "c"]));
    expect(hiddenSlugs(["src-hid"], { level: "all", userId: null }).size).toBe(0);
  });
  test("hasHiddenPages: explicit rows at team/manager, always true at public", () => {
    expect(hasHiddenPages(["src-empty"], { level: "team", userId: "U1" })).toBe(false);
    expect(hasHiddenPages(["src-empty"], { level: "public", userId: "U1" })).toBe(true);
    setPageAudience("src-has", "x", "private");
    expect(hasHiddenPages(["src-has"], { level: "team", userId: "U1" })).toBe(true);
    expect(hasHiddenPages(["src-has"], { level: "all", userId: null })).toBe(false);
  });
});

const AGENT_SLICE = "agent-agent1"; // agentSourceId("AGENT1") — matches deps gate below
const tieredScope = (level: AudienceGrant["level"], userId: string | null): BrainScope => ({
  clientId: "U1",
  sourceId: AGENT_SLICE,
  allowedSources: [AGENT_SLICE, "shared"],
  audience: { level, userId },
  audienceSources: [AGENT_SLICE],
});

describe("gather audience filter", () => {
  const call = async (_n: string, _p: Record<string, unknown>, s: BrainScope) =>
    s.allowedSources[0] === AGENT_SLICE
      ? [{ slug: "notes/secret", rerank_score: 0.9 }, { slug: "notes/open", rerank_score: 0.8 }, { rerank_score: 0.7 }]
      : [{ slug: "shared/page", rerank_score: 0.5 }];
  const audienceOf = (_src: string, slug: string) => (slug === "notes/secret" ? "manager" : null);

  test("filters tiered-source hits per page; slugless hits drop; other sources untouched", async () => {
    const hits = await gather("q", tieredScope("team", "U1"), { call, audienceOf });
    expect(hits.map((h) => h.slug)).toEqual(["notes/open", "shared/page"]);
  });
  test('grant "all" filters nothing (slugless hit survives too)', async () => {
    const hits = await gather("q", tieredScope("all", null), { call, audienceOf });
    expect(hits.length).toBe(4);
  });
  test("public level hides unlabeled (team-default) pages", async () => {
    const hits = await gather("q", tieredScope("public", "U1"), { call, audienceOf });
    expect(hits.map((h) => h.slug)).toEqual(["shared/page"]);
  });
});

const deps = (scope: BrainScope, over: Partial<BrainToolDeps> = {}): BrainToolDeps => ({
  scope: () => scope,
  gate: () => ({ userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "AGENT1" }),
  managers: () => ["UMGR"],
  requestApproval: async () => ({ approved: true, by: "UMGR" }),
  call: async (name) => ({ echoed: name }),
  ...over,
});

describe("kb_memoize audience write-through", () => {
  test("valid audience frontmatter lands in the index on an own-slice write", async () => {
    const d = deps(tieredScope("team", "U1"));
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/mgr", content: "---\naudience: manager\n---\nx", summary: "s" },
      { slug: "notes/plain", content: "no frontmatter", summary: "s" },
    ] }, d);
    expect(r.isError).toBeUndefined();
    expect(pageAudience(AGENT_SLICE, "notes/mgr")).toBe("manager");
    expect(pageAudience(AGENT_SLICE, "notes/plain")).toBeNull();
  });
  test("re-memoize without the key clears the tier back to team default", async () => {
    const d = deps(tieredScope("team", "U1"));
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/mgr2", content: "---\naudience: private\n---\nx", summary: "s" }] }, d);
    expect(pageAudience(AGENT_SLICE, "notes/mgr2")).toBe("private");
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/mgr2", content: "plain now", summary: "s" }] }, d);
    expect(pageAudience(AGENT_SLICE, "notes/mgr2")).toBeNull();
  });
  test("invalid audience rejects the whole batch before any write", async () => {
    const calls: string[] = [];
    const d = deps(tieredScope("team", "U1"), { call: async (name) => { calls.push(name); return {}; } });
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "ok/page", content: "fine", summary: "s" },
      { slug: "bad/page", content: "---\naudience: everybody\n---\nx", summary: "s" },
    ] }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("bad/page");
    expect(calls).toEqual([]);
  });
  test("audience on a non-own-slice target is ignored with a note, not indexed", async () => {
    const shared: BrainScope = { clientId: "U1", sourceId: "shared", allowedSources: ["shared"] };
    const d = deps(shared);
    const r = await brainHandlers.kb_memoize({
      pages: [{ slug: "team/page", content: "---\naudience: manager\n---\nx", summary: "s" }],
      target: "shared",
    }, d);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text).audience_note).toContain("ignored");
    expect(pageAudience("shared", "team/page")).toBeNull();
  });
});

describe("read-path audience enforcement", () => {
  test("kb_get_page denies a hidden page (keyed on result source_id)", async () => {
    setPageAudience(AGENT_SLICE, "notes/hidden", "manager");
    const d = deps(tieredScope("team", "U1"), {
      call: async () => ({ slug: "notes/hidden", source_id: AGENT_SLICE, compiled_truth: "secret" }),
    });
    const r = await brainHandlers.kb_get_page({ slug: "notes/hidden" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain("secret");
  });
  test("kb_get_page allows the same page under a manager grant, and shared pages always", async () => {
    const mgr = deps(tieredScope("manager", "UMGR"), {
      call: async () => ({ slug: "notes/hidden", source_id: AGENT_SLICE, compiled_truth: "secret" }),
    });
    expect((await brainHandlers.kb_get_page({ slug: "notes/hidden" }, mgr)).isError).toBeUndefined();
    const shared = deps(tieredScope("team", "U1"), {
      call: async () => ({ slug: "notes/hidden", source_id: "shared", compiled_truth: "fine" }),
    });
    expect((await brainHandlers.kb_get_page({ slug: "notes/hidden" }, shared)).isError).toBeUndefined();
  });
  test("kb_get_page without source_id fails closed on an explicit hidden entry", async () => {
    setPageAudience(AGENT_SLICE, "notes/nosrc", "private");
    const d = deps(tieredScope("team", "U1"), { call: async () => ({ slug: "notes/nosrc" }) });
    expect((await brainHandlers.kb_get_page({ slug: "notes/nosrc" }, d)).isError).toBe(true);
  });
  test("kb_list_pages filters explicitly hidden slugs at team level", async () => {
    setPageAudience(AGENT_SLICE, "notes/listed-hidden", "manager");
    const d = deps(tieredScope("team", "U1"), {
      call: async () => [{ slug: "notes/listed-hidden" }, { slug: "notes/visible" }],
    });
    const r = await brainHandlers.kb_list_pages({}, d);
    expect(JSON.parse(r.content[0]!.text)).toEqual([{ slug: "notes/visible" }]);
  });
  test("kb_list_pages at public level strips the tiered sources from the call scope", async () => {
    let seen: string[] = [];
    const d = deps(tieredScope("public", "U1"), {
      call: async (_n, _p, s) => { seen = s.allowedSources; return []; },
    });
    await brainHandlers.kb_list_pages({}, d);
    expect(seen).toEqual(["shared"]);
  });
  test("kb_graph denies a hidden slug and strips sources at public level", async () => {
    setPageAudience(AGENT_SLICE, "notes/graph-hidden", "private");
    const d = deps(tieredScope("team", "U1"));
    expect((await brainHandlers.kb_graph({ slug: "notes/graph-hidden" }, d)).isError).toBe(true);
    let seen: string[][] = [];
    const pub = deps(tieredScope("public", "U1"), {
      call: async (_n, _p, s) => { seen.push(s.allowedSources); return []; },
    });
    await brainHandlers.kb_graph({ slug: "shared/ok" }, pub);
    expect(seen).toEqual([["shared"], ["shared"]]);
  });
  test("kb_think strips tiered sources from synthesis when the grant hides pages", async () => {
    setPageAudience(AGENT_SLICE, "notes/think-hidden", "private");
    let thinkSources: string[] = [];
    const d = deps(tieredScope("team", "U1"), {
      think: async (_q, s) => { thinkSources = s.allowedSources; return { answer: "a", citations: [], pagesGathered: 1 }; },
      call: async () => [],
    });
    await brainHandlers.kb_think({ question: "q" }, d);
    expect(thinkSources).toEqual(["shared"]);
  });
  test("kb_think keeps full scope when nothing is hidden at this level", async () => {
    let thinkSources: string[] = [];
    const clean: BrainScope = {
      clientId: "U1", sourceId: "agent-clean", allowedSources: ["agent-clean", "shared"],
      audience: { level: "team", userId: "U1" }, audienceSources: ["agent-clean"],
    };
    const d = deps(clean, {
      think: async (_q, s) => { thinkSources = s.allowedSources; return { answer: "a", citations: [], pagesGathered: 1 }; },
      call: async () => [],
    });
    await brainHandlers.kb_think({ question: "q" }, d);
    expect(thinkSources).toEqual(["agent-clean", "shared"]);
  });
});
