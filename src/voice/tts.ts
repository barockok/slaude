// Aura TTS → bot_mic. Serialized queue with barge-in cancel: when a human
// starts talking (Flux StartOfTurn) we kill the in-flight paplay instantly.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { MIC_SINK } from "./audio";

const TTS_RATE = 16000;

export class Speaker {
  #apiKey: string;
  #voice: string;
  #current: ChildProcessWithoutNullStreams | null = null;
  #queue: { text: string; resolve: (spoken: boolean) => void }[] = [];
  #draining = false;

  constructor(apiKey: string, voice = "aura-2-thalia-en") {
    this.#apiKey = apiKey;
    this.#voice = voice;
  }

  /** Queue text; resolves true if fully spoken, false if barged-in/cancelled. */
  speak(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.#queue.push({ text, resolve });
      void this.#drain();
    });
  }

  /** Barge-in: stop current playback and drop everything queued. */
  cancel(): void {
    for (const item of this.#queue.splice(0)) item.resolve(false);
    this.#current?.kill("SIGKILL");
    this.#current = null;
  }

  get speaking(): boolean {
    return this.#current !== null || this.#queue.length > 0;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    while (this.#queue.length > 0) {
      const item = this.#queue.shift()!;
      try {
        item.resolve(await this.#speakOne(item.text));
      } catch {
        item.resolve(false);
      }
    }
    this.#draining = false;
  }

  async #speakOne(text: string): Promise<boolean> {
    const res = await fetch(
      `https://api.deepgram.com/v1/speak?model=${this.#voice}&encoding=linear16&sample_rate=${TTS_RATE}&container=none`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      },
    );
    if (!res.ok) throw new Error(`aura ${res.status}`);
    const pcm = Buffer.from(await res.arrayBuffer());

    return await new Promise<boolean>((resolve) => {
      const play = spawn("paplay", [
        `--device=${MIC_SINK}`,
        "--format=s16le",
        `--rate=${TTS_RATE}`,
        "--channels=1",
        "--raw",
      ]);
      this.#current = play;
      // paplay can die mid-write (barge-in kill, pulse restart) — an
      // unhandled stdin EPIPE would take the whole bridge down.
      play.stdin.on("error", () => {});
      play.on("error", () => resolve(false));
      play.on("exit", (code, signal) => {
        if (this.#current === play) this.#current = null;
        resolve(signal === null && code === 0);
      });
      play.stdin.write(pcm);
      play.stdin.end();
    });
  }
}
