/**
 * An in-memory stand-in for the brain ops the memory provider and kb_memoize
 * use (get_page, put_page, add_timeline_entry, get_timeline), enforcing
 * sources the way the real engine scopes them: writes land in
 * `scope.sourceId`, reads see only `scope.allowedSources`. A page's content
 * is kept per source (`contents`); get_page returns the first readable copy.
 */
import type { BrainScope } from "../../src/knowledge/scope";

export function fakeBrain() {
  /** `source\0slug` → timeline rows. */
  const pages = new Map<string, { id: number; summary: string; detail: string }[]>();
  /** `source\0slug` → the content its last put_page wrote. */
  const contents = new Map<string, string>();
  let seq = 0;
  const key = (source: string, slug: string) => `${source}\u0000${slug}`;
  const call = async (name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> => {
    const slug = String(params.slug);
    switch (name) {
      case "get_page": {
        const from = scope.allowedSources.find((s) => pages.has(key(s, slug)));
        return from === undefined ? null : { slug, content: contents.get(key(from, slug)) ?? "" };
      }
      case "put_page":
        if (!pages.has(key(scope.sourceId, slug))) pages.set(key(scope.sourceId, slug), []);
        if (typeof params.content === "string") contents.set(key(scope.sourceId, slug), params.content);
        return { slug };
      case "add_timeline_entry": {
        const rows = pages.get(key(scope.sourceId, slug));
        if (!rows) throw new Error(`no page ${slug} in ${scope.sourceId}`);
        rows.push({ id: ++seq, summary: String(params.summary), detail: String(params.detail) });
        return { ok: true };
      }
      case "get_timeline":
        return scope.allowedSources.flatMap((s) => pages.get(key(s, slug)) ?? []);
      default:
        throw new Error(`fake brain: unexpected op ${name}`);
    }
  };
  /** The sources holding a page for this session. */
  const sourcesOf = (sessionId: string) =>
    [...pages.keys()].filter((k) => k.endsWith(`\u0000conversations/${sessionId.toLowerCase()}`)).map((k) => k.split("\u0000")[0]!);
  const seed = (source: string, sessionId: string, detail: string) => {
    const slug = `conversations/${sessionId.toLowerCase()}`;
    const rows = pages.get(key(source, slug)) ?? [];
    rows.push({ id: ++seq, summary: detail, detail });
    pages.set(key(source, slug), rows);
  };
  /** A page's content in one source, or undefined. */
  const contentOf = (source: string, slug: string) => contents.get(key(source, slug));
  return { call, pages, contents, contentOf, sourcesOf, seed };
}
