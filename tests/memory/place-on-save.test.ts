/** memory_save targets under `on`: here, persona (promote), provenance, the unknown-place marker (rc.46). */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { resetStandingGrants, type ApprovalReq, type GateInput } from "../../src/knowledge/gated-dispatch";
import { parseFrontmatter } from "../../src/knowledge/memory-pages";
import { agentSourceId, resolveBrainScope, userSourceId } from "../../src/knowledge/scope";
import { kbContract } from "../../src/tools/contracts/kb";
import { metrics } from "../../src/metrics";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";
import { fakeBrain } from "./fake-brain";

const AGENT = "AGENT1";
const A = agentSourceId(AGENT);
const PLACE: PlaceRef = { kind: "place", source: placeSourceId(AGENT, "b1"), boundaryId: "b1", boundaryKind: "channel" };
const P = PLACE.kind === "place" ? PLACE.source : "";

beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(async () => {
  resetStandingGrants();
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});

function setup(over: Partial<GateInput> = {}, approver = "U0MGR") {
  const brain = fakeBrain();
  const writes: Array<{ source: string; slug: string }> = [];
  const cards: ApprovalReq[] = [];
  const g: GateInput = {
    userId: "U0ALICE", teamId: "T0TEAM", interactive: true, origin: "slack", lockedUser: null, channelTrust: "trusted", isManager: false,
    place: PLACE, placesOn: true, agentId: AGENT, threadKey: "C0CHAN:1.1", turnSenders: [{ userId: "U0ALICE", teamId: "T0TEAM", origin: "slack" }], ...over,
  };
  const deps: BrainToolDeps = {
    scope: async () => resolveBrainScope({ ...g, kbSources: [] }),
    gate: () => g,
    managers: () => ["U0MGR", "U0GRANTED"],
    promoteApprovers: () => ["U0MGR"],
    internalUserRef: async (_t, u) => `user-ref-${u.toLowerCase()}`,
    requestApproval: async (r) => (cards.push(r), { approved: true, by: approver }),
    call: async (name, params, scope) => {
      if (name === "put_page") writes.push({ source: scope.sourceId, slug: String(params.slug) });
      return brain.call(name, params, scope);
    },
  };
  return { deps, writes, brain, cards };
}

describe("target here", () => {
  test("writes the place, by default and as mine; a typed page carries provenance, an untyped one is unchanged", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [
      { slug: "notes/a", content: "plain text", summary: "s" },
      { slug: "notes/b", content: "typed body", summary: "s", type: "outcome" },
    ] }, s.deps);
    expect(r.isError).toBeUndefined();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/c", content: "x", summary: "s" }], target: "mine" }, s.deps);
    expect(s.writes.map((w) => w.source)).toEqual([P, P, P]);
    expect(s.brain.contentOf(P, "notes/a")).toBe("plain text");
    const meta = parseFrontmatter(s.brain.contentOf(P, "notes/b")!).meta;
    expect(meta).toMatchObject({ type: "outcome", origin_scope: P, origin_kind: "channel", written_by: "turn" });
    expect(meta.place).toBeUndefined();
  });

  test("a wake writes the place too, marked written_by wake", async () => {
    const s = setup({ userId: null, teamId: null, interactive: false, turnSenders: undefined });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/w", content: "x", summary: "s", type: "outcome" }] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.writes).toEqual([{ source: P, slug: "notes/w" }]);
    expect(parseFrontmatter(s.brain.contentOf(P, "notes/w")!).meta.written_by).toBe("wake");
  });

  test("an unknown place writes the persona-wide tier with place unknown, typed or not, and is counted", async () => {
    const s = setup({ place: { kind: "none", reason: "lookup-failed" } });
    const before = metrics.render().split("\n").find((l) => l.startsWith("slaude_memory_place_fallback_write_total{") && l.includes('reason="lookup-failed"'));
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/u", content: "plain", summary: "s" }, { slug: "notes/t", content: "body", summary: "s", type: "outcome" }] }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.writes.map((w) => w.source)).toEqual([A, A]);
    expect(parseFrontmatter(s.brain.contentOf(A, "notes/u")!).meta.place).toBe("unknown");
    expect(parseFrontmatter(s.brain.contentOf(A, "notes/t")!).meta.place).toBe("unknown");
    const line = metrics.render().split("\n").find((l) => l.startsWith("slaude_memory_place_fallback_write_total{") && l.includes('reason="lookup-failed"'));
    expect(Number(line?.split(" ").pop())).toBe(Number(before?.split(" ").pop() ?? 0) + 2);
  });

  test("with the mode off a page is written exactly as before: same source, same bytes, no stamp", async () => {
    const s = setup({ placesOn: false });
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/a", content: "plain", summary: "s" }, { slug: "notes/b", content: "body", summary: "s", type: "outcome" }] }, s.deps);
    expect(s.writes.map((w) => w.source)).toEqual([A, A]);
    expect(s.brain.contentOf(A, "notes/a")).toBe("plain");
    expect(Object.keys(parseFrontmatter(s.brain.contentOf(A, "notes/b")!).meta).sort()).toEqual(["as_of", "type"]);
  });
});

describe("target persona (promote)", () => {
  const page = { slug: "notes/p", content: "A stand-alone fact.", summary: "promote it", type: "outcome" };

  test("a manager card shows the exact text, then a copy lands in agent-<id> with provenance; the original stays", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/p", content: "local wording", summary: "s", type: "outcome" }] }, s.deps);
    const r = await brainHandlers.kb_memoize({ pages: [page], target: "persona" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.cards.length).toBe(1);
    expect(s.cards[0]!.category).toBe("kb-admin");
    expect(s.cards[0]!.summary).toContain("A stand-alone fact.");
    expect(s.cards[0]!.summary).toContain("promoted_from");
    expect(s.writes.at(-1)).toEqual({ source: A, slug: "notes/p" });
    const meta = parseFrontmatter(s.brain.contentOf(A, "notes/p")!).meta;
    expect(meta).toMatchObject({ promoted_from: P, promoted_by: "user-ref-u0mgr", origin_kind: "persona", written_by: "turn" });
    expect(meta.origin_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.brain.contentOf(P, "notes/p")).toContain("local wording");
  });

  test("origin_hash is none when the place has no page of that slug", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [page], target: "persona" }, s.deps);
    expect(parseFrontmatter(s.brain.contentOf(A, "notes/p")!).meta.origin_hash).toBe("none");
  });

  test("only the manager or backup may approve: a stored grant's approval is refused and nothing is written", async () => {
    const s = setup({}, "U0GRANTED");
    const r = await brainHandlers.kb_memoize({ pages: [page], target: "persona" }, s.deps);
    expect(r.isError).toBe(true);
    expect(s.writes.length).toBe(0);
  });

  test("a standing grant never covers it: every promotion asks", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/s", content: "x", summary: "s" }], target: "shared" }, s.deps);
    await brainHandlers.kb_memoize({ pages: [page], target: "persona" }, s.deps);
    await brainHandlers.kb_memoize({ pages: [{ ...page, slug: "notes/p2" }], target: "persona" }, s.deps);
    expect(s.cards.length).toBe(3);
  });

  test("a wake can never promote", async () => {
    const s = setup({ userId: null, teamId: null, interactive: false, turnSenders: undefined });
    const r = await brainHandlers.kb_memoize({ pages: [page], target: "persona" }, s.deps);
    expect(r.isError).toBe(true);
    expect(s.cards.length).toBe(0);
    expect(s.writes.length).toBe(0);
  });

  test("a promotion too long for the card is refused", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [{ ...page, content: "x".repeat(3000) }], target: "persona" }, s.deps);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("shown whole");
    expect(s.cards.length).toBe(0);
  });

  test("with no place to promote from, persona is a plain write to the persona tier", async () => {
    for (const o of [{ placesOn: false }, { place: { kind: "none", reason: "no-boundary" } as PlaceRef }]) {
      const s = setup(o);
      const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/q", content: "x", summary: "s" }], target: "persona" }, s.deps);
      expect(r.isError).toBeUndefined();
      expect(s.cards.length).toBe(0);
      expect(s.writes).toEqual([{ source: A, slug: "notes/q" }]);
    }
  });

  test("in a /1on1 persona writes nowhere beyond the person's own slice, and cards nothing", async () => {
    const s = setup({ lockedUser: "U0ALICE", channelTrust: "public" });
    const r = await brainHandlers.kb_memoize({ pages: [{ slug: "notes/q", content: "x", summary: "s" }], target: "persona" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.cards.length).toBe(0);
    expect(s.writes.map((w) => w.source)).toEqual([userSourceId("U0ALICE")]);
  });
});

describe("the tool contract", () => {
  test("accepts here, mine, persona, shared and profile, and tells the agent to rewrite a page to stand alone", () => {
    const target = kbContract.tools.memory_save.schema.target;
    for (const t of ["here", "mine", "persona", "shared", "profile"]) expect(target.safeParse(t).success).toBe(true);
    expect(target.safeParse("everywhere").success).toBe(false);
    expect(kbContract.tools.memory_save.description).toContain("stands alone");
  });
});

describe("demote: memory_delete target persona", () => {
  const page = { slug: "notes/p", content: "A stand-alone fact.", summary: "promote it", type: "outcome" };
  const deletes = (s: ReturnType<typeof setup>) => {
    const out: string[] = [];
    const call = s.deps.call!;
    s.deps.call = async (name, params, scope) => {
      if (name === "delete_page") out.push(`${scope.sourceId}:${String(params.slug)}`);
      return name === "delete_page" ? { ok: true } : call(name, params, scope);
    };
    return out;
  };
  test("a manager card, then the persona copy is deleted and the original stays", async () => {
    const s = setup();
    const del = deletes(s);
    await brainHandlers.kb_memoize({ pages: [{ ...page, content: "local" }], target: "here" }, s.deps);
    await brainHandlers.kb_memoize({ pages: [page], target: "persona" }, s.deps);
    s.cards.length = 0;
    const r = await brainHandlers.kb_delete_page({ slug: "notes/p", reason: "stale", target: "persona" }, s.deps);
    expect(r.isError).toBeUndefined();
    expect(s.cards.length).toBe(1);
    expect(del).toEqual([`${A}:notes/p`]);
    expect(s.brain.contentOf(P, "notes/p")).toContain("local");
  });
  test("a page that was never promoted, a wake, or approval by a stored grant is refused", async () => {
    const s = setup();
    const del = deletes(s);
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/own", content: "x", summary: "s" }], target: "here" }, s.deps);
    expect((await brainHandlers.kb_delete_page({ slug: "notes/own", reason: "r", target: "persona" }, s.deps)).isError).toBe(true);
    const w = setup({ userId: null, teamId: null, interactive: false, turnSenders: undefined });
    expect((await brainHandlers.kb_delete_page({ slug: "notes/p", reason: "r", target: "persona" }, w.deps)).isError).toBe(true);
    const g = setup({}, "U0GRANTED");
    const gdel = deletes(g);
    await g.brain.call("put_page", { slug: "notes/p", content: '---\npromoted_from: "x"\n---\nbody' }, { clientId: AGENT, sourceId: A, allowedSources: [A] });
    const refused = await brainHandlers.kb_delete_page({ slug: "notes/p", reason: "r", target: "persona" }, g.deps);
    expect(refused.isError).toBe(true);
    expect(del.length + gdel.length).toBe(0);
  });
  test("target here is the unchanged delete in the turn's own source", async () => {
    const s = setup();
    const del = deletes(s);
    await brainHandlers.kb_memoize({ pages: [{ slug: "notes/own", content: "x", summary: "s" }], target: "here" }, s.deps);
    await brainHandlers.kb_delete_page({ slug: "notes/own", reason: "r" }, s.deps);
    expect(del).toEqual([`${P}:notes/own`]);
  });
});
