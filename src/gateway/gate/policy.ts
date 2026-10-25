import type { Answer, GateAction, GateDecision, GateInput } from "./types";

const sure = (a: Answer, t: number) => a.value && a.confidence >= t;

/**
 * Policy table. A mention takes the mention rows even when the thread is engaged.
 * - mentioned: addressed yes >= T -> run; otherwise record_doubt
 * - engaged, unmentioned: question/request yes >= T, can-help yes >= T and not
 *   (already-answered yes >= T) -> run; otherwise record
 */
export function decideAction(input: GateInput, d: GateDecision, tAct: number): GateAction {
  if (input.mentionsAgent) return sure(d.addressedToAgent, tAct) ? "run" : "record_doubt";
  if (input.engaged && sure(d.isQuestionOrRequest, tAct) && sure(d.agentCanHelp, tAct) && !sure(d.alreadyAnswered, tAct)) {
    return "run";
  }
  return "record";
}

/** Today's behaviour as a decision: a mention is addressed, everything else is an open request. */
export function rulesDecision(input: GateInput): GateDecision {
  const yes: Answer = { value: true, confidence: 1 };
  return {
    addressedToAgent: { value: input.mentionsAgent, confidence: 1 },
    isQuestionOrRequest: yes,
    agentCanHelp: yes,
    alreadyAnswered: { value: false, confidence: 1 },
  };
}
