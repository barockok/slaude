import { redactSecrets, SECRET_KEY } from "../gateway/core/status-text";

/**
 * Audit redaction. Reuses the status-line secret net (`redactSecrets`) on the
 * summary and on every string in details, and replaces the value of any key
 * matching SECRET_KEY (the same key pattern approval cards use) whatever it
 * holds.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  // Too deep to walk: drop it rather than store anything unredacted.
  if (depth > 20) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactValue(v, depth + 1);
  }
  return out;
}

export function redactEvent(ev: { summary: string; details: Record<string, unknown> }): {
  summary: string;
  details: Record<string, unknown>;
} {
  return {
    summary: redactSecrets(ev.summary),
    details: redactValue(ev.details) as Record<string, unknown>,
  };
}
