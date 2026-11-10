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

const { AgentManager, WakeBusyError } = await import("../../src/agent/manager");
const { dbSessionStore } = await import("../../src/agent/session-store");
const Sessions = await import("../../src/db/sessions");
const { resolveDocs, sessionGuardrails } = await import("../../src/guardrails/resolve");
const { liveCalls } = await import("../../src/voice/turn-flags");
import type { BackgroundTurnRun } from "../../src/agent/manager";
import type { ModelTokens } from "../../src/background/prices";

class FakeSession {
  out: any[] = [];
  ended = false;
  /** While set, the query keeps running after its input closes (a slow exit). */
  holdExit: Promise<void> | null = null;
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
          if (self.ended) {
            if (self.holdExit) await self.holdExit;
            return;
          }
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


/** Microtask ticks a live, never-woken session's send takes to resolve. */
const TICKS = 3;
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

describe("a session changing between wake and normal turns", () => {
  let booted: any[] = [];
  beforeEach(() => {
    booted = [];
    const inner = currentQuery;
    currentQuery = (args) => {
      booted.push(args.options);
      return inner(args);
    };
  });
  const answer = (s: FakeSession) => {
    s.emit(asst([{ type: "text", text: "ok" }]));
    s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
  };
  const texts = (s: FakeSession) => s.users.map((u) => String(u.message.content));
  const expectWakeBoot = (o: any) => {
    expect(o.disallowedTools).toContain("mcp__slaude_slack__reply");
    expect(o.disallowedTools).not.toContain("mcp__slaude_runtime__proactive_post");
  };
  const expectNormalBoot = (o: any) => {
    expect(o.disallowedTools).not.toContain("mcp__slaude_slack__reply");
    expect(o.disallowedTools).toContain("mcp__slaude_runtime__proactive_post");
    expect(o.maxBudgetUsd).toBeUndefined();
    expect(o.maxTurns).toBeUndefined();
  };
  /** Lets the started flag land: a resume needs it. */
  const settled = () => Bun.sleep(25);

  it("a session booted for a normal turn restarts on its transcript for a wake", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(answer);
    const b = plan(answer);
    const seen = events(mgr, row.id);
    await mgr.sendMessage(row.id, "hello");
    await until(() => seen.includes("done"), 3000, "done");
    await settled();
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxBudgetUsd: 0.75, maxTurns: 12 } });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(a.ended).toBe(true);
    expect(texts(a)).toEqual(["hello"]);
    expect(texts(b)).toEqual([BG]);
    expect(booted).toHaveLength(2);
    expect(booted[1].resume).toBe(row.id);
    expect(booted[1].maxBudgetUsd).toBe(0.75);
    expect(booted[1].maxTurns).toBe(12);
    expectWakeBoot(booted[1]);
    await shutdown(mgr, row.id);
  });

  it("a session booted as a wake restarts as normal for a message after it, and approvals work again", async () => {
    const mgr = new AgentManager();
    const doc = { slug: "deploys", md: "---\nname: deploys\ndescription: about deploys\n\n---\n```rules\n- id: ask\n  on: tool\n  match: { tool: Deploy }\n  action: approve\n  message: Deploys need an approver.\n```", source: "file" as const, override: false, behindSource: false, enabled: true };
    const set = resolveDocs([doc]);
    mgr.setGuardrailResolver(async (_s: string, persona: string | undefined, channel: string | null) => sessionGuardrails(set, persona ?? "default", channel, { version: 5, proseMax: 4000 }));
    const asked: string[] = [];
    mgr.setPermissionResolver(async (_sid, tool, input) => {
      asked.push(tool);
      return { behavior: "allow", updatedInput: input };
    });
    const row = await mgr.ensureSession(thread());
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    const a = plan(answer);
    const b = plan(answer);
    const seen = events(mgr, row.id);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxBudgetUsd: 0.75, maxTurns: 12 } });
    await until(() => finishes.length === 1, 3000, "finish");
    await settled();
    const pre = { hook_event_name: "PreToolUse", tool_name: "Deploy", tool_input: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "/" };
    const runPre = async (o: any) => {
      const out: any[] = [];
      for (const m of o.hooks.PreToolUse) for (const h of m.hooks) out.push(await h(pre, "t", { signal: new AbortController().signal }));
      return out;
    };
    const during = await runPre(booted[0]);
    expect(during.find((o) => o?.hookSpecificOutput)?.hookSpecificOutput.permissionDecisionReason).toContain("nobody is in this turn");
    expect(asked).toHaveLength(0);
    seen.length = 0;
    await mgr.sendMessage(row.id, "hello");
    await until(() => seen.includes("done"), 3000, "done");
    expect(a.ended).toBe(true);
    expect(texts(b)).toEqual(["hello"]);
    expect(booted).toHaveLength(2);
    expect(booted[1].resume).toBe(row.id);
    expectNormalBoot(booted[1]);
    const after = await runPre(booted[1]);
    expect(after.some((o) => o?.hookSpecificOutput?.permissionDecision === "allow")).toBe(true);
    expect(asked).toEqual(["Deploy"]);
    await shutdown(mgr, row.id);
  });

  for (const maxMinutes of [5, 0]) {
    it(`a message during a wake with maxMinutes ${maxMinutes} is not pushed into it and runs in a normal boot after`, async () => {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      const a = plan(() => {}); // held until the test answers
      const b = plan(answer);
      const { run, finishes } = recorder();
      await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 12, maxMinutes } });
      await until(() => a.users.length === 1, 3000, "wake input");
      const sent = mgr.sendMessage(row.id, "person");
      await Bun.sleep(40);
      expect(texts(a)).toEqual([BG]);
      expect(booted).toHaveLength(1);
      answer(a);
      await sent;
      await until(() => b.users.length === 1, 3000, "the person's turn");
      expect(finishes).toHaveLength(1);
      expect(texts(a)).toEqual([BG]);
      expect(texts(b)).toEqual(["person"]);
      expect(booted).toHaveLength(2);
      expectNormalBoot(booted[1]);
      await shutdown(mgr, row.id);
    });
  }

  it("a wake sent during a normal turn waits for it, then boots as a wake", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    await mgr.sendMessage(row.id, "hello");
    await until(() => a.users.length === 1, 3000, "input");
    const { run, finishes } = recorder();
    const sent = mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 12 } });
    await Bun.sleep(40);
    expect(texts(a)).toEqual(["hello"]);
    expect(booted).toHaveLength(1);
    expect(a.ended).toBe(false);
    answer(a);
    await sent;
    await until(() => finishes.length === 1, 3000, "finish");
    expect(a.ended).toBe(true);
    expect(texts(b)).toEqual([BG]);
    expect(booted).toHaveLength(2);
    expect(booted[1].maxTurns).toBe(12);
    expectWakeBoot(booted[1]);
    await shutdown(mgr, row.id);
  });

  it("a session that never receives a wake does not reboot between turns", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(answer);
    const seen = events(mgr, row.id);
    await mgr.sendMessage(row.id, "one");
    await until(() => seen.includes("done"), 3000, "done");
    seen.length = 0;
    await mgr.sendMessage(row.id, "two");
    await until(() => seen.includes("done"), 3000, "second done");
    expect(texts(a)).toEqual(["one", "two"]);
    expect(booted).toHaveLength(1);
    await shutdown(mgr, row.id);
  });

  it("a wake on a new session boots once, as a wake", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(answer);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 12 } });
    await until(() => finishes.length === 1, 3000, "finish");
    expect(texts(a)).toEqual([BG]);
    expect(booted).toHaveLength(1);
    expect(booted[0].maxTurns).toBe(12);
    await shutdown(mgr, row.id);
  });

  it("a suppressed message during a wake waits and is recorded on the normal boot after it", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(() => {});
    const { run } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    mgr.suppressNextTurn(row.id);
    const sent = mgr.sendMessage(row.id, "record me");
    await Bun.sleep(30);
    const hook = (o: any) => o.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: "UserPromptSubmit", prompt: "x", session_id: "s", transcript_path: "", cwd: "/" }, undefined, { signal: new AbortController().signal });
    // The wake's query must not consume the flag meant for the message behind it.
    expect((await hook(booted[0])).continue).toBe(true);
    answer(a);
    await sent;
    await until(() => b.users.length === 1, 3000, "recorded input");
    expect(texts(b)).toEqual(["record me"]);
    expectNormalBoot(booted[1]);
    expect((await hook(booted[1])).continue).toBe(false);
    answer(b);
    await shutdown(mgr, row.id);
  });

  it("messages waiting at once keep their order, and one restart serves those of one kind", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(() => {});
    const c = plan(answer);
    const { run } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    const second = recorder("run-w2");
    const sends = [
      mgr.sendMessage(row.id, "one"),
      mgr.sendMessage(row.id, "two"),
      mgr.sendMessage(row.id, "second wake", { backgroundRun: second.run, wake: { maxTurns: 3 } }),
    ];
    await Bun.sleep(30);
    expect(booted).toHaveLength(1);
    answer(a);
    await until(() => b.users.length === 2, 3000, "both messages");
    expect(texts(b)).toEqual(["one", "two"]);
    // The later wake still waits for those turns.
    await Bun.sleep(30);
    expect(booted).toHaveLength(2);
    answer(b);
    answer(b);
    await Promise.all(sends);
    await until(() => second.finishes.length === 1, 3000, "second wake");
    expect(texts(c)).toEqual(["second wake"]);
    expect(booted).toHaveLength(3);
    expectNormalBoot(booted[1]);
    expect(booted[2].maxTurns).toBe(3);
    await shutdown(mgr, row.id);
  });

  it("a wake on a session already booted as a wake gets a query of its own", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(answer);
    const b = plan(answer);
    const first = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: first.run, wake: { maxBudgetUsd: 1 } });
    await until(() => first.finishes.length === 1, 3000, "first");
    await settled();
    const second = recorder("run-w2");
    await mgr.sendMessage(row.id, "again", { backgroundRun: second.run, wake: { maxBudgetUsd: 0.25 } });
    await until(() => second.finishes.length === 1, 3000, "second");
    expect(a.ended).toBe(true);
    expect(texts(b)).toEqual(["again"]);
    expect(booted[1].maxBudgetUsd).toBe(0.25);
    await shutdown(mgr, row.id);
  });

  it("a person's message is released when a wake's session exits without a result", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    await mgr.sendMessage(row.id, BG, { wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    const sent = mgr.sendMessage(row.id, "person");
    await Bun.sleep(20);
    mgr.abort(row.id);
    await sent;
    await until(() => b.users.length === 1, 3000, "person's turn");
    expect(texts(b)).toEqual(["person"]);
    expectNormalBoot(booted[1]);
    await shutdown(mgr, row.id);
  });

  it("a wake that ends without a ledger run still releases the message behind it", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    await mgr.sendMessage(row.id, BG, { wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    const sent = mgr.sendMessage(row.id, "person");
    await Bun.sleep(20);
    answer(a);
    await sent;
    await until(() => b.users.length === 1, 3000, "person's turn");
    expectNormalBoot(booted[1]);
    await shutdown(mgr, row.id);
  });

  it("a wake that fails to boot does not hold the messages behind it", async () => {
    const mgr = new AgentManager();
    await expect(mgr.sendMessage("no-such-session", BG, { wake: { maxMinutes: 5 } })).rejects.toThrow("session not found");
    await expect(mgr.sendMessage("no-such-session", "person")).rejects.toThrow("session not found");
  });

  it("a wake arriving during a boot waits for it, then for its turn", async () => {
    const mgr = new AgentManager();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let resolverCalled = false;
    mgr.setGuardrailResolver(async () => {
      resolverCalled = true;
      await gate;
      return null;
    });
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    const first = mgr.sendMessage(row.id, "hello");
    await until(() => resolverCalled, 3000, "boot under way");
    const { run, finishes } = recorder();
    const sent = mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2 } });
    await Bun.sleep(30);
    open();
    await first;
    await until(() => a.users.length === 1, 3000, "first input");
    await Bun.sleep(30);
    expect(booted).toHaveLength(1);
    expect(texts(a)).toEqual(["hello"]);
    answer(a);
    await sent;
    await until(() => finishes.length === 1, 3000, "finish");
    expect(booted).toHaveLength(2);
    expect(booted[1].maxTurns).toBe(2);
    await shutdown(mgr, row.id);
  });

  it("a wake is refused at once while a voice call owns the session, and its run is closed", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(answer);
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const seen = events(mgr, row.id);
    await mgr.sendMessage(row.id, "hello");
    await until(() => seen.includes("done"), 3000, "done");
    liveCalls.add(row.id);
    try {
      const { run, finishes } = recorder();
      const refused = await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2 } }).catch((e) => e);
      expect(refused).toBeInstanceOf(WakeBusyError);
      expect(refused.code).toBe("WAKE_BUSY");
      await until(() => finishes.length === 1, 3000, "the run closed");
      expect(finishes[0]!.outcome).toBe("stopped-budget");
      expect(a.ended).toBe(false);
      expect(exits).toEqual([]);
      expect(booted).toHaveLength(1);
      // The call's own turns still go through.
      seen.length = 0;
      await mgr.sendMessage(row.id, "said on the call");
      await until(() => seen.includes("done"), 3000, "the call's turn");
      expect(texts(a)).toEqual(["hello", "said on the call"]);
    } finally {
      liveCalls.delete(row.id);
    }
    await shutdown(mgr, row.id);
  });

  it("a wake is refused before its restart when a call starts while it waits, and does not hold the queue", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    await mgr.sendMessage(row.id, "hello");
    await until(() => a.users.length === 1, 3000, "input");
    const { run, finishes } = recorder();
    const sent = mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2 } }).catch((e) => e);
    const behind = mgr.sendMessage(row.id, "behind it");
    await Bun.sleep(20);
    liveCalls.add(row.id);
    try {
      answer(a);
      expect(await sent).toBeInstanceOf(WakeBusyError);
      await behind;
      expect(finishes).toHaveLength(1);
      expect(exits).toEqual([]);
      expect(a.ended).toBe(false);
      expect(texts(a)).toEqual(["hello", "behind it"]);
      expect(booted).toHaveLength(1);
    } finally {
      liveCalls.delete(row.id);
    }
    await shutdown(mgr, row.id);
  });

  it("a person's message still inside its send boots as normal, and the wake behind it waits", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    const { run, finishes } = recorder();
    const first = mgr.sendMessage(row.id, "person");
    const sent = mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2 } });
    await until(() => a.users.length === 1, 3000, "the person's input");
    await first;
    await Bun.sleep(30);
    expect(booted).toHaveLength(1);
    expectNormalBoot(booted[0]);
    expect(texts(a)).toEqual(["person"]);
    answer(a);
    await sent;
    await until(() => finishes.length === 1, 3000, "the wake");
    expect(texts(b)).toEqual([BG]);
    expect(booted[1].maxTurns).toBe(2);
    expectWakeBoot(booted[1]);
    await shutdown(mgr, row.id);
  });

  it("a send whose store read rejects stops counting, so a later wake is not held", async () => {
    const mgr = new AgentManager();
    let failing = true;
    mgr.setSessionStore({
      ...dbSessionStore,
      findById: (id: string) => (failing ? Promise.reject(new Error("store down")) : dbSessionStore.findById(id)),
    });
    const row = await mgr.ensureSession(thread());
    const a = plan(answer);
    await expect(mgr.sendMessage(row.id, "lost")).rejects.toThrow("store down");
    failing = false;
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2 } });
    await until(() => finishes.length === 1, 3000, "the wake");
    expect(texts(a)).toEqual([BG]);
    expect(booted).toHaveLength(1);
    expect(booted[0].maxTurns).toBe(2);
    await shutdown(mgr, row.id);
  });

  const hook = (o: any) => o.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: "UserPromptSubmit", prompt: "x", session_id: "s", transcript_path: "", cwd: "/" }, undefined, { signal: new AbortController().signal });

  it("a suppressed message behind a wake silences itself, not the message before it", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(() => {});
    const { run } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    const one = mgr.sendMessage(row.id, "one");
    mgr.suppressNextTurn(row.id);
    const two = mgr.sendMessage(row.id, "two");
    answer(a);
    await Promise.all([one, two]);
    await until(() => b.users.length === 2, 3000, "both inputs");
    expect((await hook(booted[1])).continue).toBe(true);
    expect((await hook(booted[1])).continue).toBe(false);
    answer(b);
    answer(b);
    await Bun.sleep(20);
    await shutdown(mgr, row.id);
  });

  it("a delivery that rejects leaves no suppression behind it", async () => {
    const mgr = new AgentManager();
    let failing = true;
    mgr.setGuardrailResolver(async () => {
      if (failing) throw new Error("rules unreadable");
      return null;
    });
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    mgr.suppressNextTurn(row.id);
    await expect(mgr.sendMessage(row.id, "lost")).rejects.toThrow();
    failing = false;
    await mgr.sendMessage(row.id, "next");
    await until(() => a.users.length === 1, 3000, "the next input");
    expect((await hook(booted[0])).continue).toBe(true);
    answer(a);
    await Bun.sleep(20);
    await shutdown(mgr, row.id);
  });

  it("a rejected delivery does not hold the messages behind it", async () => {
    const mgr = new AgentManager();
    let failing = false;
    mgr.setGuardrailResolver(async () => {
      if (failing) throw new Error("rules unreadable");
      return null;
    });
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    await mgr.sendMessage(row.id, "hello");
    await until(() => a.users.length === 1, 3000, "input");
    const sent = mgr.sendMessage(row.id, BG, { wake: {} }).catch((e) => e);
    const behind = mgr.sendMessage(row.id, "behind it");
    failing = true;
    answer(a);
    const rejected = await sent;
    expect(rejected).toBeInstanceOf(Error);
    failing = false;
    await behind;
    await until(() => b.users.length === 1, 3000, "the message behind it");
    expect(texts(b)).toEqual(["behind it"]);
    expectNormalBoot(booted.at(-1));
    await shutdown(mgr, row.id);
  });

  it("a boot that fails at go-live tears down, so a queued message is not held and the send rejects", async () => {
    const mgr = new AgentManager();
    let failing = false;
    mgr.setSessionStore({
      ...dbSessionStore,
      setStatus: (id: string, status: any) => {
        if (failing && status === "running") {
          failing = false;
          return Promise.reject(new Error("store down"));
        }
        return dbSessionStore.setStatus(id, status);
      },
    });
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    await mgr.sendMessage(row.id, "hello");
    await until(() => a.users.length === 1, 3000, "input");
    const sent = mgr.sendMessage(row.id, BG, { wake: { maxMinutes: 5 } }).catch((e) => e);
    const behind = mgr.sendMessage(row.id, "behind it");
    failing = true;
    answer(a);
    expect((await sent).message).toBe("store down");
    await behind;
    await until(() => b.users.length === 1, 3000, "the message behind it");
    expect(texts(b)).toEqual(["behind it"]);
    expectNormalBoot(booted.at(-1));
    expect(exits).toHaveLength(2); // the first query's restart, then the failed boot's teardown
    await shutdown(mgr, row.id);
  });

  it("a resume miss neither ends the wake nor clears its wall clock", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    await Sessions.markStarted(row.id);
    const a = plan(() => {});
    const b = plan(() => {}); // the retried boot, held
    const c = plan(answer);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2, maxMinutes: 0.01 } });
    await until(() => a.users.length === 1, 3000, "wake input");
    const sent = mgr.sendMessage(row.id, "person");
    a.emit(res({ subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID x"] }));
    await Bun.sleep(5);
    booted[0].stderr("Error: No conversation found with session ID x");
    a.err = new Error("process exited");
    a.wake();
    await until(() => b.users.length === 1, 3000, "the retried wake");
    expect(texts(b)).toEqual([BG]);
    expect(booted[1].maxTurns).toBe(2);
    expect(finishes).toHaveLength(0);
    expect(c.users).toHaveLength(0);
    // The wall clock survives and closes the run; the person goes after it.
    await sent;
    await until(() => c.users.length === 1, 3000, "the person's turn");
    expect(finishes).toHaveLength(1);
    expect((finishes[0]!.stats as { cap: string }).cap).toBe("minutes");
    expectNormalBoot(booted[2]);
    await shutdown(mgr, row.id);
  });

  it("a retried wake finishes its own run with its own result", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    await Sessions.markStarted(row.id);
    const a = plan(() => {});
    const b = plan(answer);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    a.emit(res({ subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID x"] }));
    await Bun.sleep(5);
    booted[0].stderr("Error: No conversation found with session ID x");
    a.err = new Error("process exited");
    a.wake();
    await until(() => finishes.length === 1, 3000, "the run closed");
    expect(finishes[0]!.outcome).toBe("ok");
    expect(texts(b)).toEqual([BG]);
    await shutdown(mgr, row.id);
  });

  it("a stream-closed wake continues as a wake with its run, and the queued message waits for that", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(() => {});
    const c = plan(answer);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxTurns: 2 } });
    await until(() => a.users.length === 1, 3000, "wake input");
    const sent = mgr.sendMessage(row.id, "person");
    await Bun.sleep(20);
    a.emit({ type: "user", tool_use_result: { is_error: true, content: "Stream closed" }, message: { content: [] } });
    a.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
    await until(() => b.users.length === 1, 3000, "the continuation");
    expect(texts(b)[0]).toContain("Please continue");
    expect(booted[1].maxTurns).toBe(2);
    expectWakeBoot(booted[1]);
    await Bun.sleep(30);
    expect(c.users).toHaveLength(0);
    expect(finishes).toHaveLength(0);
    answer(b);
    await sent;
    await until(() => c.users.length === 1, 3000, "the person's turn");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]!.outcome).toBe("ok");
    expectNormalBoot(booted[2]);
    await shutdown(mgr, row.id);
  });

  it("the wall clock releases a message waiting behind the wake", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(answer);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: { maxMinutes: 0.002 } });
    await until(() => a.users.length === 1, 3000, "wake input");
    const sent = mgr.sendMessage(row.id, "person");
    await sent;
    await until(() => b.users.length === 1, 3000, "the person's turn");
    expect(finishes).toHaveLength(1);
    expect((finishes[0]!.stats as { cap: string }).cap).toBe("minutes");
    expect(texts(b)).toEqual(["person"]);
    expectNormalBoot(booted[1]);
    await shutdown(mgr, row.id);
  });

  it("a message arriving through idle teardown waits for the exit and boots as normal", async () => {
    process.env.SLAUDE_IDLE_MINUTES = "0.0008";
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      const a = plan(answer);
      const b = plan(answer);
      let releaseExit!: () => void;
      a.holdExit = new Promise<void>((r) => (releaseExit = r));
      const { run, finishes } = recorder();
      await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
      await until(() => finishes.length === 1, 3000, "the wake");
      await until(() => a.ended, 3000, "idle teardown");
      const seen = events(mgr, row.id);
      const sent = mgr.sendMessage(row.id, "person");
      await Bun.sleep(30);
      expect(b.users).toHaveLength(0);
      releaseExit();
      await sent;
      await until(() => seen.includes("done"), 3000, "the person's turn");
      expect(texts(b)).toEqual(["person"]);
      expect(booted).toHaveLength(2);
      expectNormalBoot(booted[1]);
      await shutdown(mgr, row.id);
    } finally {
      process.env.SLAUDE_IDLE_MINUTES = "0";
    }
  });

  it("a never-woken session's send adds no await tick", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    await mgr.sendMessage(row.id, "one");
    await until(() => a.users.length === 1, 3000, "input");
    let done = false;
    let ticks = 0;
    void mgr.sendMessage(row.id, "two").then(() => void (done = true));
    while (!done && ticks < 50) {
      await null;
      ticks++;
    }
    expect(ticks).toBe(TICKS);
    a.emit(res());
    a.emit(res());
    await Bun.sleep(20);
    await shutdown(mgr, row.id);
  });

  it("no skill check follows a wake's turn, and a command pushed during it does not disturb the wait", async () => {
    const work = (s: FakeSession, text: string) => {
      if (text === "/compact") { s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) })); return; }
      if (isCheck(text)) { s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(2, 2) })); return; }
      s.emit(asst([tool("Edit"), tool("Bash"), tool("Write"), tool("Edit"), tool("Bash")]));
      s.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
    };
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const a = plan(() => {});
    const b = plan(work);
    const { run, finishes } = recorder();
    await mgr.sendMessage(row.id, BG, { backgroundRun: run, wake: {} });
    await until(() => a.users.length === 1, 3000, "wake input");
    expect(mgr.triggerCommand(row.id, "/compact")).toBe(true);
    const sent = mgr.sendMessage(row.id, "person");
    await Bun.sleep(20);
    a.emit(asst([tool("Edit"), tool("Bash"), tool("Write"), tool("Edit"), tool("Bash")]));
    a.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
    await until(() => finishes.length === 1, 3000, "finish");
    await Bun.sleep(30);
    // The command's turn is still out: the input stays open until it ends.
    expect(a.ended).toBe(false);
    expect(a.users.some((u) => isCheck(String(u.message.content)))).toBe(false);
    a.emit(res({ usage: usage(1, 1), modelUsage: modelUsage(1, 1) }));
    await sent;
    await until(() => b.users.length === 2, 3000, "person's turn and its check");
    expect(texts(b)[0]).toBe("person");
    expect(isCheck(texts(b)[1]!)).toBe(true);
    await shutdown(mgr, row.id);
  });
});
