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
import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { env } from "../../src/config/env";

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
const { injectedTurns, voiceTurns } = await import("../../src/voice/turn-flags");
const { VoiceCalls } = await import("../../src/voice/call");

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
  /** Never exit: ignore both the prompt iterable closing and the abort signal
   *  (a CLI that hangs after its stdin closes). */
  hang = false;
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
      if (self.hang) return;
      self.fail(new Error("aborted by controller"));
    });

    // Drain the manager's prompt iterable in the background.
    (async () => {
      try {
        for await (const um of prompt) {
          self.users.push(um);
          self.onUser?.(um);
        }
        if (self.hang) return;
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
  delete process.env.SLAUDE_AUTO_EVOLVE_MIN_TOOLS;
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

    const row = await mgr.ensureSession(thread());
    // get-or-create: second call returns the same row
    const again = await mgr.ensureSession({
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
    expect((await Sessions.findById(row.id))!.claude_started).toBe(1);

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
    expect((await Sessions.findById(row.id))!.status).toBe("idle");
    // budget forgotten on session teardown
    expect(mgr.getTokenSnapshot(row.id)).toBeNull();
  });

  it("suppresses a resume-miss result(is_error) but still surfaces other turn errors", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
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

  it("abort() aborts the SDK query and suppresses the error event", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    mgr.abort("not-live"); // no-op
    const row = await mgr.ensureSession(thread());
    plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    mgr.abort(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "abort teardown");
    // Intentional abort suppresses the error event (no spurious error surfaced to the gateway)
    const err = events.find((e) => e.type === "error");
    expect(err).toBeUndefined();
    expect((await Sessions.findById(row.id))!.status).toBe("idle");
  });

  it("reload() suppresses the expected exit error while reloading", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
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
    const row = await mgr.ensureSession(thread());

    // not live: persist only
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    expect((await Sessions.findById(row.id))!.permission_mode).toBe("bypassPermissions");

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
    expect((await Sessions.findById(row.id))!.permission_mode).toBe("plan");

    // rejection path: logged, does not throw
    fs.setPermissionModeImpl = async () => {
      throw new Error("sdk says no");
    };
    await mgr.setPermissionMode(row.id, "acceptEdits");
    expect((await Sessions.findById(row.id))!.permission_mode).toBe("acceptEdits");

    await shutdown(mgr, row.id);
  });

  it("mcpServerStatus passes through when live and returns null on failure", async () => {
    const mgr = new AgentManager();
    expect(await mgr.mcpServerStatus("nope")).toBeNull();

    const row = await mgr.ensureSession(thread());
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

  it("mounts the built-in slaude plugin next to the $SLAUDE_HOME plugin", async () => {
    const { BUILTIN_PLUGIN_DIR } = await import("../../src/soul/builtin");
    const { paths } = await import("../../src/config/home");
    const want = { type: "local", path: BUILTIN_PLUGIN_DIR, skipMcpDiscovery: true };
    // gateway/mono, then a node (an MCP resolver installed)
    for (const node of [false, true]) {
      const mgr = new AgentManager();
      if (node) mgr.setMcpResolver(async () => ({}));
      const row = await mgr.ensureSession(thread());
      const fs = plan();
      await mgr.sendMessage(row.id, "hello");
      await until(() => fs.options !== null, 3000, "boot");
      expect(fs.options.plugins.slice(0, 2)).toEqual([
        { type: "local", path: paths.home, skipMcpDiscovery: true },
        want,
      ]);
      await shutdown(mgr, row.id);
    }
  });

  it("warns loudly at boot when another plugin would also be named \"slaude\"", async () => {
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { paths } = await import("../../src/config/home");
    const { BUILTIN_PLUGIN_DIR } = await import("../../src/soul/builtin");
    // An installed plugin whose directory is named "slaude" and has no manifest:
    // the CLI names it after the basename, the built-in plugin's name.
    const root = mkdtempSync(join(tmpdir(), "plugin-collide-"));
    const collide = join(root, "slaude");
    mkdirSync(collide);
    const file = join(paths.claudeConfig, "plugins", "installed_plugins.json");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    mkdirSync(join(paths.claudeConfig, "plugins"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, plugins: { "x@mp": [{ scope: "user", installPath: collide }] } }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      const fs = plan();
      await mgr.sendMessage(row.id, "hello");
      await until(() => fs.options !== null, 3000, "boot");
      expect(fs.options.plugins.map((p: any) => p.path)).toContain(collide);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("plugin name \"slaude\""));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(collide);
      expect(lines[0]).toContain("built-in");
      // the built-in plugin itself is never reported
      expect(lines[0]).not.toContain(BUILTIN_PLUGIN_DIR);
      await shutdown(mgr, row.id);
    } finally {
      warn.mockRestore();
      if (before === null) rmSync(file, { force: true });
      else writeFileSync(file, before);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WS-C §4.2: a node's async resolver returns the bridged servers next to the
  // shims; they reach Options.mcpServers and the <mcp-servers> block.
  it("an async MCP resolver's bridged servers are mounted and listed in <mcp-servers>", async () => {
    const { buildBridgeServers } = await import("../../src/node/bridge");
    const mgr = new AgentManager();
    mgr.setMcpResolver(async (sid) => ({
      ...(await buildBridgeServers(sid, ["example-crm"], {
        client: { postMcpx: async () => ({ tools: [], instructions: "x" }) },
        tokenFor: () => "tok",
      })),
      slaude_session: { type: "http", url: "http://localhost:1" } as any,
    }));
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(fs.options.mcpServers["example-crm"]).toMatchObject({ type: "sdk", name: "example-crm" });
    expect(fs.options.systemPrompt.append).toContain("- example-crm\n");
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

    const row = await mgr.ensureSession(thread());
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
    const row = await mgr.ensureSession(thread());
    await Sessions.markStarted(row.id); // force a resume attempt on first boot

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
    expect((await Sessions.findById(row.id))!.claude_started).toBe(0);
    // the original first prompt is replayed
    await until(() => spawned[1]!.users.length === 1, 3000, "replayed prompt");
    expect(String(spawned[1]!.users[0].message.content)).toBe("hello");

    await shutdown(mgr, row.id);
  });

  it("retries with resume when the seeded session id already has a transcript", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    expect((await Sessions.findById(row.id))!.claude_started).toBe(0);

    plan((s) => {
      s.bootError = `Session ${row.id} is already in use.`;
    });
    plan();

    await mgr.sendMessage(row.id, "hello");
    await until(() => spawned.length === 2, 3000, "retry boot");

    expect(spawned[0]!.options.extraArgs["session-id"]).toBe(row.id);
    expect(spawned[1]!.options.resume).toBe(row.id);
    expect((await Sessions.findById(row.id))!.claude_started).toBe(1);

    await shutdown(mgr, row.id);
  });

  it("injects the auto-evolve prompt after a turn with >=2 substantive tools", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());

    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text.includes("<auto-evolve>")) {
          s.emit(res()); // silent NO from the agent
          return;
        }
        s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
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

  it("evolve turn: blocked, load, then write succeeds", async () => {
    // The fake SDK does not run hooks itself: the test calls the hooks wired in
    // options exactly as the CLI would, around each tool call of the evolve turn.
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const runHooks = async (event: string, input: any) => {
      const outs: any[] = [];
      for (const m of fs.options.hooks[event] ?? []) {
        for (const h of m.hooks) outs.push(await h({ hook_event_name: event, session_id: "cli", transcript_path: "/t", cwd: "/w", ...input }, "tu", { signal: new AbortController().signal }));
      }
      return outs.find((o) => o?.hookSpecificOutput?.permissionDecision === "deny") ?? {};
    };
    const decisions: any[] = [];
    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (!text.includes("<auto-evolve>")) {
          s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
          s.emit(res());
          return;
        }
        void (async () => {
          const write = { tool_name: "mcp__slaude_skills__write_skill", tool_input: { slug: "x" }, tool_use_id: "w1" };
          decisions.push(await runHooks("PreToolUse", write));
          const load = { tool_name: "Skill", tool_input: { skill: "slaude:skill-authoring" }, tool_use_id: "k1" };
          decisions.push(await runHooks("PreToolUse", load));
          await runHooks("PostToolUse", { ...load, tool_response: { success: true, commandName: "slaude:skill-authoring" } });
          decisions.push(await runHooks("PreToolUse", write));
          s.emit(res());
        })();
      };
    });

    await mgr.sendMessage(row.id, "do a thing");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "evolve done");
    const evolve = String(fs.users[1].message.content);
    expect(evolve).toContain("<auto-evolve>");
    expect(evolve).toContain("Load `slaude:skill-authoring` with the Skill tool (skip if already loaded this session), then call `mcp__slaude_skills__list_skills`");
    expect(decisions[0].hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: 'Load `slaude:skill-authoring` first (call the Skill tool with skill "slaude:skill-authoring"), then retry.',
    });
    expect(decisions[1]).toEqual({});
    expect(decisions[2]).toEqual({});

    // A reboot needs the skill loaded again.
    await shutdown(mgr, row.id);
    const fs2 = plan();
    await mgr.sendMessage(row.id, "again");
    await until(() => fs2.options !== null, 3000, "reboot");
    const pre = fs2.options.hooks.PreToolUse.flatMap((m: any) => m.hooks);
    const outs = await Promise.all(pre.map((h: any) => h({ hook_event_name: "PreToolUse", tool_name: "mcp__slaude_skills__write_skill", tool_input: {} }, "tu", { signal: new AbortController().signal })));
    expect(outs.some((o: any) => o?.hookSpecificOutput?.permissionDecision === "deny")).toBe(true);
    await shutdown(mgr, row.id);
  });

  it("the skill gate and the usage counter share PostToolUse: one Skill load does both", async () => {
    const mgr = new AgentManager();
    const counted: Array<[string, string | undefined, string]> = [];
    mgr.setSkillUsageRecorder(async (sessionId, persona, skill) => void counted.push([sessionId, persona, skill]));
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hi");
    await until(() => fs.options !== null, 3000, "boot");
    const post = fs.options.hooks.PostToolUse.flatMap((m: any) => m.hooks);
    // The skill gate, the usage counter, and pass ending the turn.
    expect(post).toHaveLength(3);
    const load = { hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "slaude:skill-authoring" }, tool_response: { success: true } };
    for (const h of post) await h(load, "tu", { signal: new AbortController().signal });
    await until(() => counted.length === 1, 1000, "counted");
    expect(counted).toEqual([[row.id, undefined, "slaude:skill-authoring"]]);
    // The gate saw the same load: the governed tool is no longer denied.
    const pre = fs.options.hooks.PreToolUse.flatMap((m: any) => m.hooks);
    const outs = await Promise.all(pre.map((h: any) => h({ hook_event_name: "PreToolUse", tool_name: "mcp__slaude_skills__write_skill", tool_input: {} }, "tu", { signal: new AbortController().signal })));
    expect(outs.some((o: any) => o?.hookSpecificOutput?.permissionDecision === "deny")).toBe(false);
    await shutdown(mgr, row.id);
  });

  it("marks the evolution turn's tool, text and thinking events autoEvolve, and only those (#131)", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());

    plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text.includes("<auto-evolve>")) {
          s.emit(asst([{ type: "thinking", thinking: "worth a skill?" } as any, tool("Read"), txt("no skill needed")]));
          s.emit(res());
          return;
        }
        s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "do a thing");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "evolve done");
    const firstDone = events.findIndex((e) => e.type === "done");
    const userTurn = events.slice(0, firstDone).filter((e) => ["toolCall", "assistantText", "thinking"].includes(e.type));
    const evolveTurn = events.slice(firstDone + 1).filter((e) => ["toolCall", "assistantText", "thinking"].includes(e.type));
    expect(userTurn.map((e) => e.type)).toEqual(["toolCall", "toolCall", "toolCall", "toolCall", "assistantText"]);
    expect(userTurn.every((e) => e.autoEvolve === undefined)).toBe(true);
    expect(evolveTurn.map((e) => e.type)).toEqual(["thinking", "toolCall", "assistantText"]);
    expect(evolveTurn.every((e) => e.autoEvolve === true)).toBe(true);

    await shutdown(mgr, row.id);
  });

  describe("auto-evolve during a voice call", () => {
    /** A turn that would normally trigger auto-evolve (>=2 substantive tools). */
    const evolving = () =>
      plan((s) => {
        s.onUser = (um) => {
          if (String(um.message.content).includes("<auto-evolve>")) return void s.emit(res());
          s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("done")]));
          s.emit(res());
        };
      });

    it("skips it for a delegated voice turn (voiceTurns active)", async () => {
      process.env.SLAUDE_AUTO_EVOLVE = "1";
      const mgr = new AgentManager();
      const events = record(mgr);
      const row = await mgr.ensureSession(thread());
      const fs = evolving();
      injectedTurns.enter(row.id);
      voiceTurns.enter(row.id);
      try {
        await mgr.sendMessage(row.id, "voice request");
        await until(() => events.some((e) => e.type === "done"), 3000, "done");
        await Bun.sleep(40);
        expect(fs.users.length).toBe(1);
      } finally {
        voiceTurns.exit(row.id);
        injectedTurns.exit(row.id);
      }
      await shutdown(mgr, row.id);
    });

    it("allows it for the end-of-call summary turn (injected, not voice, call no longer live)", async () => {
      process.env.SLAUDE_AUTO_EVOLVE = "1";
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      const fs = evolving();
      injectedTurns.enter(row.id);
      try {
        await mgr.sendMessage(row.id, "the voice call has ended; post a summary");
        await until(() => fs.users.length === 2, 3000, "auto-evolve after the summary");
        expect(String(fs.users[1].message.content)).toContain("<auto-evolve>");
      } finally {
        injectedTurns.exit(row.id);
      }
      await shutdown(mgr, row.id);
    });

    it("skips it for any turn while a call is live, and resumes after the call ends", async () => {
      process.env.SLAUDE_AUTO_EVOLVE = "1";
      const mgr = new AgentManager();
      const events = record(mgr);
      const row = await mgr.ensureSession(thread());
      const fs = evolving();
      const calls = new VoiceCalls();
      calls.add(row.id, {} as any);
      try {
        // A Slack turn mid-call: no runner flag, only the live call.
        await mgr.sendMessage(row.id, "slack message mid-call");
        await until(() => events.some((e) => e.type === "done"), 3000, "done");
        await Bun.sleep(40);
        expect(fs.users.length).toBe(1);
      } finally {
        calls.remove(row.id);
      }
      await mgr.sendMessage(row.id, "after the call");
      await until(() => fs.users.length === 3, 3000, "auto-evolve after the call");
      expect(String(fs.users[2].message.content)).toContain("<auto-evolve>");
      await shutdown(mgr, row.id);
    });
  });

  /** Run one user turn emitting `names`, wait for done, return the plan's user messages. */
  async function runEvolveTurn(names: string[]) {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const fs = plan((s) => {
      s.onUser = (um) => {
        if (String(um.message.content).includes("<auto-evolve>")) return void s.emit(res());
        s.emit(asst([...names.map((n) => tool(n)), txt("did the work")]));
        s.emit(res());
      };
    });
    await mgr.sendMessage(row.id, "do a thing");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    await Bun.sleep(60);
    return { fs, mgr, row };
  }

  it("does not inject auto-evolve after 3 substantive tools", async () => {
    const { fs, mgr, row } = await runEvolveTurn(["Bash", "Write", "Grep", "WebFetch"]);
    expect(fs.users.length).toBe(1);
    await shutdown(mgr, row.id);
  });

  it("does not inject auto-evolve after 4 read-only external tools (no mutating tool)", async () => {
    const { fs, mgr, row } = await runEvolveTurn(["WebFetch", "WebFetch", "WebFetch", "WebFetch"]);
    expect(fs.users.length).toBe(1);
    await shutdown(mgr, row.id);
  });

  it("injects a system-tagged, announcement-free check after 4 substantive incl. a mutating tool", async () => {
    const { fs, mgr, row } = await runEvolveTurn(["Bash", "Write", "WebFetch", "WebSearch"]);
    expect(fs.users.length).toBe(2);
    const text = String(fs.users[1].message.content);
    expect(text.startsWith('<runtime-check kind="auto-evolve">')).toBe(true);
    expect(text).toContain("<auto-evolve>");
    expect(text).not.toContain("mcp__slaude_surface__reply");
    expect(text).not.toContain("saved /");
    await shutdown(mgr, row.id);
  });

  it("an external mcp__ tool counts as mutating", async () => {
    const { fs, mgr, row } = await runEvolveTurn(["WebFetch", "WebFetch", "WebSearch", "mcp__ext__do_thing"]);
    expect(fs.users.length).toBe(2);
    await shutdown(mgr, row.id);
  });

  it("/remote read aliases are read-only and ignored, like their built-ins", async () => {
    const { fs, mgr, row } = await runEvolveTurn(["mcp__remote__read", "mcp__remote__grep", "mcp__remote__glob", "mcp__remote__read"]);
    expect(fs.users.length).toBe(1);
    await shutdown(mgr, row.id);
  });

  it("/remote write aliases count as mutating, like their built-ins", async () => {
    const { fs, mgr, row } = await runEvolveTurn(["mcp__remote__bash", "mcp__remote__edit", "WebFetch", "WebSearch"]);
    expect(fs.users.length).toBe(2);
    await shutdown(mgr, row.id);
  });

  it("SLAUDE_AUTO_EVOLVE_MIN_TOOLS overrides the bar", async () => {
    process.env.SLAUDE_AUTO_EVOLVE_MIN_TOOLS = "2";
    const { fs, mgr, row } = await runEvolveTurn(["Bash", "Write"]);
    expect(fs.users.length).toBe(2);
    await shutdown(mgr, row.id);
  });

  it("skips auto-evolve when the turn already wrote a skill", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());

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
    const row = await mgr.ensureSession(thread());

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
    const row = await mgr.ensureSession(thread());

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
    expect((await Sessions.findById(row.id))!.status).toBe("idle");
  });

  it("throws when sending to an unknown session id", async () => {
    const mgr = new AgentManager();
    await expect(mgr.sendMessage("no-such-session", "hi")).rejects.toThrow(
      "session not found: no-such-session",
    );
  });

  // -------------------------------------------------------------------------
  // stream_closed auto-recovery
  // -------------------------------------------------------------------------

  it("stream_closed: auto-reloads and injects auto-continue prompt on first detection", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());

    // Session 1: emits a stream_closed tool error then turn result → triggers reload
    plan((s) => {
      s.onUser = () => {
        s.emit({ type: "user", tool_use_result: { is_error: true, content: "Stream closed" } });
        s.emit(res());
      };
    });

    // Session 2: receives auto-continue message, completes cleanly
    plan((s) => {
      s.onUser = () => {
        s.emit(asst([txt("back online")]));
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "trigger");
    await until(() => spawned.length >= 2, 5000, "two sessions spawned");
    await until(() => events.some((e) => e.type === "done"), 5000, "done from second session");

    // Recovery was transparent — no error event surfaced
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    // Second session received the synthetic auto-continue prompt
    expect(String(spawned[1]!.users[0]?.message?.content)).toContain("MCP stream was restored");

    await shutdown(mgr, row.id);
  });

  it("stream_closed: circuit opens and emits error event after three consecutive failures", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());

    // Three successive sessions each trigger stream_closed
    for (let i = 0; i < 3; i++) {
      plan((s) => {
        s.onUser = () => {
          s.emit({ type: "user", tool_use_result: { is_error: true, content: "Stream closed" } });
          s.emit(res());
        };
      });
    }

    await mgr.sendMessage(row.id, "trigger");
    await until(
      () => events.some((e) => e.type === "error" && String(e.error).includes("circuit open")),
      8000,
      "circuit-open error event",
    );

    // Original + 2 auto-continue; circuit prevented a 4th spawn
    expect(spawned.length).toBe(3);
    const errEvt = events.find((e) => e.type === "error");
    expect(errEvt?.error).toContain("3×");
    expect(errEvt?.error).toContain("circuit open");

    await shutdown(mgr, row.id);
  });

  it("stream_closed: detects error text supplied as a content-block array", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());

    // Session 1: error content is an array of blocks, not a plain string
    plan((s) => {
      s.onUser = () => {
        s.emit({
          type: "user",
          tool_use_result: {
            is_error: true,
            content: [{ type: "text", text: "MCP stream closed by server" }],
          },
        });
        s.emit(res());
      };
    });

    // Session 2: receives auto-continue
    plan((s) => {
      s.onUser = () => {
        s.emit(res());
      };
    });

    await mgr.sendMessage(row.id, "trigger");
    await until(() => spawned.length >= 2, 5000, "two sessions spawned");
    // Array content was parsed and matched → auto-continue fired
    expect(String(spawned[1]!.users[0]?.message?.content)).toContain("MCP stream was restored");

    await shutdown(mgr, row.id);
  });

  it("stream_closed: abort() before turn-end clears pending reload, no auto-continue fires", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());

    plan((s) => {
      s.onUser = () => {
        // Emit stream_closed user event but never emit result — session stalls
        s.emit({ type: "user", tool_use_result: { is_error: true, content: "Stream closed" } });
      };
    });

    await mgr.sendMessage(row.id, "trigger");
    // toolResult event confirms #pendingReload was set in #fanout
    await until(() => events.some((e) => e.type === "toolResult"), 3000, "toolResult processed");

    // abort() clears #pendingReload and #autoContinue before aborting the SDK query
    mgr.abort(row.id);
    await until(() => !mgr.isLive(row.id), 3000, "session dead");

    // Allow any stray microtasks to settle
    await Bun.sleep(30);
    // No new session spawned — auto-continue was cleared
    expect(spawned.length).toBe(1);
  });
});

describe("AgentManager reload around a turn in flight", () => {
  it("reloadAfterTurn defers while a turn is in flight: input stays open until the result, then the next turn boots fresh", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    let finishSecond: () => void = () => {};
    const first = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text === "one") s.emit(res());
        // "two" stays in flight until the test finishes it.
        if (text === "two") finishSecond = () => s.emit(res());
      };
    });
    await mgr.sendMessage(row.id, "one");
    await until(() => events.filter((e) => e.type === "done").length === 1, 3000, "first done");
    await mgr.sendMessage(row.id, "two");
    await until(() => first.users.length === 2, 3000, "second turn delivered");

    expect(mgr.reloadAfterTurn(row.id)).toBe(true);
    await Bun.sleep(30);
    // Mid-turn: the CLI's input must still be open and the session live.
    expect(first.ended).toBe(false);
    expect(mgr.isLive(row.id)).toBe(true);

    finishSecond();
    await until(() => !mgr.isLive(row.id), 3000, "reload at turn end");
    expect(first.ended).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(2);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);

    const second = plan((s) => {
      s.onUser = () => s.emit(res());
    });
    await mgr.sendMessage(row.id, "three");
    await until(() => second.users.length === 1, 3000, "fresh session");
    expect(String(second.users[0].message.content)).toBe("three");
    await shutdown(mgr, row.id);
  });

  it("reloadAfterTurn reloads an idle session immediately", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    plan((s) => {
      s.onUser = () => s.emit(res());
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    expect(mgr.reloadAfterTurn(row.id)).toBe(true);
    await until(() => !mgr.isLive(row.id), 3000, "idle reload");
    expect(mgr.reloadAfterTurn(row.id)).toBe(false);
  });

  it("a message sent while the session is reloading is delivered by a fresh session, not dropped", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const first = plan((s) => {
      s.onUser = () => s.emit(res());
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    const second = plan((s) => {
      s.onUser = () => s.emit(res());
    });

    expect(mgr.reload(row.id)).toBe(true);
    // The old session is still in #live (its CLI has not exited yet).
    expect(mgr.isLive(row.id)).toBe(true);
    await mgr.sendMessage(row.id, "during-reload");

    await until(() => second.users.length === 1, 3000, "delivered to a fresh session");
    expect(String(second.users[0].message.content)).toBe("during-reload");
    expect(first.users.map((u) => String(u.message.content))).toEqual(["hello"]);
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "second done");
    await shutdown(mgr, row.id);
  });
});

describe("AgentManager on a node: brain-slice anchor from the bundle", () => {
  it("a named persona's session gets SLAUDE_AGENT_ID from the bundle; the default persona gets none", async () => {
    const { bundleChildEnv } = await import("../../src/node/worker");
    const saved = process.env.SLAUDE_AGENT_ID;
    delete process.env.SLAUDE_AGENT_ID;
    try {
      const mgr = new AgentManager();
      const events = record(mgr);
      // Node-shaped: soul and child env both come from the bundle; "ana" is in
      // no registry on this host.
      mgr.setPersonaSoulResolver(async () => ({ soulMd: "bundle soul", soulJson: null }));
      const personaOf = new Map<string, string>();
      mgr.setChildEnvResolver(async (sid) => {
        const persona = personaOf.get(sid) ?? "default";
        return bundleChildEnv({ providerCreds: {}, slackUserId: persona === "default" ? null : "UANA" }, persona);
      });
      const named = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      personaOf.set(named.id, "ana");
      const dflt = await mgr.ensureSession(thread());
      const a = plan((s) => (s.onUser = () => s.emit(res())));
      await mgr.sendMessage(named.id, "hi");
      await until(() => events.some((e) => e.type === "done" && e.sessionId === named.id), 3000, "named done");
      const d = plan((s) => (s.onUser = () => s.emit(res())));
      await mgr.sendMessage(dflt.id, "hi");
      await until(() => events.some((e) => e.type === "done" && e.sessionId === dflt.id), 3000, "default done");
      expect(a.options.env.SLAUDE_AGENT_ID).toBe("UANA");
      expect(d.options.env.SLAUDE_AGENT_ID).toBeUndefined();
      await shutdown(mgr, named.id);
      await shutdown(mgr, dflt.id);
    } finally {
      if (saved === undefined) delete process.env.SLAUDE_AGENT_ID;
      else process.env.SLAUDE_AGENT_ID = saved;
    }
  });
});

describe("AgentManager on a node: provider credentials from the child-env resolver (WS-A §5.4)", () => {
  const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.ANTHROPIC_API_KEY = "node-own-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "node-own-token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "node-own-oauth";
    process.env.ANTHROPIC_BASE_URL = "https://node.example.com";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("a ChildEnvPatch deletes the provider keys it does not supply: absent, not undefined", async () => {
    const { ChildEnvPatch } = await import("../../src/agent/child-env");
    const mgr = new AgentManager();
    const events = record(mgr);
    mgr.setChildEnvResolver(async () => new ChildEnvPatch({ ANTHROPIC_API_KEY: "persona-key" }, KEYS));
    const row = await mgr.ensureSession(thread());
    const s = plan((x) => (x.onUser = () => x.emit(res())));
    await mgr.sendMessage(row.id, "hi");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    expect(s.options.env.ANTHROPIC_API_KEY).toBe("persona-key");
    for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      expect(Object.hasOwn(s.options.env, k)).toBe(false);
    }
    await shutdown(mgr, row.id);
  });

  it("a plain overlay (unmanaged bundle only; nodeChildEnv never returns one for a declared provider) only adds", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    mgr.setChildEnvResolver(async () => ({ ANTHROPIC_API_KEY: "persona-key" }));
    const row = await mgr.ensureSession(thread());
    const s = plan((x) => (x.onUser = () => x.emit(res())));
    await mgr.sendMessage(row.id, "hi");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    expect(s.options.env.ANTHROPIC_API_KEY).toBe("persona-key");
    expect(s.options.env.ANTHROPIC_BASE_URL).toBe("https://node.example.com");
    await shutdown(mgr, row.id);
  });

  it("a resolver failure is fatal and typed: the boot fails with PROVIDER_CREDENTIALS_UNAVAILABLE and nothing spawns", async () => {
    const { BootFailure } = await import("../../src/gateway/core/failure-codes");
    const mgr = new AgentManager();
    mgr.setChildEnvResolver(async () => {
      throw new Error("gateway /v1 request failed: 503");
    });
    const row = await mgr.ensureSession(thread());
    const before = spawned.length;
    const e = await mgr.sendMessage(row.id, "hi").catch((x) => x);
    expect(e).toBeInstanceOf(BootFailure);
    expect(e.code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
    expect(spawned.length).toBe(before);
    expect(mgr.isLive(row.id)).toBe(false);
  });

  // R1-F10: the resume-miss reboot is fire-and-forget; its boot failure must
  // surface as the turn's typed error, not an unhandled rejection.
  it("a boot failure on the resume-miss reboot emits the typed error event", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    let calls = 0;
    mgr.setChildEnvResolver(async () => {
      if (calls++ === 0) return {};
      throw new Error("gateway /v1 request failed: 503");
    });
    const row = await mgr.ensureSession(thread());
    await Sessions.markStarted(row.id); // force a resume attempt on first boot
    plan((s) => {
      s.bootError = "Error: No conversation found with session ID " + row.id;
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "error"), 3000, "typed error");
    const err = events.find((e) => e.type === "error");
    expect(err.code).toBe("PROVIDER_CREDENTIALS_UNAVAILABLE");
    expect(err.error).not.toContain("503");
  });

  it("a BootFailure from the resolver keeps its own code", async () => {
    const { BootFailure } = await import("../../src/gateway/core/failure-codes");
    const mgr = new AgentManager();
    mgr.setChildEnvResolver(async () => {
      throw new BootFailure("LABEL_MISMATCH", "x");
    });
    const row = await mgr.ensureSession(thread());
    const e = await mgr.sendMessage(row.id, "hi").catch((x) => x);
    expect(e.code).toBe("LABEL_MISMATCH");
  });
});

describe("AgentManager reload: overlapping inputs and a CLI that never exits", () => {
  it("a reload requested while an auto-evolve turn AND a queued user message are pending waits for BOTH results", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    let finishEvolve: () => void = () => {};
    let finishB: () => void = () => {};
    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        if (text.includes("<auto-evolve>")) finishEvolve = () => s.emit(res());
        else if (text === "B") finishB = () => s.emit(res());
        else {
          s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
          s.emit(res());
        }
      };
    });
    await mgr.sendMessage(row.id, "A");
    // A is done and the auto-evolve prompt is in flight; the node would now
    // release the lock, and the next job pushes B into the same session.
    await until(() => fs.users.length === 2, 3000, "auto-evolve injected");
    await mgr.sendMessage(row.id, "B");
    await until(() => fs.users.length === 3, 3000, "B delivered");

    expect(mgr.reloadAfterTurn(row.id)).toBe(true);
    finishEvolve();
    await until(() => events.some((e) => e.type === "done" && e.autoEvolve), 3000, "evolve done");
    await Bun.sleep(30);
    // B is still in flight: input must stay open.
    expect(fs.ended).toBe(false);
    expect(mgr.isLive(row.id)).toBe(true);

    finishB();
    await until(() => !mgr.isLive(row.id), 3000, "reload after both results");
    expect(fs.ended).toBe(true);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("a deferral re-added while a dying session finishes exiting does not reload the next fresh session", async () => {
    const { dbSessionStore } = await import("../../src/agent/session-store");
    const mgr = new AgentManager();
    let releaseIdle: () => void = () => {};
    let idleBlocked = false;
    mgr.setSessionStore({
      ...dbSessionStore,
      setStatus: async (id: string, status: any) => {
        if (status === "idle" && !idleBlocked) {
          idleBlocked = true;
          await new Promise<void>((r) => (releaseIdle = r));
        }
        return dbSessionStore.setStatus(id, status);
      },
    } as any);
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    plan((s) => {
      s.onUser = (um) => {
        // The CLI dies mid-turn: no result, so an input stays outstanding.
        if (String(um.message.content) === "crash") s.fail(new Error("cli died"));
        else s.emit(res());
      };
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    await mgr.sendMessage(row.id, "crash");
    await until(() => idleBlocked, 3000, "exit reached the status write");
    // Still live, a turn outstanding: the deferral is recorded.
    expect(mgr.isLive(row.id)).toBe(true);
    expect(mgr.reloadAfterTurn(row.id)).toBe(true);
    releaseIdle();
    await until(() => !mgr.isLive(row.id), 3000, "exit");

    const fresh = plan((s) => (s.onUser = () => s.emit(res())));
    await mgr.sendMessage(row.id, "next");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "fresh done");
    await Bun.sleep(30);
    expect(fresh.ended).toBe(false);
    expect(mgr.isLive(row.id)).toBe(true);
    await shutdown(mgr, row.id);
  });

  it("a reloading session that never exits is aborted after the bound and the message boots fresh", async () => {
    const mgr = new AgentManager();
    mgr.__setReloadExitTimeoutForTests(50);
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const stuck = plan((s) => {
      s.hang = true;
      s.onUser = () => s.emit(res());
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    const fresh = plan((s) => (s.onUser = () => s.emit(res())));
    expect(mgr.reload(row.id)).toBe(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mgr.sendMessage(row.id, "after");
    } finally {
      warn.mockRestore();
    }
    await until(() => fresh.users.length === 1, 3000, "fresh session got the message");
    expect(String(fresh.users[0].message.content)).toBe("after");
    expect(stuck.ended).toBe(false);
    expect(mgr.isLive(row.id)).toBe(true);
    await shutdown(mgr, row.id);
  });
});

// R42 (M1): a session detached by the bounded reload wait keeps its own query
// loop; anything it emits late must not be credited to the fresh session that
// now holds the id — late text would join the wrong turn, and a late result
// would decrement the fresh session's outstanding inputs and apply a deferred
// reload under its running turn.
describe("a detached reloading session's late messages", () => {
  it("are not credited to the fresh session", async () => {
    const mgr = new AgentManager();
    mgr.__setReloadExitTimeoutForTests(50);
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const stuck = plan((s) => {
      s.hang = true;
      s.onUser = () => s.emit(res());
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    // The fresh session's turn stays in flight (no result yet).
    const fresh = plan(() => {});
    expect(mgr.reload(row.id)).toBe(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mgr.sendMessage(row.id, "after");
    } finally {
      warn.mockRestore();
    }
    await until(() => fresh.users.length === 1, 3000, "fresh session got the message");
    // A config change asks for a reload after the fresh session's turn.
    expect(mgr.reloadAfterTurn(row.id)).toBe(true);
    const before = events.length;
    stuck.emit(asst([txt("late text from the detached session")]));
    stuck.emit(res());
    await Bun.sleep(40);
    const late = events.slice(before);
    expect(late.some((e) => e.type === "assistantText")).toBe(false);
    expect(late.some((e) => e.type === "done")).toBe(false);
    // The deferred reload did not fire under the fresh turn.
    expect(fresh.ended).toBe(false);
    expect(mgr.isLive(row.id)).toBe(true);
    // The fresh session's own result still ends its turn and applies the reload.
    fresh.emit(res());
    await until(() => events.slice(before).some((e) => e.type === "done"), 3000, "fresh done");
    await until(() => !mgr.isLive(row.id), 3000, "deferred reload applied after the fresh turn");
  });
});

// R41 (I4): a registry install that retires a persona closes its WARM session.
// Without this, the live child keeps taking messages (sendMessage pushes into it
// and never re-resolves the persona) and runs as the default identity.
const { setPersonaRegistry, __resetPersonaRegistry } = await import("../../src/persona/registry");
describe("a warm session whose persona is retired", () => {
  const reg = (managed: boolean, live: string[]) => ({
    lookupByUserId: () => null,
    lookupByName: (n: string) => (live.includes(n) ? { name: n, slackUserId: `U${n.toUpperCase()}`, soulMd: `${n} soul`, config: { slackUserId: `U${n.toUpperCase()}`, name: n }, outClient: null } : null),
    list: () => [],
    isMultiPersonaMode: () => live.length > 0,
    isManaged: () => managed,
    tombstonedPersonaFor: () => null,
  }) as any;

  it("is closed on a managed install that drops it, and the next message fails its boot", async () => {
    setPersonaRegistry(reg(true, ["ana"]));
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      const def = await mgr.ensureSession(thread());
      plan((s) => (s.onUser = () => s.emit(res())));
      plan((s) => (s.onUser = () => s.emit(res())));
      await mgr.sendMessage(row.id, "hello");
      await mgr.sendMessage(def.id, "hello");
      await until(() => mgr.isLive(row.id) && mgr.isLive(def.id), 3000, "both live");

      setPersonaRegistry(reg(true, []));
      await until(() => !mgr.isLive(row.id), 3000, "retired session closed");
      expect(mgr.isLive(def.id)).toBe(true); // the default persona is untouched
      await expect(mgr.sendMessage(row.id, "still there?")).rejects.toThrow(/ana/);
      await shutdown(mgr, def.id);
    } finally {
      __resetPersonaRegistry();
    }
  });

  it("an unmanaged install leaves it running", async () => {
    setPersonaRegistry(reg(false, ["ana"]));
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      plan((s) => (s.onUser = () => s.emit(res())));
      await mgr.sendMessage(row.id, "hello");
      await until(() => mgr.isLive(row.id), 3000, "live");
      setPersonaRegistry(reg(false, []));
      await Bun.sleep(30);
      expect(mgr.isLive(row.id)).toBe(true);
      await shutdown(mgr, row.id);
    } finally {
      __resetPersonaRegistry();
    }
  });
});

// R42 (I2): a session's model = per-thread choice (/model) > the persona's
// effective model on a managed tenant > SLAUDE_MODEL. Mono reads the persona
// model from the registry; a node from its runtime bundle.
describe("session model precedence", () => {
  const reg = (managed: boolean, models: Record<string, string | null>, defaultModel: string | null) => ({
    lookupByUserId: () => null,
    lookupByName: (n: string) => (n in models
      ? { name: n, slackUserId: `U${n.toUpperCase()}`, soulMd: `${n} soul`, config: { slackUserId: `U${n.toUpperCase()}`, name: n }, outClient: null, ...(managed ? { model: models[n] } : {}) }
      : null),
    list: () => [],
    isMultiPersonaMode: () => Object.keys(models).length > 0,
    isManaged: () => managed,
    tombstonedPersonaFor: () => null,
    ...(managed ? { defaultPersona: () => ({ model: defaultModel, mcp: null }) } : {}),
  }) as any;

  const bootModel = async (mgr: InstanceType<typeof AgentManager>, id: string) => {
    const events = record(mgr);
    const fs = plan((s) => (s.onUser = () => s.emit(res())));
    await mgr.sendMessage(id, "hi");
    await until(() => events.some((e) => e.type === "done" && e.sessionId === id), 3000, `done ${id}`);
    await shutdown(mgr, id);
    return fs.options.model as string | undefined;
  };

  const savedModel = process.env.SLAUDE_MODEL;
  const withEnvModel = async (fn: () => Promise<void>) => {
    process.env.SLAUDE_MODEL = "m-env";
    try { await fn(); } finally {
      if (savedModel === undefined) delete process.env.SLAUDE_MODEL;
      else process.env.SLAUDE_MODEL = savedModel;
      __resetPersonaRegistry();
    }
  };

  it("mono, managed: persona model > SLAUDE_MODEL, and a per-thread /model beats both", async () => {
    await withEnvModel(async () => {
      setPersonaRegistry(reg(true, { ana: "m-ana", bea: null }, "m-default"));
      const mgr = new AgentManager();
      const ana = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      const bea = await mgr.ensureSession({ ...thread(), persona_id: "bea" });
      const dflt = await mgr.ensureSession(thread());
      // A managed tenant's row follows its persona instead of pinning SLAUDE_MODEL.
      expect(ana.model).toBe("");
      expect(await bootModel(mgr, ana.id)).toBe("m-ana");
      expect(await bootModel(mgr, bea.id)).toBe("m-env"); // persona sets no model
      expect(await bootModel(mgr, dflt.id)).toBe("m-default"); // the default persona's own model
      expect(mgr.effectiveModelOf({ model: "", persona_id: "ana" })).toBe("m-ana");

      // An override that changes the persona's model reaches the thread at its next boot.
      setPersonaRegistry(reg(true, { ana: "m-ana-2", bea: null }, "m-default"));
      expect(await bootModel(mgr, ana.id)).toBe("m-ana-2");

      // Per-thread /model wins over the persona.
      await mgr.setSessionModel(ana.id, "m-thread");
      expect(await bootModel(mgr, ana.id)).toBe("m-thread");
      expect(mgr.effectiveModelOf({ model: "m-thread", persona_id: "ana" })).toBe("m-thread");
    });
  });

  it("mono, unmanaged: unchanged — the row pins SLAUDE_MODEL at creation, /model overrides it", async () => {
    await withEnvModel(async () => {
      setPersonaRegistry(reg(false, { ana: null }, null));
      const mgr = new AgentManager();
      const ana = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      expect(ana.model).toBe("m-env");
      expect(await bootModel(mgr, ana.id)).toBe("m-env");
      await mgr.setSessionModel(ana.id, "m-thread");
      expect(await bootModel(mgr, ana.id)).toBe("m-thread");
    });
  });

  it("node: the bundle's default model > SLAUDE_MODEL, and a per-thread /model beats it; an unmanaged bundle changes nothing", async () => {
    await withEnvModel(async () => {
      // The gateway created these rows on a managed tenant.
      setPersonaRegistry(reg(true, { ana: "m-ana" }, null));
      const mgr = new AgentManager();
      const ana = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      const legacy = await mgr.ensureSession({ ...thread(), persona_id: "ana" });
      __resetPersonaRegistry(); // a node consults no registry
      mgr.setPersonaSoulResolver(async () => ({ soulMd: "bundle soul", soulJson: null }));
      let bundleModel: string | undefined = "m-bundle";
      const asked: Array<string | undefined> = [];
      mgr.setPersonaModelResolver(async (_sid, persona) => (asked.push(persona), bundleModel));
      expect(await bootModel(mgr, ana.id)).toBe("m-bundle");
      expect(asked).toEqual(["ana"]);
      await mgr.setSessionModel(ana.id, "m-thread");
      expect(await bootModel(mgr, ana.id)).toBe("m-thread");
      expect(asked).toEqual(["ana"]); // a per-thread model never consults the bundle
      // An unmanaged bundle (resolver yields undefined) leaves the row as it is.
      bundleModel = undefined;
      expect(await bootModel(mgr, legacy.id)).toBeUndefined();
    });
  });
});

describe("AgentManager voice support", () => {
  it("sessionExit fires on teardown", async () => {
    const mgr = new AgentManager();
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const row = await mgr.ensureSession(thread());
    plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    await shutdown(mgr, row.id);
    await until(() => exits.length === 1, 3000, "sessionExit");
    expect(exits).toEqual([row.id]);
  });

  it("holdIdle keeps a session past its idle TTL and release re-arms it", async () => {
    const spy = spyOn(env, "idleMs").mockReturnValue(30);
    try {
      const mgr = new AgentManager();
      const exits: string[] = [];
      mgr.on("sessionExit", (id: string) => exits.push(id));
      const row = await mgr.ensureSession(thread());
      const fs = plan();
      await mgr.sendMessage(row.id, "hello");
      await until(() => mgr.isLive(row.id), 3000, "live");
      expect(mgr.holdIdle(row.id, true)).toBe(true);
      fs.emit(res());
      await Bun.sleep(120);
      expect(mgr.isLive(row.id)).toBe(true);
      mgr.holdIdle(row.id, false);
      await until(() => !mgr.isLive(row.id), 3000, "idle close after release");
      expect(exits).toEqual([row.id]);
    } finally {
      spy.mockRestore();
    }
  });

  it("isTurnInFlight is true from send until the turn's result", async () => {
    const mgr = new AgentManager();
    expect(mgr.isTurnInFlight("nope")).toBe(false);
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    expect(mgr.isTurnInFlight(row.id)).toBe(true);
    fs.emit(res());
    await until(() => !mgr.isTurnInFlight(row.id), 3000, "turn done");
    expect(mgr.isLive(row.id)).toBe(true);
    await shutdown(mgr, row.id);
    expect(mgr.isTurnInFlight(row.id)).toBe(false);
  });

  it("holding a non-live id returns false and does not block a later session's idle", async () => {
    const spy = spyOn(env, "idleMs").mockReturnValue(30);
    try {
      const mgr = new AgentManager();
      const row = await mgr.ensureSession(thread());
      expect(mgr.holdIdle(row.id, true)).toBe(false);
      const fs = plan();
      await mgr.sendMessage(row.id, "hello");
      await until(() => mgr.isLive(row.id), 3000, "live");
      fs.emit(res());
      await until(() => !mgr.isLive(row.id), 3000, "idle close despite earlier hold attempt");
    } finally {
      spy.mockRestore();
    }
  });

  it("a detached reloading session emits sessionExit once and clears the hold", async () => {
    const mgr = new AgentManager();
    mgr.__setReloadExitTimeoutForTests(50);
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    plan((s) => {
      s.hang = true;
      s.onUser = () => s.emit(res());
    });
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    expect(mgr.holdIdle(row.id, true)).toBe(true);
    const fresh = plan((s) => (s.onUser = () => s.emit(res())));
    expect(mgr.reload(row.id)).toBe(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mgr.sendMessage(row.id, "after");
    } finally {
      warn.mockRestore();
    }
    await until(() => fresh.users.length === 1, 3000, "fresh session got the message");
    expect(exits).toEqual([row.id]);
    // The stale hold did not carry over: holding now is a fresh decision.
    const spy = spyOn(env, "idleMs").mockReturnValue(30);
    try {
      mgr.holdIdle(row.id, false);
      await until(() => !mgr.isLive(row.id), 3000, "fresh session idles out");
    } finally {
      spy.mockRestore();
    }
    await Bun.sleep(30);
    expect(exits).toEqual([row.id, row.id]);
  });
});

// A node's session store is the gateway's /v1 with the last job token bound,
// which a session that outlived its job holds expired. The detached query
// loop's store writes and reboots have no awaiting caller: a rejection there
// was unhandled and ended the process (2026-10-10 node crash).
describe("AgentManager: store failures outside any caller", () => {
  const expiredStore = async (fail: (op: string, status?: string) => boolean) => {
    const { dbSessionStore } = await import("../../src/agent/session-store");
    const refuse = () => Promise.reject(new Error('gateway /v1 request failed: 401 {"error":"invalid job token: expired"}'));
    return {
      ...dbSessionStore,
      findById: (id: string) => (fail("findById") ? (refuse() as any) : dbSessionStore.findById(id)),
      setStatus: (id: string, st: any) => (fail("setStatus", st) ? refuse() : dbSessionStore.setStatus(id, st)),
      markStarted: (id: string) => (fail("markStarted") ? refuse() : dbSessionStore.markStarted(id)),
    } as any;
  };
  const quietly = async (fn: () => Promise<void>) => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await fn();
      await Bun.sleep(30);
    } finally {
      err.mockRestore();
    }
  };

  it("a teardown status write that rejects still completes teardown and signals sessionExit", async () => {
    const mgr = new AgentManager();
    mgr.setSessionStore(await expiredStore((op, st) => op === "setStatus" && st === "idle"));
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const row = await mgr.ensureSession(thread());
    plan((s) => (s.onUser = () => s.emit(res())));
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    await quietly(async () => {
      mgr.reload(row.id);
      await until(() => exits.length === 1, 3000, "sessionExit");
    });
    expect(mgr.isLive(row.id)).toBe(false);
  });

  it("a markStarted that rejects on an assistant message is logged, the turn goes on", async () => {
    const mgr = new AgentManager();
    mgr.setSessionStore(await expiredStore((op) => op === "markStarted"));
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    plan((s) => (s.onUser = () => (s.emit(asst([txt("hi")])), s.emit(res()))));
    await quietly(async () => {
      await mgr.sendMessage(row.id, "hello");
      await until(() => events.some((e) => e.type === "done"), 3000, "done");
    });
    await shutdown(mgr, row.id);
  });

  it("a reload prompt whose reboot fails becomes the session's error event, not an unhandled rejection", async () => {
    const mgr = new AgentManager();
    let booted = false;
    mgr.setSessionStore(await expiredStore((op) => op === "findById" && booted));
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    plan((s) => (s.onUser = () => s.emit(res())));
    await mgr.sendMessage(row.id, "hello");
    await until(() => events.some((e) => e.type === "done"), 3000, "done");
    booted = true;
    await quietly(async () => {
      mgr.reload(row.id, "carry on");
      await until(() => events.some((e) => e.type === "error"), 3000, "reboot error");
    });
    expect(events.find((e) => e.type === "error")?.error).toBe("session reboot failed");
  });

  it("a teardown step that throws still drops the live entry and signals sessionExit", async () => {
    const { m } = await import("../../src/metrics");
    const mgr = new AgentManager();
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const row = await mgr.ensureSession(thread());
    plan((s) => (s.onUser = () => s.emit(res())));
    await mgr.sendMessage(row.id, "hello");
    await until(() => mgr.isLive(row.id), 3000, "live");
    // The gauge update sits between the live-map delete and the exit signal.
    const gauge = spyOn(m.sessionsLive, "set").mockImplementation(() => {
      throw new Error("gauge broke");
    });
    try {
      await quietly(async () => {
        mgr.reload(row.id);
        await until(() => exits.length === 1, 3000, "sessionExit");
      });
    } finally {
      gauge.mockRestore();
    }
    expect(mgr.isLive(row.id)).toBe(false);
  });

  it("a resume-retry reboot that fails signals sessionExit (a voice call on it must end)", async () => {
    const mgr = new AgentManager();
    let boots = 0;
    const { dbSessionStore } = await import("../../src/agent/session-store");
    mgr.setSessionStore({
      ...dbSessionStore,
      findById: (id: string) => (++boots > 1 ? Promise.reject(new Error("401 expired")) : dbSessionStore.findById(id)),
    } as any);
    const exits: string[] = [];
    mgr.on("sessionExit", (id: string) => exits.push(id));
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    await Sessions.markStarted(row.id);
    plan((s) => (s.bootError = "Error: No conversation found with session ID " + row.id));
    await quietly(async () => {
      await mgr.sendMessage(row.id, "hello");
      await until(() => events.some((e) => e.type === "error"), 3000, "reboot error");
    });
    expect(exits).toEqual([row.id]);
    expect(mgr.isLive(row.id)).toBe(false);
  });
});

describe("isSyntheticTurn: a prompt the runtime itself sent", () => {
  /** Answer every input with a result; record isSyntheticTurn as each input arrives. */
  const recorder = (mgr: InstanceType<typeof AgentManager>, id: () => string, seen: Array<[string, boolean]>, substantive = false) =>
    (s: FakeSession) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        seen.push([text, mgr.isSyntheticTurn(id())]);
        if (substantive && !text.includes("<auto-evolve>") && seen.length === 1) {
          s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
        }
        s.emit(res());
      };
    };

  it("false for a delivered turn, true during the auto-evolve turn, false again for the next human turn", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const seen: Array<[string, boolean]> = [];
    plan(recorder(mgr, () => row.id, seen, true));

    await mgr.sendMessage(row.id, "do a thing");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "evolve done");
    expect(seen.map(([t, s]) => [t.includes("<auto-evolve>") ? "evolve" : t, s])).toEqual([["do a thing", false], ["evolve", true]]);
    expect(mgr.isSyntheticTurn(row.id)).toBe(false);

    await mgr.sendMessage(row.id, "next question");
    await until(() => events.filter((e) => e.type === "done").length === 3, 3000, "next done");
    expect(seen[2]).toEqual(["next question", false]);
    expect(mgr.isSyntheticTurn(row.id)).toBe(false);
    await shutdown(mgr, row.id);
  });

  it("true for a reload_session continuation prompt; false for the human turn after it", async () => {
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const seen: Array<[string, boolean]> = [];
    plan(recorder(mgr, () => row.id, seen));
    plan(recorder(mgr, () => row.id, seen));

    await mgr.sendMessage(row.id, "hello");
    await until(() => events.filter((e) => e.type === "done").length === 1, 3000, "first done");
    expect(mgr.reload(row.id, "carry on")).toBe(true);
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "continuation done");
    expect(seen).toEqual([["hello", false], ["carry on", true]]);

    await mgr.sendMessage(row.id, "thanks");
    await until(() => events.filter((e) => e.type === "done").length === 3, 3000, "human done");
    expect(seen[2]).toEqual(["thanks", false]);
    expect(mgr.isSyntheticTurn(row.id)).toBe(false);
    await shutdown(mgr, row.id);
  });

  it("no live session: false", () => {
    expect(new AgentManager().isSyntheticTurn("S-none")).toBe(false);
  });

  it("a voice-injected turn (mono and node runners) counts as synthetic: its profile write is denied", async () => {
    const { monoRunner, nodeRunner } = await import("../../src/voice/runners");
    const { SYNTHETIC_PROFILE_DENIAL, KB_MEMOIZE_TOOL } = await import("../../src/agent/profile-write-guard");
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const decisions: Array<[string, string | undefined]> = [];
    const fs = plan((s) => {
      s.onUser = async (um) => {
        const text = String(um.message.content);
        let reason: string | undefined;
        for (const h of s.options.hooks.PreToolUse[0].hooks) {
          const out = await h(
            { hook_event_name: "PreToolUse", tool_name: KB_MEMOIZE_TOOL, tool_input: { target: "profile", pages: [] } },
            "tu",
            { signal: new AbortController().signal },
          );
          // Only the profile guard's answer (the skill gate also asks for slaude:memory).
          const r = out?.hookSpecificOutput?.permissionDecisionReason;
          if (r === SYNTHETIC_PROFILE_DENIAL) reason = r;
        }
        decisions.push([text, reason]);
        s.emit(res());
      };
    });
    await mgr.sendMessage(row.id, "hello", { sender: { userId: "U0ALICE", teamId: "T", origin: "slack" } });
    await until(() => events.filter((e) => e.type === "done").length === 1, 3000, "first done");
    const ro = { suppress: false, voice: true, cancelled: () => false };
    await monoRunner(mgr, { check: async () => {}, pollMs: 5 }).run(row.id, "voice delegate (mono)", ro);
    await nodeRunner({ agent: mgr, lock: (_sid, fn) => fn(new AbortController().signal), refreshToken: async () => {} }).run(
      row.id,
      "voice delegate (node)",
      ro,
    );
    expect(decisions).toEqual([
      ["hello", undefined],
      ["voice delegate (mono)", SYNTHETIC_PROFILE_DENIAL],
      ["voice delegate (node)", SYNTHETIC_PROFILE_DENIAL],
    ]);
    expect(mgr.isSyntheticTurn(row.id)).toBe(false);
    void fs;
    await shutdown(mgr, row.id);
  });
});

describe("turnSenders: who sent the inputs the CLI is processing (phase C, invariant 2)", () => {
  const A = { userId: "U0ALICE", teamId: "T", origin: "slack" };
  const B = { userId: "U0BOB", teamId: "T", origin: "slack" };
  const profileWrite = { pages: [{ slug: "profile", content: "Call me X.", summary: "name", type: "profile" }], target: "profile" as const };

  /** kb_memoize target:"profile" as mono runs it: the live ctx speaker is
   *  `ctxUser` (whoever spoke last), the senders come from the manager. */
  async function memoizeAs(mgr: InstanceType<typeof AgentManager>, id: string, ctxUser: string) {
    const { brainHandlers } = await import("../../src/knowledge/mcp-tools");
    const { resolveBrainScope } = await import("../../src/knowledge/scope");
    const { fakeBrain } = await import("../memory/fake-brain");
    const brain = fakeBrain();
    const senders = mgr.turnSenders(id);
    const gate = {
      userId: ctxUser, teamId: "T", interactive: true, origin: "slack" as const, lockedUser: null,
      channelTrust: "trusted" as const, isManager: false, agentId: "AGENT1",
      ...(senders ? { turnSenders: senders } : {}),
    };
    const written: string[] = [];
    const r = await brainHandlers.kb_memoize(profileWrite, {
      scope: () => resolveBrainScope({ ...gate, kbSources: [] }),
      gate: () => gate,
      managers: () => [],
      requestApproval: async () => ({ approved: false, by: "x" }),
      call: async (name, params, scope) => {
        if (name === "put_page") written.push(scope.sourceId);
        return brain.call(name, params, scope);
      },
    });
    return { text: r.content[0]!.text, written };
  }

  it("T1 Alice running, Bob queued as T2, T1 ends, Alice posts during T2: a profile write in T2 is refused", async () => {
    const { profileSourceId } = await import("../../src/knowledge/scope");
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const fs = plan(); // never answers on its own: the test ends each turn
    await mgr.sendMessage(row.id, "T1: call me Al", { sender: A });
    await until(() => fs.users.length === 1, 3000, "T1 delivered");
    expect(mgr.turnSenders(row.id)).toEqual([A]);

    await mgr.sendMessage(row.id, "T2: call me B", { sender: B }); // queued behind T1
    expect(mgr.turnSenders(row.id)).toEqual([A, B]); // the CLI may fold it into T1
    expect((await memoizeAs(mgr, row.id, "U0BOB")).text).toBe("refused: a profile is written only on that person's own turn");

    fs.emit(res()); // T1 ends; T2 (Bob's words) runs
    await until(() => events.filter((e) => e.type === "done").length === 1, 3000, "T1 done");
    expect(mgr.turnSenders(row.id)).toEqual([B]);

    await mgr.sendMessage(row.id, "T3: hi", { sender: A }); // Alice posts during T2; the ctx is now Alice
    expect(mgr.turnSenders(row.id)).toEqual([B, A]);
    const during = await memoizeAs(mgr, row.id, "U0ALICE");
    expect(during.text).toBe("refused: a profile is written only on that person's own turn");
    expect(during.written).toEqual([]);

    fs.emit(res()); // T2 ends
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "T2 done");
    expect(mgr.turnSenders(row.id)).toEqual([A]);
    fs.emit(res()); // T3 ends: nothing outstanding
    await until(() => events.filter((e) => e.type === "done").length === 3, 3000, "T3 done");
    expect(mgr.turnSenders(row.id)).toBeNull();
    expect(profileSourceId("T", "U0ALICE")).not.toBe(profileSourceId("T", "U0BOB"));
    await shutdown(mgr, row.id);
  });

  it("T2 with Bob as its sole sender writes Bob's profile, even while the ctx shows Alice", async () => {
    const { profileSourceId } = await import("../../src/knowledge/scope");
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "T1", { sender: A });
    await until(() => fs.users.length === 1, 3000, "T1 delivered");
    await mgr.sendMessage(row.id, "T2: call me B", { sender: B });
    fs.emit(res());
    await until(() => events.filter((e) => e.type === "done").length === 1, 3000, "T1 done");
    expect(mgr.turnSenders(row.id)).toEqual([B]);
    const r = await memoizeAs(mgr, row.id, "U0ALICE");
    expect(r.text).not.toContain("refused");
    expect(r.written).toEqual([profileSourceId("T", "U0BOB")]);
    await shutdown(mgr, row.id);
  });

  it("fails closed: no live session, an input without a sender, a synthetic input", async () => {
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    expect(mgr.turnSenders("S-none")).toBeNull();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const seen: Array<unknown> = [];
    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        seen.push([text.includes("<auto-evolve>") ? "evolve" : text, mgr.turnSenders(row.id)]);
        if (!text.includes("<auto-evolve>")) s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
        s.emit(res());
      };
    });
    await mgr.sendMessage(row.id, "no sender");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "evolve done");
    expect(seen).toEqual([["no sender", null], ["evolve", null]]);
    expect(fs.users.length).toBe(2);
    await shutdown(mgr, row.id);
  });
});

describe("profile writes on a synthetic turn (phase C, invariant 2)", () => {
  it("the PreToolUse hook denies kb_memoize target:\"profile\" during the auto-evolve turn only", async () => {
    // The fake SDK does not run hooks itself: the test calls the hooks wired in
    // options exactly as the CLI would, around a tool call in each turn.
    process.env.SLAUDE_AUTO_EVOLVE = "1";
    const mgr = new AgentManager();
    const events = record(mgr);
    const row = await mgr.ensureSession(thread());
    const runHooks = async (event: string, input: any) => {
      const outs: any[] = [];
      for (const m of fs.options.hooks[event] ?? []) {
        for (const h of m.hooks) outs.push(await h({ hook_event_name: event, session_id: "cli", transcript_path: "/t", cwd: "/w", ...input }, "tu", { signal: new AbortController().signal }));
      }
      return outs.find((o) => o?.hookSpecificOutput?.permissionDecision === "deny") ?? {};
    };
    const runPre = (input: any) => runHooks("PreToolUse", input);
    // kb_memoize is governed by slaude:memory (skill-gate): load it once in the
    // human turn, as the model would, so only the profile guard can deny below.
    const load = { tool_name: "Skill", tool_input: { skill: "slaude:memory" }, tool_use_id: "k1" };
    const profile = { tool_name: "mcp__slaude_kb__kb_memoize", tool_input: { target: "profile", pages: [] }, tool_use_id: "p1" };
    const mine = { tool_name: "mcp__slaude_kb__kb_memoize", tool_input: { target: "mine", pages: [] }, tool_use_id: "m1" };
    const human: any[] = [];
    const evolve: any[] = [];
    const fs = plan((s) => {
      s.onUser = (um) => {
        const text = String(um.message.content);
        void (async () => {
          const into = text.includes("<auto-evolve>") ? evolve : human;
          if (into === human) {
            await runPre(load);
            await runHooks("PostToolUse", { ...load, tool_response: { success: true, commandName: "slaude:memory" } });
          }
          into.push(await runPre(profile), await runPre(mine));
          if (into === human) s.emit(asst([tool("Bash"), tool("Write"), tool("WebFetch"), tool("WebSearch"), txt("did the work")]));
          s.emit(res());
        })();
      };
    });

    await mgr.sendMessage(row.id, "call me Al from now on");
    await until(() => events.filter((e) => e.type === "done").length === 2, 3000, "evolve done");
    expect(human).toEqual([{}, {}]);
    expect(evolve[0].hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "A profile is written only on that person's own turn.",
    });
    expect(evolve[1]).toEqual({});
    await shutdown(mgr, row.id);
  });
});
