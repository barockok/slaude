/**
 * kb_thread_history (phase C, spec §8.5): this thread's turns beyond the
 * recent-turns recall window, oldest-first, read only from this session's
 * conversation page through the memory read scope.
 */
import { describe, expect, test } from "bun:test";
import { brainHandlers, THREAD_HISTORY_REFUSAL, THREAD_HISTORY_NO_SESSION, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import type { BrainScope } from "../../src/knowledge/scope";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import { memoryScopeFor } from "../../src/memory/scope";

const AGENT = "AGENT1";
const SESSION = "Sess-ABC";
type Row = { id: number; date: string; summary: string; detail: string };

/** 30 turns, ids 1..30, one per day-ish. */
const rows = (n = 30): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
    summary: `q${i + 1}`,
    detail: `<user>question ${i + 1}</user>\n<assistant>answer ${i + 1}</assistant>`,
  }));

const gate = (over: Partial<GateInput> = {}): GateInput => ({
  userId: "U0ALICE", teamId: "T0TEAM", interactive: true, origin: "slack", lockedUser: null,
  channelTrust: "trusted", isManager: false, agentId: AGENT, threadKey: "C0CHAN:1.1", ...over,
});

function setup(over: { gate?: Partial<GateInput>; sessionId?: string | undefined; data?: Row[] } = {}) {
  const calls: { name: string; slug: unknown; scope: BrainScope }[] = [];
  const g = gate(over.gate);
  const deps: BrainToolDeps = {
    scope: () => ({ clientId: "c", sourceId: "x", allowedSources: ["x"] }),
    gate: () => g,
    managers: () => [],
    requestApproval: async () => ({ approved: true, by: "U0MGR" }),
    thread: async () => ({
      sessionId: "sessionId" in over ? over.sessionId : SESSION,
      read: memoryScopeFor(g, { channel: "C0CHAN" }).read,
    }),
    call: async (name, params, scope) => {
      calls.push({ name, slug: params.slug, scope });
      return over.data ?? rows();
    },
  };
  return { deps, calls };
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const lines = (t: string) => t.split("\n").filter((l) => l.startsWith("["));

describe("kb_thread_history", () => {
  test("limit 20 returns the 20 newest turns, oldest-first", async () => {
    const s = setup();
    const out = text(await brainHandlers.kb_thread_history({ limit: 20 }, s.deps));
    const l = lines(out);
    expect(l).toHaveLength(40); // user + assistant line per turn
    expect(l[0]).toBe("[2026-10-11] user: question 11");
    expect(l[1]).toBe("[2026-10-11] assistant: answer 11");
    expect(l[39]).toBe("[2026-10-02] assistant: answer 30");
    expect(out).not.toContain("question 10\n");
  });

  test("default limit is 20", async () => {
    const out = text(await brainHandlers.kb_thread_history({}, setup().deps));
    expect(lines(out)).toHaveLength(40);
  });

  test("before pages backwards", async () => {
    const s = setup();
    const first = text(await brainHandlers.kb_thread_history({ limit: 20 }, s.deps));
    const m = first.match(/before: "(\d+)"/);
    expect(m).not.toBeNull();
    const second = text(await brainHandlers.kb_thread_history({ limit: 20, before: m![1] }, s.deps));
    const l = lines(second);
    expect(l).toHaveLength(20); // turns 1..10
    expect(l[0]).toContain("question 1");
    expect(l[19]).toContain("answer 10");
    expect(second).not.toContain("before:");
  });

  test("reads only this session's page, in the memory read scope", async () => {
    const s = setup();
    await brainHandlers.kb_thread_history({}, s.deps);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.name).toBe("get_timeline");
    expect(s.calls[0]!.slug).toBe("conversations/sess-abc");
    expect(s.calls[0]!.scope).toEqual(memoryScopeFor(gate(), { channel: "C0CHAN" }).read!);
  });

  test("someone else's /1on1 refuses and reads nothing", async () => {
    const s = setup({ gate: { lockedUser: "U0BOB" } });
    const r = await brainHandlers.kb_thread_history({}, s.deps);
    expect(text(r)).toBe(THREAD_HISTORY_REFUSAL);
    expect(THREAD_HISTORY_REFUSAL).toBe("refused: no thread history is readable here");
    expect(s.calls).toHaveLength(0);
  });

  test("an unknown session refuses", async () => {
    const s = setup({ sessionId: undefined });
    const r = await brainHandlers.kb_thread_history({}, s.deps);
    expect(text(r)).toBe(THREAD_HISTORY_NO_SESSION);
    expect(s.calls).toHaveLength(0);
  });

  test("an empty thread says so", async () => {
    const out = text(await brainHandlers.kb_thread_history({}, setup({ data: [] }).deps));
    expect(out).toContain("No earlier turns");
  });

  test("limit outside 1..50 is rejected by the contract", async () => {
    const { kbContract } = await import("../../src/tools/contracts/kb");
    const { z } = await import("zod");
    const schema = z.object(kbContract.tools.kb_thread_history.schema);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ limit: 50, before: "5" }).success).toBe(true);
  });
});
