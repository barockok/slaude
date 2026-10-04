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

/** The only text that may be posted into Slack for a failure. Unknown or absent
 *  codes get the generic message. */
export function failureText(code: unknown): string {
  return FAILURE_TEXT[isFailureCode(code) ? code : "UNKNOWN"];
}

/** Bounded once-per-key guard: a client retry, a queue attempt and a second
 *  replica can all report the same failed job; only the first call per key
 *  returns true. The oldest keys are forgotten past `cap` entries. */
export function createOnceGuard(cap = 2000): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > cap) seen.delete(seen.values().next().value as string);
    return true;
  };
}
