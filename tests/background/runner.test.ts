import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { TOOLS_SURVIVING_EMPTY_SET } from "../../src/agent/child-env";
import { metrics } from "../../src/metrics";
import { passPrompt, PROVISIONAL_OUTPUT_TOKENS, runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
import { passToolId } from "../../src/background/pass-tools";
import type { PriceTable } from "../../src/background/prices";
import { fakeBrain } from "./fake-brain";
import { personaDefaultModel } from "../../src/persona/registry";

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
const assistant = (id: string, usage = TURN): Msg => ({ type: "assistant", parent_tool_use_id: null, message: { id, usage, content: [] } });
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

  test("unknown model: error, cost 0, query never called, one line naming the model", async () => {
    const s = spec();
    const { query, state } = fakeQuery([assistant("m1"), result()]);
    const r = await runPass(s, deps(query, 1, "mystery-model-9"));
    expect(r).toMatchObject({ outcome: "error", costUsd: 0 });
    expect(state.calls).toHaveLength(0);
    const row = await rowOf(s.agentId, r.runId);
    expect(row).toMatchObject({ outcome: "error", costUsd: 0, model: "mystery-model-9" });
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'mystery-model-9'");
    expect(lines[0]).toContain("SLAUDE_PRICE_TABLE");
  });

  test("no model configured: error, query never called", async () => {
    const { query, state } = fakeQuery([result()]);
    expect((await runPass(spec(), deps(query, 1, ""))).outcome).toBe("error");
    expect(state.calls).toHaveLength(0);
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
