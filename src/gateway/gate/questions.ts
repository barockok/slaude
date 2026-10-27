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
      // Live Jev run: framed as "an AI teammate with access to the team's knowledge
      // base", a low kbHitScore read as "cannot help" (0.40 on a plain git question
      // at score 0.05), so a young KB never chimed in. Rephrased, the same message
      // scored 1.0 while thanks, chit-chat and asks to someone else stayed "no".
      "Decide whether an AI teammate could usefully answer or act on the new message. The teammate is a capable general assistant that can also search the team's knowledge base. `kbHitScore` is the top knowledge-base match score from 0 to 1, or null when unknown; a low score means only that the team's docs do not cover it, not that the teammate cannot help.",
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
