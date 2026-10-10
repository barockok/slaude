/**
 * Workbench browser-audio client (voice mode spec §5.5; workbench
 * browser-audio-pipeline design). SSE out (call audio), one long-lived chunked
 * POST in (agent audio), `clear` for interruption. The stream and clear URLs
 * are ephemeral capability URLs: an unguessable per-audio-session secret sits
 * in their paths, and they die when the audio session stops. They are the only
 * authorization, so no Authorization header is sent and the URLs themselves are
 * never logged or echoed (see CapabilityRedactor). Audio content is never
 * logged.
 */
import type { AudioEndpoints } from "./ipc";
import { base64ToPcm } from "./provider/types";

export interface AudioHandlers {
  onAudio(pcm: Int16Array): void;
  onEnded(reason: string): void;
}
export interface AudioLinkLike {
  start(h: AudioHandlers): Promise<void>;
  write(pcm: Int16Array): void;
  /** Null when the clear failed or timed out: what played is then unknown. */
  clear(): Promise<{ playedMs: number; clearedMs: number } | null>;
  close(): Promise<void>;
}

/** Headers a model-supplied endpoint may never set: ambient credentials and
 *  routing that the capability URL must not be combined with. */
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "host"]);

/** The only route headers voice_start accepts (lower-case): naming them keeps
 *  every header that can change routing visible on the approval card. */
export const ROUTE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set(["x-browser-session"]);
export const routeHeadersAllowed = (h: Record<string, string>): boolean =>
  Object.keys(h).every((k) => ROUTE_HEADER_ALLOWLIST.has(k.toLowerCase()));

/** True when `path` resolves against `base` to the same origin, without
 *  embedded credentials. Unparseable input is false. */
export function sameOrigin(path: string, base: string): boolean {
  try {
    const b = new URL(base);
    const u = new URL(path, b);
    return u.origin === b.origin && !u.username && !u.password;
  } catch {
    return false;
  }
}

const PLACEHOLDER_BASE = "http://placeholder.invalid";
/** An absolute URL token in free text (stops at whitespace, quotes, brackets, backslash). */
const URL_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>\\]+/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const safeEncodeURI = (s: string) => { try { return encodeURI(s); } catch { return s; } };
const safeEncodeURIComponent = (s: string) => { try { return encodeURIComponent(s); } catch { return s; } };
/** Every encoding a piece may appear in: as given, decoded, encodeURI, encodeURIComponent. */
function encodings(piece: string): string[] {
  const dec = safeDecode(piece);
  return [piece, dec, safeEncodeURI(dec), safeEncodeURIComponent(dec)];
}

/** Path segments of the workbench's audio routes that carry no secret. */
export const ROUTE_WORDS: ReadonlySet<string> = new Set(["api", "browser", "tabs", "audio", "stream", "clear"]);
/** Pieces this short are masked only as a whole token, so a one-letter test
 *  path cannot eat letters inside words. */
const MIN_ANYWHERE = 4;

/** Secondary net, only for an endpoint that does not parse as a URL at all
 *  (no URL context to take exact pieces from): a piece that looks like a
 *  secret, long or mixing letters and digits. */
function looksSecret(seg: string): boolean {
  return seg.length >= 12 || (seg.length >= 6 && /[0-9]/.test(seg) && /[a-z]/i.test(seg));
}

/**
 * Masks one call's capability URLs (voice mode: the audio session's secret is
 * in the stream/clear URL paths and queries). Built once from the exact URLs
 * the call received, it derives every secret-bearing piece from them: each
 * full URL, its path and path plus query, every path segment that is not a
 * route word, every query value, each in every encoding. Those exact strings
 * are masked wherever they appear, whatever the secret's shape:
 *  - an absolute URL in the text carrying any piece is masked whole (query and
 *    all) to its origin and "/…";
 *  - a path form not attached to a host likewise;
 *  - any remaining piece (lone, encoded, after a scheme-less host) becomes "…".
 * With no usable `baseUrl`, a relative form masks to "[redacted]".
 */
export class CapabilityRedactor {
  readonly #whole: Array<[string, string]> = [];
  readonly #paths: Array<[string, string]> = [];
  readonly #pieces: string[];
  readonly #empty: boolean;

  constructor(endpoints: { streamUrl: string; clearUrl: string }, baseUrl: string) {
    let base: URL | null = null;
    try { base = baseUrl ? new URL(baseUrl) : null; } catch {}
    const routeWords = new Set([...ROUTE_WORDS, ...(base?.pathname ?? "").split("/").filter(Boolean)]);
    const pieces: string[] = [];
    for (const raw of [endpoints.streamUrl, endpoints.clearUrl]) {
      if (!raw) continue;
      let u: URL | null = null;
      let origin = "";
      let absolute = false;
      try {
        u = new URL(raw);
        origin = u.origin;
        absolute = true;
      } catch {
        try {
          u = new URL(raw, base ?? PLACEHOLDER_BASE);
          origin = base ? u.origin : "";
        } catch {}
      }
      if (origin === "null") origin = "";
      const masked = origin ? `${origin}/…` : "[redacted]";
      if (!u) {
        // No URL structure: mask it as given, plus the secondary net.
        pieces.push(raw, ...raw.split(/[/?&=#]+/).filter(looksSecret));
        continue;
      }
      // Only absolute forms are masked anywhere: a relative form may follow a
      // scheme-less host, and is left to the guarded path pass.
      for (const w of [absolute ? raw : "", origin ? u.toString() : ""]) {
        if (w) for (const e of encodings(w)) this.#whole.push([e, masked]);
      }
      if (u.pathname.length > 1) {
        for (const form of [u.pathname + u.search, u.pathname]) {
          for (const e of encodings(form)) this.#paths.push([e, masked]);
        }
      }
      for (const seg of u.pathname.split("/")) {
        const dec = safeDecode(seg);
        if (dec && !routeWords.has(dec)) pieces.push(...encodings(seg));
      }
      for (const [, v] of u.searchParams) if (v) pieces.push(...encodings(v));
    }
    const byLen = (a: string, b: string) => b.length - a.length;
    this.#whole.sort((a, b) => byLen(a[0], b[0]));
    this.#paths.sort((a, b) => byLen(a[0], b[0]));
    this.#pieces = [...new Set(pieces.filter(Boolean))].sort(byLen);
    this.#empty = !this.#whole.length && !this.#paths.length && !this.#pieces.length;
  }

  redact(text: string): string {
    if (this.#empty || !text) return text;
    const paths = this.#paths.map(([p]) => p);
    // Absolute URLs first, whole (an extra query or fragment goes with them).
    let out = text.replace(URL_TOKEN, (tok) => {
      if (!this.#pieces.some((s) => tok.includes(s)) && !paths.some((p) => tok.includes(p))) return tok;
      try {
        const o = new URL(tok).origin;
        return o && o !== "null" ? `${o}/…` : "[redacted]";
      } catch {
        return "[redacted]";
      }
    });
    for (const [form, masked] of this.#whole) out = out.split(form).join(masked);
    // Path forms only where no host precedes them (a scheme-less host/path is
    // left to the piece pass, so nothing is masked twice).
    for (const [form, masked] of this.#paths) {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9.\\-\\]:@%/])${escapeRe(form)}`, "g"), masked);
    }
    for (const piece of this.#pieces) {
      out = piece.length >= MIN_ANYWHERE
        ? out.split(piece).join("…")
        : out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(piece)}(?![A-Za-z0-9])`, "g"), "…");
    }
    return out;
  }
}

/** One-shot form of CapabilityRedactor. Use on any text that leaves the voice
 *  loop: logs, ipc `log` lines, child stderr, error messages, approval cards,
 *  the panel timeline. */
export function redactCapabilityUrls(text: string, endpoints: { streamUrl: string; clearUrl: string }, baseUrl: string): string {
  return new CapabilityRedactor(endpoints, baseUrl).redact(text);
}

export class AudioLink implements AudioLinkLike {
  #h: AudioHandlers | null = null;
  #closed = false;
  #ended = false;
  #sseAbort = new AbortController();
  #uplinkAbort = new AbortController();
  #uplinkCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
  #uplinkDone: Promise<void> = Promise.resolve();
  readonly #streamUrl: string;
  readonly #clearUrl: string;
  readonly #routeHeaders: Record<string, string>;

  constructor(private o: { baseUrl: string; endpoints: AudioEndpoints; maxSseRetries?: number; retryDelayMs?: number; busyWindowMs?: number; busyBackoffMs?: number; clearTimeoutMs?: number; closeTimeoutMs?: number }) {
    // Endpoints are model-supplied: pin them to the operator's origin so the
    // capability URL (and the route headers) can never be sent elsewhere. The
    // error names neither URL: the path is the secret.
    const pin = (path: string): string => {
      if (!sameOrigin(path, o.baseUrl)) throw new Error("workbench endpoint origin mismatch");
      return new URL(path, o.baseUrl).toString();
    };
    this.#streamUrl = pin(o.endpoints.streamUrl);
    this.#clearUrl = pin(o.endpoints.clearUrl);
    this.#routeHeaders = Object.fromEntries(
      Object.entries(o.endpoints.headers).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())),
    );
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.#routeHeaders, ...extra };
  }
  #end(reason: string): void {
    if (this.#ended || this.#closed) return;
    this.#ended = true;
    this.#h?.onEnded(reason);
  }

  async start(h: AudioHandlers): Promise<void> {
    this.#h = h;
    void this.#sseLoop();
    this.#uplinkDone = this.#uplinkLoop();
  }

  /** Wait out a 409 (the workbench still holds the previous reader/uplink): a
   *  growing backoff (base, x2, capped at 4x base) until the window closes.
   *  Returns false when the window is spent or the call is over. */
  async #busyWait(since: number, attempt: number): Promise<boolean> {
    const base = this.o.busyBackoffMs ?? 1_000;
    if (Date.now() - since >= (this.o.busyWindowMs ?? 15_000)) return false;
    await Bun.sleep(Math.min(base * 2 ** attempt, base * 4));
    return !this.#closed && !this.#ended;
  }

  /** The uplink lives for the whole call: it settling (any status other than a
   *  busy 409 inside the window, or an error) while the call is open means the
   *  agent can no longer be heard. */
  async #uplinkLoop(): Promise<void> {
    let busySince = 0;
    for (let attempt = 0; ; attempt++) {
      const body = new ReadableStream<Uint8Array>({ start: (c) => { this.#uplinkCtl = c; } });
      let status = 0;
      const attemptAbort = new AbortController();
      const onAbort = () => attemptAbort.abort();
      this.#uplinkAbort.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const r = await fetch(this.#streamUrl, {
          method: "POST",
          headers: this.#headers({ "content-type": "audio/pcm" }),
          body,
          duplex: "half",
          redirect: "error",
          // A refused streaming body leaves its connection unusable (the next
          // request on it is rejected), so the uplink never reuses one.
          keepalive: false,
          signal: attemptAbort.signal,
        });
        status = r.status;
        // Refused with its body unread: drop that connection so the retry
        // starts on a clean one.
        if (status === 409) attemptAbort.abort();
      } catch {}
      this.#uplinkAbort.signal.removeEventListener("abort", onAbort);
      if (status === 409 && !this.#closed && !this.#ended) {
        busySince ||= Date.now();
        if (await this.#busyWait(busySince, attempt)) continue;
      }
      this.#end("audio_lost");
      return;
    }
  }

  async #sseLoop(): Promise<void> {
    const max = this.o.maxSseRetries ?? 3;
    let failures = 0;
    let busySince = 0;
    let busyN = 0;
    while (!this.#closed && !this.#ended) {
      let gotData = false;
      try {
        const r = await fetch(this.#streamUrl, {
          headers: this.#headers({ accept: "text/event-stream" }),
          redirect: "error",
          signal: this.#sseAbort.signal,
        });
        if (r.status === 404) { this.#end("audio_lost"); return; }
        if (r.status === 409) {
          // The old reader is not released yet: wait, without spending the
          // failure budget, until the busy window is spent.
          busySince ||= Date.now();
          if (!(await this.#busyWait(busySince, busyN++))) { this.#end("audio_lost"); return; }
          continue;
        }
        busySince = 0;
        busyN = 0;
        if (r.ok && r.body) {
          for await (const ev of parseSse(r.body)) {
            gotData = true;
            if (ev.event === "audio") {
              const d = JSON.parse(ev.data) as { pcm: string };
              this.#h?.onAudio(base64ToPcm(d.pcm));
            } else if (ev.event === "ended") {
              const d = JSON.parse(ev.data) as { reason?: string };
              this.#end(`workbench:${sanitizeReason(d.reason)}`);
              return;
            }
          }
        }
      } catch {
        if (this.#closed) return;
      }
      if (this.#closed || this.#ended) return;
      failures = gotData ? 1 : failures + 1;
      if (failures > max) {
        this.#end("audio_lost");
        return;
      }
      await Bun.sleep(this.o.retryDelayMs ?? 500);
    }
  }

  write(pcm: Int16Array): void {
    if (this.#closed || this.#ended || !this.#uplinkCtl) return;
    try {
      this.#uplinkCtl.enqueue(new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)));
    } catch {
      // uplink already errored or cancelled; audio_lost is reported separately
    }
  }

  async clear(): Promise<{ playedMs: number; clearedMs: number } | null> {
    // Bounded: a hung clear must not hold up the steer, or a stop behind it.
    try {
      const r = await fetch(this.#clearUrl, {
        method: "POST",
        headers: this.#headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.o.clearTimeoutMs ?? 2_000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { played_ms?: number; cleared_ms?: number };
      return { playedMs: j.played_ms ?? 0, clearedMs: j.cleared_ms ?? 0 };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#uplinkCtl?.close(); } catch {}
    this.#sseAbort.abort();
    // Let the workbench finish the uplink cleanly, but not forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      this.#uplinkDone.then(() => true, () => true),
      new Promise<false>((r) => (timer = setTimeout(() => r(false), this.o.closeTimeoutMs ?? 2_000))),
    ]);
    clearTimeout(timer);
    if (!settled) this.#uplinkAbort.abort();
  }
}

/** The reason comes from the external workbench; keep it inside the ipc EndReason grammar. */
function sanitizeReason(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  return s || "stopped";
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}
