/**
 * The live tail of one session: GET /panel/api/sessions/:id/events, read with
 * fetch rather than EventSource so a 401 can refresh the sign-in and resume,
 * and so the dev stub can answer it.
 *
 * Protocol (src/gateway/panel/api.ts handleEvents):
 * - frames are `id: <entry id>` + `data: <SessionEvent JSON>`; comments
 *   (": open", ": ping") keep the connection warm;
 * - the server starts at the newest entry, so earlier turns are not replayed
 *   (the page reads those from GET .../history, the conversation record);
 * - `event: session-expired` ends the stream when the access token runs out:
 *   refresh, then reopen with `?lastId=` so nothing is lost;
 * - 503 means there is no event bus (no Redis): nothing to tail.
 * A dropped connection reconnects with backoff from the last id seen.
 */
import type { SessionEvent } from "../../../gateway/panel/api-types";
import { api } from "../client";

export interface StreamEntry {
  /** Server entry id (or a local id for a frame without one). */
  id: string;
  /** When the browser received it. */
  at: number;
  event: SessionEvent;
}

export type StreamStatus = "connecting" | "live" | "reconnecting" | "unavailable" | "signed-out";

export interface StreamHandlers {
  onEntry: (e: StreamEntry) => void;
  onStatus: (s: StreamStatus, detail?: string) => void;
}

const BACKOFF = [1000, 2000, 4000, 8000, 15000];
/** Auth failures in a row (401, or the token ran out) before giving up as signed out. */
const MAX_AUTH_FAILURES = 3;
/** A connection that stayed up this long counts as healthy even without an event. */
const HEALTHY_MS = 10_000;

async function refreshSignIn(): Promise<boolean> {
  try {
    const r = await fetch(`${api.base}/auth/refresh`, { method: "POST", headers: { "x-panel-csrf": "1" }, credentials: "same-origin" });
    return r.ok;
  } catch {
    return false;
  }
}

/** Opens the tail; returns a function that closes it for good. */
export function openSessionStream(sessionId: string, h: StreamHandlers): () => void {
  const ctl = new AbortController();
  // Gap note: until the first event arrives lastId is empty, and a reconnect
  // without one makes the server start again from its newest entry (it never
  // replays the backlog). Events written while that first connection was down
  // are therefore not shown. Once one event has arrived, reconnects resume
  // from it with ?lastId= and nothing is skipped.
  let lastId = "";
  /** Network failures in a row; drives the reconnect backoff. */
  let attempt = 0;
  /** Auth failures in a row. */
  let authFails = 0;
  let local = 0;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || ctl.signal.aborted) return resolve();
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        ctl.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      ctl.signal.addEventListener("abort", onAbort, { once: true });
    });
  const backoff = (n: number) => BACKOFF[Math.min(n, BACKOFF.length - 1)]!;

  /** Reads one connection to its end. Returns why it ended. */
  async function readOnce(): Promise<"ended" | "expired" | "unauthorized" | "unavailable" | "failed"> {
    const q = lastId ? `?lastId=${encodeURIComponent(lastId)}` : "";
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastId) headers["last-event-id"] = lastId;
    const res = await fetch(`${api.base}/api/sessions/${encodeURIComponent(sessionId)}/events${q}`, {
      headers,
      credentials: "same-origin",
      signal: ctl.signal,
    });
    if (res.status === 401) return "unauthorized";
    if (res.status === 503) return "unavailable";
    if (!res.ok || !res.body) return "failed";
    authFails = 0;
    h.onStatus("live");
    const connectedAt = Date.now();

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    // Closing the tail must end the read even when the body ignores the signal.
    const stop = () => void reader.cancel().catch(() => undefined);
    ctl.signal.addEventListener("abort", stop, { once: true });
    try {
      return await readFrames(reader);
    } finally {
      ctl.signal.removeEventListener("abort", stop);
      // A connection that opens and drops at once must keep backing off.
      if (Date.now() - connectedAt >= HEALTHY_MS) attempt = 0;
    }
  }

  async function readFrames(reader: ReadableStreamDefaultReader<string>): Promise<"ended" | "expired"> {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done || ctl.signal.aborted) return "ended";
      buf += value.replace(/\r\n?/g, "\n");
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let id = "";
        let name = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "id") id = val;
          else if (field === "event") name = val;
          else if (field === "data") data.push(val);
        }
        if (name === "session-expired") {
          void reader.cancel().catch(() => undefined);
          return "expired";
        }
        if (name !== "message" || data.length === 0) continue;
        if (id) lastId = id;
        attempt = 0; // a real frame: the connection is healthy
        try {
          const event = JSON.parse(data.join("\n")) as SessionEvent;
          h.onEntry({ id: id || `local-${++local}`, at: Date.now(), event });
        } catch {
          /* a malformed frame is skipped */
        }
      }
    }
  }

  void (async () => {
    h.onStatus("connecting");
    while (!ctl.signal.aborted) {
      let why: Awaited<ReturnType<typeof readOnce>>;
      try {
        why = await readOnce();
      } catch {
        if (ctl.signal.aborted) return;
        why = "failed";
      }
      if (ctl.signal.aborted) return;
      if (why === "unavailable") {
        h.onStatus("unavailable", "This deployment has no event bus, so there is no live tail.");
        return;
      }
      if (why === "unauthorized" || why === "expired") {
        authFails += 1;
        if (authFails >= MAX_AUTH_FAILURES) {
          h.onStatus("signed-out", "Your sign-in expired. Reload the page to sign in again.");
          return;
        }
        h.onStatus("reconnecting");
        // The first expiry is routine (the token ran out mid-stream): refresh
        // and reopen at once. Repeats back off like any other failure.
        if (authFails > 1) await wait(backoff(authFails - 2));
        if (ctl.signal.aborted) return;
        await refreshSignIn();
        continue;
      }
      h.onStatus("reconnecting");
      await wait(backoff(attempt++));
    }
  })();

  return () => ctl.abort();
}
