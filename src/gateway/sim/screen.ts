// src/gateway/sim/screen.ts
import { SPINNER_FRAMES } from "./render";

export interface FooterModel {
  status: string | null;   // pre-composed status (spinner+label+elapsed), or null when idle
  text: string;            // editor buffer, may contain "\n"
  cursor: number;          // index into text
  hint: string;
  cols: number;
  rows: number;
}

export interface FooterLayout {
  lines: string[];         // footer rows, top→bottom: [status?], boxTop, content…, boxBottom, hint
  height: number;          // lines.length
  regionBottom: number;    // scroll-region bottom = rows - height
  cursorRow: number;       // 1-based absolute terminal row for the hardware cursor
  cursorCol: number;       // 1-based absolute terminal col
}

const MAX_ROWS = 10;       // multi-line input cap (visible content rows)
const PROMPT = "› ";

/** Pure: compute the footer's rendered lines + where the cursor lands. No I/O. */
export function layoutFooter(m: FooterModel): FooterLayout {
  const cols = Math.max(8, m.cols);
  const innerW = cols - 4;                 // "│ " + content + " │"
  const logical = m.text.split("\n");

  // Locate cursor as (line, col) within logical lines.
  let cLine = 0, cCol = 0, seen = 0;
  for (let i = 0; i < logical.length; i++) {
    const len = logical[i]!.length;
    if (m.cursor <= seen + len) { cLine = i; cCol = m.cursor - seen; break; }
    seen += len + 1;                       // +1 for the "\n"
    cLine = i + 1; cCol = 0;
  }

  // Windowing: cap to MAX_ROWS, keep the cursor line visible.
  const boxRows = Math.min(MAX_ROWS, logical.length);
  const start = cLine < boxRows ? 0 : cLine - boxRows + 1;
  const window = logical.slice(start, start + boxRows);

  // Render content rows (prompt only on logical line 0; horizontal clip keeps cursor visible).
  const content = window.map((line, idx) => {
    const prefix = start + idx === 0 ? PROMPT : "  ";
    const isCursorLine = start + idx === cLine;
    const raw = prefix + line;
    let hoff = 0;
    if (isCursorLine) {
      const cx = prefix.length + cCol;
      if (cx > innerW) hoff = cx - innerW;   // shift left so the cursor is the rightmost cell
    }
    const shown = raw.slice(hoff, hoff + innerW);
    return "│ " + shown.padEnd(innerW, " ") + " │";
  });

  const top = "╭" + "─".repeat(cols - 2) + "╮";
  const bottom = "╰" + "─".repeat(cols - 2) + "╯";
  const hint = clip(m.hint, cols);

  const lines = [...(m.status ? [clip(m.status, cols)] : []), top, ...content, bottom, hint];
  const height = lines.length;
  // The footer is bottom-anchored: it occupies the last `height` rows, so the box stays
  // pinned to the bottom and the status line (when present) slots in *above* the box —
  // the cursor's absolute row is unchanged by toggling status. Scrollback scrolls in 1..regionBottom.
  // Assumes rows >= height (max footer height is MAX_ROWS+3 ≈ 13 — fine for any real terminal).
  // On a terminal shorter than the footer the clamp keeps regionBottom >= 1 and the cursor row
  // on-screen rather than computing a position below the last row.
  const regionBottom = Math.max(1, m.rows - height);

  // Absolute cursor position. Footer rows run regionBottom+1 .. rows; status (if any) is the
  // first of those, so the box top sits one row lower when status is shown.
  const boxTopRow = regionBottom + 1 + (m.status ? 1 : 0);
  const cursorRow = Math.min(m.rows, boxTopRow + 1 + (cLine - start));
  const prefixLen = cLine === 0 ? PROMPT.length : 2;
  const cxRaw = prefixLen + cCol;
  const cxClipped = Math.min(cxRaw, innerW);
  const cursorCol = 3 + cxClipped;          // 1 "│", 2 " ", content starts at col 3

  return { lines, height, regionBottom, cursorRow, cursorCol };
}

function clip(s: string, width: number): string {
  // Clip on visible length; ANSI is rare in status/hint here and kept short by callers.
  return s.length > width ? s.slice(0, width) : s;
}

type SizeFn = () => { rows: number; cols: number };

/** Owns the bottom-pinned footer (status spinner + bordered input box + hint) and the
 *  scroll region above it. I/O is injected (write sink + size getter) so layout is testable
 *  without a TTY. Mutators re-render immediately; tick() advances the spinner. */
export class Screen {
  #write: (s: string) => void;
  #size: SizeFn;
  #frames: string[];
  #now: () => number;

  #text = "";
  #cursor = 0;
  #hint = "";
  #label: string | null = null;
  #frame = 0;
  #startedAt = 0;
  #height = 0;          // last footer height (for footer-band sizing)
  #regionBottom = 0;    // last scroll-region bottom (0 = region not yet set)

  constructor(write: (s: string) => void, size: SizeFn, opts: { frames?: string[]; now?: () => number } = {}) {
    this.#write = write;
    this.#size = size;
    this.#frames = opts.frames ?? SPINNER_FRAMES;
    this.#now = opts.now ?? (() => Date.now());
  }

  setHint(hint: string) { this.#hint = hint; this.#render(); }
  setInput(text: string, cursor: number) { this.#text = text; this.#cursor = cursor; this.#render(); }

  setStatus(label: string | null) {
    if (label === null) { this.#label = null; this.#render(); return; }
    if (this.#label === null) { this.#frame = 0; this.#startedAt = this.#now(); }
    this.#label = label; this.#render();
  }
  tick() { if (this.#label === null) return; this.#frame = (this.#frame + 1) % this.#frames.length; this.#render(); }

  /** Commit a scrollback line into the scrolling region above the footer. */
  print(line: string) {
    const { rows, cols } = this.#size();
    const L = this.#layout(rows, cols);
    // The scroll trick below only works once the DECSTBM region is set. If it's stale (fresh
    // Screen, or a resize since the last paint), render first so the region matches `L`.
    if (L.regionBottom !== this.#regionBottom || L.height !== this.#height) this.#render();
    for (const seg of line.split("\n")) {
      // Park at the region's last row and newline so the region scrolls up by one.
      this.#write(`\x1b[${L.regionBottom};1H\x1b[2K${seg}\n`);
    }
    this.#render();   // repaint footer + reposition cursor
  }

  resize() { this.#render(); }

  restore() {
    const { rows } = this.#size();
    this.#write("\x1b[r");                 // reset scroll region
    this.#write(`\x1b[${rows};1H`);        // park at the bottom
    this.#write("\x1b[?2004l");            // bracketed paste off
    this.#write("\x1b[?25h\n");            // show cursor + newline
  }

  #composeStatus(): string | null {
    if (this.#label === null) return null;
    const secs = Math.floor((this.#now() - this.#startedAt) / 1000);
    return `${this.#frames[this.#frame]} ${this.#label} (${secs}s)`;
  }

  #layout(rows: number, cols: number): FooterLayout {
    return layoutFooter({ status: this.#composeStatus(), text: this.#text, cursor: this.#cursor, hint: this.#hint, cols, rows });
  }

  #render() {
    const { rows, cols } = this.#size();
    const L = this.#layout(rows, cols);
    let buf = "\x1b[?25l";                                  // hide cursor during repaint
    // Re-set the scroll region whenever its bottom moves — height change (status/multi-line)
    // OR a terminal resize (rows changed → regionBottom changed even at constant height).
    if (L.regionBottom !== this.#regionBottom || L.height !== this.#height) {
      buf += `\x1b[1;${L.regionBottom}r`;                   // (re)set scroll region
      // Clear from the smaller of the old/new region bottom down to the last row, so a shrunk
      // footer leaves no stragglers and a freed footer row (e.g. old status line) isn't left
      // as a ghost in the scroll region. On the very first paint (regionBottom 0) clear only
      // the footer band, not the whole screen.
      const clearFrom = this.#regionBottom === 0
        ? L.regionBottom + 1
        : Math.min(this.#regionBottom, L.regionBottom) + 1;
      for (let r = clearFrom; r <= rows; r++) buf += `\x1b[${r};1H\x1b[2K`;
      this.#height = L.height;
      this.#regionBottom = L.regionBottom;
    }
    L.lines.forEach((ln, i) => { buf += `\x1b[${L.regionBottom + 1 + i};1H\x1b[2K${ln}`; });
    buf += `\x1b[${L.cursorRow};${L.cursorCol}H\x1b[?25h`;  // park + show cursor
    this.#write(buf);
  }
}
