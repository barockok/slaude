/**
 * Contract for the `slaude_kb` MCP server (the agent's memory: memory stores
 * on the brain, plus the installed library knowledge bases). Brain tools mount
 * only when the brain is enabled and deps are injected; memory_stores /
 * memory_search_stores always mount.
 *
 * The tools carry `memory_*` names. The old `kb_*` names (and list_kbs /
 * search_kbs) stay mounted as aliases with the same schema and handler,
 * because a resumed session keeps calling the names it saw before.
 */
import { z } from "zod";
import type { ServerContract } from "./types";
import { PAGE_TYPES, type PageType } from "../../knowledge/page-types";

const PAGE_TYPE_ENUM = PAGE_TYPES as unknown as [PageType, ...PageType[]];
const PAGE_TYPE_LIST = PAGE_TYPES.join(", ");

export const KB_SERVER = "slaude_kb";

/** Max pages a single memory_save call may write. Bounds approval-card size and
 *  the work behind one approval. */
export const KB_MEMOIZE_MAX_PAGES = 20;

/** New memory tool name -> its deprecated alias (the old kb name). */
export const MEMORY_TOOL_ALIASES = {
  memory_search: "kb_search",
  memory_think: "kb_think",
  memory_get: "kb_get_page",
  memory_list: "kb_list_pages",
  memory_save: "kb_memoize",
  memory_delete: "kb_delete_page",
  memory_graph: "kb_graph",
  memory_thread_history: "kb_thread_history",
  memory_stores: "list_kbs",
  memory_search_stores: "search_kbs",
} as const;

export type MemoryToolName = keyof typeof MEMORY_TOOL_ALIASES;
export type MemoryToolAlias = (typeof MEMORY_TOOL_ALIASES)[MemoryToolName];

const ALIAS_TO_MEMORY: Readonly<Record<string, MemoryToolName>> = Object.fromEntries(
  Object.entries(MEMORY_TOOL_ALIASES).map(([memory, alias]) => [alias, memory as MemoryToolName]),
);

/** The `memory_*` name for a tool name: an alias maps to its new name, any
 *  other name comes back unchanged. */
export function canonicalMemoryTool(name: string): string {
  return Object.hasOwn(ALIAS_TO_MEMORY, name) ? ALIAS_TO_MEMORY[name]! : name;
}

/** The other name of an aliased memory tool (memory_save <-> kb_memoize), or
 *  null when the name has no twin. */
export function memoryToolTwin(name: string): string | null {
  if (Object.hasOwn(MEMORY_TOOL_ALIASES, name)) return MEMORY_TOOL_ALIASES[name as MemoryToolName];
  if (Object.hasOwn(ALIAS_TO_MEMORY, name)) return ALIAS_TO_MEMORY[name]!;
  return null;
}

/** Same as memoryToolTwin for a full CLI tool id (`mcp__slaude_kb__<name>`). */
export function memoryToolIdTwin(toolId: string): string | null {
  const prefix = `mcp__${KB_SERVER}__`;
  if (!toolId.startsWith(prefix)) return null;
  const twin = memoryToolTwin(toolId.slice(prefix.length));
  return twin === null ? null : prefix + twin;
}

/** The deprecated alias entry for a memory tool: same schema object, so the
 *  alias validates and dispatches exactly like the new name. */
function alias<N extends MemoryToolAlias, S>(name: N, of: { name: MemoryToolName; schema: S }) {
  return {
    name,
    description: `Alias of ${of.name} (deprecated). Same input and result as ${of.name}; call ${of.name} instead.`,
    schema: of.schema,
  };
}

const memoryThink = {
  name: "memory_think",
  description:
    "Ask your memory a question. Returns a synthesized answer with [Source: ...] citations and explicit gaps. Prefer this over memory_search when you need an answer, not documents.",
  schema: { question: z.string().describe("The question to answer from memory.") },
} as const;

const memorySearch = {
  name: "memory_search",
  description:
    "Search your memory (pages across the memory stores you may read). Returns ranked chunks with slugs.",
  schema: {
    query: z.string().describe("Search query."),
    limit: z.number().optional().describe("Max results (default 20)."),
  },
} as const;

const memoryGet = {
  name: "memory_get",
  description: "Read a memory page by slug (e.g. 'people/alice').",
  schema: { slug: z.string().describe("Page slug.") },
} as const;

const memoryList = {
  name: "memory_list",
  description: "List memory pages, optionally filtered by type or tag.",
  schema: {
    type: z.string().optional().describe("Filter by page type."),
    tag: z.string().optional().describe("Filter by tag."),
    limit: z.number().optional().describe("Max results (default 50)."),
  },
} as const;

const memoryGraph = {
  name: "memory_graph",
  description: "Get the link graph for a memory page: outgoing links and backlinks.",
  schema: { slug: z.string().describe("Page slug.") },
} as const;

const memorySave = {
  name: "memory_save",
  description: `Write/update one or more memory pages in a single call (markdown, optional YAML frontmatter; [[wikilinks]] become graph edges). Pass an array of pages, up to ${KB_MEMOIZE_MAX_PAGES} per call. By default (target:"mine") pages go to YOUR OWN memory store (your private agent mind, or the person's own store inside their /1on1) and are saved without asking. Set target:"shared" ONLY for durable team-common knowledge (decisions, people/project facts everyone needs); shared writes ask the manager for approval, and are refused inside a /1on1. Default to "mine" for your own notes, learnings, and working context; reserve "shared" for the team's shared memory. Give a page a \`type\` (${PAGE_TYPE_LIST}) and its content becomes the body under generated frontmatter (type, as_of, confidence, source, supersedes, fields); set supersedes to the older page's slug in the same memory and that page is tagged "superseded". Set \`subject\` (the Slack user id a page is about) per page, or once for the call. Use target:"profile" to record what the person you are talking to said about themselves (name to use, register, ping preferences) as a type:"profile" page with slug "profile" in their own profile, only on their own turn and never on someone else's behalf.`,
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
          subject: z.string().optional().describe("Slack user id this page is about, when it differs from the call's `subject`. With target \"profile\" it must be the current speaker."),
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
      .describe(`Where to write. "mine" (default) = your own memory store, saved without approval. "shared" = the team's shared memory, requires manager approval. "profile" = the current speaker's own profile, saved without approval on their own turn.`),
    subject: z
      .string()
      .optional()
      .describe(`Slack user id the pages are about; written into each typed page as \`subject\`. Pass it for any page about a person. With target "profile" it must be the current speaker.`),
  },
} as const;

const memoryThreadHistory = {
  name: "memory_thread_history",
  description:
    "Read this thread's earlier turns beyond the few in your memory context, oldest first, as `[date] who: text` lines; the first call opens with the thread's summary when one was written. Pass `before` (from the footer of a previous call) to page further back. Only this thread, and only where this turn may read it.",
  schema: {
    limit: z.number().int().min(1).max(50).optional().describe("Turns to return (1..50, default 20); the newest are kept."),
    before: z.string().optional().describe("Only turns older than this entry id (the footer of the previous call gives it)."),
  },
} as const;

const memoryDelete = {
  name: "memory_delete",
  description: "Soft-delete a memory page (recoverable). Requires approval.",
  schema: {
    slug: z.string().describe("Page slug to delete."),
    reason: z.string().describe("Why this page should be deleted (shown on the approval card)."),
  },
} as const;

const memoryStores = {
  name: "memory_stores",
  description:
    "List the knowledge bases (library memory stores) this agent may read. Returns JSON array with label, description, tags, and source (the store id memory_search reads it under) for each knowledge base.",
  schema: {},
} as const;

const memorySearchStores = {
  name: "memory_search_stores",
  description:
    "Search installed knowledge bases (library memory stores) by tags or keywords. Returns ranked matching knowledge bases. Use this BEFORE acting when a user query mentions a service, domain, or topic that may have curated documentation.",
  schema: {
    query: z.string().describe("Search query: keywords from the user's request (e.g. 'service-a grafana alerts')."),
    limit: z.number().optional().describe("Max results (default 5)."),
  },
} as const;

export const kbContract = {
  server: KB_SERVER,
  tools: {
    memory_think: memoryThink,
    memory_search: memorySearch,
    memory_get: memoryGet,
    memory_list: memoryList,
    memory_graph: memoryGraph,
    memory_save: memorySave,
    memory_about: {
      name: "memory_about",
      description:
        "What you hold about the person asking (\"what do you know about me?\"): their profile and every note about them this turn can read, each labelled told or inferred with its date; superseded pages are left out. Answers only for the person whose own turn this is.",
      schema: { userId: z.string().describe("Slack user id of the person asking; must be the current speaker.") },
    },
    memory_thread_history: memoryThreadHistory,
    memory_delete: memoryDelete,
    memory_stores: memoryStores,
    memory_search_stores: memorySearchStores,
    // Deprecated aliases (old names): same schema, same handler.
    kb_think: alias("kb_think", memoryThink),
    kb_search: alias("kb_search", memorySearch),
    kb_get_page: alias("kb_get_page", memoryGet),
    kb_list_pages: alias("kb_list_pages", memoryList),
    kb_graph: alias("kb_graph", memoryGraph),
    kb_memoize: alias("kb_memoize", memorySave),
    kb_thread_history: alias("kb_thread_history", memoryThreadHistory),
    kb_delete_page: alias("kb_delete_page", memoryDelete),
    list_kbs: alias("list_kbs", memoryStores),
    search_kbs: alias("search_kbs", memorySearchStores),
  },
} as const satisfies ServerContract;
