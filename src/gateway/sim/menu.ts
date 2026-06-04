/** Pure pieces of a claude-code-style arrow-select panel (the `/mcp`/`/plugin` picker shape):
 *  render the list, decode a keypress, reduce cursor state. The raw-mode stdin loop that
 *  drives these lives in the TTY seam (cli.ts) — these stay pure and unit-tested. */

export interface MenuItem { label: string; hint?: string }
export type Key = "up" | "down" | "enter" | "esc" | "other";

/** Title + one row per item (cursor row pointed by ❯ and inverted) + a footer key hint. */
export function renderMenu(title: string, items: MenuItem[], cursor: number): string[] {
  const lines = [`\x1b[1m${title}\x1b[0m`];
  items.forEach((it, i) => {
    const text = `${it.label}${it.hint ? `  \x1b[2m${it.hint}\x1b[0m` : ""}`;
    lines.push(i === cursor ? `\x1b[7m❯ ${text}\x1b[0m` : `  ${text}`);
  });
  lines.push("\x1b[2m↑/↓ select · Enter confirm · Esc cancel\x1b[0m");
  return lines;
}

export function decodeKey(seq: string): Key {
  if (seq === "\x1b[A" || seq === "k") return "up";
  if (seq === "\x1b[B" || seq === "j") return "down";
  if (seq === "\r" || seq === "\n") return "enter";
  if (seq === "\x1b" || seq === "\x03" || seq === "q") return "esc";   // Esc / Ctrl-C / q
  return "other";
}

/** Advance cursor state for a key. Up/down wrap; enter/esc terminate with a verdict. */
export function menuReduce(cursor: number, len: number, key: Key): { cursor: number; done?: "select" | "cancel" } {
  if (key === "up") return { cursor: (cursor - 1 + len) % len };
  if (key === "down") return { cursor: (cursor + 1) % len };
  if (key === "enter") return { cursor, done: "select" };
  if (key === "esc") return { cursor, done: "cancel" };
  return { cursor };
}
