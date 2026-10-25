export type Trust = "trusted" | "allowed" | "restricted";

export interface GateInput {
  message: string;
  recent: { role: "agent" | "user"; text: string }[];
  mentionsAgent: boolean;
  engaged: boolean;
  /** Top knowledge-base match score, 0 to 1, or null when unknown. */
  kbHitScore: number | null;
  channelTrust: Trust;
}

export interface Answer {
  value: boolean;
  confidence: number;
}

export interface GateDecision {
  addressedToAgent: Answer;
  isQuestionOrRequest: Answer;
  agentCanHelp: Answer;
  alreadyAnswered: Answer;
}

export type GateAction = "run" | "record" | "record_doubt";
