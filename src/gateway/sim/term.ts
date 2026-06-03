import { SPINNER_FRAMES } from "./render";

const CLEAR = "\r\x1b[2K";   // carriage-return + erase entire line

/** Owns a single bottom-pinned "live status" line (spinner + label + elapsed) and lets you
 *  commit scrollback lines above it. The status repaints in place — no new line per tick —
 *  so the terminal reads like claude-code's thinking indicator. I/O is injected (a `write`
 *  sink + a `now` clock) so the rendering is unit-testable without a real TTY. */
export class LiveTerminal {
  #write: (s: string) => void;
  #frames: string[];
  #now: () => number;
  #label: string | null = null;
  #frame = 0;
  #startedAt = 0;

  constructor(write: (s: string) => void, opts: { frames?: string[]; now?: () => number } = {}) {
    this.#write = write;
    this.#frames = opts.frames ?? SPINNER_FRAMES;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Set (or replace) the live label. `null` clears the region. Starting a fresh label
   *  resets the spinner frame + elapsed clock. */
  status(label: string | null): void {
    if (label === null) { this.#label = null; this.#write(CLEAR); return; }
    if (this.#label === null) { this.#frame = 0; this.#startedAt = this.#now(); }
    this.#label = label;
    this.#paint();
  }

  /** Advance the spinner one frame and repaint. No-op when no status is active. */
  tick(): void {
    if (this.#label === null) return;
    this.#frame = (this.#frame + 1) % this.#frames.length;
    this.#paint();
  }

  /** Commit a scrollback line above the status region, then repaint the status. */
  print(line: string): void {
    this.#write(`${CLEAR}${line}\n`);
    if (this.#label !== null) this.#paint();
  }

  /** Erase the live region (e.g. before reading input). */
  clear(): void { this.#write(CLEAR); }

  #paint(): void {
    const secs = Math.floor((this.#now() - this.#startedAt) / 1000);
    this.#write(`${CLEAR}${this.#frames[this.#frame]} ${this.#label} (${secs}s)`);
  }
}
