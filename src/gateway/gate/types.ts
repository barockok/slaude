export type Trust = "trusted" | "allowed" | "restricted";

export interface GateInput {
  message: string;
  recent: { role: "agent" | "user"; text: string }[];
  mentionsAgent: boolean;
  engaged: boolean;
  /** Top knowledge-base match score, 0 to 1, or null when unknown. */
  kbHitScore: number | null;
  channelTrust: Trust;
  /**
   * The message follows the agent's own message (a follower of an agent post),
   * as opposed to a fresh message. Only read with `implicit`.
   */
  continuation?: boolean;
  /**
   * Set when this is an implicit-engagement consult: the message does not
   * mention the agent and the channel's engage level asks whether it deserves a
   * turn anyway. Such a consult never falls back to the rules decision, and its
   * actions are only "run" or "drop".
   */
  implicit?: ImplicitLevel;
}

/** The engage levels that consult the gate; `mention` never does. */
export type ImplicitLevel = "addressed" | "contribute";

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

/**
 * "drop" is the implicit pass: nothing is created (no row, no reaction, no
 * status). The mention paths never produce it.
 */
export type GateAction = "run" | "record" | "record_doubt" | "drop";
