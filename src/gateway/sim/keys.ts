// Decode a raw stdin chunk (raw mode) into editor key tokens. Pure + stateless:
// bracketed-paste semantics (newlines-as-literal) are applied by the editor via its
// `pasting` flag, so this only needs to surface the paste-start/paste-end markers.
export type Key =
  | { type: "text"; value: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "esc" }
  | { type: "ctrl-a" }
  | { type: "ctrl-e" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-u" }
  | { type: "ctrl-w" }
  | { type: "paste-start" }
  | { type: "paste-end" };

// Longest-match-first escape sequences.
const SEQ: Array<[string, Key]> = [
  ["\x1b[200~", { type: "paste-start" }],
  ["\x1b[201~", { type: "paste-end" }],
  ["\x1b[A", { type: "up" }],
  ["\x1b[B", { type: "down" }],
  ["\x1b[C", { type: "right" }],
  ["\x1b[D", { type: "left" }],
  ["\x1b[H", { type: "home" }],
  ["\x1b[F", { type: "end" }],
  ["\x1b[1~", { type: "home" }],
  ["\x1b[4~", { type: "end" }],
  ["\x1b[3~", { type: "delete" }],
  ["\x1bOH", { type: "home" }],
  ["\x1bOF", { type: "end" }],
];

const CTRL: Record<string, Key> = {
  "\r": { type: "enter" },
  "\n": { type: "enter" },
  "\t": { type: "tab" },
  "\x7f": { type: "backspace" },
  "\x08": { type: "backspace" },
  "\x01": { type: "ctrl-a" },
  "\x05": { type: "ctrl-e" },
  "\x03": { type: "ctrl-c" },
  "\x04": { type: "ctrl-d" },
  "\x15": { type: "ctrl-u" },
  "\x17": { type: "ctrl-w" },
};

export function decodeKeys(s: string): Key[] {
  const out: Key[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ type: "text", value: text }); text = ""; } };
  let i = 0;
  outer: while (i < s.length) {
    const c = s[i]!;
    if (c === "\x1b") {
      for (const [seq, key] of SEQ) {
        if (s.startsWith(seq, i)) { flush(); out.push(key); i += seq.length; continue outer; }
      }
      // Unrecognized CSI/SS3 (e.g. "\x1b[1;5C"): consume the sequence, drop it.
      if (s[i + 1] === "[" || s[i + 1] === "O") {
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j]!)) j++;
        flush(); i = j + 1; continue;
      }
      flush(); out.push({ type: "esc" }); i += 1; continue;
    }
    const ctrl = CTRL[c];
    if (ctrl) { flush(); out.push(ctrl); i += 1; continue; }
    if (c < " ") { i += 1; continue; }   // drop other C0 controls
    text += c; i += 1;
  }
  flush();
  return out;
}
