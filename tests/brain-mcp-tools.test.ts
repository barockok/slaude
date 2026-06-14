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

  test("kb_put_page goes through the gate — denial surfaces as error", async () => {
    const d = deps({ requestApproval: async () => ({ approved: false, by: "UMGR" }) });
    const r = await brainHandlers.kb_put_page({ slug: "a/b", content: "x", summary: "add page" }, d);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("denied");
  });

  test("kb_put_page passes slug+content to the op after approval", async () => {
    let got: { name?: string; params?: Record<string, unknown> } = {};
    const d = deps({ call: async (name, params) => { got = { name, params }; return { ok: 1 }; } });
    const r = await brainHandlers.kb_put_page({ slug: "a/b", content: "hello", summary: "add" }, d);
    expect(r.isError).toBeUndefined();
    expect(got.name).toBe("put_page");
    expect(got.params).toEqual({ slug: "a/b", content: "hello" });
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

  test("kb_think does NOT fall back when citations exist", async () => {
    let searchCalled = false;
    const d = deps({
      think: async () => ({ answer: "yes", citations: [{ page_slug: "x" }], pagesGathered: 3 }),
      call: async (name) => { if (name === "search") searchCalled = true; return []; },
    });
    const r = await brainHandlers.kb_think({ question: "q" }, d);
    expect(r.isError).toBeUndefined();
    expect(searchCalled).toBe(false);
    expect(JSON.parse(r.content[0]!.text).search_fallback).toBeUndefined();
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
