import type { AudienceGrant, BrainScope } from "./scope";

/**
 * Audience share-tiers for the agent's own mind.
 *
 * A page in an agent slice may declare, via YAML frontmatter, WHO it is fair
 * to surface to:
 *
 *   ---
 *   audience: manager        # private | manager | team | public | user:<id>
 *   ---
 *
 * Tiers (each turn context has a grant level — see AudienceGrant in scope.ts):
 *   private    — the agent alone: background/cron turns only.
 *   manager    — manager turns and up.
 *   team       — trusted channels / own-1on1 turns and up. DEFAULT for
 *                unlabeled pages (preserves pre-feature behavior).
 *   public     — every turn where the agent's mind is readable at all.
 *   user:<id>  — only turns where that Slack user is the current speaker
 *                (any level except it always passes "all").
 *
 * This is a DISCLOSURE filter, not access control: the agent slice is only
 * ever read by the agent itself; the filter keeps restricted pages out of the
 * model's context on lower-trust turns so they cannot leak into replies. It
 * is self-declared by the agent at write time — safe, because it only ever
 * RESTRICTS the agent's own recall; escalating a page to other readers still
 * goes through the destination-classified write gate (target:"shared").
 *
 * STORAGE IS BRAIN TAGS, not a slaude-side index — the brain stays the single
 * source of truth (remote brain-server deploys, restores, other writers), and
 * tiers are auditable with plain kb_list_pages({tag:"audience:manager"}).
 * kb_memoize derives tags from the frontmatter: `audience:<tier>`, plus for
 * user tiers a marker pair `audience:user` + `audience:user:<ID>` (user ids
 * aren't enumerable, the marker makes "any user-restricted page?" one query).
 * gbrain's own put_page tag reconciliation is ADD-ONLY (their #1621), so a
 * demoted tier would leave the old tag behind and fail OPEN — slaude
 * reconciles explicitly (get_tags → remove stale → add current) instead.
 */

const TIERS = new Set(["private", "manager", "team", "public"]);
const USER_TIER = /^user:[A-Za-z0-9]+$/;

export const AUDIENCE_TAG_PREFIX = "audience:";
/** Marker tag carried by every user-tier page alongside audience:user:<ID>. */
export const AUDIENCE_USER_MARKER = "audience:user";

export type ParsedAudience = { audience: string | null; error?: string };

/** Extract + validate the `audience:` key from a page's leading YAML
 *  frontmatter. No frontmatter / no key → { audience: null } (team default). */
export function parseAudience(content: string): ParsedAudience {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!fm) return { audience: null };
  const line = /^audience:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]!);
  if (!line) return { audience: null };
  const raw = line[1]!.replace(/^["']|["']$/g, "");
  const value = raw.startsWith("user:") || raw.startsWith("USER:")
    ? "user:" + raw.slice(5).toUpperCase()
    : raw.toLowerCase();
  if (TIERS.has(value) || USER_TIER.test(value)) return { audience: value };
  return {
    audience: null,
    error: `"${raw}" — must be one of private|manager|team|public|user:<slack-id>`,
  };
}

/** May a page with this audience tier surface under this turn's grant?
 *  `audience: null` = unlabeled page = `team` tier. */
export function audienceVisible(audience: string | null, g: AudienceGrant): boolean {
  if (g.level === "all") return true;
  const a = audience ?? "team";
  if (a === "public") return true;
  if (a.startsWith("user:")) return g.userId !== null && a.slice(5).toUpperCase() === g.userId.toUpperCase();
  if (a === "team") return g.level === "team" || g.level === "manager";
  if (a === "manager") return g.level === "manager";
  return false; // private
}

/** Brain tags encoding a tier. Tag matching is exact-string in SQL, so user
 *  ids are normalized uppercase (parseAudience does the same). */
export function audienceTags(audience: string): string[] {
  if (audience.startsWith("user:")) {
    return [AUDIENCE_USER_MARKER, `${AUDIENCE_TAG_PREFIX}user:${audience.slice(5).toUpperCase()}`];
  }
  return [`${AUDIENCE_TAG_PREFIX}${audience}`];
}

export type BrainCallFn = (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;

/** Single-source read/write scope for tag ops — get_tags/add_tag/remove_tag
 *  thread ctx.sourceId, so the source must be explicit, not the turn default. */
const sub = (scope: BrainScope, sourceId: string): BrainScope => ({
  clientId: scope.clientId,
  sourceId,
  allowedSources: [sourceId],
});

const asTagList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []);

/** Tier of a page as recorded in brain tags, or null (unlabeled → team).
 *  A bare marker without its audience:user:<ID> pair reads as a user tier
 *  for nobody — fails closed via audienceVisible. */
export async function pageAudienceFromTags(
  call: BrainCallFn, scope: BrainScope, sourceId: string, slug: string,
): Promise<string | null> {
  const tags = asTagList(await call("get_tags", { slug }, sub(scope, sourceId)));
  const tier = tags.find((t) => t.startsWith(AUDIENCE_TAG_PREFIX) && t !== AUDIENCE_USER_MARKER);
  if (tier) return tier.slice(AUDIENCE_TAG_PREFIX.length);
  return tags.includes(AUDIENCE_USER_MARKER) ? "user:" : null;
}

/** Make a page's audience tags match its frontmatter tier exactly. Explicit
 *  remove-then-add because gbrain's put_page reconciliation is add-only —
 *  without this a demoted page keeps its old (more permissive) tag. */
export async function reconcileAudienceTags(
  call: BrainCallFn, scope: BrainScope, slug: string, audience: string | null,
): Promise<void> {
  const current = asTagList(await call("get_tags", { slug }, scope)).filter((t) => t.startsWith(AUDIENCE_TAG_PREFIX));
  const desired = audience === null ? [] : audienceTags(audience);
  for (const t of current) {
    if (!desired.includes(t)) await call("remove_tag", { slug, tag: t }, scope);
  }
  for (const t of desired) {
    if (!current.includes(t)) await call("add_tag", { slug, tag: t }, scope);
  }
}

export interface AudienceFilter {
  /** May this (source, slug) surface? Non-tiered sources always pass. */
  visible(sourceId: string, slug: string): boolean;
  /** Does the grant hide ANYTHING in the tiered sources? Drives the kb_think
   *  source strip (gbrain's internal gather can't filter per page). */
  anyHidden: boolean;
}

const PASS_ALL: AudienceFilter = { visible: () => true, anyHidden: false };
const HIDE_TIERED = (tiered: string[]): AudienceFilter => ({
  visible: (src) => !tiered.includes(src),
  anyHidden: true,
});

// list_pages caps at 100 rows with no pagination. A full page means the slug
// set may be truncated — an incomplete HIDDEN set would fail open, so the
// whole source is treated as hidden for the turn instead. (A truncated
// VISIBLE set at public level under-shows, which already fails closed.)
const LIST_LIMIT = 100;

/**
 * Build the per-turn disclosure filter from brain tags: one slug-set query per
 * relevant audience tag per tiered source. team/manager levels compute the
 * HIDDEN set (explicitly-restricted pages); public level computes the VISIBLE
 * set (only `audience:public` + the speaker's own user tier — unlabeled pages
 * default to team and stay hidden there). Any query failure → tiered sources
 * fully hidden (fail closed).
 */
export async function buildAudienceFilter(call: BrainCallFn, scope: BrainScope): Promise<AudienceFilter> {
  const g = scope.audience;
  const tiered = scope.audienceSources ?? [];
  if (!g || g.level === "all" || tiered.length === 0) return PASS_ALL;
  const uid = g.userId ? g.userId.toUpperCase() : null;

  const listSlugs = async (src: string, tag: string): Promise<{ slugs: Set<string>; full: boolean }> => {
    const rows = await call("list_pages", { tag, limit: LIST_LIMIT }, sub(scope, src));
    const arr = Array.isArray(rows) ? rows : [];
    const slugs = new Set<string>();
    for (const r of arr) {
      const s = (r as { slug?: unknown }).slug;
      if (typeof s === "string" && s) slugs.add(s);
    }
    return { slugs, full: arr.length >= LIST_LIMIT };
  };

  try {
    if (g.level === "public") {
      const visible = new Map<string, Set<string>>();
      for (const src of tiered) {
        const pub = await listSlugs(src, `${AUDIENCE_TAG_PREFIX}public`);
        const mine = uid ? await listSlugs(src, `${AUDIENCE_TAG_PREFIX}user:${uid}`) : { slugs: new Set<string>() };
        visible.set(src, new Set([...pub.slugs, ...mine.slugs]));
      }
      return {
        visible: (src, slug) => !tiered.includes(src) || (visible.get(src)?.has(slug) ?? false),
        anyHidden: true, // unlabeled pages are hidden at this level, always
      };
    }
    // team | manager: hidden = private (+ manager at team) + user:<not me>
    const hidden = new Map<string, Set<string> | "all">();
    let any = false;
    for (const src of tiered) {
      const parts = [await listSlugs(src, `${AUDIENCE_TAG_PREFIX}private`)];
      if (g.level === "team") parts.push(await listSlugs(src, `${AUDIENCE_TAG_PREFIX}manager`)); // eslint-disable-line no-await-in-loop
      const userAll = await listSlugs(src, AUDIENCE_USER_MARKER);
      const userMine = uid ? await listSlugs(src, `${AUDIENCE_TAG_PREFIX}user:${uid}`) : { slugs: new Set<string>(), full: false };
      const set = new Set<string>();
      for (const p of parts) for (const s of p.slugs) set.add(s);
      for (const s of userAll.slugs) if (!userMine.slugs.has(s)) set.add(s);
      const overflow = parts.some((p) => p.full) || userAll.full;
      hidden.set(src, overflow ? "all" : set);
      if (overflow || set.size > 0) any = true;
    }
    return {
      visible: (src, slug) => {
        const h = hidden.get(src);
        if (h === undefined) return true;
        return h === "all" ? false : !h.has(slug);
      },
      anyHidden: any,
    };
  } catch {
    return HIDE_TIERED(tiered);
  }
}
