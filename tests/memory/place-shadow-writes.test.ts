/** The shadow counters at the real write points: memory_save (plain, checklist, commitment) and the per-turn sync. Nothing a write does changes. */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { resetStandingGrants, type GateInput } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, resolveBrainScope, type BrainScope } from "../../src/knowledge/scope";
import { metrics } from "../../src/metrics";
import { BrainMemoryProvider } from "../../src/memory/brain-provider";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceShadowForTests } from "../../src/memory/place-shadow";
import { makeScopedMemory } from "../../src/memory/scoped";
import { fakeBrain } from "./fake-brain";

const AGENT = "AGENT1";
const PLACE: PlaceRef = { kind: "place", source: placeSourceId(AGENT, "b1"), boundaryId: "b1", boundaryKind: "channel" };

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(() => {
  resetStandingGrants();
  __resetPlaceShadowForTests();
});

const total = (surface: string, decision: string): number => {
  const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_memory_place_total{") && l.includes(`surface="${surface}"`) && l.includes(`decision="${decision}"`));
  return line ? Number(line.split(" ").pop()) : 0;
};

function setup(place: PlaceRef, over: Partial<GateInput> = {}) {
  const brain = fakeBrain();
  const writes: Array<{ name: string; source: string }> = [];
  const g: GateInput = {
    userId: "U0ALICE", teamId: "T0TEAM", interactive: true, origin: "slack", lockedUser: null, channelTrust: "trusted", isManager: false,
    place, agentId: AGENT, threadKey: "C0CHAN:1.1", turnSenders: [{ userId: "U0ALICE", teamId: "T0TEAM", origin: "slack" }], ...over,
  };
  const deps: BrainToolDeps = {
    scope: async () => resolveBrainScope({ ...g, kbSources: [] }),
    gate: () => g,
    managers: () => ["U0MGR"],
    requestApproval: async () => ({ approved: true, by: "U0MGR" }),
    call: async (name, params, scope) => {
      if (name === "put_page") writes.push({ name, source: scope.sourceId });
      return brain.call(name, params, scope);
    },
  };
  return { deps, writes };
}

describe("memory_save measures where each page would go", () => {
  test("plain, checklist and commitment pages are counted by surface; the write goes where it did", async () => {
    const s = setup(PLACE);
    const b = { plain: total("memory_save", "would-write-place"), list: total("checklist", "would-write-place"), com: total("commitment", "would-write-place") };
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/a", content: "x", summary: "s" },
      { slug: "self/heartbeat/c1", content: "- [ ] x", summary: "checklist" },
      { slug: "commitments/c", content: "Tell Alice.", summary: "s", type: "commitment", fields: { beneficiary: "U0ALICE", status: "open" } },
    ] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(total("memory_save", "would-write-place")).toBe(b.plain + 1);
    expect(total("checklist", "would-write-place")).toBe(b.list + 1);
    expect(total("commitment", "would-write-place")).toBe(b.com + 1);
    expect(s.writes.every((w) => w.source === agentSourceId(AGENT))).toBe(true);
    expect(s.writes.length).toBe(3);
  });

  test("no place counts would-write-none and the unknown counter, and the write still lands", async () => {
    const s = setup({ kind: "none", reason: "no-boundary" });
    const before = total("memory_save", "would-write-none");
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/a", content: "x", summary: "s" }] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(total("memory_save", "would-write-none")).toBe(before + 1);
    expect(metrics.render()).toContain('slaude_memory_place_unknown_total{reason="no-boundary"}');
    expect(s.writes.length).toBe(1);
  });

  test("target shared is same-as-today", async () => {
    const s = setup(PLACE, { isManager: true });
    const before = total("memory_save", "same-as-today");
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/s", content: "x", summary: "s" }], target: "shared" }, s.deps);
    expect(total("memory_save", "same-as-today")).toBe(before + 1);
  });
});

describe("the per-turn sync measures too", () => {
  test("syncTurn counts turn_sync and still syncs into the same scope", async () => {
    const brain = fakeBrain();
    const provider = new BrainMemoryProvider({ call: brain.call as never } as never);
    const synced: string[] = [];
    (provider as unknown as { syncTurnIn: unknown }).syncTurnIn = async (_t: unknown, w: BrainScope) => {
      synced.push(w.sourceId);
    };
    const write: BrainScope = { clientId: AGENT, sourceId: agentSourceId(AGENT), allowedSources: [agentSourceId(AGENT)] };
    const mem = makeScopedMemory({
      provider: () => provider,
      ready: async () => {},
      scopeFor: async () => ({ read: write, write, place: PLACE, agentId: AGENT }),
      onSynced: async () => {},
    });
    const before = total("turn_sync", "would-write-place");
    await mem.syncTurn({ sessionId: "s1", user: "hi", assistant: "yo" } as never);
    expect(synced).toEqual([agentSourceId(AGENT)]);
    expect(total("turn_sync", "would-write-place")).toBe(before + 1);
  });
});

