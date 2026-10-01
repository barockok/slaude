/**
 * Remote-mode wiring for AgentManager (handle lifecycle, tool aliasing, guard,
 * config-fingerprint reload) with a fully fake claude-agent-sdk `query`.
 * Same SDK-stub preamble as manager-lifecycle.test.ts (see the mock.module note there).
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

const noopExec = async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false });

describe("remote wiring", () => {
  it("with a target: remote MCP server, aliases, PreToolUse guard, remote mode block", async () => {
    const mgr = new AgentManager();
    mgr.setRemote(
      async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/home/a/repo" }),
      () => ({ exec: noopExec, release: async () => {}, dispose: async () => {} }),
    );
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(fs.options.mcpServers.remote).toBeDefined();
    expect(fs.options.toolAliases.Bash).toBe("mcp__remote__bash");
    expect(fs.options.hooks.PreToolUse).toHaveLength(1);
    expect(fs.options.systemPrompt.append).toContain("<remote-mode>");
    for (const b of ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]) {
      expect(fs.options.disallowedTools ?? []).not.toContain(b); // enabled + alias (spike §8)
    }
    for (const t of ["NotebookEdit", "Monitor", "REPL", "Workflow", "EnterWorktree", "ExitWorktree", "Artifact"]) {
      expect(fs.options.disallowedTools).toContain(t);
    }
    await shutdown(mgr, row.id);
  });

  it("a reboot releases but keeps the handle (jobs survive); a changed or ended target disposes it", async () => {
    const mgr = new AgentManager();
    let target: any = { teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" };
    const log: string[] = [];
    let opened = 0;
    mgr.setRemote(async () => target, () => {
      const n = ++opened;
      return {
        exec: noopExec,
        release: async () => { log.push(`release${n}`); },
        dispose: async () => { log.push(`dispose${n}`); },
      };
    });
    const row = await mgr.ensureSession(thread());
    const boot = async () => { const fs = plan(); await mgr.sendMessage(row.id, "hi"); await until(() => fs.options !== null, 3000, "boot"); await shutdown(mgr, row.id); };
    await boot();                       // open #1
    await boot();                       // same target: reuse #1
    expect(opened).toBe(1);
    expect(log.filter((l) => l.startsWith("dispose"))).toEqual([]);
    expect(log).toContain("release1");
    target = { ...target, addr: "tcB" }; // re-pointed
    await boot();
    expect(log).toContain("dispose1");
    expect(opened).toBe(2);
    target = null;                      // /remote off
    await boot();
    expect(log).toContain("dispose2");
  });

  it("without a target: no remote server, no aliases, no guard", async () => {
    const mgr = new AgentManager();
    mgr.setRemote(async () => null, () => { throw new Error("factory must not run"); });
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(fs.options.mcpServers?.remote).toBeUndefined();
    expect(fs.options.toolAliases).toBeUndefined();
    expect(fs.options.hooks.PreToolUse).toBeUndefined();
    expect(fs.options.disallowedTools).toBeUndefined();
    await shutdown(mgr, row.id);
  });

  it("without a target: canUseTool is the plain resolver wrapper (or absent with no resolver)", async () => {
    const mgr = new AgentManager();
    mgr.setRemote(async () => null, undefined);
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(fs.options.canUseTool).toBeUndefined();
    await shutdown(mgr, row.id);

    const asked: string[] = [];
    const mgr2 = new AgentManager();
    mgr2.setPermissionResolver(async (_sid, toolName, input) => { asked.push(toolName); return { behavior: "allow", updatedInput: input } as any; });
    mgr2.setRemote(async () => null, undefined);
    const row2 = await mgr2.ensureSession(thread());
    const fs2 = plan();
    await mgr2.sendMessage(row2.id, "hello");
    await until(() => fs2.options !== null, 3000, "boot");
    const sig = { signal: new AbortController().signal };
    await fs2.options.canUseTool("Read", { file_path: "a" }, sig);
    await fs2.options.canUseTool("mcp__remote__read", { file_path: "a" }, sig);
    expect(asked).toEqual(["Read", "mcp__remote__read"]); // no remote interception
    await shutdown(mgr2, row2.id);
  });

  it("canUseTool: remote read allowed without asking; remote bash asks as Bash; follows /mode changes", async () => {
    const mgr = new AgentManager();
    const asked: string[] = [];
    mgr.setPermissionResolver(async (_sid, toolName, input) => { asked.push(toolName); return { behavior: "allow", updatedInput: input } as any; });
    mgr.setRemote(async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" }), () => ({ exec: noopExec, release: async () => {}, dispose: async () => {} }));
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    const sig = { signal: new AbortController().signal };
    expect((await fs.options.canUseTool("mcp__remote__read", { file_path: "a" }, sig)).behavior).toBe("allow");
    await fs.options.canUseTool("mcp__remote__bash", { command: "ls" }, sig);
    expect(asked).toEqual(["Bash"]);
    await mgr.setPermissionMode(row.id, "bypassPermissions");
    await fs.options.canUseTool("mcp__remote__bash", { command: "ls" }, sig);
    expect(asked).toEqual(["Bash"]); // bypass: no second ask
    await shutdown(mgr, row.id);
  });

  it("ensureConfigFp: first sight on a non-live session records; a change reloads the warm session; same fp is a no-op", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    expect(await mgr.ensureConfigFp(row.id, "fp1")).toBe(true);
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(await mgr.ensureConfigFp(row.id, "fp1")).toBe(true);
    expect(mgr.isLive(row.id)).toBe(true);
    expect(await mgr.ensureConfigFp(row.id, "fp2")).toBe(true);
    expect(mgr.isLive(row.id)).toBe(false);
    expect(await mgr.ensureConfigFp(row.id, undefined)).toBe(true); // tokens from an older gateway: ignored
  });

  it("ensureConfigFp: a live session that booted with no fingerprint is reloaded on first sight", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await mgr.sendMessage(row.id, "hello"); // booted before any fingerprint (e.g. gateway upgraded later)
    await until(() => fs.options !== null, 3000, "boot");
    expect(await mgr.ensureConfigFp(row.id, "fpX")).toBe(true);
    expect(mgr.isLive(row.id)).toBe(false);
    // Recorded: the same fingerprint on the next (fresh) boot is a no-op.
    const fs2 = plan();
    await mgr.sendMessage(row.id, "again");
    await until(() => fs2.options !== null, 3000, "reboot");
    expect(await mgr.ensureConfigFp(row.id, "fpX")).toBe(true);
    expect(mgr.isLive(row.id)).toBe(true);
    await shutdown(mgr, row.id);
  });

  it("ensureConfigFp: returns false when the session is still live at the deadline, and retries next time", async () => {
    const mgr = new AgentManager();
    const row = await mgr.ensureSession(thread());
    const fs = plan((f) => { f.end = () => {}; }); // the turn never finishes: stays live after reload
    expect(await mgr.ensureConfigFp(row.id, "fp1")).toBe(true);
    await mgr.sendMessage(row.id, "hello");
    await until(() => fs.options !== null, 3000, "boot");
    expect(await mgr.ensureConfigFp(row.id, "fp2", 60)).toBe(false);
    expect(mgr.isLive(row.id)).toBe(true);
    // Not recorded: a retry with the same fingerprint attempts the reboot again.
    expect(await mgr.ensureConfigFp(row.id, "fp2", 60)).toBe(false);
    fs.ended = true;
    fs.wake();
    await until(() => !mgr.isLive(row.id), 3000, "release");
    expect(await mgr.ensureConfigFp(row.id, "fp2", 60)).toBe(true);
  });
});

describe("remote handle disposal bound and fail-closed", () => {
  const mkHandle = (log: string[], n: number, dispose: () => Promise<void>) => ({
    exec: noopExec,
    release: async () => { log.push(`release${n}`); },
    dispose,
  });

  it("a re-point whose old dispose never resolves still boots, releases the old handle, and swallows a late rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const mgr = new AgentManager();
      mgr.setRemoteDisposeTimeoutMs(30);
      let target: any = { teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" };
      const log: string[] = [];
      let opened = 0;
      let rejectLate!: (e: Error) => void;
      mgr.setRemote(async () => target, () => {
        const n = ++opened;
        const dispose = n === 1
          ? () => new Promise<void>((_, rej) => { rejectLate = rej; })
          : async () => { log.push(`dispose${n}`); };
        return mkHandle(log, n, dispose);
      });
      const row = await mgr.ensureSession(thread());
      const boot = async () => { const fs = plan(); await mgr.sendMessage(row.id, "hi"); await until(() => fs.options !== null, 3000, "boot"); return fs; };
      await boot();
      await shutdown(mgr, row.id);
      await Bun.sleep(10);
      log.length = 0; // drop the reboot's own release1
      target = { ...target, addr: "tcB" };
      const fs = await boot();
      expect(opened).toBe(2);
      expect(fs.options.mcpServers.remote).toBeDefined();
      expect(log).toContain("release1");
      rejectLate(new Error("late"));
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
      await shutdown(mgr, row.id);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a quick dispose is awaited before the new handle opens and triggers no timeout release", async () => {
    const mgr = new AgentManager();
    mgr.setRemoteDisposeTimeoutMs(2000);
    let target: any = { teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" };
    const log: string[] = [];
    let opened = 0;
    mgr.setRemote(async () => target, () => {
      const n = ++opened;
      log.push(`open${n}`);
      return mkHandle(log, n, async () => { await Bun.sleep(10); log.push(`dispose${n}`); });
    });
    const row = await mgr.ensureSession(thread());
    const boot = async () => { const fs = plan(); await mgr.sendMessage(row.id, "hi"); await until(() => fs.options !== null, 3000, "boot"); await shutdown(mgr, row.id); };
    await boot();
    target = { ...target, addr: "tcB" };
    await boot();
    expect(log.indexOf("dispose1")).toBeGreaterThan(-1);
    expect(log.indexOf("dispose1")).toBeLessThan(log.indexOf("open2"));
    // release1 is only the reboot's release before the re-point; no timeout release after dispose
    expect(log.filter((l) => l === "release1")).toHaveLength(1);
  });

  it("a target without an installed factory fails the boot instead of running local tools", async () => {
    const mgr = new AgentManager();
    mgr.setRemote(async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" }), undefined);
    const row = await mgr.ensureSession(thread());
    const fs = plan();
    await expect(mgr.sendMessage(row.id, "hi")).rejects.toThrow("no remote factory");
    expect(fs.options).toBeNull();
    expect(mgr.isLive(row.id)).toBe(false);
  });
});
