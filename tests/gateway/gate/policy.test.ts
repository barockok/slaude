import { describe, expect, it } from "bun:test";
import { decideAction, rulesDecision } from "../../../src/gateway/gate/policy";
import { GATE_QUESTIONS, toGateDecision } from "../../../src/gateway/gate/questions";
import type { GateDecision, GateInput } from "../../../src/gateway/gate/types";

const yes = { value: true, confidence: 1 };
const no = { value: false, confidence: 1 };
const base: GateInput = { message: "m", recent: [], mentionsAgent: false, engaged: false, kbHitScore: null, channelTrust: "allowed" };
const allNo: GateDecision = { addressedToAgent: no, isQuestionOrRequest: no, agentCanHelp: no, alreadyAnswered: no };

describe("decideAction", () => {
  it("mention addressed with confidence ≥ tAct runs", () =>
    expect(decideAction({ ...base, mentionsAgent: true }, { ...allNo, addressedToAgent: { value: true, confidence: 0.8 } }, 0.8)).toBe("run"));
  it("mention addressed below tAct is doubt", () =>
    expect(decideAction({ ...base, mentionsAgent: true }, { ...allNo, addressedToAgent: { value: true, confidence: 0.79 } }, 0.8)).toBe("record_doubt"));
  it("mention judged not-addressed is doubt", () => expect(decideAction({ ...base, mentionsAgent: true }, allNo, 0.8)).toBe("record_doubt"));
  it("a mention takes the mention rows even when engaged", () =>
    expect(decideAction({ ...base, mentionsAgent: true, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes }, 0.8)).toBe("record_doubt"));
  it("engaged question the agent can help with, unanswered, runs", () =>
    expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes }, 0.8)).toBe("run"));
  it("engaged but already answered records", () =>
    expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes, alreadyAnswered: yes }, 0.8)).toBe("record"));
  it("a weak already-answered (below tAct) does not block", () =>
    expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: yes, agentCanHelp: yes, alreadyAnswered: { value: true, confidence: 0.5 } }, 0.8)).toBe("run"));
  it("engaged low-confidence request records", () =>
    expect(decideAction({ ...base, engaged: true }, { ...allNo, isQuestionOrRequest: { value: true, confidence: 0.5 }, agentCanHelp: yes }, 0.8)).toBe("record"));
  it("engaged chit-chat records", () => expect(decideAction({ ...base, engaged: true }, allNo, 0.8)).toBe("record"));
  it("rulesDecision + policy reproduce today: mention runs, engaged runs", () => {
    expect(decideAction({ ...base, mentionsAgent: true }, rulesDecision({ ...base, mentionsAgent: true }), 0.8)).toBe("run");
    expect(decideAction({ ...base, engaged: true }, rulesDecision({ ...base, engaged: true }), 0.8)).toBe("run");
  });
});

describe("questions", () => {
  it("GATE_QUESTIONS are yes/no and toGateDecision maps them", () => {
    for (const q of Object.values(GATE_QUESTIONS)) expect(Object.keys(q.options)).toEqual(["yes", "no"]);
    expect(Object.keys(GATE_QUESTIONS).sort()).toEqual(["addressedToAgent", "agentCanHelp", "alreadyAnswered", "isQuestionOrRequest"]);
    const d = toGateDecision({
      addressedToAgent: { choice: "yes", confidence: 0.9 },
      isQuestionOrRequest: { choice: "no", confidence: 0.6 },
      agentCanHelp: { choice: "yes", confidence: 0.7 },
      alreadyAnswered: { choice: "no", confidence: 0.8 },
    });
    expect(d.addressedToAgent).toEqual({ value: true, confidence: 0.9 });
    expect(d.isQuestionOrRequest).toEqual({ value: false, confidence: 0.6 });
  });
});
