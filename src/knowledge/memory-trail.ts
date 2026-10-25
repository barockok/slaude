/**
 * The supersede trail (spec §8.3 "newer replaces older"). The newer page
 * names the older one in its `supersedes` frontmatter; the older page is
 * left as it was written and only gets the gbrain tag SUPERSEDED_TAG, so no
 * page is ever rebuilt from a `get_page` record (which cannot reproduce
 * every part of a page). Readers drop tagged pages with supersededSlugs.
 */
import type { BrainScope } from "./scope";

export const SUPERSEDED_TAG = "superseded";

/** Max tagged pages read per source. */
const LIST_LIMIT = 500;

export type BrainOpCall = (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;

/** get_page, with gbrain's page_not_found error read as "no page". */
export async function getPageOrNull(call: BrainOpCall, slug: string, scope: BrainScope): Promise<unknown> {
  try {
    return await call("get_page", { slug }, scope);
  } catch (e) {
    if ((e as { code?: string }).code === "page_not_found") return null;
    throw e;
  }
}

/**
 * The slugs tagged SUPERSEDED_TAG in each of `sourceIds`, read one source at
 * a time (`list_pages` with a tag filter, scoped to that source alone) so a
 * page is never judged by another memory's tag. The result is one slug set:
 * a slug tagged in any listed source counts as superseded.
 */
export async function supersededSlugs(call: BrainOpCall, scope: BrainScope, sourceIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const source of sourceIds) {
    const rows = await call("list_pages", { tag: SUPERSEDED_TAG, limit: LIST_LIMIT }, { ...scope, sourceId: source, allowedSources: [source] });
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const slug = (r as { slug?: unknown } | null)?.slug;
      if (typeof slug === "string") out.add(slug);
    }
  }
  return out;
}
