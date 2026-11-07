/**
 * Slack message markup as display segments, for text the console shows
 * (history lines, user messages, agent messages). Pure: the stored text is
 * never changed, only how it reads.
 *
 *   <https://x|label>  <https://x>  -> a link (http, https and mailto only)
 *   <@U123>  <@U123|name>            -> @name (from `users` when known), else @U123
 *   <#C123|name>  <#C123>            -> #name, else #C123
 *   <!here>  <!channel>  <!everyone> -> @here, @channel, @everyone
 *   <!subteam^S1|@team>  <!date^...|fallback> -> the label
 *   &amp; &lt; &gt;                  -> & < >
 */

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "channel"; id: string; text: string };

/** Slack's three escapes, undone. */
export function unescapeSlack(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function token(inner: string, users: Readonly<Record<string, string>>): Segment | null {
  const bar = inner.indexOf("|");
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? null : unescapeSlack(inner.slice(bar + 1));
  if (head.startsWith("@")) {
    const id = head.slice(1);
    if (!/^[UWB][A-Z0-9]+$/.test(id)) return null;
    const name = users[id] ?? label;
    return { kind: "user", id, text: `@${name ? name.replace(/^@/, "") : id}` };
  }
  if (head.startsWith("#")) {
    const id = head.slice(1);
    if (!/^[CGD][A-Z0-9]+$/.test(id)) return null;
    return { kind: "channel", id, text: `#${label ? label.replace(/^#/, "") : id}` };
  }
  if (head.startsWith("!")) {
    const special = head.slice(1);
    if (label) return { kind: "text", text: label };
    if (/^(here|channel|everyone)$/.test(special)) return { kind: "text", text: `@${special}` };
    return null;
  }
  const href = unescapeSlack(head);
  if (SAFE_HREF.test(href)) return { kind: "link", href, text: label || href.replace(/^mailto:/i, "") };
  return null;
}

/** Split Slack markup into display segments; `users` names `<@U…>` mentions. */
export function parseSlackMarkup(text: string, users: Readonly<Record<string, string>> = {}): Segment[] {
  const out: Segment[] = [];
  const push = (s: Segment) => {
    const last = out[out.length - 1];
    if (s.kind === "text" && last?.kind === "text") last.text += s.text;
    else if (s.kind !== "text" || s.text) out.push(s);
  };
  const re = /<([^<>\s][^<>]*)>/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    const seg = token(m[1]!, users);
    if (!seg) continue;
    push({ kind: "text", text: unescapeSlack(text.slice(at, m.index)) });
    push(seg);
    at = m.index! + m[0].length;
  }
  push({ kind: "text", text: unescapeSlack(text.slice(at)) });
  return out;
}

/** The markup as plain text (for a one-line preview). */
export function plainSlackText(text: string, users: Readonly<Record<string, string>> = {}): string {
  return parseSlackMarkup(text, users).map((s) => s.text).join("");
}

/**
 * Agent text as markdown: the agent writes markdown, but what reached Slack
 * may also carry Slack's own link and mention markup. Links become markdown
 * links, mentions their names; the rest is left for the markdown renderer.
 */
export function slackToMarkdown(text: string, users: Readonly<Record<string, string>> = {}): string {
  return parseSlackMarkup(text, users)
    .map((s) => {
      if (s.kind !== "link") return s.text;
      const label = s.text.replace(/([[\]\\])/g, "\\$1");
      return `[${label}](<${s.href.replace(/[<>]/g, encodeURIComponent)}>)`;
    })
    .join("");
}
