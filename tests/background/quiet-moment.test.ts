/**
 * The quiet-moment pass (spec §9.1, §8.5): a busy thread that goes quiet is
 * reviewed sooner, in its own scope, and gets a rolling summary beside its
 * conversation page.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import * as Sessions from "../../src/db/sessions";
import * as ThreadActivity from "../../src/db/thread-activity";
import { claimSlot } from "../../src/db/background-slots";
import { runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import { CONVERSATION_REFUSAL } from "../../src/background/pass-tools";
import type { PriceTable } from "../../src/background/prices";
import { conversationSlug, conversationSummarySlug, BrainMemoryProvider } from "../../src/memory/brain-provider";
import type { NightlyDeps } from "../../src/background/passes/nightly-review";
import {
  dueQuietThreads,
  parseQuietSlot,
  quietSlot,
  quietThresholds,
  runQuietMoment,
  SUMMARY_MAX_CHARS,
  SUMMARY_TOOL,
} from "../../src/background/passes/quiet-moment";
import { createBackgroundScheduler, passHandlers } from "../../src/background/scheduler";
import { sweepStaleRuns, RUN_STALE_MS } from "../../src/background/stale-runs";
import { makeMemoryPlane } from "../../src/gateway/api/memory";
import { makeScopedMemory } from "../../src/memory/scoped";
import { memoryScopeFor } from "../../src/memory/scope";
import type { GateInput } from "../../src/knowledge/gated-dispatch";
import type { JobClaims } from "../../src/gateway/api/auth";
import { fakeBrain } from "./fake-brain";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
// 100k input tokens at 1 USD per million: 0.10 USD per pass.
const TURN = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const AGENT = "UAGENT1";
const AGENT_SRC = "agent-uagent1";
const NOW = Date.parse("2026-10-26T15:00:00Z");
const MIN = 60_000;

const envelope = (user: string, text: string) =>
  `<channel source="slack" channel_id="D0ALICE" thread_ts="1.0" inbound_ts="1.0" user_id="${user}" user_name="${user.toLowerCase()}" trust="trusted">\n${text}\n</channel>`;
const row = (id: number, user: string, text: string, reply = "noted") => ({
  id,
  date: "2026-10-26",
  created_at: new Date(NOW - 60 * MIN + id * MIN).toISOString(),
  summary: text.slice(0, 50),
  detail: `<user>${envelope(user, text)}</user>\n<assistant>${reply}</assistant>`,
});

type Brain = ReturnType<typeof fakeBrain>;
const CONVERSATION_PAGE = (id: string) => `---\ntype: conversation\n---\n# Conversation ${id}\n`;

function thread(brain: Brain, source: string, sessionId: string, rows: unknown[]) {
  const slug = conversationSlug(sessionId);
  brain.seed(source, slug, CONVERSATION_PAGE(sessionId));
  brain.seedTimeline(source, slug, rows);
}

async function session(channel: string, threadTs: string): Promise<string> {
  const s = await Sessions.createForThread({ thread: { team_id: "T0TEAM", channel_id: channel, thread_ts: threadTs, persona_id: "default" }, model: MODEL, working_dir: "/tmp" });
  return s.id;
}

/** `turns` turns of a thread, the last `quietMin` minutes before NOW. */
async function activity(sessionId: string, scope: string, turns: number, quietMin: number) {
  for (let i = 0; i < turns; i++) await ThreadActivity.recordTurn({ sessionId, agentId: AGENT, scope, at: NOW - quietMin * MIN - (turns - 1 - i) * 1000 });
}

type Tools = Record<string, { handler: Function }>;

/** A fake query that runs `onPass` against the pass's tools (default: write a summary), then ends ok. */
function harness(brain: Brain, opts: { limitUsd?: number; onPass?: (tools: Tools, spec: PassSpec) => Promise<void> } = {}) {
  const seen: Array<{ spec: PassSpec; prompt: string; results: string[] }> = [];
  let current: PassSpec | null = null;
  let t = NOW;
  const query = ((args: { prompt: AsyncIterable<{ message: { content: string } }>; options: { mcpServers: Record<string, { instance: { _registeredTools: Tools } }> } }) =>
    (async function* () {
      let prompt = "";
      for await (const m of args.prompt) prompt = m.message.content;
      const tools = args.options.mcpServers.slaude_pass!.instance._registeredTools;
      const results: string[] = [];
      seen.push({ spec: current!, prompt, results });
      if (opts.onPass) await opts.onPass(tools, current!);
      else results.push((await tools[SUMMARY_TOOL]!.handler({ content: "Alice and the agent planned the release; the date is still open." }, {})).content[0].text);
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m${seen.length}`, usage: TURN, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: TURN };
    })()) as unknown as RunnerDeps["query"];
  const runner: RunnerDeps = {
    query,
    brainCall: brain.call,
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
    listSources: async () => [...brain.timelines.keys()],
    run: (spec, d) => {
      current = spec;
      return runPass(spec, d);
    },
  };
  return { deps, seen };
}

const group = { agentId: AGENT, personaId: "default", personaIds: ["default"], timeZone: "UTC" };
const T = { minTurns: 8, quietMs: 30 * MIN, maxPerDay: 5 };

/** A scheduler over the real pass handlers, at a fixed time past every daily slot's turn. */
function scheduler(deps: NightlyDeps, over: { now?: number; quietDue?: typeof dueQuietThreads } = {}) {
  const handlers = passHandlers(deps);
  return createBackgroundScheduler({
    now: () => new Date(over.now ?? NOW),
    brainReady: () => true,
    agents: async () => [group],
    handlers: { "quiet-moment": handlers["quiet-moment"] },
    sweep: async () => 0,
    quietDue: (g, now) => (over.quietDue ?? dueQuietThreads)(g, now, T),
  });
}

const ENV = ["SLAUDE_QUIET_MIN_TURNS", "SLAUDE_QUIET_MINUTES", "SLAUDE_QUIET_MAX_PER_DAY"];
const savedEnv: Record<string, string | undefined> = {};
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  await db.run("DELETE FROM background_slots");
  await db.run("DELETE FROM background_runs");
  await db.run("DELETE FROM thread_activity");
  await db.run("DELETE FROM sessions");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errSpy.mockRestore();
  debugSpy.mockRestore();
});

describe("thresholds", () => {
  test("N, M and K default to 8 turns, 30 minutes and 5 a day", () => {
    for (const k of ENV) delete process.env[k];
    expect(quietThresholds()).toEqual({ minTurns: 8, quietMs: 30 * MIN, maxPerDay: 5 });
  });

  test("N, M and K come from SLAUDE_QUIET_MIN_TURNS, SLAUDE_QUIET_MINUTES and SLAUDE_QUIET_MAX_PER_DAY", () => {
    process.env.SLAUDE_QUIET_MIN_TURNS = "3";
    process.env.SLAUDE_QUIET_MINUTES = "10";
    process.env.SLAUDE_QUIET_MAX_PER_DAY = "2";
    expect(quietThresholds()).toEqual({ minTurns: 3, quietMs: 10 * MIN, maxPerDay: 2 });
    process.env.SLAUDE_QUIET_MIN_TURNS = "zero";
    process.env.SLAUDE_QUIET_MINUTES = "0";
    process.env.SLAUDE_QUIET_MAX_PER_DAY = "-1";
    expect(quietThresholds()).toEqual({ minTurns: 8, quietMs: 30 * MIN, maxPerDay: 5 });
  });

  test("the env thresholds decide which threads are due", async () => {
    await activity("S-few", "agent", 3, 15);
    process.env.SLAUDE_QUIET_MIN_TURNS = "3";
    process.env.SLAUDE_QUIET_MINUTES = "10";
    expect((await dueQuietThreads(group, new Date(NOW))).map((t) => t.sessionId)).toEqual(["S-few"]);
    process.env.SLAUDE_QUIET_MINUTES = "20";
    expect(await dueQuietThreads(group, new Date(NOW))).toEqual([]);
    process.env.SLAUDE_QUIET_MINUTES = "10";
    process.env.SLAUDE_QUIET_MIN_TURNS = "4";
    expect(await dueQuietThreads(group, new Date(NOW))).toEqual([]);
  });
});

describe("selection", () => {
  test("due: at least N turns, quiet for M, not summarized through its last turn", async () => {
    await activity("S-busy", "agent", 8, 31);
    await activity("S-short", "agent", 7, 31);
    await activity("S-talking", "agent", 9, 5);
    await activity("S-done", "agent", 8, 40);
    const done = await ThreadActivity.get("S-done");
    await ThreadActivity.markSummarized("S-done", done!.lastTurnAt);
    expect((await dueQuietThreads(group, new Date(NOW), T)).map((t) => t.sessionId)).toEqual(["S-busy"]);
    // Another agent's threads are not this agent's.
    await ThreadActivity.recordTurn({ sessionId: "S-other", agentId: "UOTHER", scope: "agent", at: NOW - 60 * MIN });
    expect((await dueQuietThreads(group, new Date(NOW), T)).map((t) => t.sessionId)).toEqual(["S-busy"]);
    // A new turn after the summary makes the summarized thread due again.
    await ThreadActivity.recordTurn({ sessionId: "S-done", agentId: AGENT, scope: "agent", at: NOW - 35 * MIN });
    expect((await dueQuietThreads(group, new Date(NOW), T)).map((t) => t.sessionId)).toEqual(["S-done", "S-busy"]);
  });

  test("a turn in another scope restarts the count and clears the summary mark", async () => {
    await activity("S-x", "agent", 8, 40);
    await ThreadActivity.markSummarized("S-x", (await ThreadActivity.get("S-x"))!.lastTurnAt);
    await ThreadActivity.recordTurn({ sessionId: "S-x", agentId: AGENT, scope: "user:U0ALICE", at: NOW - 35 * MIN });
    const a = await ThreadActivity.get("S-x");
    expect(a).toMatchObject({ turns: 1, scope: "user:U0ALICE", summarizedAt: null, lastTurnAt: NOW - 35 * MIN });
    // last_turn_at never moves backwards.
    await ThreadActivity.recordTurn({ sessionId: "S-x", agentId: AGENT, scope: "user:U0ALICE", at: NOW - 90 * MIN });
    expect(await ThreadActivity.get("S-x")).toMatchObject({ turns: 2, lastTurnAt: NOW - 35 * MIN });
  });

  test("activityScopeOf: the agent slice, a person's slice, nothing else", () => {
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: AGENT_SRC, allowedSources: [AGENT_SRC] }, AGENT)).toBe("agent");
    expect(ThreadActivity.activityScopeOf({ clientId: "U0ALICE", sourceId: "user-u0alice", allowedSources: ["user-u0alice"] }, AGENT)).toBe("user:U0ALICE");
    expect(ThreadActivity.activityScopeOf({ clientId: "U0BOB", sourceId: "user-u0alice", allowedSources: ["user-u0alice"] }, AGENT)).toBeNull();
    expect(ThreadActivity.activityScopeOf({ clientId: AGENT, sourceId: "public", allowedSources: ["public"] }, AGENT)).toBeNull();
    expect(ThreadActivity.activityScopeOf(null, AGENT)).toBeNull();
  });

  test("the slot is <session>@<last_turn_at>", () => {
    expect(quietSlot("S-1", 123)).toBe("S-1@123");
    expect(parseQuietSlot("S-1@123")).toEqual({ sessionId: "S-1", lastTurnAt: 123 });
    expect(parseQuietSlot("nope")).toBeNull();
    expect(parseQuietSlot("S@x")).toBeNull();
  });
});

describe("runQuietMoment", () => {
  test("a /1on1 thread's summary lands in user-<id>, the pass runs as that user, the conversation page is untouched", async () => {
    const brain = fakeBrain();
    const sid = await session("D0ALICE", "1.1");
    thread(brain, "user-u0alice", sid, [
      row(1, "U0ALICE", "can we plan the release?"),
      row(2, "U0BOB", "bob's words never reach alice's pass"),
      row(3, "U0ALICE", "I prefer short answers please"),
    ]);
    await activity(sid, "user:U0ALICE", 8, 31);
    const { deps, seen } = harness(brain);
    await scheduler(deps).tick();

    expect(seen).toHaveLength(1);
    const { spec, prompt, results } = seen[0]!;
    expect(spec.pass).toBe("quiet-moment");
    expect(spec.scope).toEqual({ kind: "user", userId: "U0ALICE", teamId: "T0TEAM" });
    expect(prompt).toContain("running as U0ALICE");
    expect(prompt).toContain("U0ALICE: I prefer short answers please");
    expect(prompt).not.toContain("bob's words");
    expect(results).toEqual([`written: ${conversationSummarySlug(sid)}`]);

    const summary = brain.pages.get("user-u0alice")!.get(conversationSummarySlug(sid))!;
    expect(summary.content).toContain("type: conversation-summary");
    expect(summary.content).toContain("the date is still open");
    // Written only to that person's slice, and the conversation page is never rewritten.
    const puts = brain.calls.filter((c) => c.name === "put_page");
    expect(puts.map((c) => [c.scope.sourceId, c.scope.allowedSources, c.params.slug])).toEqual([["user-u0alice", ["user-u0alice"], conversationSummarySlug(sid)]]);
    expect(brain.pages.get("user-u0alice")!.get(conversationSlug(sid))!.content).toBe(CONVERSATION_PAGE(sid));
    expect(brain.pages.get(AGENT_SRC)?.has(conversationSummarySlug(sid)) ?? false).toBe(false);
    // Never another slice read: only alice's own (and the common agent/shared/public reads of a user pass).
    expect([...brain.touched()].filter((s) => s.startsWith("user-") || s.startsWith("profile-"))).toEqual(
      expect.arrayContaining(["user-u0alice"]),
    );
    expect([...brain.touched()].some((s) => s.startsWith("user-") && s !== "user-u0alice")).toBe(false);

    const a = await ThreadActivity.get(sid);
    expect(a!.summarizedAt).toBe(a!.lastTurnAt);
    const runs = await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26");
    expect(runs.map((r) => [r.pass, r.scope, r.outcome])).toEqual([["quiet-moment", "user:U0ALICE", "ok"]]);
  });

  test("a channel thread is reviewed in agent scope and its summary lands in the agent slice", async () => {
    const brain = fakeBrain();
    const sid = await session("C0CHAN", "2.1");
    thread(brain, AGENT_SRC, sid, [row(1, "U0CAROL", "the deploy failed again"), row(2, "U0DAVE", "I'll look at the logs")]);
    await activity(sid, "agent", 8, 31);
    const { deps, seen } = harness(brain);
    await scheduler(deps).tick();
    expect(seen.map((s) => s.spec.scope)).toEqual([{ kind: "agent" }]);
    expect(seen[0]!.prompt).toContain("U0CAROL: the deploy failed again");
    expect(seen[0]!.prompt).toContain("U0DAVE: I'll look at the logs");
    expect(brain.pages.get(AGENT_SRC)!.has(conversationSummarySlug(sid))).toBe(true);
    expect([...brain.touched()].some((s) => s.startsWith("user-") || s.startsWith("profile-"))).toBe(false);
  });

  test("the pass runs as the thread's own persona, not the group's first; a persona the group does not hold is not run", async () => {
    const brain = fakeBrain();
    const ana = await session("C0CHAN", "2.8");
    const bea = await session("C0CHAN", "2.9");
    await db.run("UPDATE sessions SET persona_id = ? WHERE id = ?", ["ana", ana]);
    await db.run("UPDATE sessions SET persona_id = ? WHERE id = ?", ["bea", bea]);
    for (const sid of [ana, bea]) {
      thread(brain, AGENT_SRC, sid, [row(1, "U0CAROL", "the deploy failed again")]);
      await activity(sid, "agent", 8, 31);
    }
    const { deps, seen } = harness(brain);
    const g = { ...group, personaIds: ["default", "ana"] };
    expect(await runQuietMoment({ ...g, slot: quietSlot(bea, (await ThreadActivity.get(bea))!.lastTurnAt) }, deps)).toBeNull();
    expect(seen).toHaveLength(0);
    await runQuietMoment({ ...g, slot: quietSlot(ana, (await ThreadActivity.get(ana))!.lastTurnAt) }, deps);
    expect(seen.map((s) => s.spec.personaId)).toEqual(["ana"]);
  });

  test("the earlier summary is handed to the pass; memoize cannot write the conversation page or its summary", async () => {
    const brain = fakeBrain();
    const sid = await session("C0CHAN", "2.2");
    thread(brain, AGENT_SRC, sid, [row(1, "U0CAROL", "next question")]);
    brain.seed(AGENT_SRC, conversationSummarySlug(sid), "---\ntype: conversation-summary\n---\nEarlier: the team chose the blue option.\n");
    await activity(sid, "agent", 8, 31);
    const refusals: string[] = [];
    const { deps, seen } = harness(brain, {
      onPass: async (tools) => {
        for (const slug of [conversationSlug(sid), conversationSummarySlug(sid), `/${conversationSlug(sid)}`]) {
          const r = await tools.memoize!.handler({ pages: [{ slug, content: "rewritten", type: "outcome" }] }, {});
          refusals.push(r.content[0].text);
        }
        const tooLong = await tools[SUMMARY_TOOL]!.handler({ content: "x".repeat(SUMMARY_MAX_CHARS + 1) }, {});
        refusals.push(tooLong.content[0].text);
      },
    });
    await scheduler(deps).tick();
    expect(seen[0]!.prompt).toContain("earlier summary of this thread: Earlier: the team chose the blue option.");
    expect(refusals.slice(0, 3)).toEqual([CONVERSATION_REFUSAL, CONVERSATION_REFUSAL, CONVERSATION_REFUSAL]);
    expect(refusals[3]).toContain(`over ${SUMMARY_MAX_CHARS} characters`);
    expect(brain.pages.get(AGENT_SRC)!.get(conversationSlug(sid))!.content).toBe(CONVERSATION_PAGE(sid));
    // No summary written: the thread is not marked summarized.
    expect((await ThreadActivity.get(sid))!.summarizedAt).toBeNull();
  });

  test("running twice for the same last_turn_at happens once, across two schedulers (replicas)", async () => {
    const brain = fakeBrain();
    const sid = await session("C0CHAN", "2.3");
    thread(brain, AGENT_SRC, sid, [row(1, "U0CAROL", "hello")]);
    await activity(sid, "agent", 8, 31);
    const { deps, seen } = harness(brain, { onPass: async () => {} }); // no summary: summarized_at stays behind
    // A replica that listed the thread before the other claimed it still sees it as due.
    const stale = async () => [(await ThreadActivity.get(sid))!];
    await scheduler(deps).tick();
    await scheduler(deps, { quietDue: stale }).tick();
    await scheduler(deps, { quietDue: stale }).tick();
    expect(seen).toHaveLength(1);
    expect(await claimSlot(AGENT, "quiet-moment", quietSlot(sid, (await ThreadActivity.get(sid))!.lastTurnAt))).toBe(false);
    // A new turn is a new quiet stretch: due again once quiet.
    await ThreadActivity.recordTurn({ sessionId: sid, agentId: AGENT, scope: "agent", at: NOW - 31 * MIN + 500 });
    await scheduler(deps).tick();
    expect(seen).toHaveLength(2);
  });

  test("the K+1th candidate that day is skipped", async () => {
    const brain = fakeBrain();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const sid = await session("C0CHAN", `3.${i}`);
      thread(brain, AGENT_SRC, sid, [row(1, "U0CAROL", `thread ${i}`)]);
      await activity(sid, "agent", 8, 60 - i); // quiet longest first: 0, 1, … 5
      ids.push(sid);
    }
    const { deps, seen } = harness(brain);
    await scheduler(deps).tick();
    expect(seen).toHaveLength(5);
    expect((await ThreadActivity.get(ids[5]!))!.summarizedAt).toBeNull();
    // Later ticks the same day still skip it.
    await scheduler(deps, { now: NOW + 60 * MIN }).tick();
    expect(seen).toHaveLength(5);
    expect(await Runs.countOn(AGENT, "quiet-moment", "2026-10-26")).toBe(5);
    // The next persona-local day it runs.
    await scheduler(deps, { now: Date.parse("2026-10-27T01:00:00Z") }).tick();
    expect(seen).toHaveLength(6);
    expect((await ThreadActivity.get(ids[5]!))!.summarizedAt).not.toBeNull();
  });

  test("every outcome counts toward K: budget-skipped runs fill the day", async () => {
    const brain = fakeBrain();
    for (let i = 0; i < 6; i++) {
      const sid = await session("C0CHAN", `4.${i}`);
      thread(brain, AGENT_SRC, sid, [row(1, "U0CAROL", `thread ${i}`)]);
      await activity(sid, "agent", 8, 60 - i);
    }
    const { deps, seen } = harness(brain, { limitUsd: 0 });
    await scheduler(deps).tick();
    expect(seen).toHaveLength(0);
    const runs = await Runs.listBetween(AGENT, "2026-10-26", "2026-10-26");
    expect(runs.map((r) => r.outcome)).toEqual(Array(5).fill("skipped-budget"));
  });

  test("a thread with no recorded turns in its slice runs nothing", async () => {
    const brain = fakeBrain();
    const sid = await session("C0CHAN", "5.1");
    await activity(sid, "agent", 8, 31);
    const { deps, seen } = harness(brain);
    expect(await runQuietMoment({ ...group, slot: quietSlot(sid, (await ThreadActivity.get(sid))!.lastTurnAt) }, deps)).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("turn end counts thread activity", () => {
  const gate = (over: Partial<GateInput> = {}): GateInput => ({
    userId: "U0ALICE", teamId: "T0TEAM", interactive: true, lockedUser: null, channelTrust: "trusted", isManager: false, agentId: AGENT, ...over,
  });
  const claims = (o: Partial<JobClaims> = {}) =>
    ({ tenant: "default", persona: "default", session: "S-node", team: "T0TEAM", channel: "C0CHAN", thread: "1.0", initiator: "U0ALICE", scope: "turn", job: "J1", runAs: "agent", label: "default", exp: 0, iat: 0, ...o }) as JobClaims;

  test("the node memory sync route: one row per session, scope by the memory rule", async () => {
    const brain = fakeBrain();
    const provider = new BrainMemoryProvider({ call: brain.call, ready: async () => {} });
    let g = gate();
    const plane = makeMemoryPlane({ provider, gateFor: async () => g, ready: async () => {} });
    await plane.sync(claims(), { user: "u", assistant: "a" });
    await plane.sync(claims(), { user: "u", assistant: "a" });
    expect(await ThreadActivity.get("S-node")).toMatchObject({ agentId: AGENT, turns: 2, scope: "agent" });
    // The person's own /1on1: their slice.
    g = gate({ lockedUser: "U0ALICE" });
    await plane.sync(claims({ session: "S-1on1" }), { user: "u", assistant: "a" });
    expect(await ThreadActivity.get("S-1on1")).toMatchObject({ turns: 1, scope: "user:U0ALICE" });
    // Someone else's locked thread writes nothing, so counts nothing.
    g = gate({ userId: "U0BOB", lockedUser: "U0ALICE" });
    await plane.sync(claims({ session: "S-locked", initiator: "U0BOB" }), { user: "u", assistant: "a" });
    expect(await ThreadActivity.get("S-locked")).toBeNull();
    // A cron or runtime turn (not interactive) does not count.
    g = gate({ interactive: false });
    await plane.sync(claims({ session: "S-cron" }), { user: "u", assistant: "a" });
    expect(await ThreadActivity.get("S-cron")).toBeNull();
    // The turn path never calls the brain for it: only the conversation page's own ops.
    expect(brain.calls.every((c) => ["get_page", "put_page", "add_timeline_entry"].includes(c.name))).toBe(true);
  });

  test("a failed activity write never fails the sync", async () => {
    const brain = fakeBrain();
    const provider = new BrainMemoryProvider({ call: brain.call, ready: async () => {} });
    const plane = makeMemoryPlane({ provider, gateFor: async () => gate(), ready: async () => {}, onSynced: async () => { throw new Error("db down"); } });
    await plane.sync(claims(), { user: "u", assistant: "a" });
    expect(brain.calls.some((c) => c.name === "add_timeline_entry")).toBe(true);
  });

  test("mono's scoped memory: counts the turn under the persona's agent id", async () => {
    const brain = fakeBrain();
    const provider = new BrainMemoryProvider({ call: brain.call, ready: async () => {} });
    const mem = makeScopedMemory({
      provider: () => provider,
      ready: async () => {},
      scopeFor: async (sid) => ({ ...memoryScopeFor(gate({ lockedUser: "U0ALICE" })), ...(sid === "S-mono" ? { activityAgentId: AGENT } : {}) }),
    });
    await mem.syncTurn({ sessionId: "S-mono", user: "u", assistant: "a" });
    expect(await ThreadActivity.get("S-mono")).toMatchObject({ agentId: AGENT, turns: 1, scope: "user:U0ALICE" });
    // A turn the scope does not count (not interactive) leaves no row.
    await mem.syncTurn({ sessionId: "S-cron", user: "u", assistant: "a" });
    expect(await ThreadActivity.get("S-cron")).toBeNull();
  });
});

describe("stale-run sweep", () => {
  test("a pass run open over 2 h ends as error keeping its estimate; skill-check keeps its 1 h; a younger run stays open", async () => {
    const now = new Date(NOW);
    const open = (pass: string, ageMs: number, cost: number) =>
      Runs.start({ agentId: AGENT, pass, scope: "agent", day: "2026-10-26", startedAt: NOW - ageMs, model: MODEL, costUsd: cost });
    const staleNightly = await open("nightly-review", RUN_STALE_MS + 1000, 0.1);
    const staleQuiet = await open("quiet-moment", RUN_STALE_MS + 1000, 0.05);
    const youngQuiet = await open("quiet-moment", 90 * MIN, 0.05);
    const staleCheck = await open("skill-check", 61 * MIN, 0.02);
    expect(await sweepStaleRuns(now)).toBe(3);
    for (const [id, cost] of [[staleNightly, 0.1], [staleQuiet, 0.05], [staleCheck, 0.02]] as const) {
      expect(await Runs.get(id)).toMatchObject({ outcome: "error", costUsd: cost });
    }
    expect((await Runs.get(youngQuiet))!.outcome).toBeNull();
    expect(await sweepStaleRuns(now)).toBe(0);
  });

  test("the scheduler sweeps every tick by default, before the brain check", async () => {
    const id = await Runs.start({ agentId: AGENT, pass: "nightly-review", scope: "agent", day: "2026-10-26", startedAt: NOW - RUN_STALE_MS - 1, model: MODEL, costUsd: 0.1 });
    const s = createBackgroundScheduler({ now: () => new Date(NOW), brainReady: () => false, agents: async () => [], handlers: {} });
    await s.tick();
    expect(await Runs.get(id)).toMatchObject({ outcome: "error", costUsd: 0.1 });
  });
});
