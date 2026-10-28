/**
 * A budgeted background turn (phase E, a promise check): sendMessage with a
 * `backgroundRun` tags that input, and its own result finishes the run with
 * that input's usage, never a human turn's. A run whose input never reaches a
 * result stays open (the stale-run sweep closes it at its estimate).
 *
 * The fake SDK harness is the one skill-check-budget.test.ts uses.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { paths } from "../../src/config/home";
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

const isBg = (text: string) => text.includes("<runtime-check kind=\"commitment\"");
const BG = '<runtime-check kind="commitment">check the deploy</runtime-check>';

function recorder(runId = "run-c1") {
  const finishes: { usage: ModelTokens; outcome: "ok" | "error" }[] = [];
  const run: BackgroundTurnRun = { runId, finish: async (usage, outcome) => void finishes.push({ usage, outcome }) };
  return { run, finishes };
}

let warnSpy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  pending = [];
  currentQuery = (args) => (pending.shift() ?? new FakeSession()).start(args);
  warnSpy?.mockRestore();
  warnSpy = undefined;
});
afterAll(() => {
  currentQuery = passthrough;
  warnSpy?.mockRestore();
});

const tokens = (input: number, output: number) => ({ input, output, cache_read: 0, cache_write: 0 });

describe("budgeted background turn", () => {
  it("ensureSession: workingDir applies only at creation; default stays per-thread", async () => {
    const mgr = new AgentManager();
    const t = thread();
    const x = join(tmpdir(), `ws-x-${Date.now()}`);
    const row = await mgr.ensureSession(t, { workingDir: x });
    expect(row.working_dir).toBe(x);
    expect(existsSync(x)).toBe(true);
    const again = await mgr.ensureSession(t, { workingDir: join(tmpdir(), "ws-other") });
    expect(again.id).toBe(row.id);
    expect(again.working_dir).toBe(x);
    const plain = await mgr.ensureSession(thread());
    expect(basename(plain.working_dir)).toMatch(/^T0TEAM-C0TEAM-/);
    expect(dirname(plain.working_dir)).toBe(paths.workspaces);
  });
  it("a fresh session's background input is finished with its own usage", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    plan((s) => {
      s.emit(asst([{ type: "text", text: "not out yet" }]));
      s.emit(res({ usage: usage(300, 40), modelUsage: modelUsage(300, 40) }));
    });
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]).toEqual({ outcome: "ok", usage: { [MODEL]: tokens(300, 40) } });
    await shutdown(mgr, row.id);
  });

  it("on a warm session, only the background turn's usage is charged, never the human turn before it", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = plan((s, text) => {
      if (isBg(text)) return void s.emit(res({ usage: usage(300, 40), modelUsage: modelUsage(1300, 140) }));
      s.emit(asst([{ type: "text", text: "hi" }]));
      s.emit(res({ usage: usage(1000, 100), modelUsage: modelUsage(1000, 100) }));
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.out.length === 0 , 3000, "first turn");
    await until(() => fs.users.length === 1, 3000, "first input");
    await Bun.sleep(20);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]).toEqual({ outcome: "ok", usage: { [MODEL]: tokens(300, 40) } });
    await shutdown(mgr, row.id);
  });

  it("queued behind a human input, the run waits for its own result", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    plan((s, text) => {
      // Results arrive in input order, as the CLI runs inputs one after another:
      // the human turn finishes only after the background input is queued.
      if (isBg(text)) return void gate.then(() => Bun.sleep(5)).then(() => s.emit(res({ usage: usage(200, 20), modelUsage: modelUsage(1200, 120) })));
      void gate.then(() => s.emit(res({ usage: usage(1000, 100), modelUsage: modelUsage(1000, 100) })));
    });
    await mgr.sendMessage(row.id, "hello");
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run });
    expect(finishes).toEqual([]);
    release();
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]).toEqual({ outcome: "ok", usage: { [MODEL]: tokens(200, 20) } });
    await shutdown(mgr, row.id);
  });

  it("an error result finishes the run as error", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    plan((s) => s.emit(res({ subtype: "error_during_execution", is_error: true, usage: usage(50, 5), modelUsage: modelUsage(50, 5) })));
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(finishes[0]!.outcome).toBe("error");
    await shutdown(mgr, row.id);
  });

  it("a session torn down before the result leaves the run open", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = plan(() => {});
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run });
    await until(() => fs.users.length === 1, 3000, "input");
    await shutdown(mgr, row.id);
    await Bun.sleep(20);
    expect(finishes).toEqual([]);
  });

  it("a finish that throws is logged, not thrown", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      plan((s) => s.emit(res({ usage: usage(10, 1), modelUsage: modelUsage(10, 1) })));
      let called = false;
      await mgr.sendMessage(row.id, BG, {
        backgroundRun: {
          runId: "run-x",
          finish: async () => {
            called = true;
            throw new Error("gateway down");
          },
        },
      });
      await until(() => called, 3000, "finish");
      await Bun.sleep(10);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("run-x could not be recorded"))).toBe(true);
      await shutdown(mgr, row.id);
    } finally {
      errSpy.mockRestore();
    }
  });
});
