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
});
