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
  const adapter: DecisionAdapter = { name: "scripted-test", decide: async (req) => scripts.get(id)!(req) };
  return adapter;
});
afterAll(() => scripts.clear());

async function classifierFor(script: Script, mode: GateMode = "on") {
  const id = `s${scripts.size}`;
  scripts.set(id, script);
  const adapter = await adapterFromConfig({ type: "scripted-test", script: id }, { resolveSecret: async () => "" });
  expect(adapter).not.toBeNull();
  return gateClassifier(makeGateRunner({ mode, adapter, tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: () => {} }));
}

let n = 0;
const cand = (level: EngageCandidate["level"], continuation = false): EngageCandidate => ({
  key: gateKey({ channel: "C0EXAMPLE", ts: `${++n}.0`, implicit: level, continuation }),
  level,
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

  test("shadow mode never runs; no adapter never runs; a throwing input builder is a pass", async () => {
    const shadow = await classifierFor(confidentYes, "shadow");
    expect(await shadow.classify(cand("addressed"))).toBe("pass");
    const none = gateClassifier(makeGateRunner({ mode: "on", adapter: null, tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: () => {} }));
    expect(await none.classify(cand("contribute"))).toBe("pass");
    const on = await classifierFor(confidentYes);
    expect(await on.classify({ ...cand("addressed"), input: async () => { throw new Error("x"); } })).toBe("pass");
  });
});
