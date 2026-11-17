/**
 * Secret redaction shared by the status line, approval cards and the audit
 * trail. No imports, so any module can use it without an import cycle.
 */

// Secret-shaped substrings to mask. Deterministic; order does not matter.
const SECRET_PATTERNS: RegExp[] = [
  /(authorization|x-api-key)\s*[:=]\s*\S+/gi, // headers: Authorization: …, x-api-key=…
  /bearer\s+[A-Za-z0-9._-]+/gi, // bearer <token>
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}/g, // sk-… style provider keys
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, // github tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // slack tokens
  /\bglpat-[A-Za-z0-9_-]{10,}/g, // gitlab PAT
  /\bAKIA[0-9A-Z]{12,}/g, // aws access key id
  /\bAIza[0-9A-Za-z._-]{20,}/g, // google api key
  /\beyJ[A-Za-z0-9._-]{10,}/g, // JWT
];

/** How many secret shapes redactSecrets masks (the console lists the family, not the regexes). */
export const SECRET_PATTERN_COUNT = SECRET_PATTERNS.length;

/** Deterministic regex backstop: mask anything secret-shaped. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "••••");
  return out;
}

/** Object keys whose values are secrets whatever they hold. */
export const SECRET_KEY = /token|secret|key|password|authorization|cookie|credential/i;

/** Capability URLs: the secret is in the path, so only the origin may show.
 *  voice_start's stream_url/clear_url anywhere, and any `*_url` under `audio`. */
const CAPABILITY_URL_KEY = /^(stream|clear)_url$/i;
const AUDIO_URL_KEY = /_url$/i;

function originOnly(v: unknown): string {
  if (typeof v !== "string") return "[redacted]";
  try {
    const u = new URL(v);
    return u.origin && u.origin !== "null" ? `${u.origin}/…` : "[redacted]";
  } catch {
    return "[redacted]";
  }
}

const MAX_DEPTH = 20;

export interface RedactTreeOptions {
  /** Applied to every string leaf (e.g. redactSecrets). Default: unchanged. */
  strings?: (s: string) => string;
  /** What an object nested past depth 20 becomes: kept as is, or "[truncated]". */
  tooDeep?: "keep" | "truncate";
  /** Objects and arrays walked at most; past it a node becomes "[truncated]". */
  maxNodes?: number;
}

/**
 * Copy of `value` with every secret-named key's value replaced (SECRET_KEY, at
 * any depth), every value under a `headers` object masked (route headers may
 * carry auth of any name), and every capability URL cut to its origin.
 * Bounded: a shared reference reuses its first result, a cycle becomes
 * "[circular]", and at most `maxNodes` objects are walked.
 */
export function redactTree(value: unknown, opts: RedactTreeOptions = {}): unknown {
  const seen = new WeakMap<object, unknown>();
  const maxNodes = opts.maxNodes ?? 10_000;
  let nodes = 0;
  const walk = (v: unknown, depth: number, parentKey: string): unknown => {
    if (typeof v === "string") return opts.strings ? opts.strings(v) : v;
    if (v === null || typeof v !== "object") return v;
    if (depth > MAX_DEPTH) return opts.tooDeep === "truncate" ? "[truncated]" : v;
    if (seen.has(v)) return seen.get(v);
    if (++nodes > maxNodes) return "[truncated]";
    seen.set(v, "[circular]");
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((x) => walk(x, depth + 1, parentKey));
    } else {
      const inAudio = /^audio$/i.test(parentKey);
      const obj: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) obj[k] = "[redacted]";
        else if (CAPABILITY_URL_KEY.test(k) || (inAudio && AUDIO_URL_KEY.test(k))) obj[k] = originOnly(x);
        else if (/^headers$/i.test(k) && x !== null && typeof x === "object" && !Array.isArray(x)) {
          obj[k] = Object.fromEntries(Object.keys(x as Record<string, unknown>).map((h) => [h, "[redacted]"]));
        } else obj[k] = walk(x, depth + 1, k);
      }
      out = obj;
    }
    seen.set(v, out);
    return out;
  };
  return walk(value, 0, "");
}
