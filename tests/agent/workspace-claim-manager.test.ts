/**
 * One turn at a time in the agent's proactive folder (mono, in process): a
 * session in that folder waits for the folder before its turn starts, and
 * frees it when its last outstanding input ends (ok or error) or the session
 * exits. A session's own second message never waits on itself, and a session
 * anywhere else never waits at all.
 *
 * The fake SDK harness is the one background-turn.test.ts uses.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

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


const { proactiveWorkspaceDir } = await import("../../src/agent/workspace-claim");
import type { SkillCheckBudget } from "../../src/background/skill-check";

beforeEach(() => {
  pending = [];
  currentQuery = (args) => (pending.shift() ?? new FakeSession()).start(args);
});
afterAll(() => {
  currentQuery = passthrough;
});

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

function recordEvents(mgr: InstanceType<typeof AgentManager>) {
  const log: string[] = [];
  mgr.on("event", (e: { type: string; sessionId: string }) => {
    if (["turnStart", "done", "error"].includes(e.type)) log.push(`${e.type}:${e.sessionId}`);
  });
  return log;
}

const FOLDER = () => proactiveWorkspaceDir("U0AGENT");

describe("the proactive folder holds one turn at a time", () => {
  it("two sessions in the proactive folder never run turns at once: the second starts after the first's result", async () => {
    const mgr = new AgentManager();
    const log = recordEvents(mgr);
    const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const b = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const gate = deferred();
    plan((s) => void gate.p.then(() => s.emit(res())));
    plan((s) => s.emit(res()));
    await mgr.sendMessage(a.id, "first");
    const sentB = mgr.sendMessage(b.id, "second");
    await Bun.sleep(40);
    expect(log).toEqual([`turnStart:${a.id}`]);
    gate.resolve();
    await sentB;
    await until(() => log.includes(`done:${b.id}`), 3000, "b done");
    expect(log).toEqual([`turnStart:${a.id}`, `done:${a.id}`, `turnStart:${b.id}`, `done:${b.id}`]);
    await shutdown(mgr, a.id);
    await shutdown(mgr, b.id);
  }, 10_000);

  it("a turn that errors releases the folder", async () => {
    const mgr = new AgentManager();
    const log = recordEvents(mgr);
    const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const b = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const gate = deferred();
    plan((s) => void gate.p.then(() => s.emit(res({ subtype: "error_during_execution", is_error: true }))));
    plan((s) => s.emit(res()));
    await mgr.sendMessage(a.id, "first");
    const sentB = mgr.sendMessage(b.id, "second");
    await Bun.sleep(40);
    expect(log).toEqual([`turnStart:${a.id}`]);
    gate.resolve();
    await sentB;
    await until(() => log.includes(`done:${b.id}`), 3000, "b done");
    expect(log.indexOf(`turnStart:${b.id}`)).toBeGreaterThan(log.indexOf(`error:${a.id}`));
    await shutdown(mgr, a.id);
    await shutdown(mgr, b.id);
  }, 10_000);

  it("a session torn down mid-turn releases the folder", async () => {
    const mgr = new AgentManager();
    const log = recordEvents(mgr);
    const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const b = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const fa = plan(() => {});
    plan((s) => s.emit(res()));
    await mgr.sendMessage(a.id, "first");
    await until(() => fa.users.length === 1, 3000, "a input");
    const sentB = mgr.sendMessage(b.id, "second");
    await Bun.sleep(40);
    expect(log).toEqual([`turnStart:${a.id}`]);
    await shutdown(mgr, a.id);
    await sentB;
    await until(() => log.includes(`done:${b.id}`), 3000, "b done");
    await shutdown(mgr, b.id);
  }, 10_000);

  it("a second message to the holding session does not wait on itself", async () => {
    const mgr = new AgentManager();
    const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const gate = deferred();
    const fa = plan((s) => void gate.p.then(() => s.emit(res())));
    await mgr.sendMessage(a.id, "first");
    await mgr.sendMessage(a.id, "second");
    await until(() => fa.users.length === 2, 3000, "both inputs");
    gate.resolve();
    await shutdown(mgr, a.id);
  }, 10_000);

  it("a session outside the proactive folder never waits", async () => {
    const mgr = new AgentManager();
    const log = recordEvents(mgr);
    const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
    const plain = await mgr.ensureSession(thread());
    const gate = deferred();
    plan((s) => void gate.p.then(() => s.emit(res())));
    plan((s) => s.emit(res()));
    await mgr.sendMessage(a.id, "first");
    await mgr.sendMessage(plain.id, "elsewhere");
    await until(() => log.includes(`done:${plain.id}`), 3000, "plain done");
    expect(log.includes(`done:${a.id}`)).toBe(false);
    gate.resolve();
    await shutdown(mgr, a.id);
    await shutdown(mgr, plain.id);
  }, 10_000);

  describe("a budgeted skill check after a proactive turn", () => {
    const saved = process.env.SLAUDE_AUTO_EVOLVE;
    beforeEach(() => void (process.env.SLAUDE_AUTO_EVOLVE = "1"));
    afterAll(() => void (saved === undefined ? delete process.env.SLAUDE_AUTO_EVOLVE : (process.env.SLAUDE_AUTO_EVOLVE = saved)));

    function gatedBudget() {
      const started = deferred();
      const finishes: string[] = [];
      const budget: SkillCheckBudget = {
        start: async () => (await started.p, { ok: true, runId: "run-check" }),
        finish: async (_sid, _runId, r) => void finishes.push(r.outcome),
      };
      return { budget, started, finishes };
    }
    /** A substantive first turn (qualifies for a check); later inputs per `onCheck`. */
    const substantive = (onCheck: (s: FakeSession) => void) =>
      plan((s, text) => {
        if (isCheck(text)) return onCheck(s);
        s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch")]));
        s.emit(res());
      });

    it("is skipped while another session holds the folder", async () => {
      const mgr = new AgentManager();
      const log = recordEvents(mgr);
      const { budget, started, finishes } = gatedBudget();
      mgr.setBackgroundBudget(budget);
      const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
      const b = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
      const fa = substantive((s) => s.emit(res()));
      const gateB = deferred();
      plan((s) => void gateB.p.then(() => s.emit(res())));
      await mgr.sendMessage(a.id, "first");
      await until(() => log.includes(`done:${a.id}`), 3000, "a done");
      await mgr.sendMessage(b.id, "second");
      started.resolve();
      await until(() => finishes.length === 1, 3000, "check run ended");
      expect(finishes).toEqual(["error"]);
      expect(fa.users).toHaveLength(1);
      gateB.resolve();
      await until(() => log.includes(`done:${b.id}`), 3000, "b done");
      await shutdown(mgr, a.id);
      await shutdown(mgr, b.id);
    }, 10_000);

    it("holds the folder while it runs", async () => {
      const mgr = new AgentManager();
      const log = recordEvents(mgr);
      const { budget, started, finishes } = gatedBudget();
      mgr.setBackgroundBudget(budget);
      const a = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
      const b = await mgr.ensureSession(thread(), { workingDir: FOLDER() });
      const checkGate = deferred();
      const fa = substantive((s) => void checkGate.p.then(() => s.emit(res())));
      plan((s) => s.emit(res()));
      await mgr.sendMessage(a.id, "first");
      await until(() => log.includes(`done:${a.id}`), 3000, "a done");
      started.resolve();
      await until(() => fa.users.length === 2, 3000, "check pushed");
      const sentB = mgr.sendMessage(b.id, "second");
      await Bun.sleep(40);
      expect(log.includes(`turnStart:${b.id}`)).toBe(false);
      checkGate.resolve();
      await sentB;
      await until(() => log.includes(`done:${b.id}`), 3000, "b done");
      expect(finishes).toEqual(["ok"]);
      await shutdown(mgr, a.id);
      await shutdown(mgr, b.id);
    }, 10_000);
  });
});
