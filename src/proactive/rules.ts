/**
 * Learned proactive rules: what the agent may do about a kind of thing in a
 * place, taught by a person's reaction. One `proactive-rule` page per
 * (kind, scope) in the agent's own slice. A rule can only lower the level the
 * SOUL's ceiling allows; the model's proposed level can only lower it further.
 */
import { composePage, readPageRecord } from "../knowledge/memory-pages";
import { getPageOrNull, supersededSlugs, type BrainOpCall } from "../knowledge/memory-trail";
import { agentSourceId, type BrainScope } from "../knowledge/scope";
import { minLevel, parseLevel, type Level } from "./levels";

export const RULE_PREFIX = "rules/proactive/";
export const JOURNAL_SLUG = "self/heartbeat-journal";
export const JOURNAL_MAX_CHARS = 4000;

/** gbrain's list_pages ceiling per call. */
const LIST_LIMIT = 500;
const FIELD_MAX = 500;

export interface ProactiveRule {
  slug: string;
  kind: string;
  /** A channel id, a DM user id, or "global". */
  scope: string;
  level: Level;
  how: string | null;
  taughtBy: string;
  taughtAt: string;
  thread: string;
  quote: string | null;
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const normKind = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ");
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim().slice(0, FIELD_MAX);

const agentScope = (agentId: string): BrainScope => {
  const source = agentSourceId(agentId);
  return { clientId: agentId, sourceId: source, allowedSources: [source] };
};

/** The agent's live rules; superseded and unparsable pages are skipped. */
export async function loadRules(agentId: string, call: BrainOpCall): Promise<ProactiveRule[]> {
  const scope = agentScope(agentId);
  const rows = await call("list_pages", { type: "proactive-rule", limit: LIST_LIMIT }, scope);
  if (!Array.isArray(rows)) return [];
  const gone = await supersededSlugs(call, scope, [scope.sourceId]);
  const out: ProactiveRule[] = [];
  for (const row of rows) {
    const slug = (row as { slug?: unknown } | null)?.slug;
    if (typeof slug !== "string" || gone.has(slug)) continue;
    const rec = readPageRecord(await getPageOrNull(call, slug, scope));
    if (!rec || rec.superseded) continue;
    const m = rec.meta;
    const level = m.level === undefined ? null : parseLevel(m.level);
    if (!level || !m.kind || !m.scope) continue;
    out.push({
      slug, kind: m.kind, scope: m.scope, level,
      how: m.how || null,
      taughtBy: m.taught_by ?? "", taughtAt: m.taught_at ?? "", thread: m.thread ?? "",
      quote: m.quote || null,
    });
  }
  return out;
}

/**
 * The level for an item: the matching rule's level (else `inform`), lowered by
 * the model's proposal and the SOUL ceiling. Rule choice: a named rule scoped
 * to the destination or global; else the destination's rule for the kind; else
 * the global one.
 */
export function resolveLevel(a: {
  rules: readonly ProactiveRule[];
  ruleSlug?: string;
  kind: string;
  destination: string;
  proposed: Level;
  highest: Level;
}): { level: Level; rule: ProactiveRule | null } {
  const kind = normKind(a.kind);
  const named = a.ruleSlug === undefined ? undefined : a.rules.find((r) => r.slug === a.ruleSlug && (r.scope === a.destination || r.scope === "global"));
  const byScope = (scope: string) => a.rules.find((r) => r.scope === scope && normKind(r.kind) === kind);
  const rule = named ?? byScope(a.destination) ?? byScope("global") ?? null;
  const base: Level = rule ? rule.level : "inform";
  return { level: minLevel(minLevel(base, a.proposed), a.highest), rule };
}

/** The page for a rule, or why it is refused. */
export function composeRulePage(
  r: Omit<ProactiveRule, "slug"> & { slug?: string; supersedes?: string },
  now: Date,
): { slug: string; content: string } | { error: string } {
  const scopeTag = r.scope === "global" ? "global" : r.scope.toLowerCase();
  const slug = r.slug ?? `${RULE_PREFIX}${slugify(r.kind)}-${scopeTag}`;
  const fields: Record<string, string> = {
    kind: oneLine(r.kind), scope: oneLine(r.scope), level: r.level,
    taught_by: oneLine(r.taughtBy), taught_at: oneLine(r.taughtAt), thread: oneLine(r.thread),
  };
  if (r.how) fields.how = oneLine(r.how);
  if (r.quote && r.scope !== "global") fields.quote = oneLine(r.quote);
  const page = composePage({
    slug,
    type: "proactive-rule",
    content: `When "${fields.kind}" comes up in ${fields.scope}: ${r.level}.`,
    subject: oneLine(r.taughtBy),
    source: oneLine(r.thread),
    ...(r.supersedes !== undefined ? { supersedes: r.supersedes } : {}),
    fields,
  }, now);
  return "error" in page ? page : { slug, content: page.content };
}
