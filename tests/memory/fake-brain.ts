/**
 * An in-memory stand-in for the brain ops the memory provider uses (get_page,
 * put_page, add_timeline_entry, get_timeline), enforcing sources the way the
 * real engine scopes them: writes land in `scope.sourceId`, reads see only
 * `scope.allowedSources`.
 */
import type { BrainScope } from "../../src/knowledge/scope";

export function fakeBrain() {
  /** `source\0slug` → timeline rows. */
  const pages = new Map<string, { id: number; summary: string; detail: string }[]>();
  let seq = 0;
  const key = (source: string, slug: string) => `${source}\u0000${slug}`;
  const call = async (name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> => {
    const slug = String(params.slug);
    switch (name) {
      case "get_page":
        return scope.allowedSources.some((s) => pages.has(key(s, slug))) ? { slug } : null;
      case "put_page":
        if (!pages.has(key(scope.sourceId, slug))) pages.set(key(scope.sourceId, slug), []);
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
  return { call, pages, sourcesOf, seed };
}
