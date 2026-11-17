import type { Answer, GateAction, GateDecision, GateInput } from "./types";

const sure = (a: Answer, t: number) => a.value && a.confidence >= t;

/**
 * Policy table. Implicit consults (no mention, the channel opted in) are
 * decided first and only ever return "run" or "drop":
 * - implicit addressed, or any continuation: addressed yes >= T -> run
 * - implicit contribute: addressed yes >= T, or (question/request yes >= T,
 *   can-help yes >= T and not already-answered yes >= T) -> run
 * - anything else: drop
 * These rows ignore `engaged` (an implicit message has no engaged thread to
 * lean on) and never read `mentionsAgent`.
 *
 * Mention and engaged rows: A mention takes the mention rows even when the thread is engaged.
 * - mentioned: addressed yes >= T -> run; otherwise record_doubt
 * - engaged, unmentioned: question/request yes >= T, can-help yes >= T and not
 *   (already-answered yes >= T) -> run; otherwise record
 */
export function decideAction(input: GateInput, d: GateDecision, tAct: number): GateAction {
  if (input.implicit) {
    if (sure(d.addressedToAgent, tAct)) return "run";
    if (input.implicit === "contribute" && !input.continuation) {
      const open = sure(d.isQuestionOrRequest, tAct) && sure(d.agentCanHelp, tAct) && !sure(d.alreadyAnswered, tAct);
      return open ? "run" : "drop";
    }
    return "drop";
  }
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
