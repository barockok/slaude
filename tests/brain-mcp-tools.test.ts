import { describe, expect, test } from "bun:test";
import { brainHandlers, humanizeBrainError, type BrainToolDeps } from "../src/knowledge/mcp-tools";
import { agentSourceId, type BrainScope } from "../src/knowledge/scope";
import { agentIdSync, resolveAgentId, resetAgentId } from "../src/knowledge/agent-identity";

const scope: BrainScope = { clientId: "U1", sourceId: "shared", allowedSources: ["shared"] };
const deps = (over: Partial<BrainToolDeps> = {}): BrainToolDeps => ({
  scope: () => scope,
  gate: () => ({ userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false, agentId: "AGENT1" }),
  managers: () => ["UMGR"],
  requestApproval: async () => ({ approved: true, by: "UMGR" }),
  call: async (name) => ({ echoed: name }),
  ...over,
});

describe("brainHandlers", () => {
  test("kb_search returns gathered hits (per-source fan-out, merged)", async () => {
    // kb_search now routes through gather(): one search per allowed source,
    // merged + ranked. With a single source, that's one call returning its hits.
    const d = deps({ call: async () => [{ slug: "a/b", score: 0.9 }] });
    const r = await brainHandlers.kb_search({ query: "x" }, d);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toEqual([{ slug: "a/b", score: 0.9 }]);
  });

  test("kb_search fans out one search per allowed source and merges", async () => {
    const seen: string[] = [];
    const multi: BrainScope = { clientId: "U1", sourceId: "shared", allowedSources: ["shared", "bulk-corpus"] };
    const d = deps({
      scope: () => multi,
      call: async (_name, _params, s) => {
        seen.push(s.allowedSources[0]!);
        return s.allowedSources[0] === "shared"
          ? [{ slug: "org/page", rerank_score: 0.8 }]
          : [{ slug: "bulk/stub", rerank_score: 0.05 }];
      },
    });
    const r = await brainHandlers.kb_search({ query: "x" }, d);
    const hits = JSON.parse(r.content[0]!.text) as Array<{ slug: string }>;
    expect(seen.sort()).toEqual(["bulk-corpus", "shared"]); // one call per source
    expect(hits[0]!.slug).toBe("org/page"); // higher rerank wins the merge
    expect(hits.map((h) => h.slug)).toContain("bulk/stub");
  });

  test("kb_memoize goes through the gate — denial surfaces as error", async () => {
    const d = deps({ requestApproval: async () => ({ approved: false, by: "UMGR" }) });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "a/b", content: "x", summary: "add page" }] }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("denied");
  });

  test("kb_memoize passes slug+content to the put_page op after approval", async () => {
    let got: { name?: string; params?: Record<string, unknown> } = {};
    const d = deps({ call: async (name, params) => { got = { name, params }; return { ok: 1 }; } });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "a/b", content: "hello", summary: "add" }] }, d);
    expect(r.isError).toBeUndefined();
    expect(got.name).toBe("put_page");
    expect(got.params).toEqual({ slug: "a/b", content: "hello" });
  });

  test("kb_memoize writes multiple pages under a single approval", async () => {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
    let approvals = 0;
    const d = deps({
      requestApproval: async () => { approvals++; return { approved: true, by: "UMGR" }; },
      call: async (name, params) => { calls.push({ name, params }); return { ok: 1 }; },
    });
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "a/1", content: "c1", summary: "s1" },
      { slug: "a/2", content: "c2", summary: "s2" },
      { slug: "a/3", content: "c3", summary: "s3" },
    ] }, d);
    expect(r.isError).toBeUndefined();
    expect(approvals).toBe(1);
    expect(calls.map((c) => c.name)).toEqual(["put_page", "put_page", "put_page"]);
    expect(calls.map((c) => c.params.slug)).toEqual(["a/1", "a/2", "a/3"]);
  });

  test("kb_memoize rejects an empty pages array (no approval, no writes)", async () => {
    let approvals = 0;
    const calls: string[] = [];
    const d = deps({
      requestApproval: async () => { approvals++; return { approved: true, by: "UMGR" }; },
      call: async (name) => { calls.push(name); return {}; },
    });
    const r = await brainHandlers.kb_memoize({ pages: [] }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("at least one");
    expect(approvals).toBe(0);
    expect(calls).toEqual([]);
  });

  test("kb_memoize rejects more than 20 pages", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => ({ slug: `a/${i}`, content: "c", summary: "s" }));
    const r = await brainHandlers.kb_memoize({ pages }, deps());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("20");
  });

  test("kb_memoize denial writes nothing", async () => {
    const calls: string[] = [];
    const d = deps({
      requestApproval: async () => ({ approved: false, by: "UMGR" }),
      call: async (name) => { calls.push(name); return {}; },
    });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "a/1", content: "c", summary: "s" }] }, d);
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("kb_memoize target:'mine' writes to the agent's own slice without approval", async () => {
    // Own-slice scope: default target "mine" auto-passes the gate (no card).
    const mine: BrainScope = { clientId: "AGENT1", sourceId: agentSourceId("AGENT1"), allowedSources: [agentSourceId("AGENT1")] };
    let approvals = 0;
    const wrote: unknown[] = [];
    const d = deps({
      scope: () => mine,
      requestApproval: async () => { approvals++; return { approved: true, by: "UMGR" }; },
      call: async (_n, _p, s) => { wrote.push(s.sourceId); return { ok: 1 }; },
    });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/x", content: "c", summary: "s" }] }, d);
    expect(r.isError).toBeUndefined();
    expect(approvals).toBe(0);
    expect(wrote).toEqual([agentSourceId("AGENT1")]);
  });

  test("kb_memoize target:'shared' overrides the write to the shared slice and cards", async () => {
    // Even from an own-slice scope, escalating to shared routes the write to
    // SHARED_SOURCE and goes through approval.
    const mine: BrainScope = { clientId: "AGENT1", sourceId: agentSourceId("AGENT1"), allowedSources: [agentSourceId("AGENT1"), "shared"] };
    let approvals = 0;
    const wrote: string[] = [];
    const d = deps({
      scope: () => mine,
      requestApproval: async () => { approvals++; return { approved: true, by: "UMGR" }; },
      call: async (_n, _p, s) => { wrote.push(s.sourceId); return { ok: 1 }; },
    });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "team/y", content: "c", summary: "s" }], target: "shared" }, d);
    expect(r.isError).toBeUndefined();
    expect(approvals).toBe(1);
    expect(wrote).toEqual(["shared"]);
  });

  test("kb_memoize awaits identity so a boot-window write hits the resolved slice, not agent-default (C1)", async () => {
    resetAgentId();
    let settle!: (v: { user_id: string }) => void;
    const authP = new Promise<{ user_id: string }>((res) => { settle = res; });
    void resolveAgentId(() => authP); // identity in-flight, not yet settled
    const wrote: string[] = [];
    const d = deps({
      // scope reads the live id at call time — the gateway wiring does the same.
      scope: () => ({ clientId: agentIdSync(), sourceId: agentSourceId(agentIdSync()), allowedSources: [agentSourceId(agentIdSync())] }),
      call: async (_n, _p, s) => { wrote.push(s.sourceId); return { ok: 1 }; },
    });
    const pending = brainHandlers.kb_memoize({ pages: [{ slug: "notes/boot", content: "c", summary: "s" }] }, d);
    settle({ user_id: "U_REAL" }); // auth.test lands after the write call began
    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect(wrote).toEqual([agentSourceId("U_REAL")]); // NOT agent-default
    resetAgentId();
  });

  test("kb_put_page is replaced by kb_memoize", () => {
    expect((brainHandlers as Record<string, unknown>).kb_put_page).toBeUndefined();
    expect(typeof brainHandlers.kb_memoize).toBe("function");
  });

  test("kb_delete_page goes through the gate and passes the slug on approval", async () => {
    let got: { name?: string; params?: Record<string, unknown> } = {};
    const d = deps({ call: async (name, params) => { got = { name, params }; return { deleted: 1 }; } });
    const r = await brainHandlers.kb_delete_page({ slug: "a/b", reason: "stale" }, d);
    expect(r.isError).toBeUndefined();
    expect(got.name).toBe("delete_page");
    expect(got.params).toEqual({ slug: "a/b" });
  });

  test("kb_delete_page denial surfaces as error and writes nothing", async () => {
    const calls: string[] = [];
    const d = deps({
      requestApproval: async () => ({ approved: false, by: "UMGR" }),
      call: async (name) => { calls.push(name); return {}; },
    });
    const r = await brainHandlers.kb_delete_page({ slug: "a/b", reason: "stale" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("denied");
    expect(calls).toEqual([]);
  });

  test("kb_get_page returns the page and maps op errors to tool errors", async () => {
    const ok = await brainHandlers.kb_get_page({ slug: "people/alice" }, deps({ call: async () => ({ slug: "people/alice" }) }));
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text)).toEqual({ slug: "people/alice" });
    const bad = await brainHandlers.kb_get_page({ slug: "x" }, deps({ call: async () => { throw new Error("db on fire"); } }));
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("db on fire");
  });

  test("kb_list_pages forwards filters to the list_pages op", async () => {
    let params: Record<string, unknown> | undefined;
    const d = deps({ call: async (_n, p) => { params = p; return []; } });
    const r = await brainHandlers.kb_list_pages({ type: "conversation", tag: "x", limit: 3 }, d);
    expect(r.isError).toBeUndefined();
    expect(params).toEqual({ type: "conversation", tag: "x", limit: 3 });
  });

  test("kb_graph combines links and backlinks", async () => {
    const d = deps({ call: async (name) => (name === "get_links" ? [{ to: "x" }] : [{ from: "y" }]) });
    const r = await brainHandlers.kb_graph({ slug: "a/b" }, d);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toEqual({ links: [{ to: "x" }], backlinks: [{ from: "y" }] });
  });

  test("op errors map to tool errors, not throws", async () => {
    const d = deps({ call: async () => { throw new Error("db on fire"); } });
    const r = await brainHandlers.kb_search({ query: "x" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("db on fire");
  });

  // #7a: raw FK / vector errors become actionable, never leaked verbatim.
  test("FK error maps to actionable retry-not-file guidance", async () => {
    const d = deps({ call: async () => { throw new Error('insert ... violates foreign key constraint "pages_source_id_fkey"'); } });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "a/b", content: "c", summary: "s" }] }, d);
    expect(r.isError).toBe(true);
    const t = r.content[0]!.text;
    expect(t).toMatch(/retry/i);
    expect(t).toMatch(/do NOT fall back to writing a file/i);
    expect(t).not.toMatch(/pages_source_id_fkey/); // raw shape not leaked
  });

  test("vector-extension error maps to infra-fault guidance", async () => {
    const d = deps({ call: async () => { throw new Error('could not access file "$libdir/vector": No such file or directory'); } });
    const r = await brainHandlers.kb_search({ query: "x" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/vector extension is unavailable|brain is degraded/i);
  });

  test("unknown errors pass through unchanged", () => {
    expect(humanizeBrainError("search", new Error("db on fire"))).toBe("brain search failed: db on fire");
  });

  // Mode B: a zero-citation think result must fall back to keyword search so a
  // present page isn't reported "not captured".
  // docs/findings/2026-06-14-brain-memoize-failure.md
  test("kb_think falls back to search when synthesis has zero citations", async () => {
    let searched: string | undefined;
    const d = deps({
      think: async () => ({ answer: "not in the brain", citations: [], pagesGathered: 40 }),
      call: async (name) => {
        if (name === "search") { searched = name; return [{ slug: "lessons/jot-deployment-pattern", score: 1.08 }]; }
        return { echoed: name };
      },
    });
    const r = await brainHandlers.kb_think({ question: "what lesson on jot deployment?" }, d);
    expect(r.isError).toBeUndefined();
    expect(searched).toBe("search");
    const out = JSON.parse(r.content[0]!.text);
    expect(out.search_fallback[0].slug).toBe("lessons/jot-deployment-pattern");
  });

  test("kb_think does NOT surface a hit the synthesis already cited", async () => {
    // search runs (always), but its only hit == the cited page → nothing missed.
    const d = deps({
      think: async () => ({ answer: "yes", citations: [{ page_slug: "notes/x" }], pagesGathered: 3 }),
      call: async (name) => (name === "search" ? [{ slug: "notes/x", score: 1.2 }] : { echoed: name }),
    });
    const r = await brainHandlers.kb_think({ question: "q" }, d);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text).search_fallback).toBeUndefined();
  });

  // Mode B′: synthesis answered with citations but ranked the canonical page out.
  // The cross-check search must surface the uncited strong hit.
  test("kb_think surfaces a strong hit the synthesis cited around (B′)", async () => {
    const d = deps({
      think: async () => ({ answer: "neighbor info…", citations: [{ page_slug: "team/sub-overview" }], pagesGathered: 40 }),
      call: async (name) =>
        name === "search"
          ? [{ slug: "notes/canonical-page", score: 1.1 }, { slug: "team/sub-overview", score: 0.9 }]
          : { echoed: name },
    });
    const r = await brainHandlers.kb_think({ question: "what is the canonical page?" }, d);
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0]!.text);
    // the cited page is filtered out; the uncited canonical page is surfaced
    expect(out.search_fallback.map((h: { slug: string }) => h.slug)).toEqual(["notes/canonical-page"]);
  });

  test("kb_think cross-check uses a distilled keyword query", async () => {
    let sentQuery: string | undefined;
    const d = deps({
      think: async () => ({ answer: "x", citations: [], pagesGathered: 1 }),
      call: async (name, params) => {
        if (name === "search") { sentQuery = (params as { query: string }).query; return []; }
        return { echoed: name };
      },
    });
    await brainHandlers.kb_think({ question: "what is our deploy policy?" }, d);
    expect(sentQuery).toBe("deploy policy");
  });

  test("kb_think returns the raw result when the fallback search is empty", async () => {
    const d = deps({
      think: async () => ({ answer: "not in the brain", citations: [], pagesGathered: 40 }),
      call: async () => [],
    });
    const r = await brainHandlers.kb_think({ question: "q" }, d);
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0]!.text);
    expect(out.search_fallback).toBeUndefined();
    expect(out.answer).toBe("not in the brain");
  });

  test("kb_think swallows a failing fallback search and returns the think result", async () => {
    const d = deps({
      think: async () => ({ answer: "not in the brain", citations: [], pagesGathered: 40 }),
      call: async () => { throw new Error("search index offline"); },
    });
    const r = await brainHandlers.kb_think({ question: "q" }, d);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text).answer).toBe("not in the brain");
  });
});
