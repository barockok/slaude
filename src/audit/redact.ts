import { redactSecrets, redactTree } from "../redact";

/** Longest summary kept, in characters. */
export const MAX_SUMMARY_CHARS = 500;

/**
 * Audit redaction: the approval card's walker (secret-named keys, header
 * values, capability URLs) plus the secret net on every string, and an object
 * nested too deep is dropped rather than stored raw.
 */
export function redactValue(value: unknown): unknown {
  return redactTree(value, { strings: redactSecrets, tooDeep: "truncate" });
}

export function redactSummary(summary: string): string {
  const s = redactSecrets(summary);
  return s.length > MAX_SUMMARY_CHARS ? `${s.slice(0, MAX_SUMMARY_CHARS - 1)}…` : s;
}

export function redactEvent(ev: { summary: string; details: Record<string, unknown> }): {
  summary: string;
  details: Record<string, unknown>;
} {
  return {
    summary: redactSummary(ev.summary),
    details: redactValue(ev.details) as Record<string, unknown>,
  };
}
