import type { MockMessage, MockRequest, Tag } from "./types";

const TAG_SRC = String.raw`\[\[mock:([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9-]*=[^\s\]]+)*)\s*\]\]`;
const PARAM_RE = /([a-z][a-z0-9-]*)=([^\s\]]+)/g;

function toTag(name: string, rawParams: string): Tag {
  const params: Record<string, string> = {};
  for (const p of rawParams.matchAll(PARAM_RE)) params[p[1]!] = p[2]!;
  return { name, params };
}

export function parseTag(text: string): Tag | null {
  const m = new RegExp(TAG_SRC).exec(text);
  return m ? toTag(m[1]!, m[2] ?? "") : null;
}

/**
 * Last tag in free text. A resumed thread's raw body carries every earlier turn's tag, so
 * use findTag on the parsed messages; this is only the fallback for an unparseable body.
 */
export function lastTagIn(text: string): Tag | null {
  let last: Tag | null = null;
  for (const m of text.matchAll(new RegExp(TAG_SRC, "g"))) last = toTag(m[1]!, m[2] ?? "");
  return last;
}

export function stripTags(text: string): string {
  return text.replace(new RegExp(TAG_SRC, "g"), "").replace(/\s+/g, " ").trim();
}

export function messageText(m: MockMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? "").join("\n");
  return "";
}

/** The current turn's tag: the most recent user message that carries one. */
export function findTag(req: MockRequest): { index: number; tag: Tag } | null {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const tag = parseTag(messageText(m));
    if (tag) return { index: i, tag };
  }
  return null;
}

export function paramInt(tag: Tag, key: string, dflt: number): number {
  const n = Number.parseInt(tag.params[key] ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}

export function parseDurationMs(raw: string | undefined, dflt: number): number {
  const m = /^(\d+)(ms|s)?$/.exec(raw ?? "");
  if (!m) return dflt;
  return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
}
