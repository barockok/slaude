import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { TOOLS_SURVIVING_EMPTY_SET } from "../../src/agent/child-env";
import { metrics } from "../../src/metrics";
import { passPrompt, PROVISIONAL_OUTPUT_TOKENS, runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import { passToolId, READ_ONLY_PASS_TOOLS } from "../../src/background/pass-tools";
import type { PriceTable } from "../../src/background/prices";
import { fakeBrain } from "./fake-brain";
import { personaDefaultModel } from "../../src/persona/registry";
import { runHeartbeat } from "../../src/proactive/heartbeat";
import { parseProactive } from "../../src/soul/proactive";
import type { ExternalMcp } from "../../src/gateway/core/external-mcp";

const NOW = new Date("2026-10-26T03:00:00Z");
const DAY = "2026-10-26";
const MODEL = "test-model";
// 1 USD per million input tokens: 300k input tokens = 0.30 USD.
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 0, cache_read: 0, cache_write: 0 } };
const TURN = { input_tokens: 300_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

let seq = 0;
function spec(over: Partial<PassSpec> = {}): PassSpec {
  return { pass: "nightly-review", personaId: "default", agentId: `agent-r${++seq}`, scope: { kind: "agent" }, prompt: "Review the day.", ...over };
}

type Msg = Record<string, unknown>;
const assistant = (id: string, usage = TURN, model?: string): Msg => ({ type: "assistant", parent_tool_use_id: null, message: { id, usage, content: [], ...(model ? { model } : {}) } });
const result = (usage: Msg = {}, subtype = "success"): Msg => ({ type: "result", subtype, is_error: subtype !== "success", usage });

/** A fake query yielding `msgs` (a function throws), recording calls and how many messages were taken. */
function fakeQuery(msgs: Array<Msg | (() => never)>) {
  const state = { calls: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>, taken: 0 };
  const query = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    state.calls.push(args);
    return (async function* () {
      for (const m of msgs) {
        if (typeof m === "function") m();
        state.taken++;
        yield m;
      }
    })();
  }) as unknown as RunnerDeps["query"];
  return { query, state };
}

function deps(query: RunnerDeps["query"], limitUsd = 1, model = MODEL): RunnerDeps {
  return {
    query,
    brainCall: fakeBrain().call,
    now: () => NOW,
    priceTable: TABLE,
    model: () => model,
    budget: () => ({ limitUsd, timeZone: "UTC" }),
    kbSources: () => [],
    provider: async () => null,
  };
}

const rowOf = async (agentId: string, runId: string) => (await Runs.listBetween(agentId, DAY, DAY)).find((r) => r.id === runId)!;

let errSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.run("DELETE FROM background_runs");
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
});

describe("runPass", () => {
  test("an open run counts its start estimate (the floor) until its first priced turn replaces it", async () => {
    const s = spec();
    let openCost: number | undefined;
    const query = (() =>
      (async function* () {
        openCost = (await Runs.listBetween(s.agentId, DAY, DAY))[0]?.costUsd;
        yield assistant("m1");
        yield result(TURN);
      })()) as unknown as RunnerDeps["query"];
    const r = await runPass(s, deps(query));
    expect(openCost).toBeCloseTo(0.1, 9);
    expect(r.outcome).toBe("ok");
    expect((await rowOf(s.agentId, r.runId)).costUsd).toBeCloseTo(0.3, 9);
  });

  test("budget refuses: skipped-budget, query never called, metric counted", async () => {
    const s = spec();
    const { query, state } = fakeQuery([assistant("m1"), result()]);
    // nightly-review's floor is 0.10.
    const r = await runPass(s, deps(query, 0.05));
    expect(r.outcome).toBe("skipped-budget");
    expect(r.costUsd).toBe(0);
    expect(state.calls).toHaveLength(0);
    expect((await rowOf(s.agentId, r.runId)).outcome).toBe("skipped-budget");
    expect(metrics.render()).toMatch(new RegExp(`slaude_background_runs_total\\{[^}]*agent="${s.agentId}"[^}]*outcome="skipped-budget"[^}]*\\} 1`));
  });

  test("an unpriced configured model still runs, priced by the model the CLI reports", async () => {
    const s = spec();
    const { query, state } = fakeQuery([assistant("m1", TURN, MODEL), result(TURN)]);
    const r = await runPass(s, deps(query, 1, "mystery-model-9"));
    expect(r.outcome).toBe("ok");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.options.model).toBe("mystery-model-9");
    expect(r.costUsd).toBeCloseTo(0.3, 9);
    expect(await rowOf(s.agentId, r.runId)).toMatchObject({ outcome: "ok", model: "mystery-model-9" });
  });

  test("no model configured (SLAUDE_MODEL unset): the CLI's default runs, priced by the reported model", async () => {
    const s = spec();
    const { query, state } = fakeQuery([assistant("m1", TURN, MODEL), result(TURN)]);
    const r = await runPass(s, deps(query, 1, ""));
    expect(r.outcome).toBe("ok");
    expect(state.calls).toHaveLength(1);
    expect("model" in state.calls[0]!.options).toBe(false);
    expect(r.costUsd).toBeCloseTo(0.3, 9);
  });

  test("a reported model with no price ends the run as error after that turn, keeping at least the estimate", async () => {
    const s = spec();
    const { query, state } = fakeQuery([assistant("m1", TURN, "mystery-model-9"), assistant("m2", TURN, "mystery-model-9"), result(TURN)]);
    const r = await runPass(s, deps(query, 1, ""));
    expect(r.outcome).toBe("error");
    expect(state.taken).toBe(1);
    expect((state.calls[0]!.options.abortController as AbortController).signal.aborted).toBe(true);
    // Never zero: the nightly's floor estimate stays as the cost.
    expect(r.costUsd).toBeCloseTo(0.1, 9);
    expect((await rowOf(s.agentId, r.runId)).tokens.input).toBe(300_000);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("'mystery-model-9'");
  });

  test("after a pass ends error on an unpriced reported model, no further pass of the agent starts that day", async () => {
    const agentId = `agent-unpriced${++seq}`;
    const first = fakeQuery([assistant("m1", TURN, "mystery-model-9"), result(TURN)]);
    const r1 = await runPass(spec({ agentId }), deps(first.query, 5, ""));
    expect(r1.outcome).toBe("error");
    expect((await rowOf(agentId, r1.runId)).unpricedModel).toBe("mystery-model-9");
    const second = fakeQuery([assistant("m1", TURN, MODEL), result(TURN)]);
    const r2 = await runPass(spec({ agentId, pass: "quiet-moment" }), deps(second.query, 5));
    expect(second.state.calls).toHaveLength(0);
    expect(await rowOf(agentId, r2.runId)).toMatchObject({ outcome: "error", costUsd: 0, unpricedModel: "mystery-model-9" });
    // Another agent, and the next day, are not refused.
    const other = fakeQuery([assistant("m1", TURN, MODEL), result(TURN)]);
    expect((await runPass(spec(), deps(other.query, 5))).outcome).toBe("ok");
    const tomorrow = fakeQuery([assistant("m1", TURN, MODEL), result(TURN)]);
    const r3 = await runPass(spec({ agentId }), { ...deps(tomorrow.query, 5), now: () => new Date("2026-10-27T03:00:00Z") });
    expect(r3.outcome).toBe("ok");
  });

  test("near-simultaneous starts with room for one estimate never both run (insert first, then re-check)", async () => {
    const agentId = `agent-race${++seq}`;
    const a = fakeQuery([result()]);
    const b = fakeQuery([result()]);
    // nightly-review's floor is 0.10: 0.15 leaves room for one open run, not two.
    const [ra, rb] = await Promise.all([runPass(spec({ agentId }), deps(a.query, 0.15)), runPass(spec({ agentId }), deps(b.query, 0.15))]);
    expect(a.state.calls.length + b.state.calls.length).toBeLessThanOrEqual(1);
    for (const [r, q] of [[ra, a], [rb, b]] as const) if (q.state.calls.length === 0) expect(r.outcome).toBe("skipped-budget");
    expect(await Runs.spentOn(agentId, DAY)).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  test("a 3-turn run crossing the limit on turn 2 is aborted after turn 2 and the cost includes turn 2", async () => {
    const s = spec();
    const { query, state } = fakeQuery([assistant("m1"), assistant("m2"), assistant("m3"), result()]);
    const r = await runPass(s, deps(query, 0.5));
    expect(r.outcome).toBe("stopped-budget");
    expect(r.costUsd).toBeCloseTo(0.6);
    expect(state.taken).toBe(2);
    expect((state.calls[0]!.options.abortController as AbortController).signal.aborted).toBe(true);
    const row = await rowOf(s.agentId, r.runId);
    expect(row.outcome).toBe("stopped-budget");
    expect(row.costUsd).toBeCloseTo(0.6);
    expect(row.tokens.input).toBe(600_000);
    expect(metrics.render()).toMatch(new RegExp(`slaude_background_cost_usd_total\\{[^}]*agent="${s.agentId}"[^}]*\\} 0\\.6`));
  });

  test("shutdown mid-pass: the query is aborted after the turn in flight, the run is an error, one line says why", async () => {
    const s = spec();
    const ac = new AbortController();
    let sdkAborted = false;
    let taken = 0;
    const query = ((args: { options: { abortController: AbortController } }) =>
      (async function* () {
        args.options.abortController.signal.addEventListener("abort", () => (sdkAborted = true));
        taken++;
        ac.abort(); // SIGTERM while turn 1 is in flight
        yield assistant("m1");
        taken++;
        yield assistant("m2");
        yield result(TURN);
      })()) as unknown as RunnerDeps["query"];
    const r = await runPass({ ...s, signal: ac.signal }, deps(query));
    expect(r.outcome).toBe("error");
    expect(sdkAborted).toBe(true);
    expect(taken).toBe(1);
    // Turn 1 is counted.
    expect((await rowOf(s.agentId, r.runId))).toMatchObject({ outcome: "error" });
    expect(r.costUsd).toBeCloseTo(0.3, 9);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("stopped: shutting down");
    expect(errSpy).not.toHaveBeenCalled();
    expect(metrics.render()).toMatch(new RegExp(`slaude_background_runs_total\\{[^}]*agent="${s.agentId}"[^}]*outcome="error"[^}]*\\} 1`));
  });

  test("shutdown mid-pass when the SDK throws on abort: still an error, no failure line", async () => {
    const s = spec();
    const ac = new AbortController();
    const query = (() =>
      (async function* () {
        yield assistant("m1");
        ac.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })()) as unknown as RunnerDeps["query"];
    const r = await runPass({ ...s, signal: ac.signal }, deps(query));
    expect(r.outcome).toBe("error");
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("an already-aborted signal: error row, query never called", async () => {
    const s = spec();
    const ac = new AbortController();
    ac.abort();
    const { query, state } = fakeQuery([assistant("m1"), result()]);
    const r = await runPass({ ...s, signal: ac.signal }, deps(query));
    expect(r.outcome).toBe("error");
    expect(state.calls).toHaveLength(0);
    expect((await rowOf(s.agentId, r.runId)).outcome).toBe("error");
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("not started: shutting down");
  });

  test("other runs' spend that day counts toward the stop", async () => {
    const s = spec();
    const other = await Runs.start({ agentId: s.agentId, pass: "quiet-moment", scope: "agent", day: DAY });
    await Runs.finish(other, { tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, costUsd: 0.6, outcome: "ok" });
    const { query, state } = fakeQuery([assistant("m1"), assistant("m2"), result()]);
    const r = await runPass(s, deps(query, 0.8));
    expect(r.outcome).toBe("stopped-budget");
    expect(state.taken).toBe(1);
  });

  test("a run that throws mid-way leaves an error row whose cost includes the completed turns", async () => {
    const s = spec();
    let midRunSpend = -1;
    const { query } = fakeQuery([
      assistant("m1"),
      (() => {
        throw new Error("child died");
      }) as () => never,
    ]);
    const wrapped = ((a: never) => {
      const it = (query as unknown as (a: never) => AsyncGenerator<Msg>)(a);
      return (async function* () {
        for await (const m of it) {
          yield m;
          midRunSpend = await Runs.spentOn(s.agentId, DAY);
        }
      })();
    }) as unknown as RunnerDeps["query"];
    const r = await runPass(s, deps(wrapped, 5));
    expect(r.outcome).toBe("error");
    // Recorded on the open row before the run ended.
    expect(midRunSpend).toBeCloseTo(0.3);
    const row = await rowOf(s.agentId, r.runId);
    expect(row.outcome).toBe("error");
    expect(row.costUsd).toBeCloseTo(0.3);
  });

  test("ok run: one API call split over several messages is priced once; the result total replaces the turns", async () => {
    const s = spec();
    // Counted twice, m1 would push the provisional figure to 0.9 > 0.65 and stop the run.
    const { query } = fakeQuery([assistant("m1"), assistant("m1"), assistant("m2"), result({ input_tokens: 500_000 })]);
    const r = await runPass(s, deps(query, 0.65));
    expect(r.outcome).toBe("ok");
    expect(r.costUsd).toBeCloseTo(0.5);
    expect((await rowOf(s.agentId, r.runId))).toMatchObject({ outcome: "ok" });
  });

  describe("output under-count on the real CLI (assistant usage is message_start's)", () => {
    // Output-only pricing: 100 USD per million output tokens.
    const OUT: PriceTable = { [MODEL]: { input: 0, output: 100, cache_read: 0, cache_write: 0 } };
    const tiny = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

    test("each turn counts at least 1024 output tokens, so the stop fires; the stopped row keeps the provisional figure", async () => {
      const s = spec({ pass: "lessons-upkeep" });
      const { query, state } = fakeQuery([assistant("m1", tiny), assistant("m2", tiny), assistant("m3", tiny), assistant("m4", tiny), result({ output_tokens: 9000 })]);
      const r = await runPass(s, { ...deps(query, 0.25), priceTable: OUT });
      expect(PROVISIONAL_OUTPUT_TOKENS).toBe(1024);
      expect(r.outcome).toBe("stopped-budget");
      expect(state.taken).toBe(3);
      expect(r.costUsd).toBeCloseTo((3 * 1024 * 100) / 1e6);
      expect((await rowOf(s.agentId, r.runId)).tokens.output).toBe(3 * 1024);
    });

    test("a large result total corrects the provisional figure upward", async () => {
      const s = spec({ pass: "lessons-upkeep" });
      const { query } = fakeQuery([assistant("m1", tiny), assistant("m2", tiny), result({ input_tokens: 20, output_tokens: 5000 })]);
      const r = await runPass(s, { ...deps(query, 5), priceTable: OUT });
      expect(r.outcome).toBe("ok");
      expect(r.costUsd).toBeCloseTo((5000 * 100) / 1e6);
      expect((await rowOf(s.agentId, r.runId)).tokens).toEqual({ input: 20, output: 5000, cache_read: 0, cache_write: 0 });
    });

    test("an error mid-run keeps the provisional figure", async () => {
      const s = spec({ pass: "lessons-upkeep" });
      const { query } = fakeQuery([assistant("m1", tiny), (() => { throw new Error("boom"); }) as () => never]);
      const r = await runPass(s, { ...deps(query, 5), priceTable: OUT });
      expect(r.outcome).toBe("error");
      expect(r.costUsd).toBeCloseTo((1024 * 100) / 1e6);
    });
  });

  describe("per-model pricing from result.modelUsage", () => {
    const TWO: PriceTable = { ...TABLE, "test-small": { input: 0.1, output: 0, cache_read: 0, cache_write: 0 } };
    const mu = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 999 });

    test("each model is priced at its own rate (never the SDK's costUSD)", async () => {
      const { query } = fakeQuery([assistant("m1"), { ...result(), modelUsage: { [MODEL]: mu(300_000), "test-small": mu(1_000_000) } }]);
      const r = await runPass(spec(), { ...deps(query, 5), priceTable: TWO });
      expect(r.outcome).toBe("ok");
      expect(r.costUsd).toBeCloseTo(0.3 + 0.1);
    });

    test("a model with no price ends the run as error, logs its id, and keeps a non-zero figure", async () => {
      const s = spec();
      const { query } = fakeQuery([assistant("m1"), { ...result(), modelUsage: { [MODEL]: mu(300_000), "mystery-helper": mu(50_000) } }]);
      const r = await runPass(s, deps(query, 5));
      expect(r.outcome).toBe("error");
      expect(r.costUsd).toBeCloseTo(0.3);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).some((l: string) => l.includes("'mystery-helper'") && l.includes("SLAUDE_PRICE_TABLE"))).toBe(true);
      expect((await rowOf(s.agentId, r.runId)).outcome).toBe("error");
    });
  });

  describe("provider set", () => {
    const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "AWS_REGION"] as const;
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
      saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      process.env.ANTHROPIC_API_KEY = "process-key";
      process.env.ANTHROPIC_BASE_URL = "https://process.example.invalid";
      process.env.ANTHROPIC_AUTH_TOKEN = "process-auth";
      process.env.AWS_REGION = "process-region";
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    test("a persona with its own provider set gets exactly that set, nothing from this process", async () => {
      const { query, state } = fakeQuery([result()]);
      await runPass(spec(), { ...deps(query, 5), provider: async () => ({ apiKey: "persona-key", baseUrl: "https://persona.example.invalid" }) });
      const e = state.calls[0]!.options.env as Record<string, string | undefined>;
      expect(e.ANTHROPIC_API_KEY).toBe("persona-key");
      expect(e.ANTHROPIC_BASE_URL).toBe("https://persona.example.invalid");
      expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(e.AWS_REGION).toBeUndefined();
      expect(e.PATH).toBe(process.env.PATH);
    });

    test("a filesystem registry declares no provider set (the default seam resolves null)", async () => {
      const { resolvePersonaOwnProvider } = await import("../../src/gateway/api/tenants");
      expect(await resolvePersonaOwnProvider("default")).toBeNull();
    });

    test("without one, the process's provider variables pass through", async () => {
      const { query, state } = fakeQuery([result()]);
      await runPass(spec(), deps(query, 5));
      const e = state.calls[0]!.options.env as Record<string, string | undefined>;
      expect(e.ANTHROPIC_API_KEY).toBe("process-key");
      expect(e.ANTHROPIC_BASE_URL).toBe("https://process.example.invalid");
    });

    test("a provider that cannot be resolved is an error run; the query never starts", async () => {
      const s = spec();
      const { query, state } = fakeQuery([result()]);
      const r = await runPass(s, { ...deps(query, 5), provider: async () => { throw new Error("reference not found"); } });
      expect(r.outcome).toBe("error");
      expect(state.calls).toHaveLength(0);
      expect((await rowOf(s.agentId, r.runId)).outcome).toBe("error");
    });
  });

  test("a failure before the query (budget config) still writes an error row and counts the metric", async () => {
    const s = spec();
    const { query, state } = fakeQuery([result()]);
    const r = await runPass(s, { ...deps(query, 5), budget: () => { throw new Error("registry down"); } });
    expect(r.outcome).toBe("error");
    expect(state.calls).toHaveLength(0);
    expect((await rowOf(s.agentId, r.runId)).outcome).toBe("error");
    expect(metrics.render()).toMatch(new RegExp(`slaude_background_runs_total\\{[^}]*agent="${s.agentId}"[^}]*outcome="error"[^}]*\\} 1`));
  });

  test("a user-scope pass with no team id says so in one line", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { query } = fakeQuery([result()]);
      await runPass(spec({ scope: { kind: "user", userId: "U0ALICE", teamId: "" } }), deps(query, 5));
      expect(warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("no Slack team id"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a result total above the turns seen is taken", async () => {
    const { query } = fakeQuery([assistant("m1"), result({ input_tokens: 900_000 })]);
    expect((await runPass(spec(), deps(query, 5))).costUsd).toBeCloseTo(0.9);
  });

  test("an error result is an error; a stream with no result is an error", async () => {
    expect((await runPass(spec(), deps(fakeQuery([assistant("m1"), result({}, "error_during_execution")]).query, 5))).outcome).toBe("error");
    expect((await runPass(spec(), deps(fakeQuery([assistant("m1")]).query, 5))).outcome).toBe("error");
  });

  test("the lockdown options are passed", async () => {
    process.env.SLAUDE_REDIS_URL = "redis://example.invalid:6379";
    process.env.SLAUDE_NODE_TOKEN = "node-token-for-test";
    try {
      const s = spec({ pass: "lessons-upkeep" });
      const { query, state } = fakeQuery([result()]);
      await runPass(s, deps(query, 5));
      const o = state.calls[0]!.options;
      expect(o.tools).toEqual([]);
      expect(o.disallowedTools).toEqual([...TOOLS_SURVIVING_EMPTY_SET]);
      expect(o.permissionMode).toBe("dontAsk");
      expect(o.strictMcpConfig).toBe(true);
      expect(o.settingSources).toEqual([]);
      expect(o.maxTurns).toBe(6);
      expect(o.model).toBe(MODEL);
      expect(o.persistSession).toBe(false);
      expect(o.allowedTools).toEqual(["read_pages", "list_pages", "search", "memoize", "propose"].map(passToolId));
      expect(Object.keys(o.mcpServers as object)).toEqual(["slaude_pass"]);
      expect((o.mcpServers as Record<string, { type: string }>).slaude_pass!.type).toBe("sdk");
      expect(o.allowDangerouslySkipPermissions).toBeUndefined();
      expect(o.canUseTool).toBeUndefined();
      const childEnv = o.env as Record<string, string | undefined>;
      expect(childEnv.SLAUDE_REDIS_URL).toBeUndefined();
      expect(childEnv.SLAUDE_NODE_TOKEN).toBeUndefined();
      expect(childEnv.SLAUDE_HOME).toBe(process.env.SLAUDE_HOME);
      // The PreToolUse hook denies anything but the pass's own tools.
      const hook = (o.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<Record<string, unknown>>> }> }).PreToolUse[0]!.hooks[0]!;
      expect(await hook({ hook_event_name: "PreToolUse", tool_name: passToolId("memoize") })).toEqual({});
      for (const name of ["Bash", "mcp__slaude_kb__kb_memoize", "Monitor"]) {
        const out = (await hook({ hook_event_name: "PreToolUse", tool_name: name })) as { hookSpecificOutput?: { permissionDecision?: string } };
        expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      }
    } finally {
      delete process.env.SLAUDE_REDIS_URL;
      delete process.env.SLAUDE_NODE_TOKEN;
    }
  });

  test("extra tools are mounted and allowed by name", async () => {
    const { tool } = await import("@anthropic-ai/claude-agent-sdk");
    const extra = tool("list_skills", "List skills.", {}, async () => ({ content: [{ type: "text" as const, text: "[]" }] }));
    const { query, state } = fakeQuery([result()]);
    await runPass(spec({ pass: "skill-review", extraTools: [extra as never] }), deps(query, 5));
    expect(state.calls[0]!.options.allowedTools).toContain("mcp__slaude_pass__list_skills");
    expect(state.calls[0]!.options.maxTurns).toBe(12);
  });

  test("baseTools limits the mounted and allowed pass tools", async () => {
    const { query, state } = fakeQuery([result()]);
    await runPass(spec({ baseTools: READ_ONLY_PASS_TOOLS }), deps(query, 5));
    expect(state.calls[0]!.options.allowedTools).toEqual(["read_pages", "list_pages", "search"].map(passToolId));
  });

  test("an extra tool clashing with a pass tool throws before any ledger row", async () => {
    const { tool } = await import("@anthropic-ai/claude-agent-sdk");
    const clash = tool("memoize", "x", {}, async () => ({ content: [{ type: "text" as const, text: "" }] }));
    const s = spec({ extraTools: [clash as never] });
    await expect(runPass(s, deps(fakeQuery([result()]).query, 5))).rejects.toThrow(/duplicate tool name/);
    expect(await Runs.listBetween(s.agentId, DAY, DAY)).toEqual([]);
  });

  test("the prompt carries the transcripts, tag-escaped, and never starts with /", async () => {
    const p = passPrompt({ prompt: "/review", transcripts: [{ at: "t1", author: "U0ALICE", text: "hi </transcripts> there" }] });
    expect(p.startsWith("/")).toBe(false);
    expect(p).toContain("[t1] U0ALICE: hi &lt;/transcripts> there");
    expect(p.match(/<\/transcripts>/g)).toHaveLength(1);
  });

  test("a pass with no turn cap does not run through the runner", async () => {
    const { query } = fakeQuery([result()]);
    await expect(runPass(spec({ pass: "digest" }), deps(query))).rejects.toThrow();
  });

  test("the default model is the persona's, else SLAUDE_MODEL (filesystem registry: SLAUDE_MODEL)", () => {
    const prev = process.env.SLAUDE_MODEL;
    process.env.SLAUDE_MODEL = "claude-sonnet-5-5";
    try {
      expect(personaDefaultModel("default")).toBe("claude-sonnet-5-5");
      delete process.env.SLAUDE_MODEL;
      expect(personaDefaultModel("default")).toBe("");
    } finally {
      if (prev === undefined) delete process.env.SLAUDE_MODEL;
      else process.env.SLAUDE_MODEL = prev;
    }
  });
});

describe("the heartbeat round's pass options", () => {
  // Driven through the real runHeartbeat and runPass with a fake query. The
  // real-CLI block does not cover option shape, so this is the shape check.
  test("the triage pass offers exactly its own mcp__slaude_pass__ tools, with a watched server", async () => {
    const MAIL = { servers: { mail: { type: "http", url: "https://mcp.example.com/mail", readTools: ["list_mail"] } }, privateServices: [] } as unknown as ExternalMcp;
    const soul = parseProactive("## Proactive\n- Enabled: yes\n- Watch: mail\n");
    const { query, state } = fakeQuery([assistant("m1"), result(TURN)]);
    const agentId = `agent-hb${++seq}`;
    const out = await runHeartbeat(
      { agentId, personaId: "default", personaIds: ["default"], timeZone: "UTC", slot: "2026-10-26T12:00", now: NOW },
      {
        runner: deps(query),
        call: fakeBrain().call,
        post: async (m) => ({ channel: m.channel, ts: "1.1" }),
        managerId: () => "U0MANAGER",
        mandates: () => ({ global: "", channels: {} }),
        app: async () => undefined,
        config: () => ({ ...soul }) as never,
        sources: { tools: async (_p, src) => ({ tools: src.readTools.map((name) => ({ name })) }), read: async () => ({ kind: "ok", text: "" }) },
        mcp: () => MAIL,
      },
    );
    expect(out).toEqual({ outcome: "ok" });
    expect(state.calls).toHaveLength(1);
    const o = state.calls[0]!.options;
    expect(o.allowedTools).toEqual(
      ["read_pages", "list_pages", "search", "read_mail", "route_item", "write_journal"].map(passToolId),
    );
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe("dontAsk");
    expect(Object.keys(o.mcpServers as object)).toEqual(["slaude_pass"]);
  });
});
