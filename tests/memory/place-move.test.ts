/** The move job (rc.47): attributes pages of agent-<id> to one place, copies, never deletes, lists the rest; idempotent. Fake brain only. */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import { agentSourceId } from "../../src/knowledge/scope";
import { applyMove, formatMove, planMove, type MoveDeps } from "../../src/memory/place-move";
import { placeSourceId, type PlaceRef } from "../../src/memory/place";
import { __resetPlaceBindingForTests, bindPlace } from "../../src/memory/place-binding";
import { main } from "../../src/cli/memory-places";
import { fakeBrain } from "../background/fake-brain";

const AGENT = "UAGENT1";
const A = agentSourceId(AGENT);
const TEAM = "T0TEAM";
const refFor = (channel: string): Extract<PlaceRef, { kind: "place" }> => ({ kind: "place", source: placeSourceId(AGENT, `b-${channel}`), boundaryId: `b-${channel}`, boundaryKind: "channel" });
const SECRET = "TOP-SECRET-PAGE-TEXT";

const commit = (thread: string | null) => `---\ntype: commitment\nstatus: open\npromiser: ${AGENT}\nbeneficiary: U0BOB\n${thread ? `thread: ${thread}\n` : ""}---\n${SECRET} ship it\n`;
const conv = (sid: string) => `---\ntype: conversation\n---\n# Conversation ${sid}\n`;
const row = (id: number, text: string) => ({ id, date: "2026-11-01", summary: text, detail: `<user>${text}</user>\n<assistant>ok</assistant>` });

function world() {
  const brain = fakeBrain();
  brain.seed(A, "self/heartbeat/c0one", `---\ntype: heartbeat\n---\n${SECRET} checklist one`);
  brain.seed(A, "self/heartbeat/c0nowhere", `---\ntype: heartbeat\n---\n${SECRET} checklist of an unseen channel`);
  brain.seed(A, "conversations/s-1", conv("s-1"));
  brain.seedTimeline(A, "conversations/s-1", [row(1, "first"), row(2, "second")]);
  brain.seed(A, "conversations/s-1/summary", `---\ntype: conversation-summary\n---\n${SECRET} summary`);
  brain.seed(A, "conversations/s-9", conv("s-9"));
  brain.seed(A, "commitments/c1", commit("C0TWO:100.5"));
  brain.seed(A, "commitments/c2", commit(null));
  brain.seed(A, "commitments/c3", commit("C0AMBIG:1.1"));
  brain.seed(A, "self/lessons", `---\ntype: lessons\n---\n- 2026-11-01 be brief`);
  brain.seed(A, "people/u0bob", `---\ntype: person-note\n---\nnote`);
  const deps: MoveDeps = {
    agentId: AGENT,
    personaId: null,
    call: brain.call,
    listPages: async (source) => [...(brain.pages.get(source) ?? new Map()).entries()].map(([slug, p]) => ({ slug, type: p.type ?? "untyped" })),
    channels: async () => [
      { teamId: TEAM, channel: "C0ONE" }, { teamId: TEAM, channel: "C0TWO" }, { teamId: TEAM, channel: "C0THREE" },
      { teamId: "T0A", channel: "C0AMBIG" }, { teamId: "T0B", channel: "C0AMBIG" },
    ],
    session: async (id) => (id === "s-1" ? { teamId: TEAM, channel: "C0THREE", threadTs: "9.9" } : null),
    place: async (i) => (i.channel ? refFor(i.channel) : { kind: "none", reason: "no-boundary" }),
    bind: (p) => bindPlace(AGENT, p),
  };
  return { brain, deps };
}

beforeEach(async () => {
  __resetPlaceBindingForTests();
  await db.run("DELETE FROM memory_scopes");
});

describe("planMove", () => {
  test("attributes checklists, conversations, summaries and commitments; everything else is the review list", async () => {
    const { deps } = world();
    const plan = await planMove(deps);
    const by = (slug: string) => plan.items.find((i) => i.slug === slug);
    expect(by("self/heartbeat/c0one")).toMatchObject({ kind: "checklist", status: "new", place: refFor("C0ONE") });
    expect(by("conversations/s-1")).toMatchObject({ kind: "conversation", place: refFor("C0THREE") });
    expect(by("conversations/s-1/summary")).toMatchObject({ kind: "summary", place: refFor("C0THREE") });
    expect(by("commitments/c1")).toMatchObject({ kind: "commitment", place: refFor("C0TWO") });
    expect(plan.items).toHaveLength(4);
    const review = Object.fromEntries(plan.review.map((r) => [r.slug, r.reason]));
    expect(Object.keys(review).sort()).toEqual(["commitments/c2", "commitments/c3", "conversations/s-9", "people/u0bob", "self/heartbeat/c0nowhere", "self/lessons"].sort());
    expect(review["commitments/c2"]).toContain("no thread");
    expect(review["commitments/c3"]).toContain("more than one workspace");
    expect(review["conversations/s-9"]).toContain("no session row");
    expect(review["self/heartbeat/c0nowhere"]).toContain("unknown");
  });

  test("a dry run writes nothing, to the brain or the registry, and reads no place that is not bound", async () => {
    const { deps, brain } = world();
    await planMove(deps);
    expect(brain.calls.filter((c) => c.name === "put_page" || c.name === "add_timeline_entry")).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM memory_scopes")).length).toBe(0);
    expect([...brain.touched()].filter((s) => s.startsWith("mb-"))).toEqual([]);
  });
});

describe("applyMove", () => {
  test("copies each page into its own place, the conversation with its timeline, and deletes nothing", async () => {
    const { deps, brain } = world();
    const plan = await planMove(deps);
    const res = await applyMove(deps, plan);
    expect(res).toEqual({ copied: 4, failed: [] });
    const c1 = refFor("C0ONE").source;
    expect(brain.pages.get(c1)!.get("self/heartbeat/c0one")!.content).toContain("checklist one");
    expect(brain.pages.get(refFor("C0TWO").source)!.has("commitments/c1")).toBe(true);
    const three = refFor("C0THREE").source;
    expect(brain.pages.get(three)!.has("conversations/s-1")).toBe(true);
    expect(brain.pages.get(three)!.has("conversations/s-1/summary")).toBe(true);
    expect(brain.timelines.get(three)!.get("conversations/s-1")!.map((r) => (r as { summary: string }).summary)).toEqual(["first", "second"]);
    // nothing deleted, nothing written to the persona slice, nothing to a place that is not the page's own
    expect(brain.pages.get(A)!.size).toBe(10);
    expect(brain.calls.filter((c) => c.scope.sourceId === A && c.name !== "get_page" && c.name !== "get_timeline" && c.name !== "list_pages")).toEqual([]);
    expect(brain.calls.some((c) => c.name.startsWith("delete") || c.name === "remove_tag")).toBe(false);
    for (const c of brain.calls.filter((c) => c.name === "put_page" || c.name === "add_timeline_entry")) expect(c.scope).toMatchObject({ placeAgent: AGENT });
    // the places are bound in the registry
    expect((await db.query("SELECT 1 FROM memory_scopes")).length).toBe(3);
  });

  test("a second run copies nothing: idempotent", async () => {
    const { deps, brain } = world();
    await applyMove(deps, await planMove(deps));
    const writes = () => brain.calls.filter((c) => c.name === "put_page" || c.name === "add_timeline_entry").length;
    const before = writes();
    const plan2 = await planMove(deps);
    expect(plan2.items.every((i) => i.status === "there")).toBe(true);
    expect(await applyMove(deps, plan2)).toEqual({ copied: 0, failed: [] });
    expect(writes()).toBe(before);
    // and a stale plan applied twice does not duplicate the timeline either
    const stale = await planMove(world().deps);
    await applyMove(deps, { ...stale, items: stale.items.map((i) => ({ ...i, status: "new" as const })) });
    expect(brain.timelines.get(refFor("C0THREE").source)!.get("conversations/s-1")).toHaveLength(2);
  });

  test("a page the place already holds with other text is never overwritten and is a conflict", async () => {
    const { deps, brain } = world();
    const one = refFor("C0ONE");
    await bindPlace(AGENT, one);
    brain.seed(one.source, "self/heartbeat/c0one", "---\ntype: heartbeat\n---\nthe place's own checklist");
    const plan = await planMove(deps);
    expect(plan.items.find((i) => i.slug === "self/heartbeat/c0one")!.status).toBe("conflict");
    await applyMove(deps, plan);
    expect(brain.pages.get(one.source)!.get("self/heartbeat/c0one")!.content).toContain("the place's own checklist");
  });

  test("a conversation whose place holds fewer turns than the source is a conflict and is not copied over", async () => {
    const { deps, brain } = world();
    const three = refFor("C0THREE");
    await bindPlace(AGENT, three);
    brain.seedTimeline(three.source, "conversations/s-1", [row(1, "post-switch")]);
    const plan = await planMove(deps);
    expect(plan.items.find((i) => i.slug === "conversations/s-1")!.status).toBe("conflict");
    await applyMove(deps, plan);
    expect(brain.timelines.get(three.source)!.get("conversations/s-1")).toHaveLength(1);
  });

  test("a failure on one page is reported and the rest are copied", async () => {
    const { deps, brain } = world();
    const call = deps.call;
    const flaky: MoveDeps = { ...deps, call: async (n, p, s) => (n === "put_page" && p.slug === "commitments/c1" ? Promise.reject(new Error("boom")) : call(n, p, s)) };
    const res = await applyMove(flaky, await planMove(flaky));
    expect(res.copied).toBe(3);
    expect(res.failed).toEqual([{ slug: "commitments/c1", error: "boom" }]);
    expect(brain.pages.get(refFor("C0TWO").source)?.has("commitments/c1") ?? false).toBe(false);
  });
});

describe("the report never shows page text", () => {
  test("counts and slugs only", async () => {
    const { deps } = world();
    const plan = await planMove(deps);
    const dry = formatMove(plan, { apply: false });
    expect(dry).toContain("dry run");
    expect(dry).toContain("to copy: 4 (checklist 1, conversation 1, summary 1, commitment 1)");
    expect(dry).toContain("review list (stays persona-wide): 6");
    expect(dry).toContain("self/lessons");
    expect(dry).not.toContain(SECRET);
    expect(dry).not.toContain("be brief");
    const done = formatMove(plan, { apply: true, result: await applyMove(deps, plan) });
    expect(done).toContain("copied: 4; failed: 0; originals are kept");
    expect(done).not.toContain(SECRET);
  });
});

describe("slaude memory-places move", () => {
  const run = async (args: string[]) => {
    const { deps, brain } = world();
    const lines: string[] = [];
    const code = await main(args, { move: deps, out: (s) => lines.push(s) });
    return { code, text: lines.join("\n"), brain };
  };
  test("dry run by default: exit 0, nothing written", async () => {
    const r = await run(["move"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("dry run");
    expect(r.brain.calls.some((c) => c.name === "put_page")).toBe(false);
  });
  test("--apply copies", async () => {
    const r = await run(["move", "--apply"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("copied: 4");
    expect(r.brain.calls.filter((c) => c.name === "put_page")).toHaveLength(4);
  });
  test("a bad command or flag is a usage error, and a node refuses", async () => {
    const e = console.error;
    console.error = () => {};
    try {
      expect(await main([], { move: world().deps })).toBe(2);
      expect(await main(["move", "extra"], { move: world().deps })).toBe(2);
      expect(await main(["move", "--bogus"], { move: world().deps })).toBe(2);
      process.env.SLAUDE_ROLE = "node";
      expect(await main(["move"], { move: world().deps })).toBe(2);
    } finally {
      delete process.env.SLAUDE_ROLE;
      console.error = e;
    }
  });
  test("--json carries slugs and counts, no text", async () => {
    const r = await run(["move", "--json"]);
    const j = JSON.parse(r.text);
    expect(j.plan.items).toHaveLength(4);
    expect(r.text).not.toContain(SECRET);
  });
});
