/**
 * The post-turn skill check (auto-evolve) is budgeted (spec §9.1, §9.3): with
 * a background budget installed the check prompt is pushed only after its
 * skill-check run started, the run is ended with the check turn's own usage
 * (not the user turn's), and a refused or failed start skips the check.
 *
 * The fake SDK harness is the one manager-lifecycle.test.ts uses (a swappable
 * `query` behind mock.module; outside this file it delegates to the real SDK).
 */
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

process.env.SLAUDE_MEMORY = "sqlite";
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
const passthrough = (args: QueryArgs) => realQuery(args as any);
let currentQuery: (args: QueryArgs) => any = passthrough;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: (args: QueryArgs) => currentQuery(args) }));

const { AgentManager } = await import("../../src/agent/manager");
const Sessions = await import("../../src/db/sessions");
const Runs = await import("../../src/db/background-runs");
const { db } = await import("../../src/db/schema");
const { ledgerSkillCheckBudget, turnModelTokens } = await import("../../src/background/skill-check");
const { setAgentId, resetAgentId } = await import("../../src/knowledge/agent-identity");
import type { SkillCheckBudget } from "../../src/background/skill-check";

class FakeSession {
  out: any[] = [];
  ended = false;
  err: Error | null = null;
  users: any[] = [];
  onUser: ((um: any) => void) | null = null;
  _wake: (() => void) | null = null;
  wake() {
    const w = this._wake;
    this._wake = null;
    w?.();
  }
  emit(m: any) {
    this.out.push(m);
    this.wake();
  }
  start({ prompt, options }: QueryArgs) {
    const self = this;
    options.abortController?.signal.addEventListener("abort", () => {
      self.err = new Error("aborted by controller");
      self.wake();
    });
    (async () => {
      try {
        for await (const um of prompt) {
          self.users.push(um);
          self.onUser?.(um);
        }
        self.ended = true;
        self.wake();
      } catch (e) {
        self.err = e as Error;
        self.wake();
      }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (self.err) {
            const e = self.err;
            self.err = null;
            throw e;
          }
          if (self.out.length > 0) {
            yield self.out.shift();
            continue;
          }
          if (self.ended) return;
          await new Promise<void>((r) => (self._wake = r));
        }
      },
      setPermissionMode: async () => ({}),
      mcpServerStatus: async () => [],
      interrupt: async () => {},
    };
  }
}

let pending: FakeSession[] = [];
function plan(onUser: (s: FakeSession, text: string) => void): FakeSession {
  const fs = new FakeSession();
  fs.onUser = (um) => onUser(fs, String(um.message.content));
  pending.push(fs);
  return fs;
}

let seq = 0;
const thread = () => ({ team_id: "T0TEAM", channel_id: "C0TEAM", thread_ts: `${Date.now()}.${++seq}` });
async function until(cond: () => boolean, ms = 3000, label = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}
const MODEL = "claude-test-1";
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
/** modelUsage is the CLI process's running total. */
const modelUsage = (input: number, output: number) => ({ [MODEL]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200_000 } });
const tool = (name: string) => ({ type: "tool_use", name, input: {} });
const asst = (blocks: any[], extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { content: blocks, ...extra } });
const res = (over: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, ...over });
const isCheck = (text: string) => text.includes("<auto-evolve>");

/** A qualifying user turn (usage 1000/100), then the check turn (usage 300/40). */
const qualifyingThenCheck = (check?: (s: FakeSession) => void) =>
  plan((s, text) => {
    if (isCheck(text)) {
      if (check) return check(s);
      s.emit(asst([{ type: "text", text: "no skill needed" }]));
      s.emit(res({ usage: usage(300, 40), modelUsage: modelUsage(1300, 140) }));
      return;
    }
    s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), { type: "text", text: "did it" }]));
    s.emit(res({ usage: usage(1000, 100), modelUsage: modelUsage(1000, 100) }));
  });

function fakeBudget(start: SkillCheckBudget["start"]) {
  const starts: [string, string][] = [];
  const finishes: { sessionId: string; runId: string; r: Parameters<SkillCheckBudget["finish"]>[2] }[] = [];
  const budget: SkillCheckBudget = {
    start: async (sid, persona) => {
      starts.push([sid, persona]);
      return start(sid, persona);
    },
    finish: async (sessionId, runId, r) => {
      finishes.push({ sessionId, runId, r });
    },
  };
  return { budget, starts, finishes };
}

async function shutdown(mgr: InstanceType<typeof AgentManager>, id: string) {
  if (!mgr.isLive(id)) return;
  mgr.reload(id);
  await until(() => !mgr.isLive(id), 3000, `shutdown of ${id}`);
}

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  pending = [];
  currentQuery = (args) => (pending.shift() ?? new FakeSession()).start(args);
  process.env.SLAUDE_AUTO_EVOLVE = "1";
  process.env.SLAUDE_IDLE_MINUTES = "0";
  await db.run("DELETE FROM background_runs");
  logSpy?.mockRestore();
  warnSpy?.mockRestore();
});

afterAll(() => {
  currentQuery = passthrough;
  process.env.SLAUDE_AUTO_EVOLVE = "0";
  logSpy?.mockRestore();
  warnSpy?.mockRestore();
  resetAgentId();
});

describe("budgeted skill check", () => {
  it("with budget: start, then the check turn runs, and finish gets that turn's usage only", async () => {
    const mgr = new AgentManager();
    const { budget, starts, finishes } = fakeBudget(async () => ({ ok: true, runId: "run-1" }));
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    const fs = qualifyingThenCheck();
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => finishes.length === 1, 3000, "finish");
    expect(starts).toEqual([[row.id, "default"]]);
    expect(fs.users.map((u) => isCheck(String(u.message.content)))).toEqual([false, true]);
    // 1300/140 running total minus the user turn's 1000/100.
    expect(finishes[0]).toEqual({
      sessionId: row.id,
      runId: "run-1",
      r: { outcome: "ok", usage: { [MODEL]: { input: 300, output: 40, cache_read: 0, cache_write: 0 } } },
    });
    await shutdown(mgr, row.id);
  });

  it("per-turn modelUsage: the check's own figure, not a difference from the user turn's", async () => {
    const mgr = new AgentManager();
    const { budget, finishes } = fakeBudget(async () => ({ ok: true, runId: "run-pt" }));
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    qualifyingThenCheck((s) => s.emit(res({ usage: usage(1200, 150), modelUsage: modelUsage(1200, 150) })));
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.r).toEqual({ outcome: "ok", usage: { [MODEL]: { input: 1200, output: 150, cache_read: 0, cache_write: 0 } } });
    await shutdown(mgr, row.id);
  });

  it("a qualifying result with no modelUsage (undefined base): the check's usage is still attributed", async () => {
    const mgr = new AgentManager();
    const { budget, finishes } = fakeBudget(async () => ({ ok: true, runId: "run-nb" }));
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    plan((s, text) => {
      if (isCheck(text)) return void s.emit(res({ usage: usage(300, 40), modelUsage: modelUsage(1300, 140) }));
      s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch")]));
      s.emit(res({ usage: usage(1000, 100) }));
    });
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.r).toEqual({ outcome: "ok", usage: { [MODEL]: { input: 300, output: 40, cache_read: 0, cache_write: 0 } } });
    await shutdown(mgr, row.id);
  });

  it("start refused: no check prompt is pushed", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    const mgr = new AgentManager();
    const { budget, starts, finishes } = fakeBudget(async () => ({ ok: false }));
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    const fs = qualifyingThenCheck();
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => starts.length === 1, 3000, "start");
    await Bun.sleep(40);
    expect(fs.users.length).toBe(1);
    expect(finishes).toEqual([]);
    await shutdown(mgr, row.id);
  });

  it("start throws (network, 5xx): no check prompt, one log line", async () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new AgentManager();
    const { budget, starts } = fakeBudget(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    const fs = qualifyingThenCheck();
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => starts.length === 1, 3000, "start");
    await Bun.sleep(40);
    expect(fs.users.length).toBe(1);
    const lines = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("skill check skipped"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ECONNREFUSED");
    await shutdown(mgr, row.id);
  });

  it("an errored check turn ends the run as error with its usage, and the next turn is not a check", async () => {
    const mgr = new AgentManager();
    const events: any[] = [];
    mgr.on("event", (e: any) => events.push(e));
    const { budget, finishes } = fakeBudget(async () => ({ ok: true, runId: "run-err" }));
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    qualifyingThenCheck((s) => s.emit(res({ subtype: "error_during_execution", is_error: true, usage: usage(50, 5), modelUsage: modelUsage(1050, 105) })));
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.r).toEqual({ outcome: "error", usage: { [MODEL]: { input: 50, output: 5, cache_read: 0, cache_write: 0 } } });
    await until(() => events.some((e) => e.type === "error"), 3000, "error event");
    // The next message's turn is a user turn: its done is not marked autoEvolve
    // (a node would otherwise never see its job end).
    await mgr.sendMessage(row.id, "again");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "second done");
    expect(events.filter((e) => e.type === "done").map((e) => e.autoEvolve)).toEqual([undefined, undefined]);
    await shutdown(mgr, row.id);
  });

  it("a check turn cut off before its result still ends the run (error, the usage that arrived)", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    const mgr = new AgentManager();
    const { budget, finishes } = fakeBudget(async () => ({ ok: true, runId: "run-cut" }));
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    let checkStarted = false;
    qualifyingThenCheck((s) => {
      // Two copies of one API call (same id): counted once; output floored.
      s.emit(asst([{ type: "thinking", thinking: "hmm" }], { id: "msg_1", model: MODEL, usage: usage(200, 1) }));
      s.emit(asst([tool("Read")], { id: "msg_1", model: MODEL, usage: usage(200, 1) }));
      checkStarted = true;
    });
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => checkStarted, 3000, "check turn");
    await Bun.sleep(20);
    mgr.abort(row.id);
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.r).toEqual({ outcome: "error", usage: { [MODEL]: { input: 200, output: 1024, cache_read: 0, cache_write: 0 } } });
  });

  it("a message queued while the run starts: the check is abandoned (run ends as error, no usage)", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    const mgr = new AgentManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { budget, finishes } = fakeBudget(async () => {
      await gate;
      return { ok: true, runId: "run-late" };
    });
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    let userTurns = 0;
    const fs = plan((s, text) => {
      if (isCheck(text)) return void s.emit(res());
      userTurns++;
      if (userTurns === 1) s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch")]));
      // The second message's turn stays open until the start resolves.
    });
    await mgr.sendMessage(row.id, "first");
    await until(() => userTurns === 1, 3000, "first turn");
    fs.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
    await Bun.sleep(20);
    await mgr.sendMessage(row.id, "second");
    await until(() => userTurns === 2, 3000, "second turn");
    release();
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.r).toEqual({ outcome: "error", usage: {} });
    expect(fs.users.some((u) => isCheck(String(u.message.content)))).toBe(false);
    fs.emit(res());
    await shutdown(mgr, row.id);
  });

  it("a later user turn that finished while the run started: the stale check is never pushed", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    const mgr = new AgentManager();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { budget, finishes } = fakeBudget(async () => {
      await gate;
      return { ok: true, runId: "run-stale" };
    });
    mgr.setBackgroundBudget(budget);
    const row = await mgr.ensureSession(thread());
    let userTurns = 0;
    const fs = plan((s, text) => {
      if (isCheck(text)) return void s.emit(res());
      userTurns++;
      // The first turn qualifies; the second is a plain reply that ends at once.
      if (userTurns === 1) s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch")]));
      else s.emit(asst([{ type: "text", text: "ok" }]));
      s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(userTurns, userTurns) }));
    });
    const events: any[] = [];
    mgr.on("event", (e: any) => events.push(e));
    await mgr.sendMessage(row.id, "first");
    await until(() => events.filter((e) => e.type === "done").length === 1, 3000, "first done");
    await mgr.sendMessage(row.id, "second");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "second done");
    release();
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.r).toEqual({ outcome: "error", usage: {} });
    await Bun.sleep(30);
    expect(fs.users.some((u) => isCheck(String(u.message.content)))).toBe(false);
    await shutdown(mgr, row.id);
  });

  it("mono ledger: a refused budget pushes no check and leaves a skipped-budget row", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    setAgentId("U0AGENT");
    const mgr = new AgentManager();
    mgr.setBackgroundBudget(
      ledgerSkillCheckBudget({ scopeFor: async () => "agent", budget: () => ({ limitUsd: 0, timeZone: "UTC" }), priceTable: { [MODEL]: { input: 1, output: 10, cache_read: 0, cache_write: 0 } } }),
    );
    const row = await mgr.ensureSession(thread());
    await Sessions.setModel(row.id, MODEL);
    const fs = qualifyingThenCheck();
    await mgr.sendMessage(row.id, "do a thing");
    const day = new Date().toISOString().slice(0, 10);
    const t0 = Date.now();
    let rows: Awaited<ReturnType<typeof Runs.listBetween>> = [];
    while (rows.length === 0 && Date.now() - t0 < 3000) {
      rows = await Runs.listBetween("U0AGENT", day, day);
      await Bun.sleep(10);
    }
    expect(rows.map((r) => [r.pass, r.outcome])).toEqual([["skill-check", "skipped-budget"]]);
    await Bun.sleep(40);
    expect(fs.users.length).toBe(1);
    await shutdown(mgr, row.id);
  });

  it("mono ledger: the check turn's usage is priced onto an ok run", async () => {
    setAgentId("U0AGENT");
    const mgr = new AgentManager();
    mgr.setBackgroundBudget(
      ledgerSkillCheckBudget({ scopeFor: async () => "user:U0ALICE", priceTable: { [MODEL]: { input: 1, output: 10, cache_read: 0, cache_write: 0 } } }),
    );
    const row = await mgr.ensureSession(thread());
    await Sessions.setModel(row.id, MODEL);
    qualifyingThenCheck();
    await mgr.sendMessage(row.id, "do a thing");
    const day = new Date().toISOString().slice(0, 10);
    const t0 = Date.now();
    let rows: Awaited<ReturnType<typeof Runs.listBetween>> = [];
    while (!(rows[0]?.outcome) && Date.now() - t0 < 3000) {
      rows = await Runs.listBetween("U0AGENT", day, day);
      await Bun.sleep(10);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pass: "skill-check", scope: "user:U0ALICE", model: MODEL, outcome: "ok", tokens: { input: 300, output: 40, cache_read: 0, cache_write: 0 } });
    // 300 × 1/1e6 + 40 × 10/1e6
    expect(rows[0]!.costUsd).toBeCloseTo(0.0007, 9);
    await shutdown(mgr, row.id);
  });

  it("no budget installed (a bare manager): the unbudgeted check as before", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = qualifyingThenCheck();
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => fs.users.length === 2, 3000, "check");
    await shutdown(mgr, row.id);
  });
});

describe("turnModelTokens", () => {
  const mu = (m: string, i: number, o: number) => ({ [m]: { inputTokens: i, outputTokens: o } });
  it("is the running modelUsage minus the previous result's, per model", () => {
    expect(turnModelTokens({ ...mu("a", 10, 2), ...mu("b", 5, 1) }, mu("a", 4, 1), usage(11, 2))).toEqual({
      a: { input: 6, output: 1, cache_read: 0, cache_write: 0 },
      b: { input: 5, output: 1, cache_read: 0, cache_write: 0 },
    });
  });
  it("falls back to the turn's usage on the one model when there is no previous snapshot", () => {
    expect(turnModelTokens(mu("a", 10, 2), undefined, usage(3, 1))).toEqual({ a: { input: 3, output: 1, cache_read: 0, cache_write: 0 } });
  });
  it('falls back to "" (the run\'s model) when the difference is inconsistent and several models are listed', () => {
    expect(turnModelTokens({ ...mu("a", 1, 1), ...mu("b", 1, 1) }, mu("a", 9, 9), usage(3, 1))).toEqual({ "": { input: 3, output: 1, cache_read: 0, cache_write: 0 } });
  });
  it("per-turn modelUsage (its sum equals usage) is used as it is, even when the check used more of every kind", () => {
    // User turn 1000/100, check 1200/150: a difference would wrongly say 200/50.
    expect(turnModelTokens(mu("a", 1200, 150), mu("a", 1000, 100), usage(1200, 150))).toEqual({ a: { input: 1200, output: 150, cache_read: 0, cache_write: 0 } });
    expect(turnModelTokens({ ...mu("a", 700, 100), ...mu("b", 500, 50) }, mu("a", 1000, 100), usage(1200, 150))).toEqual({
      a: { input: 700, output: 100, cache_read: 0, cache_write: 0 },
      b: { input: 500, output: 50, cache_read: 0, cache_write: 0 },
    });
  });
  it("a running total whose difference disagrees with usage falls back to usage", () => {
    expect(turnModelTokens(mu("a", 5000, 500), mu("a", 1000, 100), usage(300, 40))).toEqual({ a: { input: 300, output: 40, cache_read: 0, cache_write: 0 } });
  });
  it("an undefined base: per-turn modelUsage as it is, a running total falls back to usage", () => {
    expect(turnModelTokens(mu("a", 300, 40), undefined, usage(300, 40))).toEqual({ a: { input: 300, output: 40, cache_read: 0, cache_write: 0 } });
    expect(turnModelTokens(mu("a", 1300, 140), undefined, usage(300, 40))).toEqual({ a: { input: 300, output: 40, cache_read: 0, cache_write: 0 } });
  });
  it("is empty for a turn with no tokens", () => {
    expect(turnModelTokens(undefined, undefined, undefined)).toEqual({});
  });
});
