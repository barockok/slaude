/**
 * Read-only browsing of memory stores (brain sources) for the console: the
 * stores with page counts, a store's pages, one page with its tags and links.
 *
 * Goes through gbrain's own surfaces only: the `sources_list` admin op (page
 * counts included) and the engine's listPages / getPage / getTags / getLinks,
 * each filtered to one source. No SQL against gbrain tables. The `list_pages`
 * op is not used because it exposes no offset, and the console pages.
 *
 * Local brain only: in remote mode the engine lives in another process, and
 * a disabled brain has nothing to show. {@link memoryUnavailableReason} says
 * which, so the API answers 503 instead of booting or connecting anything.
 */
import { brainEnabled, getBrain, runAdminOp } from "./brain";
import { brainMode } from "./brain-config";
import { agentSourceId, AGENT_SOURCE, storeKind, type StoreKind } from "./scope";

export interface MemoryStore {
  id: string;
  kind: StoreKind;
  label: string;
  pageCount: number;
}

export interface MemoryPageSummary {
  slug: string;
  type: string;
  title: string;
  /** Epoch ms, or null when unknown. */
  updatedAt: number | null;
}

export interface MemoryPageLink {
  to: string;
  type: string;
  context: string;
}

export interface MemoryPage {
  store: string;
  slug: string;
  type: string;
  title: string;
  /** The page body (gbrain's compiled truth). */
  content: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: MemoryPageLink[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface MemoryBrowser {
  stores(): Promise<Array<Omit<MemoryStore, "label">>>;
  /** Pages of one store by slug, `offset` rows in. */
  pages(store: string, opts: { offset: number; limit: number }): Promise<MemoryPageSummary[]>;
  /** One page, or null when the store has no such slug. */
  page(store: string, slug: string): Promise<MemoryPage | null>;
}

/** Why the console cannot browse memory here, or null when it can. */
export function memoryUnavailableReason(): string | null {
  if (!brainEnabled()) return "memory is disabled on this deployment (SLAUDE_BRAIN_DISABLED=1)";
  if (brainMode() === "remote") return "memory runs in a separate brain server; browsing it from the console is not supported yet";
  return null;
}

/** Human label for a store. `agents` maps agent source ids to persona names. */
export function storeLabel(id: string, agents: ReadonlyMap<string, string> = new Map()): string {
  const kind = storeKind(id);
  switch (kind) {
    case "agent":
      if (id === AGENT_SOURCE) return "Agent mind (legacy)";
      return agents.has(id) ? `Agent mind: ${agents.get(id)}` : `Agent mind: ${id.slice("agent-".length)}`;
    case "shared":
      return "Shared";
    case "public":
      return "Public";
    case "personal":
      return `Personal: ${id.slice("user-".length)}`;
    case "profile":
      return "Profile";
    case "library":
      return `Library: ${id.slice("kb-".length)}`;
    default:
      return id;
  }
}

/** Persona name per agent source id, for {@link storeLabel}. */
export function agentStoreNames(personas: Array<{ name: string; agentId: string }>): Map<string, string> {
  return new Map(personas.map((p) => [agentSourceId(p.agentId), p.name]));
}

// The engine surface used here (gbrain's BrainEngine, typed locally: gbrain's
// sources are not compiled under slaude's tsconfig).
interface EnginePage {
  slug: string;
  type: string;
  title: string;
  compiled_truth?: string;
  timeline?: string;
  frontmatter?: Record<string, unknown> | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}
interface BrowseEngine {
  listPages(f: { sourceId: string; sort: "slug"; limit: number; offset: number }): Promise<EnginePage[]>;
  getPage(slug: string, opts: { sourceId: string }): Promise<EnginePage | null>;
  getTags(slug: string, opts: { sourceId: string }): Promise<string[]>;
  getLinks(slug: string, opts: { sourceId: string }): Promise<Array<{ to_slug: string; link_type: string; context: string }>>;
}

const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

export function localMemoryBrowser(): MemoryBrowser {
  const engine = async () => (await getBrain()) as unknown as BrowseEngine;
  return {
    async stores() {
      const { sources } = (await runAdminOp("sources_list", {})) as { sources: Array<{ id: string; page_count?: number }> };
      return sources.map((s) => ({ id: s.id, kind: storeKind(s.id), pageCount: Number(s.page_count ?? 0) }));
    },
    async pages(store, { offset, limit }) {
      const rows = await (await engine()).listPages({ sourceId: store, sort: "slug", limit, offset });
      return rows.map((p) => ({ slug: p.slug, type: p.type, title: p.title, updatedAt: ms(p.updated_at) }));
    },
    async page(store, slug) {
      const e = await engine();
      const p = await e.getPage(slug, { sourceId: store });
      if (!p) return null;
      const [tags, links] = await Promise.all([e.getTags(p.slug, { sourceId: store }), e.getLinks(p.slug, { sourceId: store })]);
      return {
        store,
        slug: p.slug,
        type: p.type,
        title: p.title,
        content: p.compiled_truth ?? "",
        timeline: p.timeline ?? "",
        frontmatter: p.frontmatter ?? {},
        tags,
        links: links.map((l) => ({ to: l.to_slug, type: l.link_type, context: l.context })),
        createdAt: ms(p.created_at),
        updatedAt: ms(p.updated_at),
      };
    },
  };
}
