/** Lessons upkeep across places (rc.47): code collects the proposals, the pass generalises text only, code validates every line. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import { runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import { LESSONS_REFUSAL, SOURCE_REFUSAL } from "../../src/background/pass-tools";
import type { PriceTable } from "../../src/background/prices";
import type { NightlyDeps } from "../../src/background/passes/nightly-review";
import { LESSONS_SLUG, NO_PROPOSALS, PROPOSALS_SLUG, WRITE_LESSONS_TOOL, collectProposals, runLessonsUpkeep } from "../../src/background/passes/lessons-upkeep";
import { placeSourceId } from "../../src/memory/place";
import { __resetPlaceBindingForTests } from "../../src/memory/place-binding";
import { fakeBrain } from "./fake-brain";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
const TURN = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const AGENT = "UAGENT1";
const A = "agent-uagent1";
const P1 = placeSourceId(AGENT, "b1");
const DMP = placeSourceId(AGENT, "bdm");
const SLOT = "2026-10-26";
const group = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };
const page = (body: string) => `---\ntype: correction\nas_of: 2026-10-26\n---\n${body}`;

async function bind(source: string, boundary: string, kind = "channel") {
  await db.run("INSERT INTO memory_scopes (source_id, agent_id, boundary_id, kind, created_at) VALUES (?, ?, ?, ?, ?)", [source, AGENT, boundary, kind, 1]);
}

type Tools = Record<string, { handler: Function }>;
function harness(brain: ReturnType<typeof fakeBrain>, o: { on: boolean; onPass?: (tools: Tools, spec: PassSpec, prompt: string) => Promise<void> }) {
  const seen: Array<{ spec: PassSpec; prompt: string; toolNames: string[] }> = [];
  let cur: PassSpec | null = null;
  let t = Date.parse("2026-10-26T03:00:00Z");
  const query = ((args: { prompt: AsyncIterable<{ message: { content: string } }>; options: { mcpServers: Record<string, { instance: { _registeredTools: Tools } }> } }) =>
    (async function* () {
      let prompt = "";
      for await (const m of args.prompt) prompt = m.message.content;
      const tools = args.options.mcpServers.slaude_pass!.instance._registeredTools;
      seen.push({ spec: cur!, prompt, toolNames: Object.keys(tools) });
      await o.onPass?.(tools, cur!, prompt);
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "m1", usage: TURN, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: TURN };
    })()) as unknown as RunnerDeps["query"];
  const runner: RunnerDeps = { query, brainCall: brain.call, now: () => new Date((t += 1000)), priceTable: TABLE, model: () => MODEL, budget: () => ({ limitUsd: 50, timeZone: "UTC" }), kbSources: () => [], provider: async () => null };
  const deps: NightlyDeps = { runner, call: brain.call, listSources: async () => [], placesOn: () => o.on, run: (spec, d) => ((cur = spec), runPass(spec, d)) };
  return { deps, seen };
}

let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(async () => {
  __resetPlaceBindingForTests();
  for (const t of ["background_slots", "background_runs", "memory_scopes"]) await db.run(`DELETE FROM ${t}`);
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

/** The handle the pass was given for the proposal holding `text`. */
const handle = (prompt: string, text: string): string => new RegExp(`\\] (P\\d+): [^\\n]*${text}`).exec(prompt)![1]!;
const L1 = "- 2026-10-25 check the deploy log before blaming the cache (source: thread with U0CAROL; evidence: correction)";
const L2 = "- 2026-10-24 never promise a date for a customer rollout (source: dm; evidence: pattern)";
const L3 = "- 2026-10-26 keep status replies short (source: thread; evidence: pattern)";
async function seed() {
  await bind(P1, "b1");
  await bind(DMP, "bdm", "dm");
  const brain = fakeBrain();
  brain.seed(P1, PROPOSALS_SLUG, page(`${L1}\n${L3}`));
  brain.seed(DMP, PROPOSALS_SLUG, page(L2));
  return brain;
}

describe("collectProposals", () => {
  test("reads the proposals page of every bound place (a manager DM place included), then the persona slice", async () => {
    const brain = await seed();
    brain.seed(A, PROPOSALS_SLUG, page("- 2026-10-20 an older persona-wide proposal"));
    const items = await collectProposals(AGENT, { call: brain.call });
    expect(items.map((i) => i.id)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(items.map((i) => `${i.source}|${i.date}`).sort()).toEqual([`${P1}|2026-10-25`, `${P1}|2026-10-26`, `${DMP}|2026-10-24`, `${A}|2026-10-20`].sort());
    // the persona slice's own page comes last
    expect(items[3]!.source).toBe(A);
  });
  test("a source the registry does not bind to this agent is never read; NO_PROPOSALS is nothing", async () => {
    const brain = await seed();
    brain.seed(placeSourceId(AGENT, "unbound"), PROPOSALS_SLUG, page("- 2026-10-25 sneaky"));
    const other = placeSourceId("OTHER", "bx");
    brain.seed(other, PROPOSALS_SLUG, page("- 2026-10-25 other agent"));
    brain.seed(A, PROPOSALS_SLUG, page(NO_PROPOSALS));
    const items = await collectProposals(AGENT, { call: brain.call, places: async () => [P1, DMP, placeSourceId(AGENT, "unbound"), other] });
    expect(items.map((i) => i.source)).toEqual([DMP, P1, P1]);
    expect(brain.touched().has(other)).toBe(false);
    expect(brain.touched().has(placeSourceId(AGENT, "unbound"))).toBe(false);
  });
});

describe("runLessonsUpkeep with places on", () => {
  test("the pass gets the proposal text, no search tool, no memoize, and reads no place", async () => {
    const brain = await seed();
    let readResult = "";
    const { deps, seen } = harness(brain, {
      on: true,
      onPass: async (tools) => {
        readResult = (await tools.read_pages!.handler({ slugs: [PROPOSALS_SLUG], source: P1 }, {})).content[0].text;
      },
    });
    const callsBefore = brain.calls.length;
    const r = await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    expect(r?.outcome).toBe("ok");
    expect(seen[0]!.spec.scope).toEqual({ kind: "agent" });
    expect(seen[0]!.toolNames.sort()).toEqual(["list_pages", "propose", "read_pages", WRITE_LESSONS_TOOL].sort());
    expect(readResult).toBe(SOURCE_REFUSAL);
    // the text of every proposal is in the transcript block, with a handle
    expect(seen[0]!.prompt).toContain("check the deploy log before blaming the cache");
    expect(seen[0]!.prompt).toContain("never promise a date");
    expect(seen[0]!.prompt).toMatch(/\] P\d+: /);
    // during the pass no brain call named a place source
    const passCalls = brain.calls.slice(callsBefore).filter((c) => c.scope.sourceId === P1 || c.scope.sourceId === DMP);
    // (collection happened before the pass started; the pass's own tools made none)
    expect(passCalls.every((c) => c.name === "get_page" || c.name === "put_page")).toBe(true);
    expect(passCalls.filter((c) => c.name === "put_page")).toHaveLength(0);
  });

  test("a general line is merged into agent-<id>/self/lessons, the merged proposals leave their places, the rest stay", async () => {
    const brain = await seed();
    let out = "";
    const { deps } = harness(brain, {
      on: true,
      onPass: async (tools, _s, prompt) => {
        out = (await tools[WRITE_LESSONS_TOOL]!.handler({ lessons: ["- 2026-10-25 Check logs before assuming a cache fault.", "- 2026-10-24 Do not commit to dates for rollouts."], merged: [handle(prompt, "check the deploy log")], dropped: [handle(prompt, "never promise a date")] }, {})).content[0].text;
      },
    });
    await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    expect(out).toContain(`written: ${LESSONS_SLUG} (2 lines)`);
    const lessons = brain.pages.get(A)!.get(LESSONS_SLUG)!.content;
    expect(lessons).toContain("Check logs before assuming a cache fault.");
    expect(lessons).toContain("type: lessons");
    expect(brain.pages.get(P1)!.get(PROPOSALS_SLUG)!.content).toContain(L3);
    expect(brain.pages.get(P1)!.get(PROPOSALS_SLUG)!.content).not.toContain(L1);
    expect(brain.pages.get(DMP)!.get(PROPOSALS_SLUG)!.content).toContain(NO_PROPOSALS);
    // nothing but the proposals pages was written in a place
    const placePuts = brain.calls.filter((c) => c.name === "put_page" && (c.scope.sourceId === P1 || c.scope.sourceId === DMP));
    expect(placePuts.every((c) => c.params.slug === PROPOSALS_SLUG && (c.scope as { placeAgent?: string }).placeAgent === AGENT)).toBe(true);
  });

  test("a line holding an id, mention, email or URL is refused and nothing is written or cleared", async () => {
    const brain = await seed();
    const answers: string[] = [];
    const { deps } = harness(brain, {
      on: true,
      onPass: async (tools, _s, prompt) => {
        for (const bad of ["- 2026-10-25 Ask U0CAROL first.", "- 2026-10-25 Ping <@U0CAROL> first.", "- 2026-10-25 Mail jane@example.org.", "- 2026-10-25 See https://example.org/x.", "- 2026-10-25 Use #ops-room."]) {
          answers.push((await tools[WRITE_LESSONS_TOOL]!.handler({ lessons: [bad], merged: [handle(prompt, "check the deploy log")], dropped: [] }, {})).content[0].text);
        }
      },
    });
    await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    for (const a of answers) {
      expect(a).toStartWith("refused: line 1: it holds");
      expect(a).not.toContain("U0CAROL");
      expect(a).not.toContain("example.org");
    }
    expect(brain.pages.get(A)?.has(LESSONS_SLUG) ?? false).toBe(false);
    expect(brain.pages.get(P1)!.get(PROPOSALS_SLUG)!.content).toContain(L1);
  });

  test("a proposal the pass cannot generalise stays in its place; the 40 line cap holds", async () => {
    const brain = await seed();
    const answers: string[] = [];
    const { deps } = harness(brain, {
      on: true,
      onPass: async (tools, _s, prompt) => {
        answers.push((await tools[WRITE_LESSONS_TOOL]!.handler({ lessons: Array.from({ length: 41 }, (_, i) => `- 2026-10-25 general lesson number ${i}`), merged: [], dropped: [] }, {})).content[0].text);
        answers.push((await tools[WRITE_LESSONS_TOOL]!.handler({ lessons: ["- 2026-10-25 Be brief."], merged: [handle(prompt, "keep status replies short")], dropped: [] }, {})).content[0].text);
      },
    });
    await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    expect(answers[0]).toMatch(/40|refused/);
    expect(brain.pages.get(P1)!.get(PROPOSALS_SLUG)!.content).toContain(L1);
    expect(brain.pages.get(DMP)!.get(PROPOSALS_SLUG)!.content).toContain(L2);
    expect(brain.pages.get(P1)!.get(PROPOSALS_SLUG)!.content).not.toContain(L3);
  });

  test("lines already on the page stay as written; only new or changed lines are checked", async () => {
    const brain = await seed();
    const old = "- 2025-01-01 An old lesson (source: U0CAROL; evidence: pattern)";
    brain.seed(A, LESSONS_SLUG, `---\ntype: lessons\n---\n${old}\n`);
    let out = "";
    const { deps } = harness(brain, { on: true, onPass: async (tools, _s, prompt) => void (out = (await tools[WRITE_LESSONS_TOOL]!.handler({ lessons: [old, "- 2026-10-25 Be brief."], merged: [handle(prompt, "keep status replies short")], dropped: [] }, {})).content[0].text) });
    await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    expect(out).toContain("written");
  });

  test("a proposal over 14 days old is dropped by code and never handed to the pass; nothing left means no run", async () => {
    await bind(P1, "b1");
    const brain = fakeBrain();
    brain.seed(P1, PROPOSALS_SLUG, page("- 2026-09-01 ancient proposal"));
    const { deps, seen } = harness(brain, { on: true });
    expect(await runLessonsUpkeep({ ...group, slot: SLOT }, deps)).toBeNull();
    expect(seen).toHaveLength(0);
    expect(brain.pages.get(P1)!.get(PROPOSALS_SLUG)!.content).toContain(NO_PROPOSALS);
  });
});

describe("runLessonsUpkeep with places not on is the legacy pass", () => {
  test("agent scope, all five base tools, only the persona slice's proposals page, places never read", async () => {
    const brain = await seed();
    brain.seed(A, PROPOSALS_SLUG, page("- 2026-10-25 a persona-wide proposal"));
    const { deps, seen } = harness(brain, { on: false });
    const r = await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    expect(r?.outcome).toBe("ok");
    expect(seen[0]!.spec.baseTools).toBeUndefined();
    expect(seen[0]!.spec.transcripts).toBeUndefined();
    expect(seen[0]!.toolNames.sort()).toEqual(["list_pages", "memoize", "propose", "read_pages", "search"]);
    expect(seen[0]!.prompt).toContain(PROPOSALS_SLUG);
    expect(brain.touched().has(P1)).toBe(false);
    expect(brain.touched().has(DMP)).toBe(false);
  });
  test("with no proposals page there is no run", async () => {
    const brain = await seed();
    const { deps, seen } = harness(brain, { on: false });
    expect(await runLessonsUpkeep({ ...group, slot: SLOT }, deps)).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
