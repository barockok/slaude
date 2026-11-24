/** The nightly review per place (rc.47): one pass per place with activity that day, from the registry; legacy run unchanged. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Sessions from "../../src/db/sessions";
import { runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import type { PriceTable } from "../../src/background/prices";
import { conversationSlug } from "../../src/memory/brain-provider";
import { collectDay, runNightlyReview, type NightlyDeps } from "../../src/background/passes/nightly-review";
import { placeSourceId } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";
import { fakeBrain } from "./fake-brain";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
const TURN = { input_tokens: 300_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const AGENT = "UAGENT1";
const A = "agent-uagent1";
const P1 = placeSourceId(AGENT, "b1");
const P2 = placeSourceId(AGENT, "b2");
const DAY = Date.parse("2026-10-25T12:00:00Z");

const row = (id: number, user: string, text: string) => ({
  id, date: "2026-10-25", created_at: "2026-10-25T11:00:00Z", summary: text.slice(0, 40),
  detail: `<user><channel source="slack" channel_id="C0CHAN" thread_ts="1.0" inbound_ts="1.0" user_id="${user}" trust="trusted">\n${text}\n</channel></user>\n<assistant>ok</assistant>`,
});
async function session(channel: string, ts: string): Promise<string> {
  const s = await Sessions.createForThread({ thread: { team_id: "T0TEAM", channel_id: channel, thread_ts: ts, persona_id: "default" }, model: MODEL, working_dir: "/tmp" });
  await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [DAY, s.id]);
  return s.id;
}
function thread(brain: ReturnType<typeof fakeBrain>, source: string, sid: string, rows: unknown[]) {
  brain.seed(source, conversationSlug(sid), "---\ntype: conversation\n---\n# c\n");
  brain.seedTimeline(source, conversationSlug(sid), rows);
}
async function bind(source: string, boundary: string) {
  await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", [source, AGENT, boundary, "channel", 1]);
}

function harness(brain: ReturnType<typeof fakeBrain>, o: { on: boolean }) {
  const seen: Array<{ spec: PassSpec; sources: Set<string> }> = [];
  let cur: PassSpec | null = null;
  let t = Date.parse("2026-10-26T02:30:00Z");
  const query = ((args: { prompt: AsyncIterable<unknown>; options: { mcpServers: Record<string, { instance: { _registeredTools: Record<string, { handler: Function }> } }> } }) =>
    (async function* () {
      for await (const _ of args.prompt) void _;
      const tools = args.options.mcpServers.slaude_pass!.instance._registeredTools;
      const before = brain.calls.length;
      await tools.search!.handler({ query: "anything" }, {});
      await tools.memoize!.handler({ pages: [{ slug: "self/lesson-proposals", content: "- 2026-10-25 a lesson (source: thread; evidence: correction)", type: "correction" }] }, {});
      seen.push({ spec: cur!, sources: new Set(brain.calls.slice(before).flatMap((c) => [c.scope.sourceId, ...c.scope.allowedSources])) });
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${seen.length}`, usage: TURN, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: TURN };
    })()) as unknown as RunnerDeps["query"];
  const runner: RunnerDeps = { query, brainCall: brain.call, now: () => new Date((t += 1000)), priceTable: TABLE, model: () => MODEL, budget: () => ({ limitUsd: 50, timeZone: "UTC" }), kbSources: () => [], provider: async () => null };
  const deps: NightlyDeps = { runner, call: brain.call, listSources: async () => [], placesOn: () => o.on, run: (spec, d) => ((cur = spec), runPass(spec, d)) };
  return { deps, seen };
}
const group = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };

let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(async () => {
  __resetPlaceBindingForTests();
  for (const t of ["background_slots", "background_runs", "sessions", "memory_scopes"]) await db.run(`DELETE FROM ${t}`);
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

async function seed() {
  await bind(P1, "b1");
  await bind(P2, "b2");
  const brain = fakeBrain();
  const s1 = await session("C0ONE", "1.1");
  const s2 = await session("C0TWO", "1.2");
  const s3 = await session("C0OLD", "1.3"); // pre-switch page in agent-<id>
  thread(brain, P1, s1, [row(1, "U0CAROL", "place one talk")]);
  thread(brain, P2, s2, [row(1, "U0DAVE", "place two talk")]);
  thread(brain, A, s3, [row(1, "U0ERIN", "legacy persona slice talk")]);
  return { brain };
}

describe("collectDay per place", () => {
  test("on: one set of turns per place with activity, each place only its own", async () => {
    const { brain } = await seed();
    const { deps } = harness(brain, { on: true });
    const day = await collectDay(group, "2026-10-25", deps);
    expect(day.places.map((p) => p.source).sort()).toEqual([P1, P2].sort());
    const text = (src: string) => day.places.find((p) => p.source === src)!.turns.map((t) => t.text).join("\n");
    expect(text(P1)).toContain("place one talk");
    expect(text(P1)).not.toContain("place two talk");
    expect(text(P2)).not.toContain("place one talk");
    // the legacy agent slice is still collected for pages written before the switch
    expect(day.agent.map((t) => t.text).join("\n")).toContain("legacy persona slice talk");
    expect(day.agent.map((t) => t.text).join("\n")).not.toContain("place one talk");
  });
  test("a place with no activity that day gets no run; a source the registry does not bind to this agent is never read", async () => {
    const { brain } = await seed();
    await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", ["mb-quiet", AGENT, "bq", "channel", 1]);
    await db.run("UPDATE memory_scopes SET agent_id = 'OTHER' WHERE source_id = ?", [P2]);
    const { deps } = harness(brain, { on: true });
    const day = await collectDay(group, "2026-10-25", { ...deps, places: async () => ["mb-quiet", P1, P2] });
    expect(day.places.map((p) => p.source)).toEqual([P1]);
    expect(brain.touched().has(P2)).toBe(false);
  });
  test("not on (off, shadow or a persona outside the canary): no place is read and the result is the legacy one", async () => {
    const { brain } = await seed();
    const { deps } = harness(brain, { on: false });
    const day = await collectDay(group, "2026-10-25", deps);
    expect(day.places).toEqual([]);
    expect(brain.touched().has(P1)).toBe(false);
    expect(brain.touched().has(P2)).toBe(false);
    expect(day.agent.map((t) => t.text).join("\n")).toContain("legacy persona slice talk");
  });
});

describe("runNightlyReview per place", () => {
  test("on: one pass per place plus the legacy agent pass; each place pass reads its place and the tiers and writes its proposals there", async () => {
    const { brain } = await seed();
    const { deps, seen } = harness(brain, { on: true });
    const res = await runNightlyReview({ ...group, slot: "2026-10-26" }, deps);
    expect(res.map((r) => r.scope).sort()).toEqual(["agent", `place:${P1}`, `place:${P2}`].sort());
    const p1 = seen.find((s) => s.spec.scope.kind === "place" && s.spec.scope.source === P1)!;
    expect(p1.sources.has(P1)).toBe(true);
    expect(p1.sources.has(P2)).toBe(false);
    expect(p1.spec.transcripts?.map((t) => t.text).join("\n")).toContain("place one talk");
    expect(brain.pages.get(P1)!.has("self/lesson-proposals")).toBe(true);
    expect(brain.pages.get(P2)!.has("self/lesson-proposals")).toBe(true);
    for (const s of seen.filter((x) => x.spec.scope.kind !== "place")) expect(s.sources.has(P1) || s.sources.has(P2)).toBe(false);
  });
  test("not on: exactly the legacy runs", async () => {
    const { brain } = await seed();
    const { deps } = harness(brain, { on: false });
    const res = await runNightlyReview({ ...group, slot: "2026-10-26" }, deps);
    expect(res.map((r) => r.scope)).toEqual(["agent"]);
  });
});
