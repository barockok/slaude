import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Runs from "../../src/db/background-runs";
import { TOOLS_SURVIVING_EMPTY_SET } from "../../src/agent/child-env";
import { metrics } from "../../src/metrics";
import { passPrompt, runPass, type PassSpec, type RunnerDeps } from "../../src/background/runner";
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

  test("ok run: one API call split over several messages is priced once; the result total never lowers it", async () => {
    const s = spec();
    const { query } = fakeQuery([assistant("m1"), assistant("m1"), assistant("m2"), result({ input_tokens: 500_000 })]);
    const r = await runPass(s, deps(query, 5));
    expect(r.outcome).toBe("ok");
    expect(r.costUsd).toBeCloseTo(0.6);
    expect((await rowOf(s.agentId, r.runId)).outcome).toBe("ok");
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
