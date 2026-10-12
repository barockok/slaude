/**
 * Mic pacer: call audio (the audio link's SSE) to the voice provider at real
 * time. The audio provider can deliver meeting audio in bursts (its SSE
 * stalls under CPU starvation, then flushes), and a provider may refuse audio
 * that arrives too fast (GPT-Live drops appends above 1.2x real time, and the
 * model then hears nothing). The pacer forwards at most 1.0x on average from
 * the sample count and the provider's input rate, with a short burst
 * allowance so steady input passes straight through. A source whose clock
 * runs slightly fast (rc.6 smoke: 0.5 to 2 s dropped per minute) would grow
 * the backlog forever at 1.0x, so a backlog past catchUpAfterMs drains at
 * catchUpRate, still under the provider's limit. Then a bounded jitter
 * buffer: past maxBacklogMs the OLDEST audio is dropped so latency stays
 * bounded. Drops are counted (ms only; audio content is never logged).
 */

export interface MicPacerOptions {
  /** Provider input sample rate (samples per second). */
  rate: number;
  send(pcm: Int16Array): void;
  /** Audio that may go out at once above real time (default 100 ms: the provider's rate window is unknown). */
  burstMs?: number;
  /** Queued audio past this is dropped, oldest first (default 1000 ms). */
  maxBacklogMs?: number;
  /** Rate (x real time) a backlog drains at; stays under GPT-Live's 1.2x limit, burst included (default 1.1). */
  catchUpRate?: number;
  /** Backlog past this drains at catchUpRate (default 200 ms). */
  catchUpAfterMs?: number;
  /** Granularity of paced sends (default 20 ms). */
  tickMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class MicPacer {
  readonly #o: Required<Pick<MicPacerOptions, "rate" | "send" | "burstMs" | "maxBacklogMs" | "catchUpRate" | "catchUpAfterMs" | "tickMs" | "now" | "setTimer" | "clearTimer">>;
  #queue: Int16Array[] = [];
  #queued = 0; // samples
  #credit: number; // samples that may go out now
  #creditAt: number;
  #timer: unknown = null;
  #closed = false;
  #droppedSamples = 0;
  #drops = 0;

  constructor(o: MicPacerOptions) {
    this.#o = {
      burstMs: 100, maxBacklogMs: 1_000, catchUpRate: 1.1, catchUpAfterMs: 200, tickMs: 20,
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...o,
    };
    this.#credit = this.#samples(this.#o.burstMs);
    this.#creditAt = this.#o.now();
  }

  #samples(ms: number): number {
    return Math.round((this.#o.rate * ms) / 1000);
  }

  push(pcm: Int16Array): void {
    if (this.#closed || pcm.length === 0) return;
    this.#queue.push(pcm);
    this.#queued += pcm.length;
    this.#pump();
  }

  /** Dropped audio since the last call (ms, count of drop events), then reset. */
  takeStats(): { droppedMs: number; drops: number } {
    const out = { droppedMs: Math.round((this.#droppedSamples * 1000) / this.#o.rate), drops: this.#drops };
    this.#droppedSamples = 0;
    this.#drops = 0;
    return out;
  }

  /** Drop queued audio (not counted as a drop: e.g. the provider is being replaced). */
  clear(): void {
    this.#queue = [];
    this.#queued = 0;
    this.#stopTimer();
  }

  close(): void {
    this.#closed = true;
    this.clear();
  }

  #refill(): void {
    const now = this.#o.now();
    const cap = this.#samples(this.#o.burstMs);
    const speed = this.#queued > this.#samples(this.#o.catchUpAfterMs) ? this.#o.catchUpRate : 1;
    this.#credit = Math.min(cap, this.#credit + ((now - this.#creditAt) * this.#o.rate * speed) / 1000);
    this.#creditAt = now;
  }

  #pump(): void {
    if (this.#closed) return;
    this.#refill();
    while (this.#queued > 0 && this.#credit >= 1) {
      const head = this.#queue[0]!;
      const n = Math.min(head.length, Math.floor(this.#credit));
      const out = n === head.length ? head : head.subarray(0, n);
      if (n === head.length) this.#queue.shift();
      else this.#queue[0] = head.subarray(n);
      this.#queued -= n;
      this.#credit -= n;
      this.#o.send(out);
    }
    // Bound the latency: past the backlog cap, drop the oldest.
    const max = this.#samples(this.#o.maxBacklogMs);
    if (this.#queued > max) {
      let excess = this.#queued - max;
      this.#drops++;
      this.#droppedSamples += excess;
      this.#queued -= excess;
      while (excess > 0) {
        const head = this.#queue[0]!;
        if (head.length <= excess) {
          this.#queue.shift();
          excess -= head.length;
        } else {
          this.#queue[0] = head.subarray(excess);
          excess = 0;
        }
      }
    }
    if (this.#queued > 0) this.#arm();
    else this.#stopTimer();
  }

  #arm(): void {
    if (this.#timer !== null) return;
    // Wake when one tick of audio (or what is queued, if less) has accrued.
    const need = Math.min(this.#samples(this.#o.tickMs), this.#queued) - this.#credit;
    const ms = Math.max(1, Math.ceil((need * 1000) / this.#o.rate));
    this.#timer = this.#o.setTimer(() => {
      this.#timer = null;
      this.#pump();
    }, ms);
  }

  #stopTimer(): void {
    if (this.#timer !== null) this.#o.clearTimer(this.#timer);
    this.#timer = null;
  }
}
