/**
 * The audio-origin allowlist (an ACL, deny by default). voice_start's stream
 * and clear URLs are model-supplied capability URLs: the voice loop sends the
 * call's audio and route headers to them, so they must point at an origin the
 * operator listed. Any browser audio pipe that speaks the contract (SSE
 * `audio`/`ended`, a chunked PCM POST, `clear`) can be listed; none is built in.
 *
 * Entry grammar (SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS, comma separated):
 *   scheme://host[:port]      exact origin
 *   scheme://*.suffix[:port]  one or more labels under `suffix`; never the
 *                             bare suffix, never a lookalike (`evilsuffix`)
 * The scheme is http or https. No path (a lone trailing "/" is tolerated), no
 * query, fragment, userinfo, or bare `*`. Scheme and port must match exactly;
 * default ports are normalised away; hosts compare in lower-case punycode. A
 * host with a trailing dot or an empty label never matches and is not a valid
 * entry. The authority is taken literally: `%` is refused in an entry and in a
 * matched URL's authority, so no encoded form can turn into a `*` or a dot.
 * A wildcard over a public suffix (`*.co.uk`, `*.github.io`) is refused, using
 * a short built-in list of common suffixes, not the full Public Suffix List.
 */

export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "host"]);
export const DEFAULT_AUDIO_HEADERS = "X-Browser-Session";

const ORIGINS_VAR = "SLAUDE_VOICE_AUDIO_ALLOWED_ORIGINS";
const ALLOWED_HEADERS_VAR = "SLAUDE_VOICE_AUDIO_ALLOWED_HEADERS";
const REQUIRED_HEADERS_VAR = "SLAUDE_VOICE_AUDIO_REQUIRED_HEADERS";

export class AudioAclError extends Error {}

export interface AudioOriginRule {
  /** Normalised form, e.g. "https://audio.example.com" or "https://*.example.com:8443". */
  entry: string;
  protocol: "http:" | "https:";
  wildcard: boolean;
  /** The exact hostname, or the suffix under a wildcard (lower-case punycode). */
  host: string;
  /** "" for the scheme's default port. */
  port: string;
}

export interface AudioPolicy {
  origins: AudioOriginRule[];
  /** Lower-case route header names voice_start may pass. */
  allowedHeaders: string[];
  /** Lower-case names that must be present and non-empty; a subset of allowedHeaders. */
  requiredHeaders: string[];
}

const ENTRY = /^(https?):\/\/([^/?#@\\\s%]+?)\/?$/i;

/** Common public suffixes a wildcard may not cover (every registrable domain
 *  under one would match). Not the full Public Suffix List: a deliberately
 *  short list of the usual second-level and hosting suffixes. */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn",
  "com.hk", "com.tw", "com.sg", "com.my", "co.id", "or.id", "ac.id", "go.id", "com.ph", "com.vn",
  "co.th", "in.th", "co.in", "net.in", "org.in", "com.pk", "co.il", "com.sa", "com.tr", "com.eg",
  "co.za", "com.ng", "co.ke", "com.br", "net.br", "org.br", "com.mx", "com.ar", "com.co", "com.pe",
  "com.ua", "com.pl", "co.at", "or.at", "com.es", "com.pt",
  "github.io", "gitlab.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com",
  "s3.amazonaws.com", "blogspot.com", "fly.dev", "onrender.com", "ngrok.io", "ngrok-free.app",
  "ngrok.app", "trycloudflare.com", "glitch.me", "repl.co", "replit.app", "railway.app",
]);

/** An entry as it may appear in a log line: no userinfo, query or fragment.
 *  A valid entry never holds "@", so everything up to the LAST "@" goes first
 *  (a password may hold "?", "#", "/" or "@"), then the query and fragment. */
function quotable(raw: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/*)?([\s\S]*)$/i.exec(raw)!;
  let rest = m[2]!;
  const at = rest.lastIndexOf("@");
  if (at >= 0) rest = rest.slice(at + 1);
  return JSON.stringify((m[1] ?? "") + rest.replace(/[?#][\s\S]*$/, ""));
}

const hasEmptyLabel = (host: string): boolean => host.split(".").some((l) => !l);

function parseEntry(raw: string): AudioOriginRule {
  const bad = (why: string) => new AudioAclError(`${ORIGINS_VAR}: entry ${quotable(raw)} is invalid (${why})`);
  const m = ENTRY.exec(raw);
  if (!m) throw bad("expected scheme://host[:port] or scheme://*.domain[:port], with an http or https scheme and no path, query, or userinfo");
  const scheme = m[1]!.toLowerCase() as "http" | "https";
  let authority = m[2]!;
  const wildcard = authority.startsWith("*.");
  if (wildcard) authority = authority.slice(2);
  if (authority.includes("*")) throw bad("a wildcard is only allowed as the whole first label, as in *.example.com");
  let u: URL;
  try {
    // A wildcard's suffix is parsed under a placeholder label, so it gets the
    // same lower-casing and punycode as a real host.
    u = new URL(`${scheme}://${wildcard ? "x." : ""}${authority}`);
  } catch {
    throw bad("not a valid origin");
  }
  if (!u.hostname || u.username || u.password) throw bad("not a valid origin");
  if (u.hostname.endsWith(".")) throw bad("a trailing dot is not allowed");
  if (hasEmptyLabel(u.hostname)) throw bad("empty labels are not allowed");
  // Only a literal leading "*." is a wildcard; a host that still holds a "*"
  // after parsing would serialise back as one.
  if (u.hostname.includes("*") || u.hostname.includes("%")) throw bad("a wildcard is only allowed as the whole first label, as in *.example.com");
  const port = u.port;
  const protocol = u.protocol as "http:" | "https:";
  if (!wildcard) return { entry: u.origin, protocol, wildcard, host: u.hostname, port };
  const suffix = u.hostname.slice(2);
  const labels = suffix.split(".");
  if (labels.length < 2 || /^[0-9]+$/.test(labels[labels.length - 1]!)) {
    throw bad("a wildcard needs a domain of at least two labels under it");
  }
  if (PUBLIC_SUFFIXES.has(suffix)) throw bad("a wildcard may not cover a public suffix");
  return { entry: `${scheme}://*.${suffix}${port ? `:${port}` : ""}`, protocol, wildcard, host: suffix, port };
}

const items = (raw: string | readonly string[]): string[] =>
  (typeof raw === "string" ? raw.split(",") : [...raw]).map((s) => s.trim()).filter(Boolean);

/** Parse an allowlist. Throws AudioAclError on any malformed entry. */
export function parseAudioOrigins(raw: string | readonly string[]): AudioOriginRule[] {
  return items(raw).map(parseEntry);
}

/** The URL's origin when it is an absolute http(s) URL, without userinfo,
 *  whose origin an allowlist entry matches; otherwise null. */
export function matchAudioOrigin(url: string, rules: readonly AudioOriginRule[]): string | null {
  // Taken literally: the URL parser would drop a tab or newline, read "\" as
  // "/", decode "%" in the host and accept "https:host", so what is checked
  // could differ from what was written.
  if (/[\s\\\u0000-\u001f\u007f]/.test(url)) return null;
  if (!/^https?:\/\/[^/?#%]+(?:[/?#]|$)/i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname || u.hostname.endsWith(".") || hasEmptyLabel(u.hostname)) return null;
  for (const r of rules) {
    if (r.protocol !== u.protocol || r.port !== u.port) continue;
    if (r.wildcard ? u.hostname.endsWith(`.${r.host}`) : u.hostname === r.host) return u.origin;
  }
  return null;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseHeaders(raw: string | readonly string[], varName: string): string[] {
  const out: string[] = [];
  for (const name of items(raw)) {
    if (!TOKEN.test(name)) throw new AudioAclError(`${varName}: ${JSON.stringify(name)} is not a valid header name`);
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) {
      throw new AudioAclError(`${varName}: ${name} can never be allowed (authorization, cookie and host are forbidden)`);
    }
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/** Build and validate a whole policy. Throws AudioAclError when it is invalid
 *  or the origin list is empty. Header lists default to X-Browser-Session. */
export function buildAudioPolicy(o: {
  origins: string | readonly string[];
  allowedHeaders?: string | readonly string[];
  requiredHeaders?: string | readonly string[];
}): AudioPolicy {
  const origins = parseAudioOrigins(o.origins);
  if (!origins.length) throw new AudioAclError(`${ORIGINS_VAR} is empty`);
  const allowedHeaders = parseHeaders(o.allowedHeaders ?? DEFAULT_AUDIO_HEADERS, ALLOWED_HEADERS_VAR);
  const requiredHeaders = parseHeaders(o.requiredHeaders ?? DEFAULT_AUDIO_HEADERS, REQUIRED_HEADERS_VAR);
  const extra = requiredHeaders.filter((h) => !allowedHeaders.includes(h));
  if (extra.length) {
    throw new AudioAclError(`${REQUIRED_HEADERS_VAR} must be a subset of ${ALLOWED_HEADERS_VAR} (${extra.join(", ")} not allowed)`);
  }
  return { origins, allowedHeaders, requiredHeaders };
}

/** Why voice_start's route headers break the policy, or null. */
export function audioHeadersProblem(h: Record<string, string>, p: AudioPolicy): string | null {
  for (const k of Object.keys(h)) {
    if (!p.allowedHeaders.includes(k.toLowerCase())) return `route header ${k} is not allowed`;
  }
  for (const req of p.requiredHeaders) {
    if (!Object.entries(h).some(([k, v]) => k.toLowerCase() === req && v.length > 0)) {
      return `the ${req} route header is required`;
    }
  }
  return null;
}
