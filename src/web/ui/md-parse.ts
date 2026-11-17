/**
 * A small markdown parser for the console: text in, a plain AST out. It never
 * produces HTML. The React renderer (Markdown.tsx) turns the AST into elements,
 * so every string reaches the page as text and React escapes it; raw HTML in
 * the source stays visible as text and is never interpreted.
 *
 * Covered: YAML frontmatter (top-level keys), ATX and setext headings,
 * paragraphs, emphasis (strong, em, strikethrough), inline code, fenced code
 * blocks, bullet and ordered lists (nested, task items), blockquotes, GFM
 * tables, links and autolinks, horizontal rules, hard and soft line breaks.
 * Not covered on purpose: raw HTML, images (shown as their alt text and link),
 * reference-style links, indented code blocks, footnotes.
 *
 * Links: only http, https and mailto become links (see safeHref); anything
 * else (javascript:, data:, vbscript:, relative paths) renders as plain text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** null: not a task item; true or false: a checked or open task. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "paragraph"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { t: "blockquote"; blocks: Block[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

export interface Frontmatter {
  /** The YAML text between the fences, as written. */
  raw: string;
  /** Top-level keys in order; nested values are kept as their text. */
  entries: Array<{ key: string; value: string }>;
}

export interface MdDoc {
  frontmatter: Frontmatter | null;
  blocks: Block[];
}

const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;

/**
 * The href to use for a link target, or null when it must not be a link.
 * Control characters and whitespace are dropped before the scheme check, so
 * `java\tscript:` or a leading NUL cannot slip past it.
 */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (!SAFE_SCHEME.test(cleaned)) return null;
  if (/^mailto:$/i.test(cleaned) || /^https?:\/\/$/i.test(cleaned)) return null;
  return cleaned;
}

// --- frontmatter ---------------------------------------------------------------

const unquote = (s: string) => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

function parseFrontmatter(raw: string): Frontmatter {
  const entries: Frontmatter["entries"] = [];
  let cur: { key: string; parts: string[]; list: boolean } | null = null;
  const flush = () => {
    if (!cur) return;
    entries.push({ key: cur.key, value: cur.list ? cur.parts.join(", ") : cur.parts.join("\n").trim() });
    cur = null;
  };
  for (const line of raw.split("\n")) {
    const top = /^([A-Za-z0-9_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (top) {
      flush();
      const v = top[2]!.trim();
      if (v === "|" || v === ">" || v === "|-" || v === ">-") cur = { key: top[1]!, parts: [], list: false };
      else cur = { key: top[1]!, parts: v ? [unquote(v)] : [], list: false };
      continue;
    }
    if (!cur || !line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    const c = cur as { key: string; parts: string[]; list: boolean };
    if (item && (c.list || c.parts.length === 0)) {
      c.list = true;
      c.parts.push(unquote(item[1]!));
    } else {
      c.parts.push(line.trim());
    }
  }
  flush();
  return { raw, entries };
}

/** Split leading `---` YAML frontmatter from the body. */
export function splitFrontmatter(src: string): { frontmatter: Frontmatter | null; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { frontmatter: null, body: src };
  return { frontmatter: parseFrontmatter(m[1]!.replace(/\r/g, "")), body: src.slice(m[0].length) };
}

// --- blocks --------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( {0,3})([-*+])([ \t]+(.*)|[ \t]*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+(.*)|[ \t]*)$/;
const SETEXT1 = /^ {0,3}=+[ \t]*$/;
const SETEXT2 = /^ {0,3}-+[ \t]*$/;
const DELIM_CELL = /^[ \t]*:?-+:?[ \t]*$/;

const isBlank = (l: string) => l.trim() === "";
const expandTabs = (l: string) => l.replace(/\t/g, "    ");

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (head === undefined || delim === undefined || !head.includes("|") || !delim.includes("-")) return false;
  const cells = splitRow(delim);
  if (!cells.every((c) => DELIM_CELL.test(c))) return false;
  return splitRow(head).length === cells.length;
}

interface ListMarker {
  ordered: boolean;
  /** Bullet char or ordered delimiter, so a change of marker starts a new list. */
  kind: string;
  start: number;
  /** Columns before the item's content. */
  contentIndent: number;
  first: string;
}

function listMarker(line: string): ListMarker | null {
  const b = BULLET.exec(line);
  if (b) {
    if (HR.test(line)) return null;
    const lead = b[1]!.length + 1;
    const gap = b[4] !== undefined ? b[3]!.length - b[4].length : 1;
    return { ordered: false, kind: b[2]!, start: 1, contentIndent: lead + (gap > 4 ? 1 : Math.max(1, gap)), first: b[4] ?? "" };
  }
  const o = ORDERED.exec(line);
  if (o) {
    const lead = o[1]!.length + o[2]!.length + 1;
    const gap = o[5] !== undefined ? o[4]!.length - o[5].length : 1;
    return { ordered: true, kind: o[3]!, start: Number(o[2]), contentIndent: lead + (gap > 4 ? 1 : Math.max(1, gap)), first: o[5] ?? "" };
  }
  return null;
}

/** Whether a line opens a block that interrupts a paragraph. */
function interrupts(lines: string[], i: number): boolean {
  const l = lines[i]!;
  if (FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l)) return true;
  const m = listMarker(l);
  // An ordered list interrupts a paragraph only when it starts at 1, and an
  // empty item never does (CommonMark), so "2024. was a year" stays text.
  if (m && m.first.trim() !== "" && (!m.ordered || m.start === 1)) return true;
  return isTableStart(lines, i);
}

function parseList(lines: string[], i: number, first: ListMarker, depth: number): { block: Block; next: number } {
  const items: ListItem[] = [];
  let tight = true;
  let marker: ListMarker | null = first;
  while (marker && i < lines.length) {
    const body: string[] = [marker.first];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        body.push("");
        sawBlank = true;
        i++;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent >= marker.contentIndent) {
        body.push(line.slice(marker.contentIndent));
        if (sawBlank) tight = false;
        sawBlank = false;
        i++;
        continue;
      }
      if (sawBlank) break;
      // A lazy continuation line of the item's paragraph.
      if (!interrupts(lines, i) && !listMarker(line)) {
        body.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    while (body.length && isBlank(body[body.length - 1]!)) body.pop();
    let checked: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0] ?? "");
    if (task) {
      checked = task[1] !== " ";
      body[0] = body[0]!.slice(task[0].length);
    }
    items.push({ checked, blocks: parseBlocks(body, depth + 1) });
    // Rewind over trailing blank lines so the next item (or block) sees them.
    let j = i;
    while (j > 0 && isBlank(lines[j - 1]!)) j--;
    const blankBetween = j < i;
    const next = i < lines.length ? listMarker(lines[i]!) : null;
    if (next && next.ordered === first.ordered && next.kind === first.kind) {
      if (blankBetween) tight = false;
      marker = next;
    } else {
      marker = null;
      i = j;
    }
  }
  return { block: { t: "list", ordered: first.ordered, start: first.start, tight, items }, next: i };
}

/** Nesting beyond this (quotes in quotes, lists in lists) is kept as text. */
const MAX_DEPTH = 16;

export function parseBlocks(input: string[], depth = 0): Block[] {
  if (depth > MAX_DEPTH) return [{ t: "paragraph", c: [{ t: "text", v: input.join("\n") }] }];
  const lines = input.map(expandTabs);
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) {
          i++;
          break;
        }
        let k = 0;
        while (k < indent && l[k] === " ") k++;
        code.push(l.slice(k));
        i++;
      }
      out.push({ t: "code", lang: fence[3] ?? "", v: code.join("\n") });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      out.push({ t: "heading", level: atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(atx[2] ?? "") });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const q = QUOTE.exec(lines[i]!);
        if (q) inner.push(q[1]!);
        else if (!interrupts(lines, i)) inner.push(lines[i]!.trim());
        else break;
        i++;
      }
      out.push({ t: "blockquote", blocks: parseBlocks(inner, depth + 1) });
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const { block, next } = parseList(lines, i, marker, depth);
      out.push(block);
      i = next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]!).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
        i++;
      }
      out.push({ t: "table", align, head: head.map((h) => parseInline(h)), rows });
      continue;
    }

    // Paragraph, possibly closed by a setext underline.
    const para: string[] = [line];
    i++;
    let level: 1 | 2 | null = null;
    while (i < lines.length && !isBlank(lines[i]!)) {
      if (SETEXT1.test(lines[i]!)) {
        level = 1;
        i++;
        break;
      }
      if (SETEXT2.test(lines[i]!)) {
        level = 2;
        i++;
        break;
      }
      if (interrupts(lines, i)) break;
      para.push(lines[i]!);
      i++;
    }
    const text = para.map((l) => l.replace(/^ {0,3}/, "")).join("\n");
    out.push(level ? { t: "heading", level, c: parseInline(text.trim()) } : { t: "paragraph", c: parseInline(text) });
  }
  return out;
}

// --- inline --------------------------------------------------------------------

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntity(name: string): string | null {
  if (name[0] === "#") {
    const n = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return null;
    return String.fromCodePoint(n);
  }
  return ENTITIES[name] ?? null;
}

/** The index of the `]` that closes the `[` at `open`, or -1. */
function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end !== -1) i = end + run.length - 1;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

/** `(url "title")` after a link's text: the url and the index after `)`. */
function linkTarget(s: string, at: number): { url: string; end: number } | null {
  if (s[at] !== "(") return null;
  let i = at + 1;
  while (s[i] === " ") i++;
  let url = "";
  if (s[i] === "<") {
    const close = s.indexOf(">", i);
    if (close === -1) return null;
    url = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\" && i + 1 < s.length) {
        url += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      if (/\s/.test(ch)) break;
      url += ch;
      i++;
    }
  }
  while (s[i] === " ") i++;
  if (s[i] === '"' || s[i] === "'") {
    const q = s[i]!;
    const close = s.indexOf(q, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (s[i] === " ") i++;
  }
  if (s[i] !== ")") return null;
  return { url, end: i + 1 };
}

const BARE_URL = /^(?:https?:\/\/|mailto:)[^\s<>]*[^\s<>.,:;"')\]!?*_~]/i;

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Find a closing delimiter run for emphasis that is not preceded by whitespace. */
function findClose(s: string, from: number, delim: string): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      i = end === -1 ? i + run.length : end + run.length;
      continue;
    }
    if (ch === "[") {
      const close = closingBracket(s, i);
      if (close !== -1) {
        const t = linkTarget(s, close + 1);
        if (t) {
          i = t.end;
          continue;
        }
      }
    }
    if (s.startsWith(delim, i) && i > from && !/\s/.test(s[i - 1]!)) {
      // For a single delimiter, skip a doubled one (it belongs to strong).
      if (delim.length === 1 && s[i + 1] === delim && s[i - 1] !== delim) {
        const inner = findClose(s, i + 2, delim + delim);
        if (inner !== -1) {
          i = inner + 2;
          continue;
        }
      }
      if (delim[0] === "_" && /[\p{L}\p{N}]/u.test(s[i + delim.length] ?? "")) {
        i += delim.length;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return s ? [{ t: "text", v: s }] : [];
  const out: Inline[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < s.length) {
    const ch = s[i]!;

    if (ch === "\\") {
      const next = s[i + 1];
      if (next === "\n") {
        flush();
        out.push({ t: "br" });
        i += 2;
        continue;
      }
      if (next !== undefined && PUNCT.test(next)) {
        text += next;
        i += 2;
        continue;
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === "\n") {
      // Trailing spaces before the newline do not show; every newline breaks
      // the line, since agent replies are written line by line like chat.
      text = text.replace(/ +$/, "");
      flush();
      out.push({ t: "br" });
      i++;
      while (s[i] === " ") i++;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      // The closing run must be exactly as long as the opening one.
      let close = end;
      while (close !== -1 && s[close + run.length] === "`") close = s.indexOf(run, close + run.length + 1);
      if (close !== -1) {
        flush();
        let v = s.slice(i + run.length, close).replace(/\n/g, " ");
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (ch === "&") {
      const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/.exec(s.slice(i));
      const dec = m ? decodeEntity(m[1]!) : null;
      if (m && dec !== null) {
        text += dec;
        i += m[0].length;
        continue;
      }
    }

    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      const href = m ? safeHref(m[1]!) : null;
      if (m && href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }

    if (ch === "[" || (ch === "!" && s[i + 1] === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const close = closingBracket(s, open);
      const target = close !== -1 ? linkTarget(s, close + 1) : null;
      if (target) {
        flush();
        const label = s.slice(open + 1, close);
        const inner = parseInline(label, depth + 1);
        const href = safeHref(target.url);
        // Images are never loaded: their alt text stands in, linked when safe.
        if (href) out.push({ t: "link", href, c: inner.length ? inner : [{ t: "text", v: target.url }] });
        else for (const n of inner) if (n.t === "text") pushText(out, n.v); else out.push(n);
        i = target.end;
        continue;
      }
    }

    if ((ch === "h" || ch === "H" || ch === "m" || ch === "M") && (i === 0 || /[\s(*_~]/.test(s[i - 1]!))) {
      const m = BARE_URL.exec(s.slice(i));
      const href = m ? safeHref(m[0]) : null;
      if (m && href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const double = s[i + 1] === ch;
      if (ch === "~" && !double) {
        text += ch;
        i++;
        continue;
      }
      const delim = double ? ch + ch : ch;
      const after = s[i + delim.length];
      const before = i > 0 ? s[i - 1]! : " ";
      const opens = after !== undefined && !/\s/.test(after) && !(ch === "_" && /[\p{L}\p{N}]/u.test(before));
      if (opens) {
        const close = findClose(s, i + delim.length, delim);
        if (close !== -1) {
          flush();
          const c = parseInline(s.slice(i + delim.length, close), depth + 1);
          out.push(ch === "~" ? { t: "del", c } : double ? { t: "strong", c } : { t: "em", c });
          i = close + delim.length;
          continue;
        }
      }
      text += delim;
      i += delim.length;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Parse a markdown document: frontmatter (when present) and its blocks. */
export function parseMarkdown(src: string): MdDoc {
  const { frontmatter, body } = splitFrontmatter(src.replace(/\r\n?/g, "\n"));
  return { frontmatter, blocks: parseBlocks(body.split("\n")) };
}
