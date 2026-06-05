// src/gateway/sim/editor.ts
import type { Key } from "./keys";

export type EditorAction =
  | { type: "render" }
  | { type: "none" }
  | { type: "submit"; text: string }
  | { type: "complete"; line: string }
  | { type: "sigint" }
  | { type: "eof" };

/** Pure line-editor reducer — readline parity (insert/erase/move/history/paste/multiline)
 *  with zero I/O. The caller decodes stdin to Keys, feeds them here, and paints `view()`. */
export class LineEditor {
  // State is private — `view()` is the sole read path and `handle()`/`applyCompletion()`
  // the only writers, so callers can't bypass the cursor/history invariants.
  #text = "";
  #cursor = 0;
  #pasting = false;
  #history: string[] = [];
  #hist = -1;       // -1 = live draft; else index into #history
  #draft = "";      // live line stashed while browsing history

  view(): { text: string; cursor: number } { return { text: this.#text, cursor: this.#cursor }; }
  // Replace the whole line (Tab-completion result, or a clear via ""). Resets history
  // navigation so a subsequent Up starts from the newest entry, not wherever we'd browsed to.
  applyCompletion(line: string) { this.#text = line; this.#cursor = line.length; this.#hist = -1; this.#draft = ""; }

  handle(k: Key): EditorAction {
    if (this.#pasting) return this.#paste(k);
    switch (k.type) {
      case "paste-start": this.#pasting = true; return { type: "none" };
      case "paste-end": return { type: "none" };
      case "text": return this.#insert(k.value);
      case "enter": return this.#enter();
      case "tab": return { type: "complete", line: this.#text };
      case "backspace": return this.#erase(-1);
      case "delete": return this.#erase(0);
      case "left": return this.#move(-1);
      case "right": return this.#move(1);
      case "home": case "ctrl-a": this.#cursor = 0; return { type: "render" };
      case "end": case "ctrl-e": this.#cursor = this.#text.length; return { type: "render" };
      case "ctrl-u": return this.#killToStart();
      case "ctrl-w": return this.#killWord();
      case "up": return this.#hist === -1 ? this.#histInto() : this.#histStep(-1);
      case "down": return this.#histStep(1);
      case "ctrl-c": return { type: "sigint" };
      case "ctrl-d": return this.#text.length === 0 ? { type: "eof" } : this.#erase(0);
      case "esc": return { type: "none" };
      default: return { type: "none" };
    }
  }

  #paste(k: Key): EditorAction {
    if (k.type === "paste-end") { this.#pasting = false; return { type: "render" }; }
    if (k.type === "text") return this.#insert(k.value);
    if (k.type === "enter") return this.#insert("\n");
    if (k.type === "tab") return this.#insert("\t");
    return { type: "none" };
  }

  #insert(s: string): EditorAction {
    this.#text = this.#text.slice(0, this.#cursor) + s + this.#text.slice(this.#cursor);
    this.#cursor += s.length;
    return { type: "render" };
  }
  #erase(off: -1 | 0): EditorAction {
    const at = this.#cursor + off;
    if (at < 0 || at >= this.#text.length) return { type: "none" };
    this.#text = this.#text.slice(0, at) + this.#text.slice(at + 1);
    this.#cursor = at < this.#cursor ? this.#cursor - 1 : this.#cursor;
    return { type: "render" };
  }
  #move(d: -1 | 1): EditorAction {
    const n = this.#cursor + d;
    if (n < 0 || n > this.#text.length) return { type: "none" };
    this.#cursor = n; return { type: "render" };
  }
  #killToStart(): EditorAction {
    if (this.#cursor === 0) return { type: "none" };
    this.#text = this.#text.slice(this.#cursor); this.#cursor = 0; return { type: "render" };
  }
  #killWord(): EditorAction {
    if (this.#cursor === 0) return { type: "none" };
    let i = this.#cursor;
    while (i > 0 && /\s/.test(this.#text[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.#text[i - 1]!)) i--;
    this.#text = this.#text.slice(0, i) + this.#text.slice(this.#cursor);
    this.#cursor = i; return { type: "render" };
  }
  #enter(): EditorAction {
    if (this.#text.endsWith("\\")) {            // explicit continuation
      this.#text = this.#text.slice(0, -1) + "\n";
      this.#cursor = this.#text.length;
      return { type: "render" };
    }
    const out = this.#text;
    if (out.trim().length) this.#history.push(out);
    this.#text = ""; this.#cursor = 0; this.#hist = -1; this.#draft = "";
    return { type: "submit", text: out };
  }
  #histInto(): EditorAction {
    if (this.#history.length === 0) return { type: "none" };
    this.#draft = this.#text;
    this.#hist = this.#history.length - 1;
    return this.#loadHist();
  }
  #histStep(d: -1 | 1): EditorAction {
    if (this.#hist === -1) return { type: "none" };
    const n = this.#hist + d;
    if (n < 0) return { type: "none" };
    if (n >= this.#history.length) {           // back to the live draft
      this.#hist = -1; this.#text = this.#draft; this.#cursor = this.#text.length;
      return { type: "render" };
    }
    this.#hist = n; return this.#loadHist();
  }
  #loadHist(): EditorAction {
    this.#text = this.#history[this.#hist]!; this.#cursor = this.#text.length;
    return { type: "render" };
  }
}
