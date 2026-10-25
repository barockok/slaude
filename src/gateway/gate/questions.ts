import type { DecisionQuestion, DecisionResult } from "../../decision/types";
import type { GateDecision } from "./types";

export const GATE_QUESTIONS: Record<keyof GateDecision, DecisionQuestion> = {
  addressedToAgent: {
    instructions:
      "The state holds a new chat message and the recent thread. `<agent>` is an AI teammate. Decide whether the new message is said TO `<agent>` (asking, telling or replying to it), as opposed to only mentioning or talking ABOUT `<agent>` to other people.",
    options: { yes: "spoken to <agent>", no: "about <agent>, or to someone else" },
  },
  isQuestionOrRequest: {
    instructions: "Decide whether the new message asks a question or requests that something be done.",
    options: { yes: "a question or a request", no: "a statement, reaction, thanks or chit-chat" },
  },
  agentCanHelp: {
    instructions:
      "Decide whether an AI teammate with access to the team's knowledge base could usefully answer or act on the new message. `kbHitScore` is the top knowledge-base match score from 0 to 1, or null when unknown.",
    options: { yes: "the teammate could add something useful", no: "nothing useful to add" },
  },
  alreadyAnswered: {
    instructions: "Decide whether someone in the recent thread has already answered or handled the new message.",
    options: { yes: "already answered or handled", no: "still open" },
  },
};

export function toGateDecision(r: DecisionResult): GateDecision {
  const pick = (id: keyof GateDecision) => ({ value: r[id]!.choice === "yes", confidence: r[id]!.confidence });
  return {
    addressedToAgent: pick("addressedToAgent"),
    isQuestionOrRequest: pick("isQuestionOrRequest"),
    agentCanHelp: pick("agentCanHelp"),
    alreadyAnswered: pick("alreadyAnswered"),
  };
}
