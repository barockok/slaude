import { afterAll, describe, expect, test } from "bun:test";
import "../../../src/decision/adapters/index";
import { adapterFromConfig, registerAdapter } from "../../../src/decision/registry";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "../../../src/decision/types";
import { gateClassifier } from "../../../src/gateway/engage/gate-classifier";
import type { EngageCandidate } from "../../../src/gateway/engage/types";
import { gateKey, makeGateRunner, type GateMode } from "../../../src/gateway/gate/runner";
import type { GateInput } from "../../../src/gateway/gate/types";

const input: GateInput = { message: "m", recent: [], mentionsAgent: false, engaged: false, kbHitScore: null, channelTrust: "allowed" };
const answers = (a: string, q: string, h: string, d: string, c = 0.95): DecisionResult => ({
  addressedToAgent: { choice: a, confidence: c },
  isQuestionOrRequest: { choice: q, confidence: c },
  agentCanHelp: { choice: h, confidence: c },
  alreadyAnswered: { choice: d, confidence: c },
});

/** A scripted double, registered under a test-only type name. */
type Script = (req: DecisionRequest) => DecisionResult | Promise<DecisionResult>;
const scripts = new Map<string, Script>();
registerAdapter("scripted-test", async (block) => {
  const id = String(block.script);
  const adapter: DecisionAdapter = { name: "scripted-test", decide: async (req) => Object.fromEntries(Object.entries(await scripts.get(id)!(req)).filter(([k]) => k in req.questions)) };
  return adapter;
});
afterAll(() => scripts.clear());

let calls = 0;
async function runnerFor(script: Script, mode: GateMode = "on") {
  const id = `s${scripts.size}`;
  scripts.set(id, (r) => (calls++, script(r)));
  const adapter = await adapterFromConfig({ type: "scripted-test", script: id }, { resolveSecret: async () => "" });
  expect(adapter).not.toBeNull();
  return makeGateRunner({ mode, adapter, tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: () => {} });
}
const classifierFor = async (script: Script, mode: GateMode = "on") => gateClassifier(await runnerFor(script, mode));

let n = 0;
const cand = (level: EngageCandidate["level"], continuation = false, mode: "shadow" | "on" = "on"): EngageCandidate => ({
  channel: "C0EXAMPLE",
  ts: `${++n}.0`,
  level,
  mode,
  continuation,
  input: async () => input,
});

describe("tier 3 outcomes are the same across adapters", () => {
  const confidentYes = () => answers("yes", "yes", "yes", "no");
  const confidentNo = () => answers("no", "no", "no", "no");
  const down = () => {
    throw new DecisionError("transport", "down");
  };

  test("a confident adapter: run on a yes, pass on a no", async () => {
    const c = await classifierFor(confidentYes);
    expect(await c.classify(cand("addressed"))).toBe("run");
    expect(await c.classify(cand("contribute"))).toBe("run");
    expect(await c.classify(cand("addressed", true))).toBe("run");
    const no = await classifierFor(confidentNo);
    expect(await no.classify(cand("addressed"))).toBe("pass");
    expect(await no.classify(cand("contribute"))).toBe("pass");
  });

  test("an erroring adapter: pass at every level, never run", async () => {
    const c = await classifierFor(down);
    for (const level of ["addressed", "contribute"] as const) {
      expect(await c.classify(cand(level))).toBe("pass");
      expect(await c.classify(cand(level, true))).toBe("pass");
    }
  });

  test("a hanging adapter is a pass", async () => {
    const c = await classifierFor(() => new Promise<DecisionResult>(() => {}));
    expect(await c.classify(cand("contribute"))).toBe("pass");
  });

  test("a malformed answer is a pass", async () => {
    const c = await classifierFor(() => ({ addressedToAgent: { choice: "maybe", confidence: 1 } }) as unknown as DecisionResult);
    expect(await c.classify(cand("addressed"))).toBe("pass");
  });

  test("the channel's mode, not the deployment gate mode, decides whether the answer acts", async () => {
    // Gate off and gate shadow, adapter configured: channel on runs, channel shadow passes but the adapter is called.
    for (const gate of ["off", "shadow", "on"] as const) {
      const c = await classifierFor(confidentYes, gate);
      calls = 0;
      expect(await c.classify(cand("addressed", false, "on"))).toBe("run");
      expect(calls).toBe(1);
      expect(await c.classify(cand("addressed", false, "shadow"))).toBe("pass");
      expect(calls).toBe(2);
    }
  });

  test("gate off and no adapter: pass; so is a throwing input builder", async () => {
    const none = gateClassifier(makeGateRunner({ mode: "off", adapter: null, tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: () => {} }));
    expect(await none.classify(cand("contribute"))).toBe("pass");
    const on = await classifierFor(confidentYes);
    expect(await on.classify({ ...cand("addressed"), input: async () => { throw new Error("x"); } })).toBe("pass");
  });

  test("the input the model sees is implicit and not engaged", async () => {
    const seen: GateInput[] = [];
    const c = await classifierFor((req) => (seen.push(req.state as GateInput), confidentYes()));
    await c.classify({ ...cand("contribute", true), input: async () => ({ ...input, engaged: true, mentionsAgent: true }) });
    expect(seen[0]).toMatchObject({ engaged: false, implicit: "contribute", continuation: true });
  });

  test("a stale memo entry made by a mention is never an implicit answer", async () => {
    const runner = await runnerFor(confidentYes);
    const c = gateClassifier(runner);
    const cd = cand("addressed");
    // The same key as the classifier derives, filled earlier by a non-implicit consult that said run.
    const key = gateKey({ channel: cd.channel, ts: cd.ts, continuation: false, implicit: "addressed" });
    await runner.consult(key, async () => ({ ...input, mentionsAgent: true }), "run");
    calls = 0;
    // The model now says no: the stored mention decision must not be returned.
    scripts.set([...scripts.keys()].at(-1)!, (r) => (calls++, confidentNo()));
    expect(await c.classify(cd)).toBe("pass");
    expect(calls).toBe(1);
  });

  test("a continuation entry is not reused for a fresh message", async () => {
    const runner = await runnerFor(confidentYes);
    const key = gateKey({ channel: "C0EXAMPLE", ts: "900.0", persona: "p", implicit: "addressed" });
    const mk = (continuation: boolean) => async () => ({ ...input, implicit: "addressed" as const, continuation });
    await runner.consultImplicit(key, mk(true), { level: "addressed", continuation: true });
    calls = 0;
    await runner.consultImplicit(key, mk(false), { level: "addressed", continuation: false });
    expect(calls).toBe(1);
  });
});
