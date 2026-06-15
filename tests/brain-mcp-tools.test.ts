import { describe, expect, test } from "bun:test";
import { brainHandlers, type BrainToolDeps } from "../src/knowledge/mcp-tools";
import type { BrainScope } from "../src/knowledge/scope";

const scope: BrainScope = { clientId: "U1", sourceId: "shared", allowedSources: ["shared"] };
const deps = (over: Partial<BrainToolDeps> = {}): BrainToolDeps => ({
  scope: () => scope,
  gate: () => ({ userId: "U1", lockedUser: null, channelTrust: "trusted", isManager: false }),
  managers: () => ["UMGR"],
  requestApproval: async () => ({ approved: true, by: "UMGR" }),
  call: async (name) => ({ echoed: name }),
  ...over,
});

describe("brainHandlers", () => {
  test("kb_search returns JSON of op result", async () => {
    const r = await brainHandlers.kb_search({ query: "x" }, deps());
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toEqual({ echoed: "search" });
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

  test("kb_put_page is replaced by kb_memoize", () => {
    expect((brainHandlers as Record<string, unknown>).kb_put_page).toBeUndefined();
    expect(typeof brainHandlers.kb_memoize).toBe("function");
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
