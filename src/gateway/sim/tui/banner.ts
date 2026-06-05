// src/gateway/sim/tui/banner.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StyledText, fg, bg, stringToStyledText } from "@opentui/core";

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0")).join("");

/** Parse a truecolor ANSI string (24-bit `38;2;r;g;b` fg / `48;2;r;g;b` bg + `0` reset) into an
 *  OpenTUI StyledText. <text> renders raw ANSI literally, so half-block art like the logo needs
 *  the codes turned into styled chunks. Non-SGR escapes and other SGR params are ignored. */
export function ansiToStyledText(s: string): StyledText {
  const chunks = [] as StyledText["chunks"];
  let curFg: string | undefined;
  let curBg: string | undefined;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    if (curFg && curBg) chunks.push(bg(curBg)(fg(curFg)(buf)));
    else if (curFg) chunks.push(fg(curFg)(buf));
    else if (curBg) chunks.push(bg(curBg)(buf));
    else chunks.push(...stringToStyledText(buf).chunks);
    buf = "";
  };
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      let j = i + 2;
      while (j < s.length && s[j] !== "m") j++;
      if (j >= s.length) { buf += s.slice(i); break; } // unterminated — treat as literal
      flush();
      const params = s.slice(i + 2, j).split(";").map((x) => parseInt(x, 10) || 0);
      for (let k = 0; k < params.length; ) {
        const p = params[k];
        if (p === 0) { curFg = undefined; curBg = undefined; k++; }
        else if (p === 38 && params[k + 1] === 2) { curFg = hex(params[k + 2]!, params[k + 3]!, params[k + 4]!); k += 5; }
        else if (p === 48 && params[k + 1] === 2) { curBg = hex(params[k + 2]!, params[k + 3]!, params[k + 4]!); k += 5; }
        else k++;
      }
      i = j + 1;
    } else {
      buf += s[i];
      i++;
    }
  }
  flush();
  return new StyledText(chunks);
}

// The logo asset, parsed once at module load. Trailing newline trimmed so it doesn't add a blank row.
const logoAnsi = readFileSync(join(import.meta.dir, "assets", "amartha-logo.ansi"), "utf8").replace(/\n$/, "");
export const banner: StyledText = ansiToStyledText(logoAnsi);
