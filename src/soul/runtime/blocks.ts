/**
 * The rendered runtime baseline (`runtimeBaseline()`, core.md) split into its
 * `##` blocks, for the console's Guardrails page. Each block is the exact
 * slice of the rendered text, so joining every block's markdown gives the
 * text back unchanged. Headings inside code fences do not start a block.
 * The text before the first heading (the `<runtime-baseline>` opener) is the
 * "preamble" block. The "Built-in skills" block comes from renderSkillIndex()
 * and is simply absent when there are no built-in skills.
 */

export interface BaselineBlock {
  /** Stable slug of the heading ("preamble" for the text before the first). */
  id: string;
  /** The heading text without its `## ` marker. */
  title: string;
  /** The block's exact text, heading line included. */
  markdown: string;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "block";

export function splitBaseline(text: string): BaselineBlock[] {
  const blocks: BaselineBlock[] = [];
  const seen = new Map<string, number>();
  let cur: BaselineBlock = { id: "preamble", title: "Preamble", markdown: "" };
  let fenced = false;
  // Split keeping each line's own terminator, so the slices round-trip.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    if (/^\s*(```|~~~)/.test(bare)) fenced = !fenced;
    const h = !fenced && /^##\s+(.+?)\s*$/.exec(bare);
    if (h) {
      if (cur.markdown) blocks.push(cur);
      const title = h[1]!;
      const base = slug(title.replace(/`/g, ""));
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      cur = { id: n === 1 ? base : `${base}-${n}`, title, markdown: "" };
    }
    cur.markdown += line;
  }
  if (cur.markdown) blocks.push(cur);
  return blocks;
}
