// The slice of the gbrain engine the brain migration touches. gbrain's own types
// are not importable (tsc must not resolve into node_modules/gbrain).
export interface MigrateEngine {
  connect(c: object): Promise<void>; disconnect(): Promise<void>; initSchema(): Promise<void>;
  transaction<T>(fn: (tx: MigrateEngine) => Promise<T>): Promise<T>;
  listPages(f: { sourceId?: string; limit?: number; offset?: number; sort?: "slug"; includeDeleted?: boolean }): Promise<Array<{ slug: string; type: string; title: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown>; content_hash?: string; source_id: string }>>;
  getPage(slug: string, o?: { sourceId?: string; includeDeleted?: boolean }): Promise<{ slug: string } | null>;
  getChunksWithEmbeddings(slug: string, o?: { sourceId?: string }): Promise<Array<{ chunk_index: number; chunk_text: string; chunk_source: "compiled_truth" | "timeline" | "fenced_code"; embedding: Float32Array | null; model: string; token_count: number | null }>>;
  getTags(slug: string, o?: { sourceId?: string }): Promise<string[]>;
  getTimeline(slug: string, o?: { sourceId?: string; limit?: number }): Promise<Array<{ date: string | Date; source: string; summary: string; detail: string }>>;
  getRawData(slug: string, source?: string, o?: { sourceId?: string }): Promise<Array<{ source: string; data: Record<string, unknown> }>>;
  putPage(slug: string, p: { type: string; title: string; compiled_truth: string; timeline?: string; frontmatter?: Record<string, unknown>; content_hash?: string }, o?: { sourceId?: string }): Promise<unknown>;
  upsertChunks(slug: string, chunks: Array<{ chunk_index: number; chunk_text: string; chunk_source: "compiled_truth" | "timeline" | "fenced_code"; embedding?: Float32Array; model?: string; token_count?: number }>, o?: { sourceId?: string }): Promise<void>;
  addTag(slug: string, tag: string, o?: { sourceId?: string }): Promise<void>;
  addTimelineEntry(slug: string, e: { date: string; source?: string; summary: string; detail?: string }, o?: { sourceId?: string; skipExistenceCheck?: boolean }): Promise<void>;
  putRawData(slug: string, source: string, data: object, o?: { sourceId?: string }): Promise<void>;
  addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string, originSlug?: string, originField?: string, o?: { fromSourceId?: string; toSourceId?: string }): Promise<void>;
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
}
