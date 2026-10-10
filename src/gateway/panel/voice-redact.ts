/**
 * Voice capability URLs in the panel's event stream. browser_audio_start's
 * result and voice_start's input carry the stream/clear URLs, whose paths hold
 * the audio session's secret; the panel timeline would otherwise show them in
 * full. One redactor per event stream learns the exact URLs from those events
 * and masks them (CapabilityRedactor) in every event it passes on, along with
 * the route header values sent next to them.
 */
import { CapabilityRedactor } from "../../voice/audio-link";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const parsed = (s: string): unknown => {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try { return JSON.parse(t); } catch { return null; }
};

/** Objects anywhere in `v` (JSON strings parsed too) that name audio URLs. */
function audioObjects(v: unknown, out: Obj[] = [], depth = 0): Obj[] {
  if (depth > 12) return out;
  if (typeof v === "string") {
    const p = parsed(v);
    if (p) audioObjects(p, out, depth + 1);
  } else if (Array.isArray(v)) {
    for (const x of v) audioObjects(x, out, depth + 1);
  } else if (isObj(v)) {
    if (typeof v.stream_url === "string" || typeof v.clear_url === "string") out.push(v);
    for (const x of Object.values(v)) audioObjects(x, out, depth + 1);
  }
  return out;
}

/** Route header values hidden wherever they sit beside audio URLs. */
function hideHeaderValues(v: unknown, depth = 0): unknown {
  if (depth > 12) return v;
  if (typeof v === "string") {
    const p = parsed(v);
    return p && audioObjects(p).length ? JSON.stringify(hideHeaderValues(p, depth + 1)) : v;
  }
  if (Array.isArray(v)) return v.map((x) => hideHeaderValues(x, depth + 1));
  if (!isObj(v)) return v;
  const out: Obj = {};
  const audioLike = typeof v.stream_url === "string" || typeof v.clear_url === "string";
  for (const [k, x] of Object.entries(v)) {
    out[k] = audioLike && k === "headers" && isObj(x)
      ? Object.fromEntries(Object.keys(x).map((h) => [h, "[hidden]"]))
      : hideHeaderValues(x, depth + 1);
  }
  return out;
}

export class PanelVoiceRedactor {
  #redactors: CapabilityRedactor[] = [];
  #seen = new Set<string>();

  /** Remember the capability URLs an event carries (no output). */
  learn(event: unknown): void {
    for (const a of audioObjects(event)) {
      const streamUrl = typeof a.stream_url === "string" ? a.stream_url : "";
      const clearUrl = typeof a.clear_url === "string" ? a.clear_url : "";
      const key = `${streamUrl}\n${clearUrl}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      let base = "";
      for (const u of [streamUrl, clearUrl]) {
        try { base ||= new URL(u).origin; } catch {}
      }
      this.#redactors.push(new CapabilityRedactor({ streamUrl, clearUrl }, base));
    }
  }

  /** The event as the panel may show it. */
  scrub(event: unknown): unknown {
    this.learn(event);
    if (!this.#redactors.length) return event;
    let text = JSON.stringify(hideHeaderValues(event));
    for (const r of this.#redactors) text = r.redact(text);
    try {
      return JSON.parse(text);
    } catch {
      // Masking broke the JSON: show nothing rather than the raw event.
      return isObj(event) ? { type: event.type, sessionId: event.sessionId, redacted: true } : null;
    }
  }
}
