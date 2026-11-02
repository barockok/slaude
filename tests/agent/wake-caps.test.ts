/**
 * A heartbeat wake's session (spec sections 5 to 7): its query gets the caps and
 * hides the refused tools, a cap or failure closes its run and is not surfaced as
 * an error, its wall clock closes the run itself, and no skill check follows it.
 * The fake SDK harness is the one background-turn.test.ts uses.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

process.env.SLAUDE_MEMORY = "sqlite";
process.env.SLAUDE_AUTO_EVOLVE = "1";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
const passthrough = (args: QueryArgs) => realQuery(args as any);
let currentQuery: (args: QueryArgs) => any = passthrough;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: (args: QueryArgs) => currentQuery(args) }));

const { AgentManager } = await import("../../src/agent/manager");
import type { BackgroundTurnRun } from "../../src/agent/manager";
import type { ModelTokens } from "../../src/background/prices";

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


async function shutdown(mgr: InstanceType<typeof AgentManager>, id: string) {
  if (!mgr.isLive(id)) return;
  mgr.reload(id);
  await until(() => !mgr.isLive(id), 3000, `shutdown of ${id}`);
}


const BG = '<runtime-check kind="wake">look</runtime-check>';
function recorder(runId = "run-w1") {
  const finishes: { usage: ModelTokens; outcome: string; stats: unknown }[] = [];
  const run: BackgroundTurnRun = { runId, finish: async (usage, outcome, stats) => void finishes.push({ usage, outcome, stats }) };
  return { run, finishes };
}
let lastOptions: any;
beforeEach(() => {
  pending = [];
  lastOptions = undefined;
  currentQuery = (args) => {
    lastOptions = args.options;
    return (pending.shift() ?? new FakeSession()).start(args);
  };
});
afterAll(() => {
  currentQuery = passthrough;
});
function events(mgr: InstanceType<typeof AgentManager>, id: string) {
  const seen: string[] = [];
  mgr.on("event", (e: any) => {
    if (e.sessionId === id) seen.push(e.type);
  });
  return seen;
}

describe("a wake's query", () => {
  it("gets the caps and hides what a wake may not call", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    plan((s) => s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) })));
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxBudgetUsd: 0.75, maxTurns: 12 } });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(lastOptions.maxBudgetUsd).toBe(0.75);
    expect(lastOptions.maxTurns).toBe(12);
    expect(lastOptions.disallowedTools).toContain("mcp__slaude_slack__reply");
    expect(lastOptions.disallowedTools).toContain("mcp__slaude_surface__request_approval");
    expect(lastOptions.disallowedTools).not.toContain("mcp__slaude_slack__post_message");
    expect(lastOptions.disallowedTools).not.toContain("mcp__slaude_runtime__proactive_post");
    await shutdown(mgr, row.id);
  });
  it("a cap that is off is simply not passed", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    plan((s) => s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) })));
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxBudgetUsd: 0.5 } });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(lastOptions.maxTurns).toBeUndefined();
    await shutdown(mgr, row.id);
  });
  it("a normal session gets none of this", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    plan((s) => s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) })));
    const seen = events(mgr, row.id);
    await mgr.sendMessage(row.id, "hello");
    await until(() => seen.includes("done"), 3000, "done");
    expect(lastOptions.maxBudgetUsd).toBeUndefined();
    expect(lastOptions.maxTurns).toBeUndefined();
    expect(lastOptions.disallowedTools).not.toContain("mcp__slaude_slack__reply");
    // The wake's own tools are hidden; read_channel works in any turn.
    expect(lastOptions.disallowedTools).toContain("mcp__slaude_runtime__proactive_post");
    expect(lastOptions.disallowedTools).toContain("mcp__slaude_runtime__finish_round");
    expect(lastOptions.disallowedTools).not.toContain("mcp__slaude_runtime__read_channel");
    await shutdown(mgr, row.id);
  });
});

describe("how a wake ends", () => {
  it("success reports what it took", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    plan((s) => s.emit(res({ usage: usage(5, 2), modelUsage: modelUsage(5, 2), num_turns: 7, duration_ms: 42_000 })));
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.outcome).toBe("ok");
    expect(finishes[0]!.stats).toEqual({ turns: 7, durationMs: 42_000 });
    await shutdown(mgr, row.id);
  });
  for (const [subtype, cap] of [["error_max_budget_usd", "usd"], ["error_max_turns", "turns"]] as const) {
    it(`${subtype} is stopped-budget, not an error anyone is told about`, async () => {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      const seen = events(mgr, row.id);
      plan((s) => s.emit(res({ subtype, is_error: true, errors: ["cap"], usage: usage(5, 2), modelUsage: modelUsage(5, 2), num_turns: 3 })));
      const { run, finishes } = recorder();
      await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
      await until(() => finishes.length === 1 && seen.includes("done"), 3000, "finish");
      expect(finishes[0]!.outcome).toBe("stopped-budget");
      expect((finishes[0]!.stats as { cap: string }).cap).toBe(cap);
      expect(seen).not.toContain("error");
      await shutdown(mgr, row.id);
    });
  }
  it("any other failure closes the run as an error, and is not posted either", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const seen = events(mgr, row.id);
    plan((s) => s.emit(res({ subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: usage(5, 2), modelUsage: modelUsage(5, 2) })));
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => finishes.length === 1 && seen.includes("done"), 3000, "finish");
    expect(finishes[0]!.outcome).toBe("error");
    expect(seen).not.toContain("error");
    await shutdown(mgr, row.id);
  });
  it("the wall clock closes the run itself and ends the turn", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const seen = events(mgr, row.id);
    plan(() => {}); // never answers
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxMinutes: 0.001 } });
    await until(() => finishes.length === 1 && seen.includes("done"), 3000, "wall clock");
    expect(finishes[0]!.outcome).toBe("stopped-budget");
    expect(finishes[0]!.usage).toEqual({});
    expect((finishes[0]!.stats as { cap: string }).cap).toBe("minutes");
  });
  it("no skill check follows a substantive wake, though one follows the same work in a normal turn", async () => {
    const work = (s: FakeSession, text: string) => {
      if (isCheck(text)) { s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(2, 2) })); return; }
      s.emit(asst([tool("Edit"), tool("Bash"), tool("Write"), tool("Edit"), tool("Bash")]));
      s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
    };
    const mgr = new AgentManager();
    const normal = await mgr.ensureSession(thread());
    const a = plan(work);
    const seenA = events(mgr, normal.id);
    await mgr.sendMessage(normal.id, "do the thing");
    await until(() => seenA.includes("done"), 3000, "done");
    await until(() => a.users.some((u) => isCheck(String(u.message.content))), 3000, "the control's check");

    const woken = await mgr.ensureSession(thread());
    const b = plan(work);
    const { run, finishes } = recorder();
    await mgr.sendMessage(woken.id, BG, { backgroundRun: run, wake: {} });
    await until(() => finishes.length === 1, 3000, "finish");
    await Bun.sleep(50);
    expect(b.users.some((u) => isCheck(String(u.message.content)))).toBe(false);
    await shutdown(mgr, normal.id);
    await shutdown(mgr, woken.id);
  });
});
