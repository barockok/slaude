/**
 * One outbound-fetch policy (WS-D D5.3; the MCP bridge's SSRF policy, WS-C
 * §4.2.7). Every fetch to a URL that came from configuration or from a remote
 * server's response — OAuth discovery, client registration, code exchange,
 * refresh — goes through `safeFetch`, because the gateway attaches real
 * credentials to those URLs and runs next to the cluster's private services.
 *
 * - Only https. http only for loopback with SLAUDE_OUTBOUND_DEV_LOOPBACK=1
 *   (development), or for an operator-declared internal host.
 * - The host is resolved once and EVERY address is checked: loopback, private,
 *   shared (CGNAT), link-local (cloud metadata), unspecified, multicast and
 *   reserved ranges are refused, v4 and v6, including IPv4 carried in IPv6
 *   (mapped, compatible, NAT64, 6to4).
 * - The connection goes to the checked address (a pinned `lookup`), so a
 *   second DNS answer cannot move it (no rebinding window).
 * - Redirects are never followed: a 3xx is returned as is, so a credential is
 *   never replayed to a host the policy did not check.
 * - A timeout and a response-size cap.
 * - SLAUDE_OUTBOUND_ALLOWED_HOSTS (optional) narrows the hosts further.
 * - SLAUDE_OUTBOUND_INTERNAL_HOSTS (optional) names hosts the operator vouches
 *   for that may resolve to PRIVATE ranges (an in-cluster IdP or MCP server).
 *   They are still refused loopback, link-local and metadata addresses.
 *
 * Errors name the host and the category, never the resolved address: they can
 * reach a Slack thread, and the address would map the operator's network.
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type AddressKind = "loopback" | "private" | "link-local" | "unspecified" | "reserved" | "invalid";

export interface ResolvedAddress { address: string; family: number; }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface OutboundPolicyOptions {
  /** Default: the system resolver. Injected by tests. */
  resolver?: Resolver;
  /** Admit loopback addresses (and http to them). Default: SLAUDE_OUTBOUND_DEV_LOOPBACK=1. */
  allowLoopback?: boolean;
  /** When non-empty, only these hosts (`host` or `*.domain`). Default: SLAUDE_OUTBOUND_ALLOWED_HOSTS. */
  allowedHosts?: string[];
  /** Hosts allowed to resolve to private ranges and to use http. Default: SLAUDE_OUTBOUND_INTERNAL_HOSTS. */
  internalHosts?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface SafeRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class OutboundBlockedError extends Error {
  constructor(reason: string) {
    super(`outbound request refused: ${reason}`);
    this.name = "OutboundBlockedError";
  }
}

// ── address classification ───────────────────────────────────────────────

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes, or null. Accepts `::`, an embedded dotted IPv4 tail and a zone id. */
function parseV6(input: string): number[] | null {
  let s = input.split("%")[0]!;
  let v4Tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    v4Tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (v4Tail.length) bytes.splice(12, 4, ...v4Tail);
  return bytes;
}

function classifyV4([a, b, c]: number[]): AddressKind | null {
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b! >= 64 && b! <= 127) return "private"; // shared address space (CGNAT)
  if (a === 169 && b === 254) return "link-local"; // includes the cloud metadata address
  if (a! >= 224) return "reserved"; // multicast, 240/4, broadcast
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || (a === 198 && (b === 18 || b === 19))) return "reserved";
  return null;
}

function classifyV6(x: number[]): AddressKind | null {
  const zeroUpTo = (n: number) => x.slice(0, n).every((v) => v === 0);
  if (zeroUpTo(16)) return "unspecified";
  if (zeroUpTo(15) && x[15] === 1) return "loopback";
  // IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96): judge the IPv4.
  if (zeroUpTo(12) || (zeroUpTo(10) && x[10] === 0xff && x[11] === 0xff)) return classifyV4(x.slice(12));
  // NAT64 well-known prefix 64:ff9b::/96 and 6to4 2002::/16 carry an IPv4 too.
  if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b && x.slice(4, 12).every((v) => v === 0)) return classifyV4(x.slice(12));
  if (x[0] === 0x20 && x[1] === 0x02) return classifyV4(x.slice(2, 6));
  if ((x[0]! & 0xfe) === 0xfc) return "private"; // unique local fc00::/7
  if (x[0] === 0xfe && (x[1]! & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (x[0] === 0xfe && (x[1]! & 0xc0) === 0xc0) return "private"; // deprecated site-local fec0::/10
  if (x[0] === 0xff) return "reserved"; // multicast
  if (x[0] === 0x20 && x[1] === 0x01 && ((x[2] === 0x0d && x[3] === 0xb8) || (x[2] === 0 && x[3] === 0))) return "reserved"; // documentation, Teredo
  if (x[0] === 0x01 && x[1] === 0 && x.slice(2, 8).every((v) => v === 0)) return "reserved"; // discard 100::/64
  return null;
}

/** Why an address is refused, or null when it is a public unicast address. */
export function classifyAddress(ip: string): AddressKind | null {
  const v4 = parseV4(ip);
  if (v4) return classifyV4(v4);
  if (!ip.includes(":")) return "invalid";
  const v6 = parseV6(ip);
  return v6 ? classifyV6(v6) : "invalid";
}

// ── policy ───────────────────────────────────────────────────────────────

const csvEnv = (name: string): string[] =>
  (process.env[name] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}

/** Validate a URL against the policy and resolve it once. The returned
 *  addresses are the ONLY ones a request may connect to. */
export async function checkOutbound(
  rawUrl: string,
  opts: OutboundPolicyOptions = {},
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new OutboundBlockedError("invalid URL"); }
  const allowLoopback = opts.allowLoopback ?? process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK === "1";
  const allowedHosts = (opts.allowedHosts ?? csvEnv("SLAUDE_OUTBOUND_ALLOWED_HOSTS")).map((h) => h.toLowerCase());
  const internalHosts = (opts.internalHosts ?? csvEnv("SLAUDE_OUTBOUND_INTERNAL_HOSTS")).map((h) => h.toLowerCase());
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const internal = internalHosts.includes(host);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OutboundBlockedError(`scheme ${url.protocol} is not allowed (https only)`);
  }
  // http is decided before DNS where it can be: only loopback (dev) or an internal host.
  if (url.protocol === "http:" && !internal && !allowLoopback) {
    throw new OutboundBlockedError(`${host}: only https is allowed`);
  }
  if (allowedHosts.length && !allowedHosts.some((p) => hostMatches(host, p))) {
    throw new OutboundBlockedError(`${host} is not in SLAUDE_OUTBOUND_ALLOWED_HOSTS`);
  }

  let addresses: ResolvedAddress[];
  const family = isIP(host);
  if (family) {
    addresses = [{ address: host, family }];
  } else {
    try { addresses = await (opts.resolver ?? systemResolver)(host); } catch { addresses = []; }
    if (!addresses.length) throw new OutboundBlockedError(`${host} could not be resolved`);
  }

  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind === null) continue;
    if (kind === "loopback" && allowLoopback) continue;
    if (kind === "private" && internal) continue;
    throw new OutboundBlockedError(`${host} resolves to a ${kind} address`);
  }
  if (url.protocol === "http:" && !internal && !addresses.every((a) => classifyAddress(a.address) === "loopback")) {
    throw new OutboundBlockedError(`${host}: only https is allowed (http only for loopback in development)`);
  }
  return { url, addresses };
}

// ── fetch ────────────────────────────────────────────────────────────────

/** The subset of a fetch Response the callers use. */
export class SafeResponse {
  constructor(
    readonly status: number,
    private readonly rawHeaders: http.IncomingHttpHeaders,
    private readonly body: Buffer,
  ) {}
  readonly headers = {
    get: (name: string): string | null => {
      const v = this.rawHeaders[name.toLowerCase()];
      return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
    },
  };
  async text(): Promise<string> { return this.body.toString("utf8"); }
  async json(): Promise<any> { return JSON.parse(this.body.toString("utf8")); }
}

/** A short, address-free label for a transport error: its code when it is a
 *  plain identifier (ECONNREFUSED, ERR_TLS_CERT_ALTNAME_INVALID), else its name. */
function transportCode(e: Error & { code?: unknown }): string {
  if (typeof e.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)) return e.code;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : "Error";
}

/** Fetch under the policy: checked once, connected to the checked address,
 *  no redirects, bounded in time and size. */
export async function safeFetch(
  rawUrl: string,
  init: SafeRequestInit = {},
  opts: OutboundPolicyOptions = {},
): Promise<SafeResponse> {
  const { url, addresses } = await checkOutbound(rawUrl, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const fail = (e: Error) => settle(() => reject(e));
    // Transport errors are rewritten, never passed through: the runtime's own
    // message can embed the pinned address (a TLS failure reads `fetching
    // "https://<ip>:<port>/…"`), and connect errors reach the Slack thread.
    const transportFail = (e: Error & { code?: unknown }) =>
      fail(new Error(`request to ${url.hostname} failed (${transportCode(e)})`));

    const req = (url.protocol === "https:" ? https : http).request(url, {
      method: init.method ?? "GET",
      headers,
      // Pin the connection to the addresses checked above: no second lookup.
      lookup: ((_h: string, o: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) =>
        o?.all ? cb(null, addresses) : cb(null, addresses[0]!.address, addresses[0]!.family)) as never,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          fail(new Error(`response from ${url.hostname} exceeded ${maxBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => settle(() => resolve(new SafeResponse(res.statusCode ?? 0, res.headers, Buffer.concat(chunks)))));
      res.on("error", transportFail);
    });
    const timer = setTimeout(() => {
      fail(new Error(`request to ${url.hostname} timed out after ${timeoutMs}ms`));
      req.destroy();
    }, timeoutMs);
    req.on("error", transportFail);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** `safeFetch` with the environment's policy, shaped like the `FetchLike`
 *  the OAuth modules take: their default for every outbound call. */
export const outboundFetch = (url: string, init?: SafeRequestInit): Promise<SafeResponse> => safeFetch(url, init);
