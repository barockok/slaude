/**
 * An in-memory stand-in for the brain ops the memory provider and kb_memoize
 * use (get_page, put_page, add_tag, remove_tag, list_pages by tag and type, add_timeline_entry,
 * get_timeline), enforcing
 * sources the way the real engine scopes them: writes land in
 * `scope.sourceId`, reads see only `scope.allowedSources`. A page's content
 * is kept per source (`contents`); get_page returns the first readable copy.
 */
import type { BrainScope } from "../../src/knowledge/scope";
import { parseFrontmatter } from "../../src/knowledge/memory-pages";

export function fakeBrain() {
  /** `source\0slug` → timeline rows. */
  const pages = new Map<string, { id: number; summary: string; detail: string }[]>();
  /** `source\0slug` → the content its last put_page wrote. */
  const contents = new Map<string, string>();
  /** `source\0slug` → its tags. */
  const tags = new Map<string, Set<string>>();
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
      case "add_tag": {
        if (!pages.has(key(scope.sourceId, slug))) throw Object.assign(new Error(`page not found: ${slug}`), { code: "page_not_found" });
        const t = tags.get(key(scope.sourceId, slug)) ?? new Set<string>();
        t.add(String(params.tag));
        tags.set(key(scope.sourceId, slug), t);
        return { ok: true };
      }
      case "remove_tag": {
        tags.get(key(scope.sourceId, slug))?.delete(String(params.tag));
        return { ok: true };
      }
      case "list_pages": {
        const want = params.tag === undefined ? null : String(params.tag);
        // A type filter matches the page's frontmatter `type`, as gbrain
        // derives a page's type from it.
        const wantType = params.type === undefined ? null : String(params.type);
        return [...pages.keys()]
          .map((k) => k.split("\u0000") as [string, string])
          .filter(([src, sl]) => scope.allowedSources.includes(src) && (want === null || (tags.get(key(src, sl))?.has(want) ?? false)))
          .filter(([src, sl]) => wantType === null || parseFrontmatter(contents.get(key(src, sl)) ?? "").meta.type === wantType)
          .map(([, sl]) => ({ slug: sl }));
      }
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
  /** A page's tags in one source. */
  const tagsOf = (source: string, slug: string) => [...(tags.get(key(source, slug)) ?? [])];
  return { call, pages, contents, contentOf, tagsOf, sourcesOf, seed };
}
