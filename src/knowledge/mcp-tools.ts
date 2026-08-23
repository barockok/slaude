import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadKbs } from "./loader";
import { brainCall, brainEnabled } from "./brain";
import { brainThink, sdkThinkClient } from "./brain-think";
import { gather } from "./gather";
import { gatedBrainCall, type ApprovalReq, type ApprovalRes, type GateInput } from "./gated-dispatch";
import { SHARED_SOURCE, type BrainScope } from "./scope";
import { agentIdReady } from "./agent-identity";
import { kbContract, KB_MEMOIZE_MAX_PAGES } from "../tools/contracts/kb";

export const KB_MCP_NAME = kbContract.server;
// Re-export: the limit is defined in the shared contract (single source of truth)
// but existing import sites read it from here.
export { KB_MEMOIZE_MAX_PAGES };

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
  scope: () => BrainScope | Promise<BrainScope>;
  gate: () => GateInput | Promise<GateInput>;
  /** Manager + backup user ids — hard backstop for kb-admin approvals. */
  managers: () => string[];
  requestApproval: (r: ApprovalReq) => Promise<ApprovalRes>;
  /** Injectable op caller (tests). Default: brainCall with current scope. */
  call?: (name: string, params: Record<string, unknown>, scope: BrainScope) => Promise<unknown>;
  /** Injectable think (tests). Default: brainThink (SDK-routed synthesis). */
  think?: (question: string, scope: BrainScope) => Promise<unknown>;
}

const asJson = (v: unknown): ToolResult => ok(typeof v === "string" ? v : JSON.stringify(v, null, 2));

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
    return asJson(await call(name, params, await d.scope()));
  } catch (e) {
    return err(humanizeBrainError(name, e));
  }
}

async function runGated(name: string, params: Record<string, unknown>, summary: string, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    const r = await gatedBrainCall(name, {
      scope: await d.scope(),
      gate: await d.gate(),
      managers: d.managers(),
      requestApproval: d.requestApproval,
      call: async () => call(name, params, await d.scope()),
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
      const result = await think(p.question, await d.scope());
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
        const hits = await gather(distillQuery(p.question), await d.scope(), { finalLimit: 5, call: d.call });
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
      const hits = await gather(p.query, await d.scope(), { finalLimit: p.limit ?? 20, call: d.call });
      return asJson(hits);
    } catch (e) {
      return err(humanizeBrainError("search", e));
    }
  },
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
  kb_memoize: async (p: { pages: Array<{ slug: string; content: string; summary: string }>; target?: "mine" | "shared" }, d: BrainToolDeps): Promise<ToolResult> => {
    const pages = p.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      return err("kb_memoize requires at least one page");
    }
    if (pages.length > KB_MEMOIZE_MAX_PAGES) {
      return err(`kb_memoize accepts at most ${KB_MEMOIZE_MAX_PAGES} pages per call (got ${pages.length})`);
    }
    // C1: settle the agent identity before resolving the write scope, so a write
    // in the boot window (before auth.test lands) targets the real `agent-<id>`
    // slice, not `agent-default`. No-op once resolved; never hangs (falls back).
    await agentIdReady();
    // "mine" (default) writes to the resolved own slice — the agent's private
    // mind outside a 1on1, the user's slice inside one — and auto-passes.
    // "shared" escalates to the common team KB, which requires human approval.
    const scope = p.target === "shared" ? { ...await d.scope(), sourceId: SHARED_SOURCE } : await d.scope();
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
        gate: await d.gate(),
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
      return r.ok ? asJson({ written: pages.map((pg) => pg.slug), target: p.target ?? "mine", results: r.result }) : err(r.reason);
    } catch (e) {
      return err(humanizeBrainError("put_page", e));
    }
  },
  kb_delete_page: (p: { slug: string; reason: string }, d: BrainToolDeps) =>
    runGated("delete_page", { slug: p.slug }, `KB delete: ${p.slug} — ${p.reason}`, d),
};

export function createKbMcp(deps?: BrainToolDeps): McpSdkServerConfigWithInstance {
  const c = kbContract.tools;
  const brainTools = deps && brainEnabled()
    ? [
        tool(c.kb_think.name, c.kb_think.description, c.kb_think.schema,
          (a: { question: string }) => brainHandlers.kb_think(a, deps)),
        tool(c.kb_search.name, c.kb_search.description, c.kb_search.schema,
          (a: { query: string; limit?: number }) => brainHandlers.kb_search(a, deps)),
        tool(c.kb_get_page.name, c.kb_get_page.description, c.kb_get_page.schema,
          (a: { slug: string }) => brainHandlers.kb_get_page(a, deps)),
        tool(c.kb_list_pages.name, c.kb_list_pages.description, c.kb_list_pages.schema,
          (a: { type?: string; tag?: string; limit?: number }) => brainHandlers.kb_list_pages(a, deps)),
        tool(c.kb_graph.name, c.kb_graph.description, c.kb_graph.schema,
          (a: { slug: string }) => brainHandlers.kb_graph(a, deps)),
        tool(c.kb_memoize.name, c.kb_memoize.description, c.kb_memoize.schema,
          (a: { pages: Array<{ slug: string; content: string; summary: string }>; target?: "mine" | "shared" }) => brainHandlers.kb_memoize(a, deps)),
        tool(c.kb_delete_page.name, c.kb_delete_page.description, c.kb_delete_page.schema,
          (a: { slug: string; reason: string }) => brainHandlers.kb_delete_page(a, deps)),
      ]
    : [];

  return createSdkMcpServer({
    name: KB_MCP_NAME,
    version: "0.2.0",
    tools: [
      ...brainTools,
      tool(c.list_kbs.name, c.list_kbs.description, c.list_kbs.schema, kbHandlers.list_kbs),
      tool(c.search_kbs.name, c.search_kbs.description, c.search_kbs.schema, kbHandlers.search_kbs),
    ],
  });
}
