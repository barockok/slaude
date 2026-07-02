// Deepgram Flux client — STT with model-native turn detection.
// wss://api.deepgram.com/v2/listen (v2, not v1), binary PCM in, TurnInfo JSON out.
// https://developers.deepgram.com/docs/flux/quickstart

import { EventEmitter } from "node:events";
import { CHUNK_BYTES, SAMPLE_RATE } from "./audio";

export interface FluxWord {
  word: string;
  confidence: number;
}

/** One TurnInfo message. `event` drives the loop:
 *  StartOfTurn → barge-in (kill TTS); EagerEndOfTurn → start thinking;
 *  TurnResumed → cancel eager work; EndOfTurn → respond. */
export interface TurnInfo {
  type: "TurnInfo";
  event:
    | "StartOfTurn"
    | "Update"
    | "EagerEndOfTurn"
    | "TurnResumed"
    | "EndOfTurn";
  turn_index: number;
  transcript: string;
  words?: FluxWord[];
  end_of_turn_confidence?: number;
}

export interface FluxOptions {
  apiKey: string;
  model?: string;
  eotThreshold?: number;
  eagerEotThreshold?: number;
}

/**
 * Thin websocket wrapper. Feed PCM via write(); listen for:
 *   "turn"  (TurnInfo)   — every Flux turn event
 *   "open" | "close" | "error"
 */
export class FluxClient extends EventEmitter {
  #ws: WebSocket | null = null;
  #buf: Buffer[] = [];
  #buffered = 0;
  #opts: FluxOptions;

  constructor(opts: FluxOptions) {
    super();
    this.#opts = opts;
  }

  connect(): void {
    const params = new URLSearchParams({
      model: this.#opts.model ?? "flux-general-en",
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
    });
    if (this.#opts.eotThreshold !== undefined)
      params.set("eot_threshold", String(this.#opts.eotThreshold));
    if (this.#opts.eagerEotThreshold !== undefined)
      params.set("eager_eot_threshold", String(this.#opts.eagerEotThreshold));

    this.#ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
      // Bun extension: custom headers on the WS handshake.
      headers: { Authorization: `Token ${this.#opts.apiKey}` },
    } as unknown as string[]);
    this.#ws.binaryType = "arraybuffer";

    this.#ws.onopen = () => this.emit("open");
    this.#ws.onclose = (ev) => this.emit("close", ev.code, ev.reason);
    this.#ws.onerror = (ev) => this.emit("error", ev);
    this.#ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "TurnInfo") this.emit("turn", msg as TurnInfo);
      else this.emit("message", msg);
    };
  }

  /** Buffer PCM and ship in ~80ms binary frames. */
  write(pcm: Buffer): void {
    this.#buf.push(pcm);
    this.#buffered += pcm.length;
    while (this.#buffered >= CHUNK_BYTES) {
      const chunk = Buffer.concat(this.#buf);
      this.#buf = [chunk.subarray(CHUNK_BYTES)];
      this.#buffered = this.#buf[0]!.length;
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(chunk.subarray(0, CHUNK_BYTES));
      }
    }
  }

  close(): void {
    this.#ws?.close(1000);
    this.#ws = null;
  }
}
