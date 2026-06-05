// One-time generator: downscale amartha-logo.ansi (28×11 half-block cells = 28×22 px) to a
// smaller truecolor half-block .ansi, preserving aspect. Reverses asciify.py's encoding:
//   "▀" → (top=fg, bottom=bg), "▄" → (bottom=fg), " " → transparent.
// Run: bun src/gateway/sim/tui/assets/gen-small-logo.ts <targetRows>   (default 6)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Px = [number, number, number] | null;

const dir = import.meta.dir;
const src = readFileSync(join(dir, "amartha-logo.ansi"), "utf8").replace(/\n$/, "");
const lines = src.split("\n");
const W = Math.max(...lines.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, "")].length));
const H = lines.length * 2;

// Parse cells → pixel grid [H][W].
const grid: Px[][] = Array.from({ length: H }, () => Array<Px>(W).fill(null));
lines.forEach((line, row) => {
  let fg: Px = null, bg: Px = null, col = 0, i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      let j = i + 2;
      while (j < line.length && line[j] !== "m") j++;
      const ps = line.slice(i + 2, j).split(";").map((x) => parseInt(x, 10) || 0);
      for (let k = 0; k < ps.length; ) {
        if (ps[k] === 0) { fg = null; bg = null; k++; }
        else if (ps[k] === 38 && ps[k + 1] === 2) { fg = [ps[k + 2]!, ps[k + 3]!, ps[k + 4]!]; k += 5; }
        else if (ps[k] === 48 && ps[k + 1] === 2) { bg = [ps[k + 2]!, ps[k + 3]!, ps[k + 4]!]; k += 5; }
        else k++;
      }
      i = j + 1;
    } else {
      const ch = line[i]!;
      const top = row * 2, bot = row * 2 + 1;
      if (ch === "▀") { grid[top]![col] = fg; grid[bot]![col] = bg; }
      else if (ch === "▄") { grid[bot]![col] = fg; }
      // space → leave transparent
      col++;
      i++;
    }
  }
});

// Downscale to target size (keep aspect from the px grid).
const targetRows = Number(process.argv[2]) || 6;
const TH = targetRows * 2;
const TW = Math.max(1, Math.round(W * (TH / H)));
const sample = (y0: number, y1: number, x0: number, x1: number): Px => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = grid[y]?.[x]; if (p) { r += p[0]; g += p[1]; b += p[2]; n++; }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
};
const out: Px[][] = Array.from({ length: TH }, (_, ty) =>
  Array.from({ length: TW }, (_, tx) =>
    sample(Math.floor((ty * H) / TH), Math.max(Math.floor((ty * H) / TH) + 1, Math.floor(((ty + 1) * H) / TH)),
           Math.floor((tx * W) / TW), Math.max(Math.floor((tx * W) / TW) + 1, Math.floor(((tx + 1) * W) / TW)))));

// Re-encode half-blocks (same scheme as asciify.py).
const enc = (t: Px, b: Px) =>
  !t && !b ? " "
  : t && b ? `\x1b[38;2;${t[0]};${t[1]};${t[2]}m\x1b[48;2;${b[0]};${b[1]};${b[2]}m▀\x1b[0m`
  : t ? `\x1b[38;2;${t[0]};${t[1]};${t[2]}m▀\x1b[0m`
  : `\x1b[38;2;${b![0]};${b![1]};${b![2]}m▄\x1b[0m`;
const result: string[] = [];
for (let y = 0; y < TH; y += 2) {
  let line = "";
  for (let x = 0; x < TW; x++) line += enc(out[y]![x]!, out[y + 1]?.[x] ?? null);
  result.push(line);
}
writeFileSync(join(dir, "amartha-logo-small.ansi"), result.join("\n") + "\n");
console.log(`wrote amartha-logo-small.ansi — ${TW}×${targetRows} cells (from ${W}×${lines.length})`);
