export interface ModelInfo {
  id: string;
  display_name: string;
}

const TTL_MS = 5 * 60 * 1000;
let cache: { data: ModelInfo[]; fetchedAtMs: number } | null = null;

/** Test-only: clear the module cache between cases. */
export function __resetModelCache(): void {
  cache = null;
}

/**
 * Fetch the provider's available models from `GET /v1/models`. Returns the
 * exact `id` strings to pass to the SDK `options.model` / `Query.setModel()`.
 *
 * Auth + base URL mirror `soul/extract.ts`: API key wins over OAuth; OAuth
 * needs the anthropic-beta header. Result cached in-memory for 5 minutes.
 * Throws on missing auth, non-200, or network error — callers treat any throw
 * as "can't verify" (pass-through + warn).
 */
export async function listModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.fetchedAtMs < TTL_MS) return cache.data;

  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const key = process.env.ANTHROPIC_API_KEY;
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!key && !oauth) {
    throw new Error("missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  }
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (key) {
    headers["x-api-key"] = key;
  } else {
    headers["authorization"] = `Bearer ${oauth}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const res = await fetch(`${base.replace(/\/$/, "")}/v1/models?limit=100`, { headers });
  if (!res.ok) throw new Error(`models list http ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  const data: ModelInfo[] = (body.data ?? []).map((m) => ({
    id: m.id,
    display_name: m.display_name ?? m.id,
  }));
  cache = { data, fetchedAtMs: Date.now() };
  return data;
}
