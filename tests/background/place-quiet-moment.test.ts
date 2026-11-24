/** Pass scopes for memory places (rc.47): thread_activity `place:<source>`, the quiet-moment summary beside the page in the place. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as Sessions from "../../src/db/sessions";
import * as ThreadActivity from "../../src/db/thread-activity";
import { runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import { PLACE_LESSONS_REFUSAL, passReadSources, passWriteSource } from "../../src/background/pass-tools";
import type { PriceTable } from "../../src/background/prices";
import { conversationSlug, conversationSummarySlug } from "../../src/memory/brain-provider";
import type { NightlyDeps } from "../../src/background/passes/nightly-review";
import { passScopeOf, runQuietMoment, SUMMARY_TOOL } from "../../src/background/passes/quiet-moment";
import { placeSourceId } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";
import { fakeBrain } from "./fake-brain";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
const TURN = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const AGENT = "UAGENT1";
const A = "agent-uagent1";
const PS = placeSourceId(AGENT, "bnd1");
const NOW = Date.parse("2026-10-26T15:00:00Z");
const MIN = 60_000;
const group = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC", slot: "x" };

const row = (id: number, user: string, text: string) => ({
  id, date: "2026-10-26", created_at: new Date(NOW - 60 * MIN + id * MIN).toISOString(), summary: text.slice(0, 50),
  detail: `<user><channel source="slack" channel_id="C0CHAN" thread_ts="1.0" inbound_ts="1.0" user_id="${user}" trust="trusted">\n${text}\n</channel></user>\n<assistant>noted</assistant>`,
});

function harness(brain: ReturnType<typeof fakeBrain>, onPass?: (tools: Record<string, { handler: Function }>) => Promise<void>) {
  const seen: PassSpec[] = [];
  let cur: PassSpec | null = null;
  let t = NOW;
  const query = ((args: { prompt: AsyncIterable<unknown>; options: { mcpServers: Record<string, { instance: { _registeredTools: Record<string, { handler: Function }> } }> } }) =>
    (async function* () {
      for await (const _ of args.prompt) void _;
      const tools = args.options.mcpServers.slaude_pass!.instance._registeredTools;
      seen.push(cur!);
      if (onPass) await onPass(tools);
      else await tools[SUMMARY_TOOL]!.handler({ content: "The thread planned a release." }, {});
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "m1", usage: TURN, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: TURN };
    })()) as unknown as RunnerDeps["query"];
  const runner: RunnerDeps = { query, brainCall: brain.call, now: () => new Date((t += 1000)), priceTable: TABLE, model: () => MODEL, budget: () => ({ limitUsd: 5, timeZone: "UTC" }), kbSources: () => [], provider: async () => null };
  const deps: NightlyDeps = { runner, call: brain.call, listSources: async () => [], run: (spec, d) => ((cur = spec), runPass(spec, d)) };
  return { deps, seen };
}

async function bind(source = PS, boundary = "bnd1") {
  await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", [source, AGENT, boundary, "channel", 1]);
}

let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(async () => {
  __resetPlaceBindingForTests();
  for (const t of ["background_slots", "background_runs", "thread_activity", "sessions", "memory_scopes"]) await db.run(`DELETE FROM ${t}`);
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe("thread_activity scope", () => {
  test("a write to one of the agent's places is place:<source>; the persona slice, a person and the rest are as before", () => {
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: PS, allowedSources: [PS], placeAgent: AGENT }, AGENT)).toBe(`place:${PS}`);
    // a place with no owning agent, or another agent's, is not a scope any pass reviews
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: PS, allowedSources: [PS] }, AGENT)).toBeNull();
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: PS, allowedSources: [PS], placeAgent: "OTHER" }, AGENT)).toBeNull();
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: A, allowedSources: [A] }, AGENT)).toBe("agent");
    expect(ThreadActivity.activityScopeOf({ clientId: "U1", sourceId: "user-u1", allowedSources: ["user-u1"] }, AGENT)).toBe("user:U1");
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: "public", allowedSources: ["public"] }, AGENT)).toBeNull();
  });
  test("passScopeOf takes place:<source> only for a well formed place source", () => {
    expect(passScopeOf(`place:${PS}`, "T")).toEqual({ kind: "place", source: PS });
    expect(passScopeOf("place:agent-uagent1", "T")).toBeNull();
    expect(passScopeOf("place:", "T")).toBeNull();
    expect(passScopeOf("agent", "T")).toEqual({ kind: "agent" });
    expect(passScopeOf("user:U1", "T1")).toEqual({ kind: "user", userId: "U1", teamId: "T1" });
    expect(passScopeOf("nonsense", "T")).toBeNull();
  });
  test("a turn in another scope restarts the count (place after agent)", async () => {
    await ThreadActivity.recordTurn({ sessionId: "S", agentId: AGENT, scope: "agent", at: 1 });
    await ThreadActivity.recordTurn({ sessionId: "S", agentId: AGENT, scope: `place:${PS}`, at: 2 });
    expect((await ThreadActivity.get("S"))?.turns).toBe(1);
  });
});

describe("pass scope place", () => {
  test("reads the place then the tiers, writes the place alone", () => {
    expect(passReadSources({ kind: "place", source: PS }, AGENT, ["kb-x"])).toEqual([PS, A, "agent", "shared", "public", "kb-x"]);
    expect(passWriteSource({ kind: "place", source: PS }, AGENT)).toBe(PS);
    expect(() => passReadSources({ kind: "place", source: "agent-x" }, AGENT, [])).toThrow();
  });
});

describe("runQuietMoment over a place", () => {
  async function setup() {
    await bind();
    const brain = fakeBrain();
    const s = await Sessions.createForThread({ thread: { team_id: "T0TEAM", channel_id: "C0CHAN", thread_ts: "2.1", persona_id: "default" }, model: MODEL, working_dir: "/tmp" });
    const slug = conversationSlug(s.id);
    brain.seed(PS, slug, "---\ntype: conversation\n---\n# c\n");
    brain.seedTimeline(PS, slug, [row(1, "U0CAROL", "the deploy failed again"), row(2, "U0DAVE", "I will look")]);
    await ThreadActivity.recordTurn({ sessionId: s.id, agentId: AGENT, scope: `place:${PS}`, at: NOW - 40 * MIN });
    return { brain, sid: s.id };
  }

  test("the summary is written beside the conversation page in the same place, with the owning agent on the scope", async () => {
    const { brain, sid } = await setup();
    const { deps, seen } = harness(brain);
    const res = await runQuietMoment({ ...group, slot: `${sid}@${NOW - 40 * MIN}` }, deps);
    expect(res?.summarized).toBe(true);
    expect(seen[0]!.scope).toEqual({ kind: "place", source: PS });
    expect(brain.pages.get(PS)!.has(conversationSummarySlug(sid))).toBe(true);
    expect(brain.pages.get(A)?.has(conversationSummarySlug(sid)) ?? false).toBe(false);
    for (const c of brain.calls.filter((c) => c.name === "put_page")) expect(c.scope).toMatchObject({ sourceId: PS, allowedSources: [PS], placeAgent: AGENT });
    expect((await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26")).map((r) => r.scope)).toEqual([`place:${PS}`]);
  });

  test("a place the registry does not bind to this agent runs nothing", async () => {
    const { brain, sid } = await setup();
    await db.run("DELETE FROM memory_scopes");
    __resetPlaceBindingForTests();
    const { deps, seen } = harness(brain);
    expect(await runQuietMoment({ ...group, slot: `${sid}@${NOW - 40 * MIN}` }, deps)).toBeNull();
    expect(seen).toHaveLength(0);
  });

  test("a place pass may propose a lesson as a correction page in its place but cannot write the lessons page", async () => {
    const { brain, sid } = await setup();
    let lessons = "";
    let correction = "";
    const { deps } = harness(brain, async (tools) => {
      lessons = (await tools.memoize!.handler({ pages: [{ slug: "self/lessons", content: "- x", type: "lessons" }] }, {})).content[0].text;
      correction = (await tools.memoize!.handler({ pages: [{ slug: "self/lesson-proposals", content: "- 2026-10-26 keep replies short (source: thread; evidence: correction)", type: "correction" }] }, {})).content[0].text;
      await tools[SUMMARY_TOOL]!.handler({ content: "s" }, {});
    });
    await runQuietMoment({ ...group, slot: `${sid}@${NOW - 40 * MIN}` }, deps);
    expect(lessons).toBe(PLACE_LESSONS_REFUSAL);
    expect(correction).toContain("written");
    expect(brain.pages.get(PS)!.has("self/lesson-proposals")).toBe(true);
    expect(brain.pages.get(A)?.has("self/lesson-proposals") ?? false).toBe(false);
  });
});
