// src/brain-migrate/embedding-info.ts
import type { MigrateEngine } from "./engine-types";

export interface EmbeddingInfo { embeddingModel: string | null; embeddingDimensions: number | null }
export interface BrainConfigFile { embedding_model?: string; embedding_dimensions?: number }

/**
 * The one place a brain's embedding shape is derived, shared by export (writes it
 * into the manifest) and import (compares against it) so they cannot disagree.
 * The pgvector column width is authoritative for the dimension: a default brain
 * has no config.json at all. The model name only comes from config and is null
 * when none is configured.
 */
export async function readEmbeddingInfo(engine: Pick<MigrateEngine, "executeRaw">, config: () => BrainConfigFile | null | undefined): Promise<EmbeddingInfo> {
  let cfg: BrainConfigFile = {};
  try { cfg = config() ?? {}; } catch { /* absent or unreadable config: the column still answers */ }
  const row = (await engine.executeRaw(
    "SELECT atttypmod FROM pg_attribute WHERE attname = 'embedding' AND attrelid = 'content_chunks'::regclass"))[0];
  const colDims = row && Number(row.atttypmod) > 0 ? Number(row.atttypmod) : null;
  return { embeddingModel: cfg.embedding_model ?? null, embeddingDimensions: colDims ?? cfg.embedding_dimensions ?? null };
}

/**
 * Null when compatible, else the refusal text. Dimensions must match exactly;
 * the model is compared only when both sides name one (a default brain has none).
 */
export function embeddingMismatch(bundle: EmbeddingInfo, target: EmbeddingInfo): string | null {
  const dimsDiffer = bundle.embeddingDimensions !== target.embeddingDimensions;
  const modelsDiffer = bundle.embeddingModel !== null && target.embeddingModel !== null && bundle.embeddingModel !== target.embeddingModel;
  if (!dimsDiffer && !modelsDiffer) return null;
  const models = bundle.embeddingModel !== null && target.embeddingModel !== null
    ? `; models: bundle '${bundle.embeddingModel}', this brain '${target.embeddingModel}'` : "";
  return `embedding mismatch: bundle has ${bundle.embeddingDimensions ?? "unknown"} dimensions, this brain has ${target.embeddingDimensions ?? "unknown"}${models}; align EMBEDDING_MODEL and EMBEDDING_DIMENSIONS or re-export`;
}
