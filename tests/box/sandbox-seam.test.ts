/**
 * The sandbox seam in AgentManager (box plan, Phase 1): with a resolver that
 * returns a sandbox, the options of a boot carry a `spawnClaudeCodeProcess`
 * that hands the SDK's spawn request to `sandbox.spawn`; with no resolver or a
 * null answer the option is absent and the option keys are today's; a resolver
 * that throws fails the boot and nothing is spawned.
 * Same SDK-stub approach as tests/agent/manager-node-mcp.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

process.env.SLAUDE_MEMORY = "sqlite";
process.env.SLAUDE_AUTO_EVOLVE = "0";
process.env.SLAUDE_IDLE_MINUTES = "0";

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
const realQuery = realSdk.query;
type QueryArgs = { prompt: AsyncIterable<any>; options: any };
let captured: any[] = [];
let currentQuery: (args: QueryArgs) => any = () => {
  throw new Error("no query installed");
};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: (args: QueryArgs) => currentQuery(args),
}));

const { AgentManager } = await import("../../src/agent/manager");
const { BootFailure, failureText } = await import("../../src/gateway/core/failure-codes");
const { noneDriver } = await import("../../src/box/drivers/none");
import type { SessionSandbox, SpawnOptions, SpawnedProcess } from "../../src/box/sandbox";

/** A query that records its options and ends when the prompt iterable closes. */
function recordingQuery({ prompt, options }: QueryArgs) {
  captured.push(options);
  let done = false;
  const waker: { wake: (() => void) | null } = { wake: null };
  (async () => {
    for await (const _ of prompt) {
      /* drain */
    }
    done = true;
    waker.wake?.();
  })();
  return {
    async *[Symbol.asyncIterator]() {
      while (!done) await new Promise<void>((r) => (waker.wake = r));
    },
    setPermissionMode: async () => ({}),
    mcpServerStatus: async () => [],
    interrupt: async () => {},
  };
}

let seq = 0;
const thread = () => ({ team_id: "T1", channel_id: "C1", thread_ts: `${Date.now()}.${++seq}` });

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}

async function boot(mgr: InstanceType<typeof AgentManager>): Promise<{ opts: any; sessionId: string }> {
  const row = await mgr.ensureSession(thread());
  const before = captured.length;
  await mgr.sendMessage(row.id, "hello");
  await until(() => captured.length > before);
  const opts = captured[captured.length - 1];
  mgr.reload(row.id);
  await until(() => !mgr.isLive(row.id));
  return { opts, sessionId: row.id };
}

function fakeSandbox(): { sandbox: SessionSandbox; spawns: SpawnOptions[]; returned: SpawnedProcess; started: number } {
  const spawns: SpawnOptions[] = [];
  const returned = { marker: "fake-process" } as unknown as SpawnedProcess;
  const state = {
    spawns,
    returned,
    started: 0,
    sandbox: {
      tier: "gvisor" as const,
      start: async () => {
        state.started++;
      },
      spawn: (o: SpawnOptions) => {
        spawns.push(o);
        return returned;
      },
      stats: async () => ({ memoryBytes: 0, pids: 0, homeBytes: 0, overlayBytes: 0 }),
      stop: async () => {},
    } satisfies SessionSandbox,
  };
  return state;
}

/** The option keys of an unboxed boot on this build. A new key is a deliberate change here. */
const UNBOXED_OPTION_KEYS = [
  "abortController",
  "cwd",
  "disallowedTools",
  "env",
  "extraArgs",
  "hooks",
  "permissionMode",
  "plugins",
  "stderr",
  "systemPrompt",
];

beforeEach(() => {
  captured = [];
  currentQuery = recordingQuery;
});
afterAll(() => {
  // The mock outlives this file: without this, later files get the recording query.
  currentQuery = (args) => realQuery(args as any);
});

describe("sandbox seam", () => {
  it("no resolver: no spawn hook, and the option keys are today's", async () => {
    const { opts } = await boot(new AgentManager());
    expect(Object.hasOwn(opts, "spawnClaudeCodeProcess")).toBe(false);
    expect(Object.keys(opts).sort()).toEqual(UNBOXED_OPTION_KEYS);
  });

  it("a null answer (tier none) is the same as no resolver", async () => {
    const mgr = new AgentManager();
    const asked: string[] = [];
    mgr.setSandboxResolver(async (sessionId) => {
      asked.push(sessionId);
      return null;
    });
    const { opts, sessionId } = await boot(mgr);
    expect(asked).toEqual([sessionId]);
    expect(Object.hasOwn(opts, "spawnClaudeCodeProcess")).toBe(false);
    expect(Object.keys(opts).sort()).toEqual(UNBOXED_OPTION_KEYS);
  });

  it("a boxed session is told what lasts in its box and how a refused host looks; an unboxed one is told nothing of it", async () => {
    const { BOXED_SESSION_BLOCK } = await import("../../src/box/prompt");
    const unboxed = (await boot(new AgentManager())).opts.systemPrompt.append as string;
    const viaNull = new AgentManager();
    viaNull.setSandboxResolver(async () => null);
    const unboxedNull = (await boot(viaNull)).opts.systemPrompt.append as string;
    const mgr = new AgentManager();
    mgr.setSandboxResolver(async () => fakeSandbox().sandbox);
    const boxed = (await boot(mgr)).opts.systemPrompt.append as string;
    expect(unboxed).not.toContain("<box>");
    expect(unboxedNull).not.toContain("<box>");
    expect(boxed.endsWith(BOXED_SESSION_BLOCK)).toBe(true);
    // The box block is the only difference a sandbox makes to the prompt.
    expect(boxed.slice(0, -BOXED_SESSION_BLOCK.length).trimEnd().length).toBe(unboxed.length);
    expect(BOXED_SESSION_BLOCK).toContain("/home/agent");
    expect(BOXED_SESSION_BLOCK).toContain("403");
    expect(BOXED_SESSION_BLOCK).toContain("pip");
    expect(BOXED_SESSION_BLOCK).not.toMatch(/\u2014/);
  });

  it("a sandbox: the spawn hook hands the SDK's request to sandbox.spawn and returns its process", async () => {
    const mgr = new AgentManager();
    const fake = fakeSandbox();
    mgr.setSandboxResolver(async () => fake.sandbox);
    const { opts } = await boot(mgr);
    expect(typeof opts.spawnClaudeCodeProcess).toBe("function");
    expect(Object.keys(opts).sort()).toEqual([...UNBOXED_OPTION_KEYS, "spawnClaudeCodeProcess"].sort());
    // Booting calls nothing on the sandbox: the SDK decides when to spawn.
    expect(fake.spawns).toHaveLength(0);

    const signal = new AbortController().signal;
    const request: SpawnOptions = { command: "/opt/cli/claude", args: ["--print", "x"], cwd: "/work/s1", env: { A: "1" }, signal };
    const proc = opts.spawnClaudeCodeProcess(request);
    expect(proc).toBe(fake.returned);
    expect(fake.spawns).toHaveLength(1);
    const got = fake.spawns[0]!;
    expect(got.command).toBe("/opt/cli/claude");
    expect(got.args).toEqual(["--print", "x"]);
    expect(got.cwd).toBe("/work/s1");
    expect(got.env).toEqual({ A: "1" });
    expect(got.signal).toBe(signal);
  });

  it("a sandbox is resolved again on every boot", async () => {
    const mgr = new AgentManager();
    let calls = 0;
    mgr.setSandboxResolver(async () => {
      calls++;
      return fakeSandbox().sandbox;
    });
    await boot(mgr);
    await boot(mgr);
    expect(calls).toBe(2);
  });

  it("removing the resolver returns to an unboxed spawn", async () => {
    const mgr = new AgentManager();
    mgr.setSandboxResolver(async () => fakeSandbox().sandbox);
    mgr.setSandboxResolver(undefined);
    const { opts } = await boot(mgr);
    expect(Object.hasOwn(opts, "spawnClaudeCodeProcess")).toBe(false);
  });

  it("a resolver that throws fails the boot with BOX_UNAVAILABLE and nothing is spawned", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const mgr = new AgentManager();
      mgr.setSandboxResolver(async () => {
        throw new Error("boxd socket refused: token=raw-detail-never-posted");
      });
      const row = await mgr.ensureSession(thread());
      const before = captured.length;
      const e = await mgr.sendMessage(row.id, "hi").catch((x) => x);
      expect(e).toBeInstanceOf(BootFailure);
      expect(e.code).toBe("BOX_UNAVAILABLE");
      expect(e.message).not.toContain("raw-detail-never-posted");
      expect(captured.length).toBe(before);
      expect(mgr.isLive(row.id)).toBe(false);
      expect(failureText(e.code)).not.toContain("raw-detail");
      const logged = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("sandbox resolver failed");
      expect(logged).not.toContain("raw-detail-never-posted");
    } finally {
      err.mockRestore();
    }
  });

  it("a BootFailure from the resolver keeps its own code", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const mgr = new AgentManager();
      mgr.setSandboxResolver(async () => {
        throw new BootFailure("LABEL_MISMATCH", "no node offers this tier");
      });
      const row = await mgr.ensureSession(thread());
      const e = await mgr.sendMessage(row.id, "hi").catch((x) => x);
      expect(e).toBeInstanceOf(BootFailure);
      expect(e.code).toBe("LABEL_MISMATCH");
      expect(captured).toHaveLength(0);
    } finally {
      err.mockRestore();
    }
  });
});

describe("tier none driver", () => {
  it("always probes ok and never creates a sandbox", async () => {
    expect(noneDriver.tier).toBe("none");
    expect(await noneDriver.probe()).toEqual({ ok: true });
    expect(() => noneDriver.create({} as any)).toThrow(/returns null/);
  });
});
