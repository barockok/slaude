import { describe, expect, it } from "bun:test";
import { DecisionError, type DecisionAdapter, type DecisionResult } from "../../../src/decision/types";
import { formatEngageLine, toEngageAction } from "../../../src/gateway/gate/log";
import { decideAction } from "../../../src/gateway/gate/policy";
import { gateKey, makeGateRunner } from "../../../src/gateway/gate/runner";
import type { GateDecision, GateInput } from "../../../src/gateway/gate/types";

const base: GateInput = { message: "m", recent: [], mentionsAgent: false, engaged: false, kbHitScore: null, channelTrust: "allowed" };
const yes = { value: true, confidence: 0.95 };
const no = { value: false, confidence: 0.95 };
const dec = (a: boolean, q: boolean, h: boolean, d: boolean): GateDecision => ({
  addressedToAgent: a ? yes : no,
  isQuestionOrRequest: q ? yes : no,
  agentCanHelp: h ? yes : no,
  alreadyAnswered: d ? yes : no,
});

describe("decideAction implicit rows", () => {
  const T = 0.8;
  const rows: [string, Partial<GateInput>, GateDecision, string][] = [
    ["addressed, said to the agent", { implicit: "addressed" }, dec(true, false, false, false), "run"],
    ["addressed, not said to the agent", { implicit: "addressed" }, dec(false, true, true, false), "drop"],
    ["contribute, open request", { implicit: "contribute" }, dec(false, true, true, false), "run"],
    ["contribute, already answered", { implicit: "contribute" }, dec(false, true, true, true), "drop"],
    ["contribute, cannot help", { implicit: "contribute" }, dec(false, true, false, false), "drop"],
    ["contribute, said to the agent", { implicit: "contribute" }, dec(true, false, false, false), "run"],
    ["contribute continuation ignores open-request rows", { implicit: "contribute", continuation: true }, dec(false, true, true, false), "drop"],
    ["continuation, said to the agent", { implicit: "addressed", continuation: true }, dec(true, false, false, false), "run"],
    ["engaged flag is ignored", { implicit: "addressed", engaged: true }, dec(false, true, true, false), "drop"],
    ["a mention flag does not take the mention rows", { implicit: "addressed", mentionsAgent: true }, dec(false, false, false, false), "drop"],
  ];
  for (const [name, over, d, want] of rows) it(name, () => expect(decideAction({ ...base, ...over }, d, T)).toBe(want as any));

  it("low confidence is a drop", () => {
    const d = { ...dec(true, true, true, false), addressedToAgent: { value: true, confidence: 0.5 } };
    expect(decideAction({ ...base, implicit: "addressed" }, d, T)).toBe("drop");
  });
  it("non-implicit rows are unchanged", () => {
    expect(decideAction({ ...base, mentionsAgent: true }, dec(false, false, false, false), T)).toBe("record_doubt");
    expect(decideAction({ ...base, engaged: true }, dec(false, true, true, false), T)).toBe("run");
    expect(decideAction(base, dec(true, true, true, false), T)).toBe("record");
  });
});

const ans = (a: string, q: string, h: string, d: string): DecisionResult => ({
  addressedToAgent: { choice: a, confidence: 0.95 },
  isQuestionOrRequest: { choice: q, confidence: 0.95 },
  agentCanHelp: { choice: h, confidence: 0.95 },
  alreadyAnswered: { choice: d, confidence: 0.95 },
});
const OPEN = ans("no", "yes", "yes", "no");
const lines: string[] = [];
const opts = { tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: (l: string) => lines.push(l) };
const scripted = (r: DecisionResult | "throw" | "hang"): DecisionAdapter & { calls: number } => {
  const a = {
    name: "scripted",
    calls: 0,
    decide: () => {
      a.calls++;
      if (r === "throw") return Promise.reject(new DecisionError("transport", "down"));
      if (r === "hang") return new Promise<DecisionResult>(() => {});
      return Promise.resolve(r);
    },
  };
  return a;
};
const contribute: GateInput = { ...base, implicit: "contribute", continuation: false };

describe("implicit consult through the runner", () => {
  it("off: undefined, no adapter call", async () => {
    const a = scripted(OPEN);
    const r = makeGateRunner({ ...opts, mode: "off", adapter: a });
    expect(await r.consult("k1", async () => contribute, "drop")).toBeUndefined();
    expect(a.calls).toBe(0);
  });
  it("shadow: returns actual with source shadow, logs the decision", async () => {
    const a = scripted(OPEN);
    const r = makeGateRunner({ ...opts, mode: "shadow", adapter: a });
    expect(await r.consult("k2", async () => contribute, "drop")).toEqual({ action: "drop", source: "shadow" });
    await new Promise((res) => setTimeout(res, 30));
    expect(lines.some((l) => l.includes("implicit=contribute") && l.includes("action=run") && l.includes("actual=drop"))).toBe(true);
  });
  it("on: the policy action with source adapter", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted(OPEN) });
    expect(await r.consult("k3", async () => contribute, "drop")).toEqual({ action: "run", source: "adapter" });
    expect(await r.consult("k3b", async () => ({ ...contribute, implicit: "addressed" }), "drop")).toEqual({ action: "drop", source: "adapter" });
  });
  it("on, input builder throws: undefined (a pass for implicit)", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted(OPEN) });
    expect(await r.consult("k4", async () => { throw new Error("x"); }, "drop")).toBeUndefined();
  });
  it("contribute, adapter throws, mode on: pass, never the rules run", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted("throw") });
    const c = await r.consult("k5", async () => contribute, "drop");
    expect(c).toEqual({ action: "drop", source: "rules" });
    expect(toEngageAction(c?.action)).toBe("pass");
  });
  it("contribute, adapter times out, mode on: pass", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted("hang") });
    expect((await r.consult("k6", async () => contribute, "drop"))?.action).toBe("drop");
  });
  it("contribute, no adapter, mode on: pass", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: null });
    expect(await r.consult("k7", async () => contribute, "drop")).toEqual({ action: "drop", source: "rules" });
  });
  it("a mention with the adapter down still falls back to the rules (unchanged)", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted("throw") });
    expect(await r.gate("k8", async () => ({ ...base, mentionsAgent: true }), "run")).toBe("run");
  });
});

describe("keys and lines", () => {
  it("the memo key separates persona, app, continuation and implicit", () => {
    const o = { channel: "C1", ts: "1.0" };
    const keys = [gateKey(o), gateKey({ ...o, persona: "a" }), gateKey({ ...o, app: "A1" }), gateKey({ ...o, continuation: true }), gateKey({ ...o, implicit: "addressed" })];
    expect(new Set(keys).size).toBe(5);
  });
  it("two personas do not share a memoised decision", async () => {
    const a = scripted(OPEN);
    const r = makeGateRunner({ ...opts, mode: "on", adapter: a });
    await r.consult(gateKey({ channel: "C", ts: "1", persona: "a", implicit: "contribute" }), async () => contribute, "drop");
    await r.consult(gateKey({ channel: "C", ts: "1", persona: "b", implicit: "contribute" }), async () => contribute, "drop");
    expect(a.calls).toBe(2);
  });
  it("formats the engage line", () => {
    expect(formatEngageLine({ key: "C:1", level: "addressed", tier: 2, action: "run", actual: "drop" })).toBe(
      "[gate] key=C:1 implicit=addressed tier=2 action=run actual=pass",
    );
  });
});
