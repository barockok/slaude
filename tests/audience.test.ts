import { describe, expect, test } from "bun:test";
import {
  parseAudience, audienceVisible, audienceTags, reconcileAudienceTags,
  pageAudienceFromTags, buildAudienceFilter, type BrainCallFn,
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
  test("user:<id> normalizes the id uppercase (tags are exact-match)", () => {
    expect(parseAudience("---\naudience: user:uexample42\n---\nx").audience).toBe("user:UEXAMPLE42");
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
  test("bare user marker (user: with no id) is visible to nobody but 'all'", () => {
    expect(audienceVisible("user:", g("manager", "U1"))).toBe(false);
    expect(audienceVisible("user:", g("all", null))).toBe(true);
  });
});

describe("audienceTags", () => {
  test("simple tiers map to one tag; user tiers add the marker", () => {
    expect(audienceTags("manager")).toEqual(["audience:manager"]);
    expect(audienceTags("user:u1")).toEqual(["audience:user", "audience:user:U1"]);
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

/** Mock brain: per-source tag→slugs table + per-slug tags, records mutations. */
const mockBrain = (data: {
  tagged?: Record<string, Record<string, string[]>>; // source → tag → slugs
  pageTags?: Record<string, string[]>; // slug → tags (get_tags)
}) => {
  const ops: Array<{ name: string; params: Record<string, unknown>; sourceId: string }> = [];
  const call: BrainCallFn = async (name, params, scope) => {
    ops.push({ name, params, sourceId: scope.sourceId });
    if (name === "list_pages") {
      const slugs = data.tagged?.[scope.sourceId]?.[params.tag as string] ?? [];
      return slugs.map((s) => ({ slug: s }));
    }
    if (name === "get_tags") return data.pageTags?.[params.slug as string] ?? [];
    return { ok: 1 };
  };
  return { call, ops };
};

describe("reconcileAudienceTags", () => {
  test("removes stale audience tags and adds the new tier (demote fails closed)", async () => {
    const { call, ops } = mockBrain({ pageTags: { "notes/x": ["audience:public", "other-tag"] } });
    await reconcileAudienceTags(call, tieredScope("all", null), "notes/x", "manager");
    const muts = ops.filter((o) => o.name !== "get_tags").map((o) => [o.name, o.params.tag]);
    expect(muts).toEqual([["remove_tag", "audience:public"], ["add_tag", "audience:manager"]]);
  });
  test("clearing (audience null) removes all audience tags, keeps other tags", async () => {
    const { call, ops } = mockBrain({ pageTags: { "notes/x": ["audience:user", "audience:user:U9", "keep-me"] } });
    await reconcileAudienceTags(call, tieredScope("all", null), "notes/x", null);
    const removed = ops.filter((o) => o.name === "remove_tag").map((o) => o.params.tag);
    expect(removed.sort()).toEqual(["audience:user", "audience:user:U9"]);
    expect(ops.some((o) => o.name === "add_tag")).toBe(false);
  });
  test("already-correct tags are a no-op", async () => {
    const { call, ops } = mockBrain({ pageTags: { "notes/x": ["audience:private"] } });
    await reconcileAudienceTags(call, tieredScope("all", null), "notes/x", "private");
    expect(ops.filter((o) => o.name !== "get_tags")).toEqual([]);
  });
});

describe("pageAudienceFromTags", () => {
  const scope = tieredScope("team", "U1");
  test("reads the tier tag; marker-only reads as an unmatchable user tier", async () => {
    const { call } = mockBrain({ pageTags: { a: ["audience:manager"], b: ["audience:user", "audience:user:U2"], c: ["audience:user"], d: ["plain"] } });
    expect(await pageAudienceFromTags(call, scope, AGENT_SLICE, "a")).toBe("manager");
    expect(await pageAudienceFromTags(call, scope, AGENT_SLICE, "b")).toBe("user:U2");
    expect(await pageAudienceFromTags(call, scope, AGENT_SLICE, "c")).toBe("user:");
    expect(await pageAudienceFromTags(call, scope, AGENT_SLICE, "d")).toBeNull();
  });
  test("queries the requested source sub-scoped, not the turn write target", async () => {
    const { call, ops } = mockBrain({ pageTags: {} });
    await pageAudienceFromTags(call, scope, "agent", "a");
    expect(ops[0]!.sourceId).toBe("agent");
  });
});

describe("buildAudienceFilter", () => {
  test("team level: hides private/manager/user:<other>, keeps user:<me> and unlabeled", async () => {
    const { call } = mockBrain({ tagged: { [AGENT_SLICE]: {
      "audience:private": ["p1"],
      "audience:manager": ["m1"],
      "audience:user": ["u-mine", "u-other"],
      "audience:user:U1": ["u-mine"],
    } } });
    const f = await buildAudienceFilter(call, tieredScope("team", "U1"));
    expect(f.anyHidden).toBe(true);
    expect(f.visible(AGENT_SLICE, "p1")).toBe(false);
    expect(f.visible(AGENT_SLICE, "m1")).toBe(false);
    expect(f.visible(AGENT_SLICE, "u-other")).toBe(false);
    expect(f.visible(AGENT_SLICE, "u-mine")).toBe(true);
    expect(f.visible(AGENT_SLICE, "unlabeled")).toBe(true);
    expect(f.visible("shared", "p1")).toBe(true); // non-tiered source untouched
  });
  test("manager level: manager-tier pages are visible, private hidden", async () => {
    const { call } = mockBrain({ tagged: { [AGENT_SLICE]: { "audience:private": ["p1"] } } });
    const f = await buildAudienceFilter(call, tieredScope("manager", "UMGR"));
    expect(f.visible(AGENT_SLICE, "p1")).toBe(false);
    expect(f.visible(AGENT_SLICE, "m1")).toBe(true); // no manager-tag query at this level
  });
  test("public level: only audience:public and user:<me> visible", async () => {
    const { call } = mockBrain({ tagged: { [AGENT_SLICE]: {
      "audience:public": ["pub"],
      "audience:user:U1": ["mine"],
    } } });
    const f = await buildAudienceFilter(call, tieredScope("public", "U1"));
    expect(f.anyHidden).toBe(true);
    expect(f.visible(AGENT_SLICE, "pub")).toBe(true);
    expect(f.visible(AGENT_SLICE, "mine")).toBe(true);
    expect(f.visible(AGENT_SLICE, "unlabeled")).toBe(false);
  });
  test("nothing restricted → anyHidden false, everything visible", async () => {
    const { call } = mockBrain({});
    const f = await buildAudienceFilter(call, tieredScope("team", "U1"));
    expect(f.anyHidden).toBe(false);
    expect(f.visible(AGENT_SLICE, "anything")).toBe(true);
  });
  test("a full 100-row tag list (possible truncation) hides the whole source", async () => {
    const { call } = mockBrain({ tagged: { [AGENT_SLICE]: {
      "audience:private": Array.from({ length: 100 }, (_, i) => `p${i}`),
    } } });
    const f = await buildAudienceFilter(call, tieredScope("team", "U1"));
    expect(f.visible(AGENT_SLICE, "not-even-tagged")).toBe(false);
    expect(f.anyHidden).toBe(true);
  });
  test("query failure hides the tiered sources (fail closed)", async () => {
    const call: BrainCallFn = async () => { throw new Error("brain down"); };
    const f = await buildAudienceFilter(call, tieredScope("team", "U1"));
    expect(f.visible(AGENT_SLICE, "x")).toBe(false);
    expect(f.visible("shared", "x")).toBe(true);
  });
});

describe("gather audience filter", () => {
  const searchable = (tagged: Record<string, string[]>) => {
    const { call: tagCall } = mockBrain({ tagged: { [AGENT_SLICE]: tagged } });
    const call: BrainCallFn = async (name, params, s) => {
      if (name === "search") {
        return s.allowedSources[0] === AGENT_SLICE
          ? [{ slug: "notes/secret", rerank_score: 0.9 }, { slug: "notes/open", rerank_score: 0.8 }, { rerank_score: 0.7 }]
          : [{ slug: "shared/page", rerank_score: 0.5 }];
      }
      return tagCall(name, params, s);
    };
    return call;
  };

  test("filters tiered-source hits per page; slugless hits drop; other sources untouched", async () => {
    const call = searchable({ "audience:manager": ["notes/secret"] });
    const hits = await gather("q", tieredScope("team", "U1"), { call });
    expect(hits.map((h) => h.slug)).toEqual(["notes/open", "shared/page"]);
  });
  test('grant "all" filters nothing (slugless hit survives too)', async () => {
    const call = searchable({ "audience:manager": ["notes/secret"] });
    const hits = await gather("q", tieredScope("all", null), { call });
    expect(hits.length).toBe(4);
  });
  test("public level hides unlabeled (team-default) pages", async () => {
    const call = searchable({});
    const hits = await gather("q", tieredScope("public", "U1"), { call });
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

describe("kb_memoize audience tag reconcile", () => {
  test("own-slice write derives tags from frontmatter and reconciles in the brain", async () => {
    const { call, ops } = mockBrain({ pageTags: {} });
    const d = deps(tieredScope("team", "U1"), { call });
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/mgr", content: "---\naudience: manager\n---\nx", summary: "s" },
      { slug: "notes/plain", content: "no frontmatter", summary: "s" },
    ] }, d);
    expect(r.isError).toBeUndefined();
    expect(ops.filter((o) => o.name === "put_page").length).toBe(2);
    const tagOps = ops.filter((o) => o.name === "add_tag").map((o) => [o.params.slug, o.params.tag]);
    expect(tagOps).toEqual([["notes/mgr", "audience:manager"]]); // plain page: nothing to add
  });
  test("demote removes the stale (more permissive) tag", async () => {
    const { call, ops } = mockBrain({ pageTags: { "notes/x": ["audience:public"] } });
    const d = deps(tieredScope("team", "U1"), { call });
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "---\naudience: manager\n---\nx", summary: "s" }] }, d);
    expect(ops.filter((o) => o.name === "remove_tag").map((o) => o.params.tag)).toEqual(["audience:public"]);
    expect(ops.filter((o) => o.name === "add_tag").map((o) => o.params.tag)).toEqual(["audience:manager"]);
  });
  test("invalid audience rejects the whole batch before any write", async () => {
    const { call, ops } = mockBrain({});
    const d = deps(tieredScope("team", "U1"), { call });
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "ok/page", content: "fine", summary: "s" },
      { slug: "bad/page", content: "---\naudience: everybody\n---\nx", summary: "s" },
    ] }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("bad/page");
    expect(ops).toEqual([]);
  });
  test("tag-write failure after page save surfaces as an error, never silent success", async () => {
    const call: BrainCallFn = async (name) => {
      if (name === "get_tags") throw new Error("tags table sad");
      return { ok: 1 };
    };
    const d = deps(tieredScope("team", "U1"), { call });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "---\naudience: private\n---\nx", summary: "s" }] }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("was saved");
    expect(r.content[0]!.text).toContain("retry");
  });
  test("audience on a non-own-slice target is ignored with a note, no tag ops", async () => {
    const { call, ops } = mockBrain({});
    const shared: BrainScope = { clientId: "U1", sourceId: "shared", allowedSources: ["shared"] };
    const d = deps(shared, { call });
    const r = await brainHandlers.kb_memoize({
      pages: [{ slug: "team/page", content: "---\naudience: manager\n---\nx", summary: "s" }],
      target: "shared",
    }, d);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text).audience_note).toContain("ignored");
    expect(ops.filter((o) => o.name !== "put_page")).toEqual([]);
  });
});

describe("read-path audience enforcement", () => {
  test("kb_get_page denies a hidden page (keyed on result source_id + get_tags)", async () => {
    const { call: tagCall } = mockBrain({ pageTags: { "notes/hidden": ["audience:manager"] } });
    const call: BrainCallFn = async (name, params, s) =>
      name === "get_page" ? { slug: "notes/hidden", source_id: AGENT_SLICE, compiled_truth: "secret" } : tagCall(name, params, s);
    const r = await brainHandlers.kb_get_page({ slug: "notes/hidden" }, deps(tieredScope("team", "U1"), { call }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain("secret");
  });
  test("kb_get_page allows the same page under a manager grant, and shared pages always", async () => {
    const { call: tagCall } = mockBrain({ pageTags: { "notes/hidden": ["audience:manager"] } });
    const asPage = (source_id: string): BrainCallFn => async (name, params, s) =>
      name === "get_page" ? { slug: "notes/hidden", source_id, compiled_truth: "body" } : tagCall(name, params, s);
    const mgr = await brainHandlers.kb_get_page({ slug: "notes/hidden" }, deps(tieredScope("manager", "UMGR"), { call: asPage(AGENT_SLICE) }));
    expect(mgr.isError).toBeUndefined();
    const shared = await brainHandlers.kb_get_page({ slug: "notes/hidden" }, deps(tieredScope("team", "U1"), { call: asPage("shared") }));
    expect(shared.isError).toBeUndefined();
  });
  test("kb_get_page without source_id fails closed on an explicit hidden tier", async () => {
    const { call: tagCall } = mockBrain({ pageTags: { "notes/nosrc": ["audience:private"] } });
    const call: BrainCallFn = async (name, params, s) =>
      name === "get_page" ? { slug: "notes/nosrc" } : tagCall(name, params, s);
    const r = await brainHandlers.kb_get_page({ slug: "notes/nosrc" }, deps(tieredScope("team", "U1"), { call }));
    expect(r.isError).toBe(true);
  });
  test("kb_list_pages filters hidden slugs at team level via tag sets", async () => {
    const { call: tagCall } = mockBrain({ tagged: { [AGENT_SLICE]: { "audience:manager": ["notes/listed-hidden"] } } });
    const call: BrainCallFn = async (name, params, s) =>
      name === "list_pages" && !params.tag
        ? [{ slug: "notes/listed-hidden" }, { slug: "notes/visible" }]
        : tagCall(name, params, s);
    const r = await brainHandlers.kb_list_pages({}, deps(tieredScope("team", "U1"), { call }));
    expect(JSON.parse(r.content[0]!.text)).toEqual([{ slug: "notes/visible" }]);
  });
  test("kb_list_pages at public level strips the tiered sources from the call scope", async () => {
    let seen: string[] = [];
    const call: BrainCallFn = async (name, _p, s) => {
      if (name === "list_pages") seen = s.allowedSources;
      return [];
    };
    await brainHandlers.kb_list_pages({}, deps(tieredScope("public", "U1"), { call }));
    expect(seen).toEqual(["shared"]);
  });
  test("kb_graph denies a hidden slug and strips sources at public level", async () => {
    const { call: tagCall } = mockBrain({ pageTags: { "notes/graph-hidden": ["audience:private"] } });
    const r = await brainHandlers.kb_graph({ slug: "notes/graph-hidden" }, deps(tieredScope("team", "U1"), { call: tagCall }));
    expect(r.isError).toBe(true);
    const linkScopes: string[][] = [];
    const pub: BrainCallFn = async (name, _p, s) => {
      if (name === "get_links" || name === "get_backlinks") linkScopes.push(s.allowedSources);
      return [];
    };
    await brainHandlers.kb_graph({ slug: "shared/ok" }, deps(tieredScope("public", "U1"), { call: pub }));
    expect(linkScopes).toEqual([["shared"], ["shared"]]);
  });
  test("kb_think strips tiered sources from synthesis when the grant hides pages", async () => {
    const { call } = mockBrain({ tagged: { [AGENT_SLICE]: { "audience:private": ["notes/think-hidden"] } } });
    let thinkSources: string[] = [];
    const d = deps(tieredScope("team", "U1"), {
      call,
      think: async (_q, s) => { thinkSources = s.allowedSources; return { answer: "a", citations: [], pagesGathered: 1 }; },
    });
    await brainHandlers.kb_think({ question: "q" }, d);
    expect(thinkSources).toEqual(["shared"]);
  });
  test("kb_think keeps full scope when nothing is hidden at this level", async () => {
    const { call } = mockBrain({});
    let thinkSources: string[] = [];
    const d = deps(tieredScope("team", "U1"), {
      call,
      think: async (_q, s) => { thinkSources = s.allowedSources; return { answer: "a", citations: [], pagesGathered: 1 }; },
    });
    await brainHandlers.kb_think({ question: "q" }, d);
    expect(thinkSources).toEqual([AGENT_SLICE, "shared"]);
  });
});
