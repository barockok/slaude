import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadKbs } from "./loader";
import { brainCall, brainEnabled } from "./brain";
import { brainThink } from "./brain-think";
import { gatedBrainCall, type ApprovalReq, type ApprovalRes, type GateInput } from "./gated-dispatch";
import type { BrainScope } from "./scope";

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

async function runRead(name: string, params: Record<string, unknown>, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    return asJson(await call(name, params, d.scope()));
  } catch (e) {
    return err(humanizeBrainError(name, e));
  }
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
      // SDK-routed synthesis (subscription auth) — not the raw think op.
      const think = d.think ?? brainThink;
      const result = await think(p.question, d.scope());
      // Mode B / B′ guard: kb_think's hybrid gather can rank a present,
      // well-titled page below noisier neighbors and then synthesize a
      // confident answer that cites the wrong pages (or none). Always
      // cross-check with a distilled keyword search and surface any strong hit
      // the synthesis did NOT cite — so a present page is never silently
      // dropped, whether the answer was empty or just off-target.
      // See docs/findings/2026-06-14-brain-memoize-failure.md.
      try {
        const call = d.call ?? brainCall;
        const hits = await call("search", { query: distillQuery(p.question), limit: 5 }, d.scope());
        if (Array.isArray(hits) && hits.length > 0) {
          const cited = citationSlugs(result);
          const missed = hits.filter((h) => {
            const s = hitSlug(h);
            return s !== undefined && !cited.has(s);
          });
          if (missed.length > 0) {
            return asJson({ ...(result as object), search_fallback: missed });
          }
        }
      } catch {
        // cross-check is best-effort; fall through to the raw think result
      }
      return asJson(result);
    } catch (e) {
      return err(humanizeBrainError("think", e));
    }
  },
  kb_search: (p: { query: string; limit?: number }, d: BrainToolDeps) =>
    runRead("search", { query: p.query, ...(p.limit ? { limit: p.limit } : {}) }, d),
  kb_get_page: (p: { slug: string }, d: BrainToolDeps) => runRead("get_page", { slug: p.slug }, d),
  kb_list_pages: (p: { type?: string; tag?: string; limit?: number }, d: BrainToolDeps) =>
    runRead("list_pages", { ...p }, d),
  kb_graph: async (p: { slug: string }, d: BrainToolDeps): Promise<ToolResult> => {
    const links = await runRead("get_links", { slug: p.slug }, d);
    if (links.isError) return links;
    const back = await runRead("get_backlinks", { slug: p.slug }, d);
    if (back.isError) return back;
    return ok(JSON.stringify({
      links: JSON.parse(links.content[0]!.text),
      backlinks: JSON.parse(back.content[0]!.text),
    }, null, 2));
  },
  kb_memoize: async (p: { pages: Array<{ slug: string; content: string; summary: string }> }, d: BrainToolDeps): Promise<ToolResult> => {
    const pages = p.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      return err("kb_memoize requires at least one page");
    }
    if (pages.length > KB_MEMOIZE_MAX_PAGES) {
      return err(`kb_memoize accepts at most ${KB_MEMOIZE_MAX_PAGES} pages per call (got ${pages.length})`);
    }
    const describe = pages.length === 1
      ? `KB write: ${pages[0]!.slug} — ${pages[0]!.summary}`
      : `KB write: ${pages.length} pages — ${pages.map((pg) => pg.slug).join(", ")}`;
    try {
      const call = d.call ?? brainCall;
      // One approval gates the whole batch; the gated thunk writes every page.
      // Each put_page goes through brainCall, which ensures scope.sourceId
      // exists first (see docs/findings/2026-06-14-brain-memoize-failure.md).
      const r = await gatedBrainCall("put_page", {
        scope: d.scope(),
        gate: d.gate(),
        managers: d.managers(),
        requestApproval: d.requestApproval,
        call: async () => {
          const results: unknown[] = [];
          for (const pg of pages) {
            results.push(await call("put_page", { slug: pg.slug, content: pg.content }, d.scope()));
          }
          return results;
        },
        describe,
      });
      return r.ok ? asJson({ written: pages.map((pg) => pg.slug), results: r.result }) : err(r.reason);
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
          `Write/update one or more brain pages in a single call (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Pass an array of pages — up to ${KB_MEMOIZE_MAX_PAGES} per call — and they are written under one approval. Writes outside your own slice require human approval — give each page a clear summary.`,
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
          },
          (a: { pages: Array<{ slug: string; content: string; summary: string }> }) => brainHandlers.kb_memoize(a, deps),
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
