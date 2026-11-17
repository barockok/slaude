import type { GateInput, ImplicitLevel } from "../gate/types";

/**
 * One message the deterministic tiers could not settle. `input` builds the
 * classifier's view of it (and is only called when a classifier is asked, so
 * a message that never reaches tier 3 costs nothing).
 */
export interface EngageCandidate {
  /** Where the message is; the classifier derives the decision memo key from these and the flags below, never from a caller's key. */
  channel: string;
  ts: string;
  persona?: string;
  app?: string;
  level: ImplicitLevel;
  /** The channel's engage mode: shadow decides and logs but always answers pass; on acts on the answer. */
  mode: "shadow" | "on";
  /** The message follows the agent's own message. */
  continuation: boolean;
  input: () => Promise<GateInput>;
}

/**
 * The seam between engagement and whatever answers the tier 3 question. The
 * deterministic tiers never depend on it, so engagement works with no
 * classifier at all (tiers 0 to 2 act, tier 3 is a pass). The channel's mode is
 * applied here, not by the gate: it does not depend on the deployment's gate mode. Any implementation
 * must answer "pass" for anything but a confident yes: an error, a timeout,
 * an exhausted budget and a missing adapter are all "pass", never "run".
 */
export interface EngageClassifier {
  classify(candidate: EngageCandidate): Promise<"run" | "pass">;
  /**
   * The model's own verdict and why there is none, with the channel's mode NOT
   * applied: for shadow logging and counters, never for acting.
   * `answer` is "run" only on a confident model yes.
   */
  classifyDetailed?(candidate: EngageCandidate): Promise<ClassifierVerdict>;
}

export interface ClassifierVerdict {
  answer: "run" | "pass";
  /** `answer`: a model answered. The others: no model answer (a pass). */
  reason: "answer" | "timeout" | "error" | "noadapter" | "input";
}
