/**
 * Workbench browser-audio client (voice mode spec §5.5; workbench
 * browser-audio-pipeline design). SSE out (call audio), one long-lived chunked
 * POST in (agent audio), `clear` for interruption. The stream and clear URLs
 * are ephemeral capability URLs: an unguessable per-audio-session secret sits
 * in their paths, and they die when the audio session stops. They are the only
 * authorization, so no Authorization header is sent and the URLs themselves are
 * never logged or echoed (see redactCapabilityUrls). Audio content is never
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

/** A path segment that can carry the capability secret: long, or mixing
 *  letters and digits. Plain route words (api, audio, stream...) are not. */
function secretSegment(seg: string, routeWords: Set<string>): boolean {
  if (!seg || routeWords.has(seg)) return false;
  return seg.length >= 12 || (seg.length >= 6 && /[0-9]/.test(seg) && /[a-z]/i.test(seg));
}

interface CapabilityForms {
  /** Whole-URL forms (as given, resolved, encoded) → their masked text. */
  whole: Array<[string, string]>;
  /** Path(+query) forms, masked only when not attached to a host. */
  paths: Array<[string, string]>;
  /** Secret segments and long query values (raw, decoded and encoded). */
  secrets: string[];
  /** Every query value: masked after `=`. */
  queryValues: string[];
}

function capabilityForms(endpoints: { streamUrl: string; clearUrl: string }, baseUrl: string): CapabilityForms {
  const f: CapabilityForms = { whole: [], paths: [], secrets: [], queryValues: [] };
  let base: URL | null = null;
  try { base = baseUrl ? new URL(baseUrl) : null; } catch {}
  const routeWords = new Set((base?.pathname ?? "").split("/").filter(Boolean));
  for (const raw of [endpoints.streamUrl, endpoints.clearUrl]) {
    if (!raw) continue;
    let u: URL | null = null;
    let origin = "";
    try {
      u = new URL(raw);
      origin = u.origin;
    } catch {
      try {
        u = new URL(raw, base ?? PLACEHOLDER_BASE);
        origin = base ? u.origin : "";
      } catch {}
    }
    if (origin === "null") origin = "";
    const masked = origin ? `${origin}/…` : "[redacted]";
    for (const w of [raw, u && origin ? u.toString() : ""]) {
      if (!w) continue;
      f.whole.push([w, masked], [encodeURIComponent(w), masked]);
    }
    if (!u) {
      f.secrets.push(raw);
      continue;
    }
    if (u.pathname.length > 1) f.paths.push([u.pathname + u.search, masked], [u.pathname, masked]);
    for (const seg of u.pathname.split("/")) {
      const dec = safeDecode(seg);
      if (secretSegment(dec, routeWords)) f.secrets.push(seg, dec, encodeURIComponent(dec));
    }
    for (const [, v] of u.searchParams) {
      if (!v) continue;
      f.queryValues.push(v, encodeURIComponent(v));
      if (v.length >= 8) f.secrets.push(v, encodeURIComponent(v));
    }
  }
  const byLen = (a: string, b: string) => b.length - a.length;
  f.whole.sort((a, b) => byLen(a[0], b[0]));
  f.paths.sort((a, b) => byLen(a[0], b[0]));
  f.secrets = [...new Set(f.secrets.filter(Boolean))].sort(byLen);
  f.queryValues = [...new Set(f.queryValues.filter(Boolean))].sort(byLen);
  return f;
}

/** `text` with the capability URLs masked, in every form: whole URLs (as
 *  given, resolved, URL-encoded, or any absolute URL in the text carrying the
 *  secret, query and all) become the origin and "/…"; path forms not attached
 *  to a host likewise; then any remaining secret segment or query value (lone,
 *  encoded, scheme-less) becomes "…". With no usable `baseUrl` a relative form
 *  masks to "[redacted]". Use on any text that leaves the voice loop: logs, ipc
 *  `log` lines, child stderr, error messages, approval cards. */
export function redactCapabilityUrls(text: string, endpoints: { streamUrl: string; clearUrl: string }, baseUrl: string): string {
  const f = capabilityForms(endpoints, baseUrl);
  if (!f.whole.length) return text;
  const pathNames = f.paths.map(([p]) => p);
  // Absolute URLs first, whole (an extra query or fragment goes with them).
  let out = text.replace(URL_TOKEN, (tok) => {
    if (!f.secrets.some((s) => tok.includes(s)) && !pathNames.some((p) => tok.includes(p))) return tok;
    try {
      const o = new URL(tok).origin;
      return o && o !== "null" ? `${o}/…` : "[redacted]";
    } catch {
      return "[redacted]";
    }
  });
  for (const [form, masked] of f.whole) out = out.split(form).join(masked);
  // Path forms only where no host precedes them (a scheme-less host/path is
  // left to the segment pass below, so nothing is masked twice).
  for (const [form, masked] of f.paths) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9.\\-\\]:@%/])${escapeRe(form)}`, "g"), masked);
  }
  for (const v of f.queryValues) out = out.split(`=${v}`).join("=…");
  for (const sec of f.secrets) out = out.split(sec).join("…");
  return out;
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

  constructor(private o: { baseUrl: string; endpoints: AudioEndpoints; maxSseRetries?: number; retryDelayMs?: number; clearTimeoutMs?: number; closeTimeoutMs?: number }) {
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
    const body = new ReadableStream<Uint8Array>({ start: (c) => { this.#uplinkCtl = c; } });
    // The uplink lives for the whole call: it settling (any status, or an
    // error) while the call is open means the agent can no longer be heard.
    this.#uplinkDone = fetch(this.#streamUrl, {
      method: "POST",
      headers: this.#headers({ "content-type": "audio/pcm" }),
      body,
      duplex: "half",
      redirect: "error",
      signal: this.#uplinkAbort.signal,
    }).then(
      () => this.#end("audio_lost"),
      () => this.#end("audio_lost"),
    );
  }

  async #sseLoop(): Promise<void> {
    const max = this.o.maxSseRetries ?? 3;
    let failures = 0;
    while (!this.#closed && !this.#ended) {
      let gotData = false;
      try {
        const r = await fetch(this.#streamUrl, {
          headers: this.#headers({ accept: "text/event-stream" }),
          redirect: "error",
          signal: this.#sseAbort.signal,
        });
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
