// Convert common Markdown to WhatsApp formatting.
//
// WhatsApp format:
//   bold      *X*       (md: **X**)
//   italic    _X_       (md: *X* or _X_)
//   strike    ~X~       (md: ~~X~~)
//   link      text (url) (md: [text](url) — no hyperlinks in WA)
//   heading   *X*       (md: #/##/### X)
//   codespan  `X`       (same)
//   codeblock ```X```   (same)

const C1 = "\x01"; // code block ref
const C2 = "\x02"; // code span ref
const C3 = "\x03"; // bold open
const C4 = "\x04"; // bold close

export function mdToWhatsApp(md: string): string {
  // 1. Carve fenced code blocks.
  const blocks: string[] = [];
  let work = md.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, body) => {
    blocks.push("```" + body.replace(/\n+$/, "") + "```");
    return `${C1}${blocks.length - 1}${C1}`;
  });

  // 2. Carve inline code spans.
  const spans: string[] = [];
  work = work.replace(/`([^`\n]+)`/g, (_m, body) => {
    spans.push("`" + body + "`");
    return `${C2}${spans.length - 1}${C2}`;
  });

  // 3. Links: [text](url) → text (url).
  work = work.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    "$1 ($2)",
  );

  // 4. Headings → bold line.
  work = work.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, `${C3}$1${C4}`);

  // 5. Italic FIRST while bold markers are still **.
  work = work.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1_$2_");

  // 6. Bold: **X** or __X__ → sentinel.
  work = work.replace(/\*\*([\s\S]+?)\*\*/g, `${C3}$1${C4}`);
  work = work.replace(/__([^_\n]+?)__/g, `${C3}$1${C4}`);

  // 7. Strike: ~~X~~ → ~X~.
  work = work.replace(/~~([^~\n]+?)~~/g, "~$1~");

  // 8. Bullet markers.
  work = work.replace(/^[ \t]*[*\-][ \t]+/gm, "• ");

  // 9. Restore sentinels + carved code.
  work = work
    .replaceAll(C3, "*")
    .replaceAll(C4, "*")
    .replace(new RegExp(`${C2}(\\d+)${C2}`, "g"), (_m, i) => spans[+i] ?? "")
    .replace(new RegExp(`${C1}(\\d+)${C1}`, "g"), (_m, i) => blocks[+i] ?? "");

  return work;
}

export const WA_MAX_TEXT = 4096;

export function chunkText(text: string, max = WA_MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}
