// PCM constants + framing shared by the audio plumbing and the Flux client.
// Flux wants linear16 mono 16k in ~80ms binary frames.

export const SAMPLE_RATE = 16000;
export const CHUNK_BYTES = (SAMPLE_RATE * 2 * 80) / 1000; // 2560

/** Accumulates arbitrarily-sized PCM buffers and yields exact frames. */
export class Framer {
  #buf: Buffer[] = [];
  #buffered = 0;
  readonly #frameBytes: number;

  constructor(frameBytes = CHUNK_BYTES) {
    this.#frameBytes = frameBytes;
  }

  push(pcm: Buffer): Buffer[] {
    this.#buf.push(pcm);
    this.#buffered += pcm.length;
    if (this.#buffered < this.#frameBytes) return [];
    const all = Buffer.concat(this.#buf);
    const frames: Buffer[] = [];
    let off = 0;
    while (all.length - off >= this.#frameBytes) {
      frames.push(all.subarray(off, off + this.#frameBytes));
      off += this.#frameBytes;
    }
    const rest = all.subarray(off);
    this.#buf = rest.length ? [rest] : [];
    this.#buffered = rest.length;
    return frames;
  }

  get pending(): number {
    return this.#buffered;
  }
}
