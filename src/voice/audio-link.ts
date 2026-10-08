/**
 * Workbench browser-audio client (voice mode spec §5.5; workbench
 * browser-audio-pipeline design). SSE out (call audio), one long-lived chunked
 * POST in (agent audio), `clear` for interruption. Authorized by the call's
 * stream_token (plan deviation 1). Audio content is never logged.
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

/** Headers a model-supplied endpoint may never set: the link adds its own bearer. */
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

export class AudioLink implements AudioLinkLike {
  #h: AudioHandlers | null = null;
  #closed = false;
  #ended = false;
  #sseAbort = new AbortController();
  #uplinkCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
  #uplinkDone: Promise<void> = Promise.resolve();
  readonly #streamUrl: string;
  readonly #clearUrl: string;
  readonly #routeHeaders: Record<string, string>;

  constructor(private o: { baseUrl: string; endpoints: AudioEndpoints; streamToken: string; maxSseRetries?: number; retryDelayMs?: number; clearTimeoutMs?: number }) {
    // Endpoints are model-supplied: pin them to the operator's origin so the
    // bearer token can never be sent elsewhere.
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
    return { ...this.#routeHeaders, authorization: `Bearer ${this.o.streamToken}`, ...extra };
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
    this.#uplinkDone = fetch(this.#streamUrl, {
      method: "POST",
      headers: this.#headers({ "content-type": "audio/pcm" }),
      body,
      duplex: "half",
    }).then(
      (r) => { if (r.status === 404 || r.status === 401 || r.status === 403) this.#end("audio_lost"); },
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
    await this.#uplinkDone.catch(() => {});
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
