/**
 * Lifecycle coverage for AgentManager (#startSession / #fanout / #flushTurn /
 * #shouldAutoEvolve) with a fully fake claude-agent-sdk `query`.
 *
 * mock.module note: bun's mock.module can leak across test files in the same
 * process. The mock here delegates to a swappable `currentQuery` function;
 * outside this file's tests it delegates straight to the REAL sdk query, so a
 * leak is behaviorally a no-op. Every non-`query` export is re-exported from
 * the real module (session-mcp & friends need createSdkMcpServer/tool).
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// Must be set before src/memory/index.ts is first imported in this process.
process.env.SLAUDE_MEMORY = "sqlite";
// Defaults for determinism; individual tests override + beforeEach restores.
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
// Capture the original function BEFORE mock.module patches the namespace —
// the namespace object's `query` property gets live-rebound to the mock.
const realQuery = realSdk.query;

type QueryArgs = { prompt: AsyncIterable<any>; options: any };
const passthrough = (args: QueryArgs) => realQuery(args as any);
let currentQuery: (args: QueryArgs) => any = passthrough;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => currentQuery(args),
}));

// Canonical import (no query-string cache-buster): manager.ts dereferences
// `agentSdk.query` at call time, so the mock.module swap above applies even
// when an earlier test file already imported AgentManager. Keeping the canonical
// specifier means coverage is attributed to src/agent/manager.ts.
const { AgentManager } = await import("../../src/agent/manager");
const Sessions = await import("../../src/db/sessions");

// ---------------------------------------------------------------------------
// Fake SDK session
// ---------------------------------------------------------------------------

class FakeSession {
  out: any[] = [];
  ended = false;
  err: Error | null = null;
  users: any[] = [];
  options: any = null;
  onUser: ((um: any) => void) | null = null;
  /** When set, query boot writes this to options.stderr and throws. */
  bootError: string | null = null;
  /** Throw (instead of clean return) when the prompt iterable closes. */
  throwOnClose = false;
  setPermissionModeImpl: (m: string) => Promise<unknown> = async () => ({});
  mcpServerStatusImpl: () => Promise<unknown> = async () => [];
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
  fail(e: Error) {
    this.err = e;
    this.wake();
  }
  end() {
    this.ended = true;
    this.wake();
  }

  start({ prompt, options }: QueryArgs) {
    this.options = options;
    const self = this;

    if (this.bootError) {
      const text = this.bootError;
      return {
        async *[Symbol.asyncIterator]() {
          options.stderr?.(text);
          throw new Error("boot failure");
        },
      };
    }

    options.abortController?.signal.addEventListener("abort", () => {
      self.fail(new Error("aborted by controller"));
    });

    // Drain the manager's prompt iterable in the background.
    (async () => {
      try {
        for await (const um of prompt) {
          self.users.push(um);
          self.onUser?.(um);
        }
        if (self.throwOnClose) self.fail(new Error("transport closed"));
        else self.end();
      } catch (e) {
        self.fail(e as Error);
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
      setPermissionMode: (m: string) => self.setPermissionModeImpl(m),
      mcpServerStatus: () => self.mcpServerStatusImpl(),
      interrupt: async () => {},
    };
  }
}

let pending: FakeSession[] = [];
let spawned: FakeSession[] = [];

function dispatcher(args: QueryArgs) {
  const fs = pending.shift() ?? new FakeSession();
  spawned.push(fs);
  return fs.start(args);
}

function plan(setup?: (fs: FakeSession) => void): FakeSession {
  const fs = new FakeSession();
  setup?.(fs);
  pending.push(fs);
  return fs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function thread() {
  seq++;
  return { team_id: "T1", channel_id: "C1", thread_ts: `${Date.now()}.${seq}` };
}

function record(mgr: InstanceType<typeof AgentManager>): any[] {
  const events: any[] = [];
  mgr.on("event", (e: any) => events.push(e));
  return events;
}

async function until(cond: () => boolean, ms = 3000, label = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}

const txt = (text: string) => ({ type: "text", text });
const think = (thinking: string) => ({ type: "thinking", thinking });
const tool = (name: string, input: unknown = {}) => ({ type: "tool_use", name, input });
const asst = (blocks: any[]) => ({ type: "assistant", message: { content: blocks } });
const res = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  ...over,
});

async function shutdown(mgr: InstanceType<typeof AgentManager>, id: string) {
  if (!mgr.isLive(id)) return;
  mgr.reload(id);
  await until(() => !mgr.isLive(id), 3000, `shutdown of ${id}`);
}

beforeEach(() => {
  pending = [];
  spawned = [];
  currentQuery = dispatcher;
  process.env.SLAUDE_AUTO_EVOLVE = "0";
  process.env.SLAUDE_IDLE_MINUTES = "0";
});

afterAll(() => {
  // Restore real-sdk delegation in case the module mock leaks to later files.
  currentQuery = passthrough;
  process.env.SLAUDE_AUTO_EVOLVE = "0";
  process.env.SLAUDE_IDLE_MINUTES = "0";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentManager lifecycle", () => {
  it("runs a full session: text/thinking/tool blocks, tool results, token usage, errors, reload", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);

    const row = mgr.ensureSession(thread());
    // get-or-create: second call returns the same row
    const again = mgr.ensureSession({
      team_id: row.slack_team_id,
      channel_id: row.slack_channel_id,
      thread_ts: row.slack_thread_ts,
    } as any);
    expect(again.id).toBe(row.id);

    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text === "hello") {
          s.emit(asst([txt("hi there"), think("pondering"), tool("Bash", { command: "ls" })]));
          s.emit({ type: "user", tool_use_result: { ok: 1 } });
          s.emit({ type: "user" }); // no tool_use_result → no event
          s.emit({ type: "system", subtype: "init" }); // default branch
          s.emit(
            res({
              usage: {
                input_tokens: 1000,
                output_tokens: 50,
                cache_read_input_tokens: 200,
                cache_creation_input_tokens: 100,
              },
              modelUsage: { "claude-test": { contextWindow: 200_000 } },
            }),
          );
        } else if (text === "again") {
          s.emit(asst([txt("second answer")]));
          s.emit(res());
        } else if (text === "boom") {
          s.emit(res({ is_error: true, subtype: "error_during_execution" }));
        } else if (text === "boom2") {
          s.emit(res({ is_error: true, subtype: "x", errors: ["a", "b"] }));
        }
      };
    });

    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "first done");

    expect(events.some((e) => e.type === "turnStart" && e.sessionId === row.id)).toBe(true);
    expect(events.find((e) => e.type === "assistantText")?.text).toBe("hi there");
    expect(events.find((e) => e.type === "thinking")?.text).toBe("pondering");
    const call = events.find((e) => e.type === "toolCall");
    expect(call?.tool).toBe("Bash");
    expect(call?.input).toEqual({ command: "ls" });
    const toolResults = events.filter((e) => e.type === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].result).toEqual({ ok: 1 });

    // token accounting
    const usage = events.find((e) => e.type === "tokenUsage");
    expect(usage).toBeDefined();
    expect(usage.snapshot.totalInput).toBe(1300);
    expect(usage.snapshot.contextWindow).toBe(200_000);
    const snap = mgr.getTokenSnapshot(row.id);
    expect(snap).not.toBeNull();
    expect(snap!.outputTokens).toBe(50);

    expect(mgr.isLive(row.id)).toBe(true);
    expect(mgr.liveCount()).toBe(1);
    // assistant message marked the CLI transcript as started
    expect(Sessions.findById(row.id)!.claude_started).toBe(1);

    // second message on an already-live session (flush + pushUser path)
    await mgr.sendMessage(row.id, "again");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "second done");
    expect(events.filter((e) => e.type === "assistantText").map((e) => e.text)).toEqual([
      "hi there",
      "second answer",
    ]);

    // error result via subtype
    await mgr.sendMessage(row.id, "boom");
    await until(() => events.some((e) => e.type === "error"), 3000, "error event");
    expect(events.find((e) => e.type === "error")?.error).toBe("error_during_execution");

    // error result via errors[] array
    await mgr.sendMessage(row.id, "boom2");
    await until(
      () => events.filter((e) => e.type === "error").length === 2,
      3000,
      "second error event",
    );
    expect(events.filter((e) => e.type === "error")[1].error).toBe("a; b");

    expect(fs.users.length).toBe(4);

    // reload: true while live, false once gone
    expect(mgr.reload(row.id)).toBe(true);
    await until(() => !mgr.isLive(row.id), 3000, "session exit");
    expect(mgr.reload(row.id)).toBe(false);
    expect(mgr.liveCount()).toBe(0);
    expect(Sessions.findById(row.id)!.status).toBe("idle");
    // budget forgotten on session teardown
    expect(mgr.getTokenSnapshot(row.id)).toBeNull();
  });

  it("suppresses a resume-miss result(is_error) but still surfaces other turn errors", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = mgr.ensureSession(thread());
    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text === "resumemiss") {
          // Resume miss arrives as a result(is_error); the reboot handles recovery.
          s.emit(res({ is_error: true, errors: ["No conversation found with session ID: " + row.id] }));
        } else if (text === "realerror") {
          s.emit(res({ is_error: true, subtype: "error_during_execution" }));
        }
      };
    });

    await mgr.sendMessage(row.id, "resumemiss");
    // give the result a beat to flow through #fanout
    await until(() => fs.users.length === 1, 3000, "first turn consumed");
    await Bun.sleep(20);
    expect(events.some((e) => e.type === "error")).toBe(false); // suppressed

    await mgr.sendMessage(row.id, "realerror");
    await until(() => events.some((e) => e.type === "error"), 3000, "real error surfaces");
    expect(events.find((e) => e.type === "error")?.error).toBe("error_during_execution");

    await shutdown(mgr, row.id);
  });

  it("abort() aborts the SDK query and surfaces the generic error path", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    mgr.abort("not-live"); // no-op
    const row = mgr.ensureSession(thread());
    plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    mgr.abort(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "abort teardown");
    const err = events.find((e) => e.type === "error");
    expect(err?.error).toContain("aborted by controller");
    expect(Sessions.findById(row.id)!.status).toBe("idle");
  });

  it("reload() suppresses the expected exit error while reloading", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = mgr.ensureSession(thread());
    plan((s) => {
      s.throwOnClose = true;
      s.onUser = () => {
        s.emit(asst([txt("ok")]));
        s.emit(res());
      };
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    expect(mgr.reload(row.id)).toBe(true);
    await until(() => !mgr.isLive(row.id), 3000, "reload exit");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("setPermissionMode persists, pushes to a live query, and logs rejections", async () => {
    const mgr = new AgentManager();
    const row = mgr.ensureSession(thread());

    // not live: persist only
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    expect(Sessions.findById(row.id)!.permission_mode).toBe("bypassPermissions");

    const seen: string[] = [];
    const fs = plan((s) => {
      s.setPermissionModeImpl = async (m) => {
        seen.push(m);
        return {};
      };
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    // bypassPermissions mode at boot sets the danger flag
    expect(fs.options.permissionMode).toBe("bypassPermissions");
    expect(fs.options.allowDangerouslySkipPermissions).toBe(true);

    await mgr.setPermissionMode(row.id, "plan");
    expect(seen).toEqual(["plan"]);
    expect(Sessions.findById(row.id)!.permission_mode).toBe("plan");

    // rejection path: logged, does not throw
    fs.setPermissionModeImpl = async () => {
      throw new Error("sdk says no");
    };
    await mgr.setPermissionMode(row.id, "acceptEdits");
    expect(Sessions.findById(row.id)!.permission_mode).toBe("acceptEdits");

    await shutdown(mgr, row.id);
  });

  it("mcpServerStatus passes through when live and returns null on failure", async () => {
    const mgr = new AgentManager();
    expect(await mgr.mcpServerStatus("nope")).toBeNull();

    const row = mgr.ensureSession(thread());
    const fs = plan((s) => {
      s.mcpServerStatusImpl = async () => [{ name: "kb", status: "connected" }];
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");

    expect(await mgr.mcpServerStatus(row.id)).toEqual([{ name: "kb", status: "connected" }]);

    fs.mcpServerStatusImpl = async () => {
      throw new Error("broken pipe");
    };
    expect(await mgr.mcpServerStatus(row.id)).toBeNull();

    await shutdown(mgr, row.id);
  });

  it("wires resolver/mcp options and runs Stop + PreCompact hooks", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const resolverCalls: any[] = [];
    mgr.setPermissionResolver(async (sid: string, toolName: string, input: Record<string, unknown>) => {
      resolverCalls.push([sid, toolName, input]);
      return { behavior: "allow", updatedInput: input } as any;
    });
    mgr.setMcpResolver(() => ({
      fake: { type: "http", url: "http://localhost:1" } as any,
    }));

    let blocks = 0;
    mgr.setStopGuard(() => (blocks++ >= 0 ? "you must reply first" : null));

    const row = mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");

    // resolver closure + mcp servers landed in Options
    expect(fs.options.mcpServers.fake).toBeDefined();
    expect(fs.options.systemPrompt.append).toContain("<mcp-servers>");
    await fs.options.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    expect(resolverCalls).toEqual([[row.id, "Bash", { command: "ls" }]]);

    const stopHook = fs.options.hooks.Stop[0].hooks[0];
    const preCompact = fs.options.hooks.PreCompact[0].hooks[0];

    // non-matching events pass through
    expect(await stopHook({ hook_event_name: "PreToolUse" })).toEqual({ continue: true });
    expect(await preCompact({ hook_event_name: "Stop" })).toEqual({ continue: true });

    // first Stop is blocked, second is allowed (stderr drift log)
    expect(await stopHook({ hook_event_name: "Stop" })).toEqual({
      decision: "block",
      reason: "you must reply first",
    });
    expect(await stopHook({ hook_event_name: "Stop" })).toEqual({ continue: true });

    // a new user message resets the once-per-turn block
    await mgr.sendMessage(row.id, "next");
    expect((await stopHook({ hook_event_name: "Stop" })).decision).toBe("block");

    // guard returning null allows the stop
    mgr.setStopGuard(() => null);
    expect(await stopHook({ hook_event_name: "Stop" })).toEqual({ continue: true });
    // no guard installed allows the stop
    mgr.setStopGuard(undefined);
    expect(await stopHook({ hook_event_name: "Stop" })).toEqual({ continue: true });

    // PreCompact surfaces a compacting event
    await preCompact({ hook_event_name: "PreCompact", trigger: "auto" });
    const compacting = events.find((e) => e.type === "compacting");
    expect(compacting).toEqual({ type: "compacting", sessionId: row.id, trigger: "auto" });

    await shutdown(mgr, row.id);
  });

  it("retries without resume when the provider lost the session id", async () => {
    const mgr = new AgentManager();
    const row = mgr.ensureSession(thread());
    Sessions.markStarted(row.id); // force a resume attempt on first boot

    plan((s) => {
      s.bootError = "Error: No conversation found with session ID " + row.id;
    });
    plan((s) => {
      s.onUser = () => {
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "hello");
    await until(() => spawned.length === 2, 3000, "retry boot");

    expect(spawned[0]!.options.resume).toBe(row.id);
    // retried fresh: started flag cleared, --session-id seeded instead of resume
    expect(spawned[1]!.options.resume).toBeUndefined();
    expect(spawned[1]!.options.extraArgs["session-id"]).toBe(row.id);
    expect(Sessions.findById(row.id)!.claude_started).toBe(0);
    // the original first prompt is replayed
    await until(() => spawned[1]!.users.length === 1, 3000, "replayed prompt");
    expect(String(spawned[1]!.users[0].message.content)).toBe("hello");

    await shutdown(mgr, row.id);
  });

  it("retries with resume when the seeded session id already has a transcript", async () => {
    const mgr = new AgentManager();
    const row = mgr.ensureSession(thread());
    expect(Sessions.findById(row.id)!.claude_started).toBe(0);

    plan((s) => {
      s.bootError = `Session ${row.id} is already in use.`;
    });
    plan();

    await mgr.sendMessage(row.id, "hello");
    await until(() => spawned.length === 2, 3000, "retry boot");

    expect(spawned[0]!.options.extraArgs["session-id"]).toBe(row.id);
    expect(spawned[1]!.options.resume).toBe(row.id);
    expect(Sessions.findById(row.id)!.claude_started).toBe(1);

    await shutdown(mgr, row.id);
  });

  it("injects the auto-evolve prompt after a turn with >=2 substantive tools", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = mgr.ensureSession(thread());

    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text.includes("<auto-evolve>")) {
          s.emit(res()); // silent NO from the agent
          return;
        }
        s.emit(asst([tool("Bash"), tool("Write"), tool("Read"), txt("did the work")]));
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "do a thing");
    await until(() => fs.users.length === 2, 3000, "auto-evolve injection");
    expect(String(fs.users[1].message.content)).toContain("<auto-evolve>");

    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "evolve done");
    const dones = events.filter((e) => e.type === "done");
    expect(dones[0].autoEvolve).toBeUndefined();
    expect(dones[1].autoEvolve).toBe(true);

    // no recursive evolve after the evolve turn itself
    await Bun.sleep(40);
    expect(fs.users.length).toBe(2);

    await shutdown(mgr, row.id);
  });

  it("skips auto-evolve when the turn already wrote a skill", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = mgr.ensureSession(thread());

    const fs = plan((s) => {
      s.onUser = () => {
        s.emit(asst([tool("mcp__slaude_skills__write_skill"), tool("Bash"), tool("Write")]));
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "save that skill");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    await Bun.sleep(40);
    expect(fs.users.length).toBe(1);

    await shutdown(mgr, row.id);
  });

  it("ignores surface/runtime/skills namespaces and read-only tools for auto-evolve", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = mgr.ensureSession(thread());

    const fs = plan((s) => {
      s.onUser = () => {
        s.emit(
          asst([
            tool("mcp__slaude_surface__reply"),
            tool("mcp__slaude_runtime__status"),
            tool("mcp__slaude_slack__post_message"),
            tool("mcp__slaude_skills__list_skills"),
            tool("Read"),
            tool("Grep"),
            tool("Bash"), // only ONE substantive tool → below threshold
          ]),
        );
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "light touch");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    await Bun.sleep(40);
    expect(fs.users.length).toBe(1);
    expect(events.find((e) => e.type === "done")!.autoEvolve).toBeUndefined();

    await shutdown(mgr, row.id);
  });

  it("idle timer closes the SDK loop and the session exits cleanly", async () => {
    process.env.SLAUDE_IDLE_MINUTES = "0.0005"; // 30ms
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = mgr.ensureSession(thread());

    plan((s) => {
      s.onUser = () => {
        s.emit(asst([txt("quick answer")]));
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    await until(() => !mgr.isLive(row.id), 3000, "idle close");

    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(Sessions.findById(row.id)!.status).toBe("idle");
  });

  it("throws when sending to an unknown session id", async () => {
    const mgr = new AgentManager();
    await expect(mgr.sendMessage("no-such-session", "hi")).rejects.toThrow(
      "session not found: no-such-session",
    );
  });
});
