import { db } from "../db/schema";
import type { AudienceGrant } from "./scope";

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
 * Enforcement source of truth is a local sqlite index (kb_page_audience),
 * written through on every kb_memoize into an agent slice. Pages written by
 * other paths (nightly ingest, timeline entries) have no index row and get
 * the `team` default.
 */

const TIERS = new Set(["private", "manager", "team", "public"]);
const USER_TIER = /^user:[A-Za-z0-9]+$/;

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
    ? "user:" + raw.slice(5)
    : raw.toLowerCase();
  if (TIERS.has(value) || USER_TIER.test(value)) return { audience: value };
  return {
    audience: null,
    error: `"${raw}" — must be one of private|manager|team|public|user:<slack-id>`,
  };
}

const userIdEq = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/** May a page with this audience tier surface under this turn's grant?
 *  `audience: null` = unlabeled page = `team` tier. */
export function audienceVisible(audience: string | null, g: AudienceGrant): boolean {
  if (g.level === "all") return true;
  const a = audience ?? "team";
  if (a === "public") return true;
  if (a.startsWith("user:")) return g.userId !== null && userIdEq(a.slice(5), g.userId);
  if (a === "team") return g.level === "team" || g.level === "manager";
  if (a === "manager") return g.level === "manager";
  return false; // private
}

/** Upsert (or clear, when audience is null) a page's tier in the index. */
export function setPageAudience(sourceId: string, slug: string, audience: string | null): void {
  if (audience === null) {
    db.run(`DELETE FROM kb_page_audience WHERE source_id = ? AND slug = ?`, [sourceId, slug]);
    return;
  }
  db.run(
    `INSERT INTO kb_page_audience (source_id, slug, audience, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_id, slug) DO UPDATE SET audience = excluded.audience, updated_at = excluded.updated_at`,
    [sourceId, slug, audience, Date.now()],
  );
}

/** Indexed tier for a page, or null (= unlabeled → team default). */
export function pageAudience(sourceId: string, slug: string): string | null {
  const row = db
    .query(`SELECT audience FROM kb_page_audience WHERE source_id = ? AND slug = ?`)
    .get(sourceId, slug) as { audience: string } | null;
  return row?.audience ?? null;
}

const rowsFor = (sources: string[]): Array<{ slug: string; audience: string }> => {
  if (sources.length === 0) return [];
  const marks = sources.map(() => "?").join(",");
  return db
    .query(`SELECT slug, audience FROM kb_page_audience WHERE source_id IN (${marks})`)
    .all(...sources) as Array<{ slug: string; audience: string }>;
};

/** Slugs with an EXPLICIT tier the grant may not surface. (Unlabeled pages are
 *  not representable here — callers that must hide those too fail closed by
 *  stripping the sources instead; see kb_list_pages / kb_think.) */
export function hiddenSlugs(sources: string[], g: AudienceGrant): Set<string> {
  const out = new Set<string>();
  if (g.level === "all") return out;
  for (const r of rowsFor(sources)) {
    if (!audienceVisible(r.audience, g)) out.add(r.slug);
  }
  return out;
}

/** Does the grant hide ANY page in these sources? Drives the kb_think source
 *  strip: gbrain's internal gather can't filter per page, so when something is
 *  hidden the whole slice drops out of synthesis (the slaude-side cross-check
 *  gather, which CAN filter, compensates). At "public" level unlabeled pages
 *  are hidden by default and unverifiable from the index — always true. */
export function hasHiddenPages(sources: string[], g: AudienceGrant): boolean {
  if (g.level === "all") return false;
  if (g.level === "public") return true;
  return rowsFor(sources).some((r) => !audienceVisible(r.audience, g));
}
