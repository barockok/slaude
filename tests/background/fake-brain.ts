import type { BrainScope } from "../../src/knowledge/scope";

/** In-memory brain op caller: pages per source, every call recorded with its scope. */
export function fakeBrain() {
  const pages = new Map<string, Map<string, { content: string; tags: Set<string>; type?: string }>>();
  const calls: Array<{ name: string; params: Record<string, unknown>; scope: BrainScope }> = [];
  /** Timeline rows per source, per slug (get_timeline). */
  const timelines = new Map<string, Map<string, unknown[]>>();
  const src = (s: string) => {
    let m = pages.get(s);
    if (!m) pages.set(s, (m = new Map()));
    return m;
  };
  const typeOf = (content: string) => /^---\n[\s\S]*?^type: ([a-z-]+)$/m.exec(content)?.[1];
  const call = async (name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> => {
    calls.push({ name, params, scope });
    const [only] = scope.allowedSources;
    switch (name) {
      case "get_page": {
        const pg = pages.get(only!)?.get(params.slug as string);
        if (!pg) throw Object.assign(new Error("page not found"), { code: "page_not_found" });
        return { content: pg.content, tags: [...pg.tags] };
      }
      case "list_pages": {
        const rows = [...(pages.get(only!) ?? new Map()).entries()]
          .filter(([, p]) => (params.type === undefined || p.type === params.type) && (params.tag === undefined || p.tags.has(params.tag as string)))
          .map(([slug, p]) => ({ slug, type: p.type }));
        return rows;
      }
      case "search": {
        const q = String(params.query).toLowerCase();
        return [...(pages.get(only!) ?? new Map()).entries()]
          .filter(([, p]) => p.content.toLowerCase().includes(q))
          .map(([slug]) => ({ slug, source_id: only, score: 1 }));
      }
      case "get_timeline":
        return timelines.get(only!)?.get(params.slug as string) ?? [];
      case "add_timeline_entry": {
        let m = timelines.get(scope.sourceId);
        if (!m) timelines.set(scope.sourceId, (m = new Map()));
        const rows = m.get(params.slug as string) ?? [];
        rows.push({ id: rows.length + 1, ...params });
        m.set(params.slug as string, rows);
        return { ok: true };
      }
      case "put_page": {
        const content = params.content as string;
        const prev = src(scope.sourceId).get(params.slug as string);
        src(scope.sourceId).set(params.slug as string, { content, tags: prev?.tags ?? new Set(), type: typeOf(content) });
        return { ok: true };
      }
      case "add_tag":
        src(scope.sourceId).get(params.slug as string)?.tags.add(params.tag as string);
        return { ok: true };
      case "remove_tag":
        src(scope.sourceId).get(params.slug as string)?.tags.delete(params.tag as string);
        return { ok: true };
      default:
        throw new Error(`fake brain: unexpected op ${name}`);
    }
  };
  const seed = (source: string, slug: string, content: string) => src(source).set(slug, { content, tags: new Set(), type: typeOf(content) });
  const seedTimeline = (source: string, slug: string, rows: unknown[]) => {
    let m = timelines.get(source);
    if (!m) timelines.set(source, (m = new Map()));
    m.set(slug, rows);
  };
  /** Every source any call read or wrote. */
  const touched = () => new Set(calls.flatMap((c) => [c.scope.sourceId, ...c.scope.allowedSources]));
  return { call, calls, pages, timelines, seed, seedTimeline, touched };
}
