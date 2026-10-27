import { describe, expect, test } from "bun:test";
import { fakeBrain } from "../memory/fake-brain";
import { JOURNAL_MAX_CHARS } from "../../src/proactive/rules";
import type { ReadOutcome, SourceReader } from "../../src/proactive/source-reader";
import { TRIAGE_MAX_BYTES_PER_SOURCE, TRIAGE_MAX_ITEMS, TRIAGE_MAX_READS, triageTools, type TriageState } from "../../src/proactive/triage-tools";

const NOW = new Date("2026-10-27T10:00:00Z");
const fresh = (): TriageState => ({ items: [], readCalls: 0, bytes: {}, needsAuth: new Set(), failed: new Set(), journal: null });

function setup(outcome: ReadOutcome = { kind: "ok", text: "item" }, tools: Array<{ name: string }> = [{ name: "list_things" }]) {
  const brain = fakeBrain();
  const seen: unknown[] = [];
  const reader: SourceReader = {
    tools: async () => [],
    read: async (_p, server, tool, args) => {
      seen.push([server, tool, args]);
      return outcome;
    },
  };
  const state = fresh();
  const list = triageTools(
    {
      personaId: "default",
      agentId: "a1",
      sources: [{ server: "tracker", readTools: ["list_things"], tools }],
      reader,
      since: { tracker: null },
      call: brain.call,
      now: () => NOW,
    },
    state,
  );
  const by = (n: string) => list.find((t) => t.name === n)! as any;
  const run = async (n: string, a: unknown) => (await by(n).handler(a, {})) as { content: { text: string }[]; isError?: boolean };
  return { brain, seen, state, list, run };
}

describe("triage tools", () => {
  test("read caps hold", async () => {
    const { run, seen } = setup();
    for (let i = 0; i < TRIAGE_MAX_READS; i++) expect((await run("read_tracker", { tool: "list_things", args: {} })).isError).toBeFalsy();
    const r = await run("read_tracker", { tool: "list_things", args: {} });
    expect(r.isError).toBe(true);
    expect(seen.length).toBe(TRIAGE_MAX_READS);
  });

  test("a result over the byte cap is truncated with a note", async () => {
    const { run } = setup({ kind: "ok", text: "x".repeat(TRIAGE_MAX_BYTES_PER_SOURCE + 100) });
    const r = await run("read_tracker", { tool: "list_things", args: {} });
    expect(r.content[0]!.text.length).toBeLessThan(TRIAGE_MAX_BYTES_PER_SOURCE + 300);
    expect(r.content[0]!.text).toContain("truncated");
    expect((await run("read_tracker", { tool: "list_things", args: {} })).isError).toBe(true);
  });

  test("needs-auth is recorded and the round continues", async () => {
    const { run, state } = setup({ kind: "needs-auth" });
    const r = await run("read_tracker", { tool: "list_things", args: {} });
    expect(state.needsAuth.has("tracker")).toBe(true);
    expect(r.isError).toBeFalsy();
    expect((await run("route_item", { source: "memory", itemId: "1", kind: "k", destination: "none", proposedLevel: "ignore", summary: "s", evidence: "e" })).isError).toBeFalsy();
  });

  test("a failed read is recorded", async () => {
    const { run, state } = setup({ kind: "error", text: "boom" });
    await run("read_tracker", { tool: "list_things", args: {} });
    expect(state.failed.has("tracker")).toBe(true);
  });

  test("a source with no tools gets no read tool", () => {
    expect(setup(undefined, []).list.map((t) => t.name)).toEqual(["route_item", "write_journal"]);
  });

  test("route_item validates destination and source", async () => {
    const { run, state } = setup();
    const base = { source: "tracker", itemId: "1", kind: "k", proposedLevel: "inform", summary: "s", evidence: "e" };
    expect((await run("route_item", { ...base, destination: "#general" })).isError).toBe(true);
    expect((await run("route_item", { ...base, source: "other", destination: "C0ABC" })).isError).toBe(true);
    expect((await run("route_item", { ...base, destination: "C0ABC" })).isError).toBeFalsy();
    expect((await run("route_item", { ...base, itemId: "2", source: "memory", destination: "U0ABC" })).isError).toBeFalsy();
    expect((await run("route_item", { ...base, itemId: "3", destination: "none" })).isError).toBeFalsy();
    expect(state.items.length).toBe(3);
  });

  test("route_item refuses beyond the item cap", async () => {
    const { run } = setup();
    for (let i = 0; i < TRIAGE_MAX_ITEMS; i++) await run("route_item", { source: "tracker", itemId: `i${i}`, kind: "k", destination: "none", proposedLevel: "ignore", summary: "s", evidence: "e" });
    const r = await run("route_item", { source: "tracker", itemId: "extra", kind: "k", destination: "none", proposedLevel: "ignore", summary: "s", evidence: "e" });
    expect(r.isError).toBe(true);
  });

  test("a repeated item replaces the earlier one", async () => {
    const { run, state } = setup();
    const a = { source: "tracker", itemId: "1", kind: "k", destination: "C0ABC", proposedLevel: "inform", summary: "first", evidence: "e" };
    await run("route_item", a);
    await run("route_item", { ...a, summary: "second", proposedLevel: "ask" });
    expect(state.items.length).toBe(1);
    expect(state.items[0]!.summary).toBe("second");
    expect(state.items[0]!.proposedLevel).toBe("ask");
  });

  test("write_journal over the cap is refused, and nothing is written to the brain by any triage tool", async () => {
    const { run, state, brain } = setup();
    expect((await run("write_journal", { body: "x".repeat(JOURNAL_MAX_CHARS + 1) })).isError).toBe(true);
    expect(state.journal).toBeNull();
    expect((await run("write_journal", { body: "ok" })).isError).toBeFalsy();
    expect(state.journal).toBe("ok");
    await run("read_tracker", { tool: "list_things", args: {} });
    await run("route_item", { source: "tracker", itemId: "1", kind: "k", destination: "none", proposedLevel: "ignore", summary: "s", evidence: "e" });
    expect(brain.contents.size).toBe(0);
    expect(brain.pages.size).toBe(0);
  });
});
