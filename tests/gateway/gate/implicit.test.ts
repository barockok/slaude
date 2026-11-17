import { beforeEach, describe, expect, it } from "bun:test";
import { metrics } from "../../../src/metrics";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "../../../src/decision/types";
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
    decide: (req: DecisionRequest) => {
      a.calls++;
      if (r === "throw") return Promise.reject(new DecisionError("transport", "down"));
      if (r === "hang") return new Promise<DecisionResult>(() => {});
      return Promise.resolve(Object.fromEntries(Object.entries(r).filter(([k]) => k in req.questions)));
    },
  };
  return a;
};
const contribute: GateInput = { ...base, implicit: "contribute", continuation: false };

const W = { level: "contribute" as const, continuation: false };

describe("implicit consult through the runner", () => {
  beforeEach(() => {
    lines.length = 0;
  });
  // The deployment gate mode does not matter to an implicit consult: the adapter answers in all three.
  for (const mode of ["off", "shadow", "on"] as const) {
    it(`gate ${mode}: the adapter's answer is returned, awaited`, async () => {
      const a = scripted(OPEN);
      const r = makeGateRunner({ ...opts, mode, adapter: a });
      expect(await r.consultImplicit(`k1${mode}`, async () => contribute, W)).toEqual({ action: "run", source: "adapter" });
      expect(await r.consultImplicit(`k2${mode}`, async () => ({ ...contribute, implicit: "addressed" }), { level: "addressed", continuation: false })).toMatchObject({ action: "drop", source: "adapter" });
      expect(a.calls).toBe(2);
    });
    it(`gate ${mode}: contribute, adapter throws: pass, never the rules run, no rules answers in the log`, async () => {
      const r = makeGateRunner({ ...opts, mode, adapter: scripted("throw") });
      const c = await r.consultImplicit(`k3${mode}`, async () => contribute, W);
      expect(c).toMatchObject({ action: "drop", source: "rules" });
      expect(toEngageAction(c?.action)).toBe("pass");
      expect(lines.at(-1)).toContain("source=rules");
      expect(lines.at(-1)).toContain("a=- q=- h=- d=-");
    });
  }
  it("at addressed (and on a continuation) the adapter is asked one question, at contribute four", async () => {
    const asked: string[][] = [];
    const a: DecisionAdapter = { name: "spy", decide: async (req) => { asked.push(Object.keys(req.questions)); return Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice: "no", confidence: 0.9 }])); } };
    const r = makeGateRunner({ ...opts, mode: "off", adapter: a });
    await r.consultImplicit("q1", async () => ({ ...contribute, implicit: "addressed" }), { level: "addressed", continuation: false });
    await r.consultImplicit("q2", async () => ({ ...contribute, continuation: true }), { level: "contribute", continuation: true });
    await r.consultImplicit("q3", async () => contribute, W);
    expect(asked.map((q) => q.length)).toEqual([1, 1, 4]);
    expect(asked[0]).toEqual(["addressedToAgent"]);
  });
  it("a quiet (shadow) consult counts no gate decision and prints no gate line, but still answers", async () => {
    const decisions = () => metrics.render().split("\n").filter((l) => l.startsWith("slaude_gate_decisions_total{")).reduce((n, l) => n + Number(l.split(" ").at(-1)), 0);
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted(OPEN) });
    const before = decisions();
    lines.length = 0;
    expect(await r.consultImplicit("qq1", async () => contribute, { ...W, quiet: true })).toEqual({ action: "run", source: "adapter" });
    expect(decisions()).toBe(before);
    expect(lines).toEqual([]);
    await r.consultImplicit("qq2", async () => contribute, W);
    expect(decisions()).toBe(before + 1);
    expect(lines).toHaveLength(1);
  });
  it("says why no model answered", async () => {
    const none = makeGateRunner({ ...opts, mode: "off", adapter: null });
    expect(none.hasAdapter).toBe(false);
    expect(await none.consultImplicit("w1", async () => contribute, W)).toMatchObject({ source: "rules", why: "noadapter" });
    const t = makeGateRunner({ ...opts, mode: "off", adapter: scripted("hang"), timeoutMs: 30 });
    expect(await t.consultImplicit("w2", async () => contribute, W)).toMatchObject({ source: "rules", why: "timeout" });
    const e = makeGateRunner({ ...opts, mode: "off", adapter: scripted("throw") });
    expect(await e.consultImplicit("w3", async () => contribute, W)).toMatchObject({ source: "rules", why: "error" });
  });
  it("a logged model answer carries its answers", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted(OPEN) });
    await r.consultImplicit("k4", async () => contribute, W);
    expect(lines.at(-1)).toMatch(/implicit=contribute .*a=no:0\.95 q=yes:0\.95/);
  });
  it("input failure is undefined (a pass)", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted(OPEN) });
    expect(await r.consultImplicit("k5", async () => { throw new Error("x"); }, W)).toBeUndefined();
  });
  it("adapter times out: pass", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted("hang") });
    expect((await r.consultImplicit("k6", async () => contribute, W))?.action).toBe("drop");
  });
  it("no adapter: pass", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: null });
    expect(await r.consultImplicit("k7", async () => contribute, W)).toMatchObject({ action: "drop", source: "rules" });
  });
  it("the mention paths still honor the deployment mode", async () => {
    const a = scripted(OPEN);
    const off = makeGateRunner({ ...opts, mode: "off", adapter: a });
    expect(await off.consult("k8", async () => ({ ...base, mentionsAgent: true }), "run")).toBeUndefined();
    expect(a.calls).toBe(0);
    const shadow = makeGateRunner({ ...opts, mode: "shadow", adapter: a });
    expect(await shadow.consult("k9", async () => ({ ...base, mentionsAgent: true }), "run")).toEqual({ action: "run", source: "shadow" });
  });
  it("a mention with the adapter down still falls back to the rules (unchanged)", async () => {
    const r = makeGateRunner({ ...opts, mode: "on", adapter: scripted("throw") });
    expect(await r.gate("k10", async () => ({ ...base, mentionsAgent: true }), "run")).toBe("run");
    expect(await r.consult("k11", async () => ({ ...base, mentionsAgent: true }), "run")).toEqual({ action: "run", source: "rules" });
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
    await r.consultImplicit(gateKey({ channel: "C", ts: "1", persona: "a", implicit: "contribute" }), async () => contribute, W);
    await r.consultImplicit(gateKey({ channel: "C", ts: "1", persona: "b", implicit: "contribute" }), async () => contribute, W);
    expect(a.calls).toBe(2);
  });
  it("formats the engage line", () => {
    expect(formatEngageLine({ key: "C:1", level: "addressed", tier: 2, action: "run", actual: "drop" })).toBe(
      "[gate] key=C:1 implicit=addressed tier=2 action=run actual=pass",
    );
  });
});
