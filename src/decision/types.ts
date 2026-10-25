/** Provider-neutral decision core types. Knows nothing about Slack or any provider. */

export interface DecisionQuestion {
  instructions: string;
  /** option id → description; at least two options. */
  options: Record<string, string>;
}

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionAnswer {
  /** One of the question's option ids. */
  choice: string;
  /** 0 ≤ confidence ≤ 1. */
  confidence: number;
}

/** Exactly the request's question ids. */
export type DecisionResult = Record<string, DecisionAnswer>;

export interface DecisionAdapter {
  readonly name: string;
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}

export type DecisionErrorKind =
  | "auth"
  | "invalid_request"
  | "rate_limited"
  | "overloaded"
  | "transport"
  | "timeout"
  | "bad_output";

export class DecisionError extends Error {
  constructor(
    readonly kind: DecisionErrorKind,
    msg: string,
  ) {
    super(msg);
    this.name = "DecisionError";
  }
}
