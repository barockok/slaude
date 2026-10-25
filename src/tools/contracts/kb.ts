/**
 * Contract for the `slaude_kb` MCP server (knowledge bases + brain). Brain
 * tools mount only when the brain is enabled and deps are injected; list_kbs /
 * search_kbs always mount.
 */
import { z } from "zod";
import type { ServerContract } from "./types";
import { PAGE_TYPES, type PageType } from "../../knowledge/page-types";

const PAGE_TYPE_ENUM = PAGE_TYPES as unknown as [PageType, ...PageType[]];
const PAGE_TYPE_LIST = PAGE_TYPES.join(", ");

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
      description: `Write/update one or more brain pages in a single call (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Pass an array of pages — up to ${KB_MEMOIZE_MAX_PAGES} per call. By default (target:"mine") pages go to YOUR OWN slice — your private agent mind, or the person's own slice inside their /1on1 — and are saved without asking. Set target:"shared" ONLY for durable team-common knowledge (decisions, people/project facts everyone needs); shared writes ask the manager for approval, and are refused inside a /1on1. Default to "mine" for your own notes, learnings, and working context; reserve "shared" for the team KB. Give a page a \`type\` (${PAGE_TYPE_LIST}) and its content becomes the body under generated frontmatter (type, as_of, confidence, source, supersedes, fields); set supersedes to the older page's slug in the same memory and that page is tagged "superseded". Use target:"profile" to record what the person you are talking to said about themselves (name to use, register, ping preferences) as a type:"profile" page with slug "profile" in their own profile, only on their own turn and never on someone else's behalf.`,
      schema: {
        pages: z
          .array(
            z.object({
              slug: z.string().describe("Page slug, e.g. 'people/alice' or 'notes/2026-06-10-x'."),
              content: z.string().describe("Full markdown content for the page. With `type`, the body only (no frontmatter)."),
              summary: z.string().describe("One-line description of the change, shown on the approval card."),
              type: z.enum(PAGE_TYPE_ENUM).optional().describe("Page type; generates the common frontmatter."),
              confidence: z.enum(["told", "inferred"]).optional().describe('"told" = the person said it; "inferred" = your observation. Never mix them in one page. profile is always told, person-note always inferred.'),
              source: z.string().optional().describe('Where this came from: a thread permalink or "told by <user>".'),
              supersedes: z.string().optional().describe("Slug of the older page this one replaces, in the same memory; it gets the tag superseded."),
              fields: z
                .record(z.string(), z.string())
                .optional()
                .describe("Type-specific frontmatter keys, one line each. commitment: promiser, beneficiary (required), thread (<channel>:<threadTs>), due, check, on_no_change (close-in-one-line|silent), status (open|done|dropped, required)."),
            }),
          )
          .min(1)
          .max(KB_MEMOIZE_MAX_PAGES)
          .describe(`Pages to write (1..${KB_MEMOIZE_MAX_PAGES}).`),
        target: z
          .enum(["mine", "shared", "profile"])
          .optional()
          .describe(`Where to write. "mine" (default) = your own slice, saved without approval. "shared" = the common team KB, requires manager approval. "profile" = the current speaker's own profile, saved without approval on their own turn.`),
        subject: z
          .string()
          .optional()
          .describe(`Slack user id the pages are about. With target "profile" it must be the current speaker.`),
      },
    },
    memory_about: {
      name: "memory_about",
      description:
        "What you hold about the person asking (\"what do you know about me?\"): their profile and every note about them this turn can read, each labelled told or inferred with its date; superseded pages are left out. Answers only for the person whose own turn this is.",
      schema: { userId: z.string().describe("Slack user id of the person asking; must be the current speaker.") },
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
        "List the knowledge bases this agent may read. Returns JSON array with label, description, tags, and source (the brain source id kb_search reads it under) for each KB.",
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
