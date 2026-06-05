// src/gateway/sim/screen.ts
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
  // regionBottom is the scroll-region boundary, anchored to the core footer
  // (box + hint) regardless of whether a status line is present.  The status
  // line is drawn at regionBottom so the box position is stable.
  const coreHeight = boxRows + 2 + 1;     // borders (2) + hint (1), no status
  const regionBottom = Math.max(1, m.rows - coreHeight);

  // Absolute cursor position.
  // boxTopRow = regionBottom + 1 (status occupies regionBottom when present).
  const boxTopRow = regionBottom + 1 + (m.status ? 1 : 0);
  const cursorRow = boxTopRow + 1 + (cLine - start);
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
