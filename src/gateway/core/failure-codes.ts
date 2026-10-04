/**
 * Typed turn/job failure codes (spec WS-D D1.6).
 *
 * Failure text can be a provider or CLI message ("Invalid API key · Please run
 * /login") or a stack fragment, and Slack channels are readable by other people.
 * So a failure travels as a CODE; the gateway posts only the fixed text below and
 * the raw detail goes to the server log. Anything not in the table is UNKNOWN.
 */
export const FAILURE_TEXT = {
  PROVIDER_CREDENTIALS_UNAVAILABLE:
    ":warning: I can't reach my model provider right now (credentials unavailable). The details are in the server log.",
  LABEL_MISMATCH:
    ":warning: No worker is available that matches this persona's requirements. The details are in the server log.",
  TURN_FAILED: ":warning: Something went wrong while handling that message. Try again; details are in the server log.",
  UNKNOWN: ":warning: Something went wrong. Details are in the server log.",
} as const;

export type FailureCode = keyof typeof FAILURE_TEXT;

export function isFailureCode(v: unknown): v is FailureCode {
  return typeof v === "string" && Object.hasOwn(FAILURE_TEXT, v);
}

/**
 * A session boot that failed for a reason with its own failure code. The node
 * worker turns it into the job's failure reason and an error event carrying the
 * code; the message is for the server log only.
 */
export class BootFailure extends Error {
  override readonly name = "BootFailure";
  /** True when the cause may clear by itself (a secret store or the gateway
   *  not answering): the job may be retried. False (default) when retrying
   *  cannot help (a denial, a missing secret, a bad reference). */
  readonly transient: boolean;
  constructor(
    readonly code: FailureCode,
    message: string,
    options?: { cause?: unknown; transient?: boolean },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.transient = options?.transient ?? false;
  }
}

/** The only text that may be posted into Slack for a failure. Unknown or absent
 *  codes get the generic message. */
export function failureText(code: unknown): string {
  return FAILURE_TEXT[isFailureCode(code) ? code : "UNKNOWN"];
}

/** Bounded, in-process once-per-key guard: only the first call per key returns
 *  true. It is a plain Set, so it does NOT dedupe across replicas. The oldest
 *  keys are forgotten past `cap` entries. */
export function createOnceGuard(cap = 2000): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > cap) seen.delete(seen.values().next().value as string);
    return true;
  };
}
