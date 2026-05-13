/**
 * Pre-flight redaction over outbound Slack text. Patterns sourced from
 * `soulData().redactPatterns`. Each pattern is compiled as `new RegExp(p, "gi")`.
 * Invalid regex sources are skipped (logged once at compile time).
 *
 * Applied AFTER markdown→mrkdwn conversion so the matched substring is what
 * Slack would actually render. Substring match replaced with `[REDACTED]`.
 */
export function redactSlack(text: string, patterns: readonly string[]): string {
  if (!patterns.length) return text;
  let out = text;
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, "gi");
    } catch {
      continue;
    }
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}
