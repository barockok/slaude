import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  async open_kb({ label }: { label: string }): Promise<ToolResult> {
    const kbs = loadKbs();
    const kb = kbs.find((k) => k.label === label);
    if (!kb) return err(`unknown knowledge base "${label}". Use list_kbs to see available labels.`);
    const indexPath = join(kb.path, kb.index_file);
    if (!existsSync(indexPath)) return err(`index file ${kb.index_file} not found in "${label}"`);
    return ok(readFileSync(indexPath, "utf8"));
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

async function runRead(name: string, params: Record<string, unknown>, d: BrainToolDeps): Promise<ToolResult> {
  try {
    const call = d.call ?? brainCall;
    return asJson(await call(name, params, d.scope()));
  } catch (e) {
    return err(`brain ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
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
    return err(`brain ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const brainHandlers = {
  kb_think: async (p: { question: string }, d: BrainToolDeps): Promise<ToolResult> => {
    try {
      // SDK-routed synthesis (subscription auth) — not the raw think op.
      const think = d.think ?? brainThink;
      return asJson(await think(p.question, d.scope()));
    } catch (e) {
      return err(`brain think failed: ${e instanceof Error ? e.message : String(e)}`);
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
  kb_put_page: (p: { slug: string; content: string; summary: string }, d: BrainToolDeps) =>
    runGated("put_page", { slug: p.slug, content: p.content }, `KB write: ${p.slug} — ${p.summary}`, d),
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
          "kb_put_page",
          "Write/update a brain page (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Writes outside your own slice require human approval — provide a clear summary.",
          {
            slug: z.string().describe("Page slug, e.g. 'people/alice' or 'notes/2026-06-10-x'."),
            content: z.string().describe("Full markdown content for the page."),
            summary: z.string().describe("One-line description of the change, shown on the approval card."),
          },
          (a: { slug: string; content: string; summary: string }) => brainHandlers.kb_put_page(a, deps),
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
        "open_kb",
        "Open a knowledge base by label. Returns the full contents of its index file (README.md, index.md, or first .md). Use this to discover the wiki's structure, then navigate with Read/Grep/Glob.",
        { label: z.string().describe("Knowledge base label as listed by list_kbs.") },
        kbHandlers.open_kb,
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
