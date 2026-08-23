/**
 * Contract for the `slaude_kb` MCP server (knowledge bases + brain). Brain
 * tools mount only when the brain is enabled and deps are injected; list_kbs /
 * search_kbs always mount.
 */
import { z } from "zod";
import type { ServerContract } from "./types";

export const KB_SERVER = "slaude_kb";

/** Max pages a single kb_memoize call may write. Bounds approval-card size and
 *  the work behind one approval. */
export const KB_MEMOIZE_MAX_PAGES = 20;

export const kbContract = {
  server: KB_SERVER,
  tools: {
    kb_think: {
      name: "kb_think",
      description:
        "Ask the knowledge brain a question. Returns a synthesized answer with [Source: ...] citations and explicit gaps. Prefer this over kb_search when you need an answer, not documents.",
      schema: { question: z.string().describe("The question to answer from the brain.") },
    },
    kb_search: {
      name: "kb_search",
      description:
        "Search the knowledge brain (pages across your allowed scopes). Returns ranked chunks with slugs.",
      schema: {
        query: z.string().describe("Search query."),
        limit: z.number().optional().describe("Max results (default 20)."),
      },
    },
    kb_get_page: {
      name: "kb_get_page",
      description: "Read a brain page by slug (e.g. 'people/alice').",
      schema: { slug: z.string().describe("Page slug.") },
    },
    kb_list_pages: {
      name: "kb_list_pages",
      description: "List brain pages, optionally filtered by type or tag.",
      schema: {
        type: z.string().optional().describe("Filter by page type."),
        tag: z.string().optional().describe("Filter by tag."),
        limit: z.number().optional().describe("Max results (default 50)."),
      },
    },
    kb_graph: {
      name: "kb_graph",
      description: "Get knowledge-graph edges for a page: outgoing links and backlinks.",
      schema: { slug: z.string().describe("Page slug.") },
    },
    kb_memoize: {
      name: "kb_memoize",
      description: `Write/update one or more brain pages in a single call (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Pass an array of pages — up to ${KB_MEMOIZE_MAX_PAGES} per call. By default (target:"mine") pages go to YOUR OWN slice — your private agent mind — and are saved without asking. Set target:"shared" ONLY for durable team-common knowledge (decisions, people/project facts everyone needs); shared writes ask the manager for approval. Default to "mine" for your own notes, learnings, and working context; reserve "shared" for the team KB.`,
      schema: {
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
    },
    kb_delete_page: {
      name: "kb_delete_page",
      description: "Soft-delete a brain page (recoverable). Requires approval.",
      schema: {
        slug: z.string().describe("Page slug to delete."),
        reason: z.string().describe("Why this page should be deleted (shown on the approval card)."),
      },
    },
    list_kbs: {
      name: "list_kbs",
      description:
        "List installed knowledge bases. Returns JSON array with label, description, path, and index_file for each KB.",
      schema: {},
    },
    search_kbs: {
      name: "search_kbs",
      description:
        "Search installed knowledge bases by tags or keywords. Returns ranked matching KBs. Use this BEFORE acting when a user query mentions a service, domain, or topic that may have curated documentation.",
      schema: {
        query: z.string().describe("Search query — keywords from the user's request (e.g. 'service-a grafana alerts')."),
        limit: z.number().optional().describe("Max results (default 5)."),
      },
    },
  },
} as const satisfies ServerContract;
