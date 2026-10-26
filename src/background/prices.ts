import { readFileSync } from "node:fs";
import type { ResultUsage } from "../agent/token-budget";

export type TokenKind = "input" | "output" | "cache_read" | "cache_write";
export type TokenCounts = Record<TokenKind, number>;
/** USD per million tokens, keyed by model id. */
export type PriceTable = Record<string, Record<TokenKind, number>>;

const KINDS: TokenKind[] = ["input", "output", "cache_read", "cache_write"];

/**
 * Anthropic list prices, USD per million tokens, taken 2026-10-25 from the
 * claude-api skill's pricing reference (model table cached 2026-10-06, plus its
 * prompt-caching economics). Input/output are the table figures. cache_read is
 * stated per model where the reference does (Fable 5.1 0.25, Fable 5 1.00,
 * Opus 5.5 0.20, Sonnet 5.5 0.20) and is 0.1x input elsewhere. cache_write is
 * 1.25x input (5-minute TTL). Haiku 5.5 uses its up-to-100K-token prompt price.
 * Keys are model ids as the SDK reports them in `result.modelUsage`.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

function isPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Parse SLAUDE_PRICE_TABLE: inline JSON when it starts with `{`, else a file
 * path. On any problem returns the default table and errors that name paths
 * only, never values.
 */
export function loadPriceTable(raw: string | undefined): { table: PriceTable; errors: string[] } {
  const fail = (e: string) => ({ table: DEFAULT_PRICE_TABLE, errors: [e] });
  if (raw === undefined || raw.trim() === "") return { table: DEFAULT_PRICE_TABLE, errors: [] };
  const v = raw.trim();
  let text = v;
  if (!v.startsWith("{")) {
    try {
      text = readFileSync(v, "utf8");
    } catch {
      return fail("SLAUDE_PRICE_TABLE file could not be read");
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("SLAUDE_PRICE_TABLE is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("SLAUDE_PRICE_TABLE invalid: (root)");
  }
  const table: PriceTable = {};
  const bad: string[] = [];
  for (const [model, row] of Object.entries(json as Record<string, unknown>)) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      bad.push(model);
      continue;
    }
    const r = row as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!KINDS.includes(k as TokenKind)) bad.push(`${model}.${k} (unknown key)`);
    for (const k of KINDS) if (!isPrice(r[k])) bad.push(`${model}.${k}`);
    if (KINDS.every((k) => isPrice(r[k]))) {
      table[model] = { input: r.input as number, output: r.output as number, cache_read: r.cache_read as number, cache_write: r.cache_write as number };
    }
  }
  if (bad.length > 0) return fail(`SLAUDE_PRICE_TABLE invalid: ${bad.join(", ")}`);
  return { table, errors: [] };
}

/** Strip the one known provider prefix. Exact lookup otherwise, never fuzzy. */
function normalizeModel(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}

/** Σ tokens(kind) × price(model, kind) / 1e6. Null for a model not in the table. */
export function costUsd(table: PriceTable, model: string, t: TokenCounts): number | null {
  const p = Object.hasOwn(table, model) ? table[model] : Object.hasOwn(table, normalizeModel(model)) ? table[normalizeModel(model)] : undefined;
  if (!p) return null;
  return KINDS.reduce((sum, k) => sum + ((t[k] || 0) * p[k]) / 1_000_000, 0);
}

export function tokensFromUsage(u: ResultUsage): TokenCounts {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_write: u.cache_creation_input_tokens || 0,
  };
}
