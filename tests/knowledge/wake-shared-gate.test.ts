/**
 * A turn with no user (a wake, a cron, a background pass) writes to `shared` only to CREATE a page
 * that does not exist there yet. Changing an existing shared page (overwrite, supersede, delete) is
 * refused with a message to ask in the channel, since a wake has nobody to answer a card. Interactive
 * turns are unchanged. An existence check that fails refuses (fail closed).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { classifyBrainOp, gatedBrainCall, resetStandingGrants, WAKE_SHARED_REFUSAL, type GateInput } from "../../src/knowledge/gated-dispatch";
import { brainHandlers, type BrainToolDeps } from "../../src/knowledge/mcp-tools";
import { agentSourceId, resolveBrainScope, SHARED_SOURCE, type BrainScope } from "../../src/knowledge/scope";
import { NO_PLACE } from "../../src/memory/place";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "AGENT1";
beforeAll(() => {
  process.env.SLAUDE_AGENT_ID ??= AGENT;
});
beforeEach(() => resetStandingGrants());

const gate = (o: Partial<GateInput> = {}): GateInput => ({
  userId: null, teamId: null, interactive: false, lockedUser: null, channelTrust: "trusted", isManager: false, place: NO_PLACE, agentId: AGENT, ...o,
});
const shared = async (g: GateInput): Promise<BrainScope> => ({ ...(await resolveBrainScope({ ...g, kbSources: [] })), sourceId: SHARED_SOURCE });
const exists = (...have: string[]) => ({ slugs: ["notes/a"], exists: async (s: string) => have.includes(s) });

describe("classifyBrainOp: a turn with no user writing to shared", () => {
  test("a page that does not exist yet is automatic", async () => {
    const g = gate();
    expect(await classifyBrainOp("put_page", await shared(g), g, exists())).toBe("auto");
  });
  test("a page that exists is refused", async () => {
    const g = gate();
    expect(await classifyBrainOp("put_page", await shared(g), g, exists("notes/a"))).toBe("deny");
  });
  test("a batch is automatic only when every page is new", async () => {
    const g = gate();
    const w = { slugs: ["notes/a", "notes/b"], exists: async (s: string) => s === "notes/b" };
    expect(await classifyBrainOp("put_page", await shared(g), g, w)).toBe("deny");
  });
  test("a supersede is a change to an existing page: refused even when the new slug is new", async () => {
    const g = gate();
    expect(await classifyBrainOp("put_page", await shared(g), g, { ...exists(), modifies: true })).toBe("deny");
  });
  test("a failed existence check refuses (fail closed)", async () => {
    const g = gate();
    const w = { slugs: ["notes/a"], exists: async () => { throw new Error("brain down"); } };
    expect(await classifyBrainOp("put_page", await shared(g), g, w)).toBe("deny");
  });
  test("with no way to check, a write to shared is refused", async () => {
    const g = gate();
    expect(await classifyBrainOp("put_page", await shared(g), g)).toBe("deny");
    expect(await classifyBrainOp("add_tag", await shared(g), g)).toBe("deny");
  });
  test("a delete of a shared page is refused, never carded", async () => {
    const g = gate();
    expect(await classifyBrainOp("delete_page", await shared(g), g, exists("notes/a"))).toBe("deny");
  });
  test("a write to the agent's own slice is still automatic, and a delete there is still a card", async () => {
    const g = gate();
    const own = await resolveBrainScope({ ...g, kbSources: [] });
    expect(own.sourceId).toBe(agentSourceId(AGENT));
    expect(await classifyBrainOp("put_page", own, g)).toBe("auto");
    expect(await classifyBrainOp("delete_page", own, g)).toBe("approval");
  });
  test("an interactive turn is unchanged: shared cards, and the existence check is never consulted", async () => {
    const g = gate({ userId: "U1", interactive: true, isManager: true });
    let asked = 0;
    const w = { slugs: ["notes/a"], exists: async () => { asked++; return true; } };
    expect(await classifyBrainOp("put_page", await shared(g), g, w)).toBe("approval");
    expect(asked).toBe(0);
  });
  test("a locked thread still denies a turn with no user, whatever the page", async () => {
    const g = gate({ lockedUser: "U1" });
    expect(await classifyBrainOp("put_page", await shared(g), g, exists())).toBe("deny");
  });
});

describe("gatedBrainCall: the refusal tells the agent to ask in the channel", () => {
  test("message", async () => {
    const g = gate();
    let called = false;
    const r = await gatedBrainCall("put_page", { scope: await shared(g), gate: g, managers: ["UMGR"], requestApproval: async () => ({ approved: true, by: "UMGR" }), call: async () => { called = true; return 1; }, describe: "x", write: exists("notes/a") });
    expect(r).toEqual({ ok: false, reason: WAKE_SHARED_REFUSAL });
    expect(WAKE_SHARED_REFUSAL).toMatch(/Ask in the channel/);
    expect(called).toBe(false);
  });
  test("a new page goes through without a card", async () => {
    const g = gate();
    let cards = 0;
    const r = await gatedBrainCall("put_page", { scope: await shared(g), gate: g, managers: ["UMGR"], requestApproval: async () => { cards++; return { approved: true, by: "UMGR" }; }, call: async () => "done", describe: "x", write: exists() });
    expect(r).toEqual({ ok: true, result: "done" });
    expect(cards).toBe(0);
  });
});

describe("memory_save target shared from a wake, end to end", () => {
  function setup() {
    const brain = fakeBrain();
    const g = gate({ channelTrust: "trusted" });
    let cards = 0;
    const deps: BrainToolDeps = {
      scope: async () => resolveBrainScope({ ...g, kbSources: [] }),
      gate: () => g,
      managers: () => ["UMGR"],
      requestApproval: async () => { cards++; return { approved: true, by: "UMGR" }; },
      call: (name, params, scope) => brain.call(name, params, scope),
    };
    return { deps, cards: () => cards };
  }
  const page = (slug: string, extra: object = {}) => ({ slug, content: "fact", summary: "s", ...extra });

  test("creates once, then refuses to overwrite, with no card either time", async () => {
    const s = setup();
    const first = await brainHandlers.kb_memoize({ pages: [page("notes/team-fact")], target: "shared" }, s.deps);
    expect(first.isError).toBeUndefined();
    const again = await brainHandlers.kb_memoize({ pages: [page("notes/team-fact")], target: "shared" }, s.deps);
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toBe(WAKE_SHARED_REFUSAL);
    expect(s.cards()).toBe(0);
  });

  test("a supersede of an existing shared page is refused", async () => {
    const s = setup();
    await brainHandlers.kb_memoize({ pages: [page("notes/old", { type: "team-fact" })], target: "shared" }, s.deps);
    const r = await brainHandlers.kb_memoize({ pages: [page("notes/new", { type: "team-fact", supersedes: "notes/old" })], target: "shared" }, s.deps);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(WAKE_SHARED_REFUSAL);
  });

  test("memory delete from a wake reaches the agent's own slice only, so it is a card as before, never shared", async () => {
    const s = setup();
    const r = await brainHandlers.kb_delete_page({ slug: "notes/x", reason: "stale" }, s.deps);
    expect(r.content[0]!.text).not.toBe(WAKE_SHARED_REFUSAL);
    expect(s.cards()).toBe(1);
  });

  test("a mine write (the agent's own slice) is unaffected", async () => {
    const s = setup();
    const r = await brainHandlers.kb_memoize({ pages: [page("notes/mine")] }, s.deps);
    expect(r.isError).toBeUndefined();
  });
});
