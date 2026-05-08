// Minimal markdown -> slack mrkdwn conversion. Best-effort.
export function mdToMrkdwn(md: string): string {
  return md
    // **bold** -> *bold*
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    // [text](url) -> <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
    // headers -> bold line
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
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
