import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as Sessions from "../../src/db/sessions";
import { runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import { LESSONS_REFUSAL } from "../../src/background/pass-tools";
import type { PriceTable } from "../../src/background/prices";
import { conversationSlug } from "../../src/memory/brain-provider";
import {
  collectDay,
  parseTimelineRow,
  runNightlyReview,
  type NightlyDeps,
} from "../../src/background/passes/nightly-review";
import { NO_PROPOSALS, PROPOSALS_SLUG, LESSONS_SLUG, runLessonsUpkeep } from "../../src/background/passes/lessons-upkeep";
import { createBackgroundScheduler, passHandlers } from "../../src/background/scheduler";
import { fakeBrain } from "./fake-brain";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
// 300k input tokens at 1 USD per million: 0.30 USD per pass.
const TURN = { input_tokens: 300_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const AGENT = "UAGENT1";
const AGENT_SRC = "agent-uagent1";
const SLOT = "2026-10-26"; // reviews 2026-10-25

const envelope = (user: string, text: string, extra = "") =>
  `<channel source="slack" channel_id="C0CHAN" thread_ts="1.0" inbound_ts="1.0" user_id="${user}" user_name="${user.toLowerCase()}" trust="trusted"${extra}>\n${text}\n</channel>\n\nReply by calling \`mcp__slaude_surface__reply\`.`;
const row = (id: number, at: string, user: string, text: string, reply = "ok") => ({
  id,
  date: at.slice(0, 10),
  created_at: at,
  summary: text.slice(0, 50),
  detail: `<user>${envelope(user, text, ` one_on_one="true" locked_user="<@${user}>"`)}</user>\n<assistant>${reply}</assistant>`,
});

type Brain = ReturnType<typeof fakeBrain>;

/** A session's conversation page in `source`, with its timeline rows. */
function thread(brain: Brain, source: string, sessionId: string, rows: unknown[]) {
  const slug = conversationSlug(sessionId);
  brain.seed(source, slug, `---\ntype: conversation\n---\n# Conversation ${sessionId}\n`);
  brain.seedTimeline(source, slug, rows);
}

async function session(persona: string, team: string, channel: string, thread: string, updatedAt: number): Promise<string> {
  const s = await Sessions.createForThread({ thread: { team_id: team, channel_id: channel, thread_ts: thread, persona_id: persona }, model: MODEL, working_dir: "/tmp" });
  await db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [updatedAt, s.id]);
  return s.id;
}

interface Seen {
  spec: PassSpec;
  prompt: string;
  /** Sources the runner brain was called with while this pass ran (its tools). */
  sources: Set<string>;
}

/** A fake query that calls `search` on the pass's tools (all its read sources), then ends ok. */
function harness(brain: Brain, opts: { limitUsd?: number; onPass?: (tools: Record<string, { handler: Function }>, spec: PassSpec) => Promise<void> } = {}) {
  const seen: Seen[] = [];
  let current: PassSpec | null = null;
  let t = Date.parse("2026-10-26T02:30:00Z");
  const query = ((args: { prompt: AsyncIterable<{ message: { content: string } }>; options: { mcpServers: Record<string, { instance: { _registeredTools: Record<string, { handler: Function }> } }> } }) =>
    (async function* () {
      let prompt = "";
      for await (const m of args.prompt) prompt = m.message.content;
      const tools = args.options.mcpServers.slaude_pass!.instance._registeredTools;
      const before = brain.calls.length;
      await tools.search!.handler({ query: "anything" }, {});
      await opts.onPass?.(tools, current!);
      const sources = new Set(brain.calls.slice(before).flatMap((c) => [c.scope.sourceId, ...c.scope.allowedSources]));
      seen.push({ spec: current!, prompt, sources });
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${seen.length}`, usage: TURN, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: TURN };
    })()) as unknown as RunnerDeps["query"];
  const runner: RunnerDeps = {
    query,
    brainCall: brain.call,
    // Each read moves a second on, so ledger rows order by start.
    now: () => new Date((t += 1000)),
    priceTable: TABLE,
    model: () => MODEL,
    budget: () => ({ limitUsd: opts.limitUsd ?? 5, timeZone: "UTC" }),
    kbSources: () => [],
    provider: async () => null,
  };
  const deps: NightlyDeps = {
    runner,
    call: brain.call,
    listSources: async () => [...brain.timelines.keys(), "shared"],
    run: (spec, d) => {
      current = spec;
      return runPass(spec, d);
    },
  };
  return { deps, seen };
}

const group = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM background_slots");
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM sessions");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errSpy.mockRestore();
});

/** Two people's /1on1 threads in their own slices plus one channel thread in the agent slice. */
async function seedDay(brain: Brain) {
  const day = Date.parse("2026-10-25T12:00:00Z");
  const alice = await session("default", "T0TEAM", "D0ALICE", "1.1", day);
  const bob = await session("default", "T0TEAM", "D0BOB", "1.2", day);
  const chan = await session("default", "T0TEAM", "C0CHAN", "1.3", day);
  // A session last touched before the window: never read.
  const old = await session("default", "T0TEAM", "C0OLD", "1.4", Date.parse("2026-10-20T12:00:00Z"));
  // Another persona's session: not this agent's.
  const other = await session("p-other", "T0TEAM", "C0OTH", "1.5", day);
  thread(brain, "user-u0alice", alice, [
    row(1, "2026-10-24T23:59:00Z", "U0ALICE", "yesterday's alice message"),
    row(2, "2026-10-25T09:00:00Z", "U0ALICE", "I prefer short answers please"),
    row(3, "2026-10-26T00:01:00Z", "U0ALICE", "tomorrow's alice message"),
  ]);
  thread(brain, "user-u0bob", bob, [row(1, "2026-10-25T10:00:00Z", "U0BOB", "bob private planning notes")]);
  thread(brain, AGENT_SRC, chan, [row(1, "2026-10-25T11:00:00Z", "U0CAROL", "the deploy failed again")]);
  thread(brain, AGENT_SRC, old, [row(1, "2026-10-25T11:00:00Z", "U0CAROL", "never read: old session")]);
  thread(brain, AGENT_SRC, other, [row(1, "2026-10-25T11:00:00Z", "U0CAROL", "never read: other persona")]);
  return { alice, bob, chan };
}

describe("parseTimelineRow", () => {
  test("splits the envelope author, the agent reply and envelope-less text", () => {
    const turns = parseTimelineRow({
      id: 1,
      date: "2026-10-25",
      created_at: "2026-10-25T09:00:00Z",
      summary: "s",
      detail: `<user>${envelope("U0ALICE", "hello there", ` one_on_one="true" locked_user="<@U0ALICE>"`)}\n${envelope("U0BOB", "and me")}</user>\n<assistant>hi both</assistant>`,
    });
    expect(turns).toEqual([
      { at: "2026-10-25T09:00:00.000Z", author: "U0ALICE", text: "hello there" },
      { at: "2026-10-25T09:00:00.000Z", author: "U0BOB", text: "and me" },
      { at: "2026-10-25T09:00:00.000Z", author: "agent", text: "hi both" },
    ]);
  });

  test("a runtime turn with no envelope is a system turn; a truncated envelope keeps its text", () => {
    expect(parseTimelineRow({ date: "2026-10-25", summary: "x", detail: "<user><runtime-check>look</runtime-check></user>\n<assistant></assistant>" })).toEqual([
      { at: "2026-10-25", author: "system", text: "<runtime-check>look</runtime-check>" },
    ]);
    const cut = parseTimelineRow({ date: "2026-10-25", summary: "x", detail: `<user><channel user_id="U0ALICE" locked_user="<@U0ALICE>">\nhalf a messa…` });
    expect(cut).toEqual([{ at: "2026-10-25", author: "U0ALICE", text: "half a messa…" }]);
    // No detail: the summary.
    expect(parseTimelineRow({ date: "2026-10-25", summary: "plain" })).toEqual([{ at: "2026-10-25", author: "system", text: "plain" }]);
  });
});

describe("collectDay", () => {
  test("groups the day's turns by slice: one transcript per person, the agent slice apart", async () => {
    const brain = fakeBrain();
    await seedDay(brain);
    const { deps } = harness(brain);
    const day = await collectDay(group, "2026-10-25", deps);
    const agent = day.agent.map((t) => `${t.author}: ${t.text}`).join("\n");
    expect(agent).toContain("U0CAROL: the deploy failed again");
    expect(agent).toContain("agent: ok");
    expect(agent).not.toContain("never read");
    expect(day.users.map((u) => [u.userId, u.teamId])).toEqual([
      ["U0ALICE", "T0TEAM"],
      ["U0BOB", "T0TEAM"],
    ]);
    const alice = day.users[0]!.turns.map((t) => t.text).join("\n");
    expect(alice).toContain("I prefer short answers please");
    expect(alice).not.toContain("yesterday's");
    expect(alice).not.toContain("tomorrow's");
    expect(alice).not.toContain("bob");
  });

  test("a persona-local day: entries are bucketed by the persona's timezone", async () => {
    const brain = fakeBrain();
    await seedDay(brain);
    const { deps } = harness(brain);
    // 2026-10-26T00:01Z is still 2026-10-25 in New York.
    const day = await collectDay({ ...group, timeZone: "America/New_York" }, "2026-10-25", deps);
    const alice = day.users.find((u) => u.userId === "U0ALICE")!.turns.map((t) => t.text).join("\n");
    expect(alice).toContain("tomorrow's alice message"); // 20:01 on the 25th in New York
    expect(alice).toContain("I prefer short answers please");
    expect(alice).not.toContain("yesterday's alice message"); // 19:59 on the 24th
  });
});

describe("runNightlyReview", () => {
  test("two people's /1on1 pages plus agent pages give three passes, each person seeing only their own", async () => {
    const brain = fakeBrain();
    await seedDay(brain);
    const { deps, seen } = harness(brain);
    const out = await runNightlyReview({ ...group, slot: SLOT }, deps);
    expect(out.map((o) => o.outcome)).toEqual(["ok", "ok", "ok"]);
    expect(seen.map((s) => s.spec.scope)).toEqual([
      { kind: "agent" },
      { kind: "user", userId: "U0ALICE", teamId: "T0TEAM" },
      { kind: "user", userId: "U0BOB", teamId: "T0TEAM" },
    ]);
    expect(seen.every((s) => s.spec.pass === "nightly-review")).toBe(true);
    const [agent, alice, bob] = seen;
    // The prompt carries the day's transcript of that scope alone.
    expect(agent!.prompt).toContain("the deploy failed again");
    expect(agent!.prompt).not.toContain("short answers");
    expect(agent!.prompt).not.toContain("bob private");
    expect(agent!.prompt).toContain(PROPOSALS_SLUG);
    expect(alice!.prompt).toContain("U0ALICE: I prefer short answers please");
    expect(alice!.prompt).not.toContain("bob private");
    expect(alice!.prompt).not.toContain("deploy failed");
    expect(alice!.prompt).not.toContain(PROPOSALS_SLUG);
    expect(bob!.prompt).toContain("bob private planning notes");
    expect(bob!.prompt).not.toContain("short answers");
    // The tools read only that scope's sources: never another person's slice.
    expect(alice!.sources.has("user-u0alice")).toBe(true);
    expect(alice!.sources.has("user-u0bob")).toBe(false);
    expect(bob!.sources.has("user-u0alice")).toBe(false);
    expect([...agent!.sources].some((s) => s.startsWith("user-") || s.startsWith("profile-"))).toBe(false);
    // The transcripts handed to each pass are that person's turns plus the agent's.
    expect(new Set(alice!.spec.transcripts!.map((t) => t.author))).toEqual(new Set(["system", "U0ALICE", "agent"]));
  });

  test("a person's quoted words from that day reach their profile through the pass", async () => {
    const brain = fakeBrain();
    const { alice } = await seedDay(brain);
    void alice;
    const results: string[] = [];
    const { deps } = harness(brain, {
      onPass: async (tools, spec) => {
        if (spec.scope.kind !== "user" || spec.scope.userId !== "U0ALICE") return;
        const r = await tools.memoize!.handler({ pages: [{ slug: "profile", type: "profile", content: "Short answers.", quote: "I prefer short answers please" }] }, {});
        results.push(r.isError ? "refused" : "written");
      },
    });
    await runNightlyReview({ ...group, slot: SLOT }, deps);
    expect(results).toEqual(["written"]);
    expect(brain.pages.get("profile-t0team-u0alice")?.get("profile")?.content).toContain("Short answers.");
  });

  test("a turn by someone else inside a person's slice is dropped from their pass", async () => {
    const brain = fakeBrain();
    const s = await session("default", "T0TEAM", "D0ALICE", "2.1", Date.parse("2026-10-25T12:00:00Z"));
    thread(brain, "user-u0alice", s, [
      row(1, "2026-10-25T09:00:00Z", "U0ALICE", "alice speaking here"),
      row(2, "2026-10-25T09:05:00Z", "U0MALLORY", "mallory pretending"),
    ]);
    const { deps, seen } = harness(brain);
    await runNightlyReview({ ...group, slot: SLOT }, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toContain("alice speaking here");
    expect(seen[0]!.prompt).not.toContain("mallory");
  });

  test("a slice listing that fails reads every candidate; a slice nobody can be matched to is left out", async () => {
    const brain = fakeBrain();
    const s = await session("default", "T0TEAM", "D0ALICE", "3.1", Date.parse("2026-10-25T12:00:00Z"));
    thread(brain, "user-u0alice", s, [row(1, "2026-10-25T09:00:00Z", "U0ALICE", "alice again here")]);
    // A slice whose id no Slack user id maps to (only runtime turns, a lower-case id).
    brain.seedTimeline("user-x_y", conversationSlug(s), [{ id: 1, date: "2026-10-25", created_at: "2026-10-25T09:00:00Z", summary: "s", detail: "<user>tick</user>\n<assistant>ok</assistant>" }]);
    const { deps, seen } = harness(brain);
    const call = deps.call;
    deps.call = async (name, params, scope) => {
      if (name === "list_pages") throw new Error("list unavailable");
      return call(name, params, scope);
    };
    deps.listSources = async () => ["user-u0alice", "user-x_y"];
    await runNightlyReview({ ...group, slot: SLOT }, deps);
    expect(seen.map((x) => x.spec.scope)).toEqual([{ kind: "user", userId: "U0ALICE", teamId: "T0TEAM" }]);
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("cannot tell whose slice user-x_y is");
  });

  test("an over-long day keeps its newest turns", async () => {
    const brain = fakeBrain();
    const s = await session("default", "T0TEAM", "C0LONG", "4.1", Date.parse("2026-10-25T12:00:00Z"));
    thread(brain, AGENT_SRC, s, [
      row(1, "2026-10-25T08:00:00Z", "U0CAROL", `OLDEST ${"x".repeat(70_000)}`),
      row(2, "2026-10-25T09:00:00Z", "U0CAROL", `NEWEST ${"y".repeat(70_000)}`),
    ]);
    const { deps, seen } = harness(brain);
    await runNightlyReview({ ...group, slot: SLOT }, deps);
    expect(seen[0]!.prompt).toContain("NEWEST");
    expect(seen[0]!.prompt).not.toContain("OLDEST");
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("oldest turn(s) are left out");
  });

  test("a quiet day runs no pass", async () => {
    const brain = fakeBrain();
    const { deps, seen } = harness(brain);
    expect(await runNightlyReview({ ...group, slot: SLOT }, deps)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  test("budget refusal mid-review: later passes are recorded skipped-budget", async () => {
    const brain = fakeBrain();
    await seedDay(brain);
    // 0.32: the agent pass (estimate 0.10) runs and costs 0.30; the rest find 0.02 left.
    const { deps, seen } = harness(brain, { limitUsd: 0.32 });
    const out = await runNightlyReview({ ...group, slot: SLOT }, deps);
    expect(out.map((o) => o.outcome)).toEqual(["ok", "skipped-budget", "skipped-budget"]);
    expect(seen).toHaveLength(1);
    const rows = await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26");
    expect(rows.map((r) => [r.scope, r.outcome])).toEqual([
      ["agent", "ok"],
      ["user:U0ALICE", "skipped-budget"],
      ["user:U0BOB", "skipped-budget"],
    ]);
  });
});

describe("runLessonsUpkeep", () => {
  const proposals = (body: string) => `---\ntype: correction\nas_of: 2026-10-26\n---\n${body}`;
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `- 2026-10-2${i % 10} lesson ${i} (source: thread)`).join("\n");

  test("merges proposals into self/lessons: a 41-line lessons page is refused, 40 lines lands, proposals cleared", async () => {
    const brain = fakeBrain();
    brain.seed(AGENT_SRC, PROPOSALS_SLUG, proposals("- 2026-10-25 check the deploy log before blaming the cache (correction by U0CAROL)"));
    const answers: string[] = [];
    const { deps, seen } = harness(brain, {
      onPass: async (tools) => {
        for (const n of [41, 40]) {
          const r = await tools.memoize!.handler({ pages: [{ slug: LESSONS_SLUG, type: "lessons", content: lines(n) }] }, {});
          answers.push(r.isError ? r.content[0].text : "written");
        }
        await tools.memoize!.handler({ pages: [{ slug: PROPOSALS_SLUG, type: "correction", content: NO_PROPOSALS }] }, {});
      },
    });
    const r = await runLessonsUpkeep({ ...group, slot: SLOT }, deps);
    expect(r?.outcome).toBe("ok");
    expect(answers).toEqual([LESSONS_REFUSAL, "written"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.spec).toMatchObject({ pass: "lessons-upkeep", scope: { kind: "agent" } });
    expect(seen[0]!.prompt).toContain(LESSONS_SLUG);
    expect(seen[0]!.prompt).toContain("40");
    expect(brain.pages.get(AGENT_SRC)!.get(LESSONS_SLUG)!.content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(40);
    expect(brain.pages.get(AGENT_SRC)!.get(PROPOSALS_SLUG)!.content).toContain(NO_PROPOSALS);
  });

  test("no proposals, or only the cleared page: no pass, no spend", async () => {
    const brain = fakeBrain();
    const { deps, seen } = harness(brain);
    expect(await runLessonsUpkeep({ ...group, slot: SLOT }, deps)).toBeNull();
    brain.seed(AGENT_SRC, PROPOSALS_SLUG, proposals(`${NO_PROPOSALS}\n`));
    expect(await runLessonsUpkeep({ ...group, slot: SLOT }, deps)).toBeNull();
    expect(seen).toHaveLength(0);
    expect(await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26")).toEqual([]);
  });
});

describe("on the schedule", () => {
  const writeProposal = async (tools: Record<string, { handler: Function }>, spec: PassSpec) => {
    if (spec.pass !== "nightly-review" || spec.scope.kind !== "agent") return;
    await tools.memoize!.handler({ pages: [{ slug: PROPOSALS_SLUG, type: "correction", content: "- 2026-10-25 read the deploy log first (correction by U0CAROL)" }] }, {});
  };

  test("02:30: the nightly review's three passes, then lessons upkeep", async () => {
    const brain = fakeBrain();
    await seedDay(brain);
    const { deps, seen } = harness(brain, { onPass: writeProposal });
    const s = createBackgroundScheduler({ now: () => new Date("2026-10-26T02:30:00Z"), brainReady: () => true, agents: async () => [group], handlers: passHandlers(deps), sweep: async () => {} });
    await s.tick();
    expect(seen.map((x) => `${x.spec.pass}:${x.spec.scope.kind}`)).toEqual(["nightly-review:agent", "nightly-review:user", "nightly-review:user", "lessons-upkeep:agent"]);
    // The slot is claimed: a second tick (or replica) runs nothing.
    await s.tick();
    await createBackgroundScheduler({ now: () => new Date("2026-10-26T02:31:00Z"), brainReady: () => true, agents: async () => [group], handlers: passHandlers(deps), sweep: async () => {} }).tick();
    expect(seen).toHaveLength(4);
  });

  test("budget refusal mid-schedule: later passes are recorded skipped-budget and the scheduler keeps running", async () => {
    const brain = fakeBrain();
    await seedDay(brain);
    const { deps, seen } = harness(brain, { limitUsd: 0.32, onPass: writeProposal });
    let at = "2026-10-26T02:30:00Z";
    const digests: string[] = [];
    const s = createBackgroundScheduler({
      now: () => new Date(at),
      brainReady: () => true,
      agents: async () => [group],
      handlers: { ...passHandlers(deps), digest: async (r) => void digests.push(r.slot) },
      sweep: async () => {},
    });
    await s.tick();
    expect(seen).toHaveLength(1);
    const rows = await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26");
    expect(rows.map((r) => [r.pass, r.scope, r.outcome])).toEqual([
      ["nightly-review", "agent", "ok"],
      ["nightly-review", "user:U0ALICE", "skipped-budget"],
      ["nightly-review", "user:U0BOB", "skipped-budget"],
      ["lessons-upkeep", "agent", "skipped-budget"],
    ]);
    at = "2026-10-26T09:00:00Z";
    await s.tick();
    expect(digests).toEqual(["2026-W44"]);
  });
});
