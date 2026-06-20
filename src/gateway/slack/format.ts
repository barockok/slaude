// Convert common Markdown (what LLMs emit) to Slack mrkdwn.
//
// Slack mrkdwn differs from CommonMark:
//   bold      *X*       (md: **X**)
//   italic    _X_       (md: *X* or _X_)
//   strike    ~X~       (md: ~~X~~)
//   link      <url|txt> (md: [txt](url))
//   heading   *X*       (md: #/##/### X)
//   codespan  `X`       (same)
//   codeblock ```X```   (same; language hint ignored)

const C1 = ""; // code block ref
const C2 = ""; // code span ref
const C3 = ""; // bold open
const C4 = ""; // bold close
const C5 = ""; // url ref

export function mdToMrkdwn(md: string): string {
  // 0. Markdown tables → fixed-width code block (Slack has no native tables).
  let pre = md.replace(
    /(^\|.+\|[ \t]*\n\|[ \t]*[-:| \t]+\|[ \t]*\n(?:\|.*\|[ \t]*\n?)+)/gm,
    (block) => renderTable(block),
  );

  // 1. Carve fenced code blocks.
  const blocks: string[] = [];
  let work = pre.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, body) => {
    blocks.push("```" + body.replace(/\n+$/, "") + "```");
    return `${C1}${blocks.length - 1}${C1}`;
  });

  // 2. Carve inline code spans.
  const spans: string[] = [];
  work = work.replace(/`([^`\n]+)`/g, (_m, body) => {
    spans.push("`" + body + "`");
    return `${C2}${spans.length - 1}${C2}`;
  });

  // 2a. Standalone bare URLs → labeled links using the host, so Slack renders a
  //     compact <url|host> instead of a space-eating raw URL. Skipped (via the
  //     lookbehind) when already a markdown link `[t](url)`, a mrkdwn link/label
  //     `<url|t>`, or an autolink `<url>`; code spans are already carved out.
  //     The full URL stays as the link target — only the visible text shrinks.
  work = work.replace(/(?<![(<|])https?:\/\/[^\s<>)\]]+/g, (u) => {
    try {
      return `[${new URL(u).host}](${u})`;
    } catch {
      return u;
    }
  });

  // 2b. Carve URLs (autolinks <…> and bare http(s)://…) so emphasis rules never
  //     rewrite a `_`/`__`/`*` inside a link. Restored verbatim at the end. Runs
  //     before the link rule, whose url group then carries the sentinel through.
  const urls: string[] = [];
  const carveUrl = (m: string) => { urls.push(m); return `${C5}${urls.length - 1}${C5}`; };
  work = work.replace(/<https?:\/\/[^>\s]+>/g, carveUrl);
  work = work.replace(/https?:\/\/[^\s<>)\]]+/g, carveUrl);

  // 3. Links: [text](url) → <url|text>.
  work = work.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    "<$2|$1>",
  );

  // 4. Headings → bold line.
  work = work.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, `${C3}$1${C4}`);

  // 4b. Bold+italic ***X*** → _*X*_. Slack nests emphasis but has no
  //     triple-star; a literal *** leaves stray asterisks unrendered.
  work = work.replace(
    /\*\*\*([^*\n]+?)\*\*\*/g,
    (_m, body) => `_${C3}${body.trim()}${C4}_`,
  );

  // 5. Italic FIRST while bold markers are still **. Single-star italic
  //    requires non-* on both sides so we don't munch bold. Trim inner
  //    padding — Slack won't render "_ x _" (space hugging the marker).
  work = work.replace(
    /(^|[^*])\*([^*\n]+?)\*(?!\*)/g,
    (_m, pre, body) => `${pre}_${body.trim()}_`,
  );

  // 6. Bold: **X** or __X__ → sentinel; restored to single * at the end so
  //    nothing else mistakes them for emphasis. Trim inner padding — Slack
  //    won't render "* x *".
  work = work.replace(
    /\*\*([\s\S]+?)\*\*/g,
    (_m, body) => `${C3}${body.trim()}${C4}`,
  );
  work = work.replace(
    /__([^_\n]+?)__/g,
    (_m, body) => `${C3}${body.trim()}${C4}`,
  );

  // 7. Strike: ~~X~~ → ~X~.
  work = work.replace(/~~([^~\n]+?)~~/g, "~$1~");

  // 8. Bullet markers: "* foo" or "- foo" at line start → "• foo".
  work = work.replace(/^[ \t]*[*\-][ \t]+/gm, "• ");

  // 9. Restore bold sentinels + carved code.
  work = work
    .replaceAll(C3, "*")
    .replaceAll(C4, "*")
    .replace(new RegExp(`${C2}(\\d+)${C2}`, "g"), (_m, i) => spans[+i] ?? "")
    .replace(new RegExp(`${C1}(\\d+)${C1}`, "g"), (_m, i) => blocks[+i] ?? "");
  work = work.replace(new RegExp(`${C5}(\\d+)${C5}`, "g"), (_m, i) => urls[+i] ?? "");

  return work;
}

/** Render a markdown table as a monospace code block w/ column padding. */
function renderTable(block: string): string {
  const lines = block.trim().split("\n");
  const rows = lines
    .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  if (rows.length < 2) return block;
  const sep = rows[1] ?? [];
  const isSep = sep.every((c) => /^:?-+:?$/.test(c));
  const header = rows[0] ?? [];
  const body = isSep ? rows.slice(2) : rows.slice(1);
  const cols = header.length;
  // Code-block branch renders verbatim — markdown emphasis (**bold**, *italic*,
  // _x_, ~~strike~~) would show literal. Strip before width calc + render.
  const stripCells = (r: string[]) => r.map((c) => stripEmphasis(c ?? ""));
  const headerStripped = stripCells(header);
  const bodyStripped = body.map(stripCells);
  const widths = new Array(cols).fill(0);
  for (const r of [headerStripped, ...bodyStripped]) {
    for (let i = 0; i < cols; i++) {
      widths[i] = Math.max(widths[i], (r[i] ?? "").length);
    }
  }
  // Slack's thread panel is narrow (~70 chars). If the table is wider,
  // render as a definition list so long cells don't wrap mid-row.
  const totalWidth = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
  if (totalWidth > 60 && cols >= 2) {
    const lines: string[] = [];
    for (const r of body) {
      lines.push(`**${r[0] ?? "—"}**`);
      for (let i = 1; i < cols; i++) {
        const k = header[i] ?? `col${i}`;
        const v = r[i] ?? "";
        lines.push(`  • ${k}: ${v}`);
      }
    }
    return "\n" + lines.join("\n") + "\n";
  }
  const fmt = (r: string[]) =>
    r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out: string[] = [fmt(headerStripped)];
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of bodyStripped) out.push(fmt(r));
  return "\n```\n" + out.join("\n") + "\n```\n";
}

/** Strip markdown emphasis markers (bold/italic/strike) — for code-block contexts
 *  where mrkdwn doesn't render and markers would show literal. */
function stripEmphasis(s: string): string {
  return s
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/__([^_\n]+?)__/g, "$1")
    .replace(/~~([^~\n]+?)~~/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1$2");
}

export const SLACK_MAX_TEXT = 39000;

export function chunkText(text: string, max = SLACK_MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}
