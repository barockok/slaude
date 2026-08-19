import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadKbs } from "./loader";
import { brainCall, brainEnabled } from "./brain";
import { brainThink, sdkThinkClient } from "./brain-think";
import { gather } from "./gather";
import { gatedBrainCall, type ApprovalReq, type ApprovalRes, type GateInput } from "./gated-dispatch";
import { SHARED_SOURCE, agentSourceId, type BrainScope } from "./scope";
import { audienceVisible, buildAudienceFilter, pageAudienceFromTags, parseAudience, reconcileAudienceTags } from "./audience";
import { agentIdReady } from "./agent-identity";

export const KB_MCP_NAME = "slaude_kb";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function scoreKb(kb: ReturnType<typeof loadKbs>[number], queryTokens: string[]): number {
  let score = 0;
  const labelTokens = tokenize(kb.label);
  const descTokens = tokenize(kb.description);
  // Split hyphenated tags so "service-a" yields "service-a", "service", "a"
  const tagTokens = kb.tags.flatMap((t) => [t, ...t.split(/[^a-z0-9]+/)]);
  for (const qt of queryTokens) {
    if (tagTokens.some((t) => t === qt)) score += 10;
    if (labelTokens.some((t) => t === qt)) score += 5;
    if (labelTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 2;
    if (descTokens.some((t) => t === qt)) score += 3;
    if (descTokens.some((t) => t.includes(qt) || qt.includes(t))) score += 1;
  }
  return score;
}

export const kbHandlers = {
  async list_kbs(): Promise<ToolResult> {
    const kbs = loadKbs();
    if (kbs.length === 0) return ok("(no knowledge bases installed)");
    return ok(JSON.stringify(kbs, null, 2));
  },

  async search_kbs({ query, limit }: { query: string; limit?: number }): Promise<ToolResult> {
    const kbs = loadKbs();
    if (kbs.length === 0) return ok("(no knowledge bases installed)");
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return err("query too short or empty after tokenization");
    const scored = kbs
      .map((kb) => ({ kb, score: scoreKb(kb, queryTokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit ?? 5)
      .map((s) => s.kb);
    if (scored.length === 0) return ok("(no matching knowledge bases)");
    return ok(JSON.stringify(scored, null, 2));
  },
};

export interface BrainToolDeps {
  scope: () => BrainScope;
  gate: () => GateInput;
  /** Manager + backup user ids — hard backstop for kb-admin approvals. */
  managers: () => string[];
  requestApproval: (r: ApprovalReq) => Promise<ApprovalRes>;
  /** Injectable op caller (tests). Default: brainCall with current scope. */
  call?: (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;
  /** Injectable think (tests). Default: brainThink (SDK-routed synthesis). */
  think?: (question: string, scope: BrainScope) => Promise<unknown>;
}

const asJson = (v: unknown): ToolResult => ok(typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Drop the audience-tiered sources (the agent slices) from a scope's read
 *  union — the fail-closed move for read paths that can't filter per page. */
function stripAudienceSources(scope: BrainScope): BrainScope {
  const tiered = new Set(scope.audienceSources ?? []);
  return { ...scope, allowedSources: scope.allowedSources.filter((s) => !tiered.has(s)) };
}

/** Max pages a single kb_memoize call may write. Bounds approval-card size and
 *  the work behind one approval. */
export const KB_MEMOIZE_MAX_PAGES = 20;

/**
 * Map raw brain/Postgres errors to actionable agent-facing text. A leaked
 * `pages_source_id_fkey` / `$libdir/vector` string is meaningless to the agent
 * and led it to abandon the brain and silently write files instead (Mode A).
 * Translate known shapes into "what to do"; pass unknown errors through.
 * See docs/findings/2026-06-14-brain-memoize-failure.md.
 */
export function humanizeBrainError(name: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/pages_source_id_fkey|foreign key constraint|source.*not.*(exist|registered)/i.test(raw)) {
    return `brain ${name} failed: the target brain source isn't ready yet. This is a transient brain-write error — retry the same ${name} call once. If it still fails, tell the user the write did NOT land and ask the manager; do NOT fall back to writing a file or claim it was saved.`;
  }
  if (/\$libdir\/vector|could not access file|extension .*vector/i.test(raw)) {
    return `brain ${name} failed: the brain's vector extension is unavailable, so embeddings/search can't run. This is an infrastructure fault, not your input — tell the user the brain is degraded; do NOT work around it with files.`;
  }
  return `brain ${name} failed: ${raw}`;
}

async function runGated(name: string, params: Record<string, unknown>, summary: string, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    const r = await gatedBrainCall(name, {
      scope: d.scope(),
      gate: d.gate(),
      managers: d.managers(),
      requestApproval: d.requestApproval,
      call: () => call(name, params, d.scope()),
      describe: summary,
    });
    return r.ok ? asJson(r.result) : err(r.reason);
  } catch (e) {
    return err(humanizeBrainError(name, e));
  }
}

// Question words / stopwords stripped before the kb_think cross-check search.
// A verbose NL question ("what's our company wide OKR?") dilutes both the vector
// and keyword arms; the distilled keyword form ("company wide okr") ranks the
// canonical page far higher (jot-deployment case: full-question kb_think missed,
// tight kb_search hit rank 1). See docs/findings/2026-06-14-brain-memoize-failure.md.
const THINK_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do", "does",
  "did", "what", "whats", "which", "who", "whom", "whose", "when", "where", "why",
  "how", "our", "your", "my", "we", "you", "i", "me", "us", "it", "its", "of", "to",
  "in", "on", "for", "about", "with", "and", "or", "tell", "know", "have", "has",
  "give", "show", "find", "any", "anything", "current", "currently", "please",
]);

/** Distill a verbose NL question to its content keywords for the cross-check
 *  search. Falls back to the original question if distillation empties it. */
export function distillQuery(question: string): string {
  const kept = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !THINK_STOPWORDS.has(t));
  return kept.length > 0 ? kept.join(" ") : question;
}

const citationSlugs = (result: unknown): Set<string> => {
  const cites = (result as { citations?: Array<{ page_slug?: string }> } | null)?.citations;
  const out = new Set<string>();
  if (Array.isArray(cites)) for (const c of cites) if (c?.page_slug) out.add(c.page_slug);
  return out;
};

const hitSlug = (h: unknown): string | undefined =>
  (h as { slug?: string; page_slug?: string })?.slug ?? (h as { page_slug?: string })?.page_slug;

export const brainHandlers = {
  kb_think: async (p: { question: string }, d: BrainToolDeps): Promise<ToolResult> => {
    try {
      const scope = d.scope();
      // Audience tiers: gbrain's internal gather can't filter per page, so when
      // this turn's grant hides ANY agent-slice page, the slices drop out of
      // synthesis entirely (fail closed). The cross-check gather below keeps the
      // full scope — it filters per page — so visible agent-slice pages still
      // surface as search_fallback / rescue context. See audience.ts.
      const g = scope.audience;
      const tiered = scope.audienceSources ?? [];
      const thinkScope = g && g.level !== "all" && tiered.length > 0
        && (await buildAudienceFilter(d.call ?? brainCall, scope)).anyHidden
        ? stripAudienceSources(scope)
        : scope;
      // SDK-routed synthesis (subscription auth) — not the raw think op.
      const think = d.think ?? brainThink;
      const result = await think(p.question, thinkScope);
      // Mode B / B′ guard: kb_think's hybrid gather can rank a present,
      // well-titled page below noisier neighbors and then synthesize a
      // confident answer that cites the wrong pages (or none). Always
      // cross-check with a distilled keyword search and surface any strong hit
      // the synthesis did NOT cite — so a present page is never silently
      // dropped, whether the answer was empty or just off-target.
      // See docs/findings/2026-06-14-brain-memoize-failure.md.
      try {
        // Per-source cross-check (gather), not a single pooled search: the
        // pooled search is the very thing a bulk corpus floods, so the fallback
        // used to surface more junk instead of the present page. gather()
        // guarantees curated sources their own slots, so a strong uncited hit
        // (e.g. the curated page kb_think's gather missed) actually shows up here.
        const hits = await gather(distillQuery(p.question), scope, { finalLimit: 5, call: d.call });
        if (Array.isArray(hits) && hits.length > 0) {
          const cited = citationSlugs(result);
          const missed = hits.filter((h) => {
            const s = hitSlug(h);
            return s !== undefined && !cited.has(s);
          });
          if (missed.length > 0) {
            // If runThink gathered nothing, attempt rescue synthesis from the
            // fallback pages. runThink uses gbrain's pooled search (sourceId-
            // anchored) which consistently misses pages in other agent slices
            // even when gather()'s per-source fan-out finds them fine.
            // See docs/findings/2026-07-27-kb-think-gather-miss.md.
            const pagesGathered = (result as { pagesGathered?: number }).pagesGathered ?? -1;
            if (pagesGathered === 0) {
              try {
                const pageContext = missed
                  .filter((h) => typeof (h as { chunk_text?: unknown }).chunk_text === "string")
                  .map((h) => `[Source: ${hitSlug(h)}]\n${(h as { chunk_text: string }).chunk_text}`)
                  .join("\n\n---\n\n");
                if (pageContext) {
                  const client = sdkThinkClient();
                  const synthetic = await client.create({
                    messages: [{ role: "user", content: `Answer the following question using only the provided context. Be concise and cite the source slugs.\n\nQuestion: ${p.question}\n\nContext:\n${pageContext}` }],
                    max_tokens: 1024,
                  });
                  const synthText = ((synthetic as { content?: Array<{ text?: string }> }).content?.[0]?.text) ?? "";
                  if (synthText) {
                    return asJson({
                      question: p.question,
                      answer: synthText,
                      citations: missed.map((h) => ({ page_slug: hitSlug(h) })).filter((c) => c.page_slug),
                      pagesGathered: missed.length,
                      takesGathered: 0,
                      graphHits: 0,
                      synthesisOk: true,
                      gather_rescue: true,
                    });
                  }
                }
              } catch (synthErr) {
                console.warn("[brain] kb_think rescue synthesis failed:", synthErr instanceof Error ? synthErr.message : String(synthErr));
              }
            }
            return asJson({ ...(result as object), search_fallback: missed });
          }
        }
      } catch (crossCheckErr) {
        console.warn("[brain] kb_think cross-check failed:", crossCheckErr instanceof Error ? crossCheckErr.message : String(crossCheckErr));
      }
      return asJson(result);
    } catch (e) {
      return err(humanizeBrainError("think", e));
    }
  },
  kb_search: async (p: { query: string; limit?: number }, d: BrainToolDeps): Promise<ToolResult> => {
    // Per-source gather instead of gbrain's single pooled search, so a curated
    // page is never crowded out of the candidate set by a high-volume source
    // (a bulk auto-generated corpus). See src/knowledge/gather.ts.
    try {
      const hits = await gather(p.query, d.scope(), { finalLimit: p.limit ?? 20, call: d.call });
      return asJson(hits);
    } catch (e) {
      return err(humanizeBrainError("search", e));
    }
  },
  kb_get_page: async (p: { slug: string }, d: BrainToolDeps): Promise<ToolResult> => {
    const scope = d.scope();
    try {
      const call = d.call ?? brainCall;
      const page = await call("get_page", { slug: p.slug }, scope);
      const g = scope.audience;
      const tiered = scope.audienceSources ?? [];
      if (g && g.level !== "all" && tiered.length > 0 && page && typeof page === "object") {
        const src = (page as { source_id?: unknown }).source_id;
        // Keyed on the result's source when present (per-slug get_tags — no
        // list truncation concerns); when absent, fail closed on any explicit
        // tier for the slug in a tiered source.
        const denied = typeof src === "string"
          ? tiered.includes(src) && !audienceVisible(await pageAudienceFromTags(call, scope, src, p.slug), g)
          : await (async () => {
              for (const s of tiered) {
                const a = await pageAudienceFromTags(call, scope, s, p.slug);
                if (a !== null && !audienceVisible(a, g)) return true;
              }
              return false;
            })();
        if (denied) return err(`page not available in this conversation: ${p.slug}`);
      }
      return asJson(page);
    } catch (e) {
      return err(humanizeBrainError("get_page", e));
    }
  },
  kb_list_pages: async (p: { type?: string; tag?: string; limit?: number }, d: BrainToolDeps): Promise<ToolResult> => {
    const scope = d.scope();
    const g = scope.audience;
    const tiered = scope.audienceSources ?? [];
    // list_pages rows carry no source_id, so per-row audience checks can't be
    // keyed reliably. At "public" level unlabeled pages are hidden by default —
    // fail closed by dropping the tiered sources from the listing. At
    // team/manager level only explicitly-hidden slugs need filtering.
    const listScope = g && g.level === "public" && tiered.length > 0 ? stripAudienceSources(scope) : scope;
    try {
      const call = d.call ?? brainCall;
      const rows = await call("list_pages", { ...p }, listScope);
      if (g && (g.level === "team" || g.level === "manager") && tiered.length > 0 && Array.isArray(rows)) {
        const filter = await buildAudienceFilter(call, scope);
        if (filter.anyHidden) {
          // Rows carry no source_id — keep a row only if its slug is visible
          // in EVERY tiered source (slug-collision over-filtering fails closed).
          return asJson(rows.filter((r) => {
            const slug = (r as { slug?: string })?.slug ?? "";
            return tiered.every((s) => filter.visible(s, slug));
          }));
        }
      }
      return asJson(rows);
    } catch (e) {
      return err(humanizeBrainError("list_pages", e));
    }
  },
  kb_graph: async (p: { slug: string }, d: BrainToolDeps): Promise<ToolResult> => {
    const scope = d.scope();
    const g = scope.audience;
    const tiered = scope.audienceSources ?? [];
    const call = d.call ?? brainCall;
    let readScope = scope;
    if (g && g.level !== "all" && tiered.length > 0) {
      try {
        for (const s of tiered) {
          const a = await pageAudienceFromTags(call, scope, s, p.slug);
          if (a !== null && !audienceVisible(a, g)) {
            return err(`page not available in this conversation: ${p.slug}`);
          }
        }
      } catch (e) {
        return err(humanizeBrainError("get_tags", e)); // fail closed
      }
      // Link targets of a readable page are part of its content — no per-edge
      // filtering needed. At "public" level unlabeled agent pages are hidden,
      // so their graphs must be too: drop the tiered sources (fail closed).
      if (g.level === "public") readScope = stripAudienceSources(scope);
    }
    let links: unknown;
    try {
      links = await call("get_links", { slug: p.slug }, readScope);
    } catch (e) {
      return err(humanizeBrainError("get_links", e));
    }
    try {
      const back = await call("get_backlinks", { slug: p.slug }, readScope);
      return ok(JSON.stringify({ links, backlinks: back }, null, 2));
    } catch (e) {
      return err(humanizeBrainError("get_backlinks", e));
    }
  },
  kb_memoize: async (p: { pages: Array<{ slug: string; content: string; summary: string }>; target?: "mine" | "shared" }, d: BrainToolDeps): Promise<ToolResult> => {
    const pages = p.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      return err("kb_memoize requires at least one page");
    }
    if (pages.length > KB_MEMOIZE_MAX_PAGES) {
      return err(`kb_memoize accepts at most ${KB_MEMOIZE_MAX_PAGES} pages per call (got ${pages.length})`);
    }
    // Audience tiers: validate BEFORE any write so a bad value never lands
    // half-indexed. null = no/absent frontmatter key = team default.
    const audiences: Array<string | null> = [];
    for (const pg of pages) {
      const parsed = parseAudience(pg.content);
      if (parsed.error) return err(`invalid audience frontmatter on ${pg.slug}: ${parsed.error}`);
      audiences.push(parsed.audience);
    }
    // C1: settle the agent identity before resolving the write scope, so a write
    // in the boot window (before auth.test lands) targets the real `agent-<id>`
    // slice, not `agent-default`. No-op once resolved; never hangs (falls back).
    await agentIdReady();
    // "mine" (default) writes to the resolved own slice — the agent's private
    // mind outside a 1on1, the user's slice inside one — and auto-passes.
    // "shared" escalates to the common team KB, which requires human approval.
    const scope = p.target === "shared" ? { ...d.scope(), sourceId: SHARED_SOURCE } : d.scope();
    const label = p.target === "shared" ? "→ shared" : "→ mine";
    const describe = pages.length === 1
      ? `KB write ${label}: ${pages[0]!.slug} — ${pages[0]!.summary}`
      : `KB write ${label}: ${pages.length} pages — ${pages.map((pg) => pg.slug).join(", ")}`;
    try {
      const call = d.call ?? brainCall;
      // One approval gates the whole batch; the gated thunk writes every page.
      // Each put_page goes through brainCall, which ensures scope.sourceId
      // exists first (see docs/findings/2026-06-14-brain-memoize-failure.md).
      const r = await gatedBrainCall("put_page", {
        scope,
        gate: d.gate(),
        managers: d.managers(),
        requestApproval: d.requestApproval,
        call: async () => {
          const results: unknown[] = [];
          for (const pg of pages) {
            results.push(await call("put_page", { slug: pg.slug, content: pg.content }, scope));
          }
          return results;
        },
        describe,
      });
      if (!r.ok) return err(r.reason);
      // Reconcile audience tags in the BRAIN — only for pages landing in the
      // agent's OWN slice (tiers govern the agent's mind; user/shared slices
      // have source-level visibility already). Explicit remove-then-add
      // because gbrain's put_page tag reconciliation is add-only; a
      // re-memoize without the key clears back to the team default. Same
      // authorization envelope as the approved batch (own-slice tag writes
      // auto-pass the gate anyway).
      const ownSlice = scope.sourceId === agentSourceId(d.gate().agentId);
      if (ownSlice) {
        for (let idx = 0; idx < pages.length; idx++) {
          const pg = pages[idx]!;
          try {
            await reconcileAudienceTags(call, scope, pg.slug, audiences[idx] ?? null);
          } catch (e) {
            // The page IS saved but its tier is NOT applied — never report
            // clean success on a possibly under-protected page.
            const raw = e instanceof Error ? e.message : String(e);
            return err(
              `page "${pg.slug}" was saved, but applying its audience tags failed: ${raw} — ` +
              `retry the SAME kb_memoize call once (put_page is idempotent); ` +
              `until it succeeds, treat the page's audience tier as not enforced.`,
            );
          }
        }
      }
      const audienceNote = !ownSlice && audiences.some((a) => a !== null)
        ? { audience_note: "audience frontmatter applies only to your own agent slice; ignored for this target" }
        : {};
      return asJson({ written: pages.map((pg) => pg.slug), target: p.target ?? "mine", ...audienceNote, results: r.result });
    } catch (e) {
      return err(humanizeBrainError("put_page", e));
    }
  },
  kb_delete_page: (p: { slug: string; reason: string }, d: BrainToolDeps) =>
    runGated("delete_page", { slug: p.slug }, `KB delete: ${p.slug} — ${p.reason}`, d),
};

export function createKbMcp(deps?: BrainToolDeps): McpSdkServerConfigWithInstance {
  const brainTools = deps && brainEnabled()
    ? [
        tool(
          "kb_think",
          "Ask the knowledge brain a question. Returns a synthesized answer with [Source: ...] citations and explicit gaps. Prefer this over kb_search when you need an answer, not documents.",
          { question: z.string().describe("The question to answer from the brain.") },
          (a: { question: string }) => brainHandlers.kb_think(a, deps),
        ),
        tool(
          "kb_search",
          "Search the knowledge brain (pages across your allowed scopes). Returns ranked chunks with slugs.",
          {
            query: z.string().describe("Search query."),
            limit: z.number().optional().describe("Max results (default 20)."),
          },
          (a: { query: string; limit?: number }) => brainHandlers.kb_search(a, deps),
        ),
        tool(
          "kb_get_page",
          "Read a brain page by slug (e.g. 'people/alice').",
          { slug: z.string().describe("Page slug.") },
          (a: { slug: string }) => brainHandlers.kb_get_page(a, deps),
        ),
        tool(
          "kb_list_pages",
          "List brain pages, optionally filtered by type or tag.",
          {
            type: z.string().optional().describe("Filter by page type."),
            tag: z.string().optional().describe("Filter by tag."),
            limit: z.number().optional().describe("Max results (default 50)."),
          },
          (a: { type?: string; tag?: string; limit?: number }) => brainHandlers.kb_list_pages(a, deps),
        ),
        tool(
          "kb_graph",
          "Get knowledge-graph edges for a page: outgoing links and backlinks.",
          { slug: z.string().describe("Page slug.") },
          (a: { slug: string }) => brainHandlers.kb_graph(a, deps),
        ),
        tool(
          "kb_memoize",
          `Write/update one or more brain pages in a single call (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Pass an array of pages — up to ${KB_MEMOIZE_MAX_PAGES} per call. By default (target:"mine") pages go to YOUR OWN slice — your private agent mind — and are saved without asking. Set target:"shared" ONLY for durable team-common knowledge (decisions, people/project facts everyone needs); shared writes ask the manager for approval. Default to "mine" for your own notes, learnings, and working context; reserve "shared" for the team KB. Own-slice pages may declare a disclosure tier via frontmatter \`audience: private|manager|team|public|user:<slack-id>\` — it controls which later conversations may surface the page (private = only when you work alone, manager = manager turns, team = trusted channels [the default when unlabeled], public = also allowed/public channels, user:<id> = only when that user is speaking).`,
          {
            pages: z
              .array(
                z.object({
                  slug: z.string().describe("Page slug, e.g. 'people/alice' or 'notes/2026-06-10-x'."),
                  content: z.string().describe("Full markdown content for the page."),
                  summary: z.string().describe("One-line description of the change, shown on the approval card."),
                }),
              )
              .min(1)
              .max(KB_MEMOIZE_MAX_PAGES)
              .describe(`Pages to write (1..${KB_MEMOIZE_MAX_PAGES}).`),
            target: z
              .enum(["mine", "shared"])
              .optional()
              .describe(`Where to write. "mine" (default) = your own slice, saved without approval. "shared" = the common team KB, requires manager approval.`),
          },
          (a: { pages: Array<{ slug: string; content: string; summary: string }>; target?: "mine" | "shared" }) => brainHandlers.kb_memoize(a, deps),
        ),
        tool(
          "kb_delete_page",
          "Soft-delete a brain page (recoverable). Requires approval.",
          {
            slug: z.string().describe("Page slug to delete."),
            reason: z.string().describe("Why this page should be deleted (shown on the approval card)."),
          },
          (a: { slug: string; reason: string }) => brainHandlers.kb_delete_page(a, deps),
        ),
      ]
    : [];

  return createSdkMcpServer({
    name: KB_MCP_NAME,
    version: "0.2.0",
    tools: [
      ...brainTools,
      tool(
        "list_kbs",
        "List installed knowledge bases. Returns JSON array with label, description, path, and index_file for each KB.",
        {},
        kbHandlers.list_kbs,
      ),
      tool(
        "search_kbs",
        "Search installed knowledge bases by tags or keywords. Returns ranked matching KBs. Use this BEFORE acting when a user query mentions a service, domain, or topic that may have curated documentation.",
        {
          query: z.string().describe("Search query — keywords from the user's request (e.g. 'service-a grafana alerts')."),
          limit: z.number().optional().describe("Max results (default 5)."),
        },
        kbHandlers.search_kbs,
      ),
    ],
  });
}
