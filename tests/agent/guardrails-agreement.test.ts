/**
 * The guardrail registry agrees with what runs. Real SDK options are built
 * through the existing seams (a fake `query` captures them): an interactive
 * session, a wake, a remote session, and a background pass's lockdown options.
 * For each, `options.hooks` is walked and every callback's registry mark read
 * back: the [event, ordered ids] must equal the registry's wired hook entries
 * filtered by appliesTo, each id once, and no callback unmarked.
 *
 * Voice is not built separately: a voice call drives the interactive session
 * (the same boot, the same hooks object), and only the synthetic-turn flag the
 * hooks read changes their behaviour, not which hooks exist.
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

const { AgentManager, SCHEDULER_TOOLS } = await import("../../src/agent/manager");
const { passQueryOptions } = await import("../../src/background/runner");
const { hookTag } = await import("../../src/agent/hook-tags");
const { GUARDRAILS, SCHEDULER_TOOL_NAMES, wiredHookEntries, NODE_RUNTIME } = await import("../../src/agent/guardrails");
import type { BackgroundTurnRun } from "../../src/agent/manager";
import type { GuardrailAppliesTo } from "../../src/agent/guardrails";

class FakeSession {
  out: any[] = [];
  ended = false;
  err: Error | null = null;
  _wake: (() => void) | null = null;
  wake() { const w = this._wake; this._wake = null; w?.(); }
  start({ prompt, options }: QueryArgs, onUser?: (s: FakeSession) => void) {
    const self = this;
    options.abortController?.signal.addEventListener("abort", () => { self.err = new Error("aborted by controller"); self.wake(); });
    (async () => {
      try {
        for await (const _ of prompt) onUser?.(self);
        self.ended = true;
        self.wake();
      } catch (e) { self.err = e as Error; self.wake(); }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (self.err) { const e = self.err; self.err = null; throw e; }
          if (self.out.length > 0) { yield self.out.shift(); continue; }
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

let lastOptions: any;
let reply = false;
beforeEach(() => {
  lastOptions = undefined;
  reply = false;
  currentQuery = (args) => {
    lastOptions = args.options;
    return new FakeSession().start(args, (s) => {
      if (!reply) return;
      s.out.push({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      s.wake();
    });
  };
});
afterAll(() => { currentQuery = passthrough; });

let seq = 0;
const thread = () => ({ team_id: "T1", channel_id: "C1", thread_ts: `${Date.now()}.${++seq}` });
async function until(cond: () => boolean, ms = 3000, label = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}
async function shutdown(mgr: InstanceType<typeof AgentManager>, id: string) {
  if (!mgr.isLive(id)) return;
  mgr.reload(id);
  await until(() => !mgr.isLive(id), 3000, `shutdown of ${id}`);
}
const noopExec = async () => ({ stdout: "", stderr: "", code: 0, truncated: false, timedOut: false });

/** [event, ordered registry ids] as wired; an unmarked callback shows as "UNTAGGED". */
function wired(options: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [event, matchers] of Object.entries(options.hooks ?? {})) {
    out[event] = (matchers as any[]).flatMap((m) => m.hooks).map((h: unknown) => hookTag(h) ?? "UNTAGGED");
  }
  return out;
}

/** The registry's expectation for one session kind. */
function expected(kind: GuardrailAppliesTo): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of wiredHookEntries()) {
    if (!g.appliesTo.includes(kind)) continue;
    (out[g.event!] ??= []).push(g.id);
  }
  return out;
}

async function interactiveOptions(): Promise<any> {
  lastOptions = undefined;
  const mgr = new AgentManager();
  mgr.setPermissionResolver(async (_s, _t, input) => ({ behavior: "allow", updatedInput: input }) as any);
  const row = await mgr.ensureSession(thread());
  await mgr.sendMessage(row.id, "hello");
  await until(() => lastOptions !== undefined, 3000, "boot");
  const o = lastOptions;
  await shutdown(mgr, row.id);
  return o;
}

async function wakeOptions(): Promise<any> {
  lastOptions = undefined;
  const mgr = new AgentManager();
  const row = await mgr.ensureSession(thread());
  reply = true;
  const finishes: string[] = [];
  const run: BackgroundTurnRun = { runId: "run-g1", finish: async (_u, outcome) => void finishes.push(outcome) };
  await mgr.sendMessage(row.id, '<runtime-check kind="wake">look</runtime-check>', { backgroundRun: run, wake: {} });
  await until(() => finishes.length === 1, 3000, "wake finish");
  const o = lastOptions;
  await shutdown(mgr, row.id);
  return o;
}

async function remoteOptions(): Promise<any> {
  lastOptions = undefined;
  const mgr = new AgentManager();
  mgr.setRemote(async () => ({ teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r" }), () => ({ exec: noopExec, release: async () => {}, dispose: async () => {} }));
  const row = await mgr.ensureSession(thread());
  await mgr.sendMessage(row.id, "hello");
  await until(() => lastOptions !== undefined, 3000, "boot");
  const o = lastOptions;
  await shutdown(mgr, row.id);
  return o;
}

function backgroundOptions(): any {
  return passQueryOptions({ model: "m", maxTurns: 2, server: {} as any, toolIds: ["mcp__slaude_pass__note"], abort: new AbortController() });
}

describe("the registry agrees with the wired hooks", () => {
  it("interactive (and voice, which is the interactive build)", async () => {
    const o = await interactiveOptions();
    expect(wired(o)).toEqual(expected("interactive"));
    expect(expected("voice")).toEqual(expected("interactive"));
    expect(typeof o.canUseTool).toBe("function");
  });
  it("wake", async () => {
    expect(wired(await wakeOptions())).toEqual(expected("wake"));
  });
  it("remote", async () => {
    const o = await remoteOptions();
    expect(wired(o)).toEqual(expected("remote"));
    expect(o.hooks.PreToolUse[0].hooks).toHaveLength(5);
  });
  it("background pass", () => {
    expect(wired(backgroundOptions())).toEqual(expected("background"));
  });
  it("every wired registry hook appears, once per session that has it, and nothing is untagged", async () => {
    const all = [await interactiveOptions(), await wakeOptions(), await remoteOptions(), backgroundOptions()].map(wired);
    const seen = new Set<string>();
    for (const w of all) {
      const ids = Object.values(w).flat();
      expect(ids).not.toContain("UNTAGGED");
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) seen.add(id);
    }
    expect([...seen].sort()).toEqual(wiredHookEntries().map((g) => g.id).sort());
  });
});

describe("the registry itself", () => {
  it("ids are unique; not-built entries are never wired", () => {
    const ids = GUARDRAILS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GUARDRAILS.filter((x) => x.notBuilt)) {
      expect(g.fieldNote?.href).toMatch(/^https:\/\//);
      expect(wiredHookEntries()).not.toContain(g);
    }
  });
  it("both owner guardrail hooks are in the registry, tagged, and wired where they apply", async () => {
    const byId = (id: string) => GUARDRAILS.find((g) => g.id === id)!;
    expect(byId("hook.pre-tool.owner-guardrails").appliesTo).toEqual(["interactive", "wake", "remote", "voice", "background"]);
    expect(byId("hook.pre-tool.guardrail-files").appliesTo).toEqual(["interactive", "wake", "remote", "voice"]);
    for (const o of [await interactiveOptions(), await wakeOptions(), await remoteOptions()]) {
      expect(wired(o).PreToolUse).toEqual(expect.arrayContaining(["hook.pre-tool.guardrail-files", "hook.pre-tool.owner-guardrails"]));
    }
    expect(wired(backgroundOptions()).PreToolUse).toEqual(["hook.pre-tool.owner-guardrails", "hook.pre-tool.background-only-pass-tools"]);
  });
  it("telemetry hooks are observability entries", () => {
    const kind = (id: string) => GUARDRAILS.find((g) => g.id === id)!.kind;
    expect(kind("obs.pre-compact.compacting")).toBe("observability");
    expect(kind("obs.post-tool.skill-usage")).toBe("observability");
  });
  it("the scheduler deny list is the manager's own", () => {
    expect([...SCHEDULER_TOOL_NAMES]).toEqual([...SCHEDULER_TOOLS]);
  });
});

describe("state from runtime facts and toggles", () => {
  const byId = (id: string) => GUARDRAILS.find((g) => g.id === id)!;
  const ctx = (over: Partial<typeof NODE_RUNTIME> = {}) => ({ agent: "default", stopGuard: true, permissionResolver: true, turnsRunOn: "this-process" as const, ...over });
  const saved = { ...process.env };
  afterAll(() => {
    for (const k of ["SLAUDE_DECISION_CONFIG", "SLAUDE_REMOTE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("the must-reply guard is not wired without a Stop guard; nodes install one", () => {
    expect(byId("hook.stop.must-reply").state(ctx())).toBe("enforcing");
    expect(byId("hook.stop.must-reply").state(ctx({ stopGuard: false }))).toBe("not-wired");
    expect(byId("hook.stop.must-reply").state({ agent: "default", ...NODE_RUNTIME })).toBe("enforcing");
  });
  it("the permission and wake gates are not wired without a resolver", () => {
    for (const id of ["gate.can-use-tool.permission", "gate.can-use-tool.wake-refusal"]) {
      expect(byId(id).state(ctx())).toBe("enforcing");
      expect(byId(id).state(ctx({ permissionResolver: false }))).toBe("not-wired");
    }
  });
  it("the decision gate reports its real mode; a broken config is off and names the field only", () => {
    const g = byId("gate.dispatch.decision");
    delete process.env.SLAUDE_DECISION_CONFIG;
    expect(g.state(ctx())).toBe("off");
    process.env.SLAUDE_DECISION_CONFIG = JSON.stringify({ gate: { mode: "shadow" } });
    expect(g.state(ctx())).toBe("shadow");
    process.env.SLAUDE_DECISION_CONFIG = JSON.stringify({ gate: { mode: "on" } });
    expect(g.state(ctx())).toBe("enforcing");
    process.env.SLAUDE_DECISION_CONFIG = JSON.stringify({ gate: { mode: "on" }, adapter: { apiKey: "hidden-value" }, bogus: 1 });
    expect(g.state(ctx())).toBe("off");
    expect(JSON.stringify(g.details!(ctx(), { role: "superadmin" }))).not.toContain("hidden-value");
  });
  it("remote mode entries follow SLAUDE_REMOTE", () => {
    process.env.SLAUDE_REMOTE = "0";
    expect(byId("hook.pre-tool.remote-deny-local").state(ctx())).toBe("off");
    process.env.SLAUDE_REMOTE = "1";
    expect(byId("hook.pre-tool.remote-deny-local").state(ctx())).toBe("enforcing");
  });
  it("not-built entries are not-built whatever the facts", () => {
    expect(byId("hook.stop.kb-first").state(ctx())).toBe("not-built");
    expect(byId("gate.policy.tier-2-3").state(ctx())).toBe("not-built");
  });
});
