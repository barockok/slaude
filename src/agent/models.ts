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
 * `/model` validation for a session whose persona may run on its OWN provider
 * (WS-A §5.5). listModels asks the gateway's provider; a persona with provider
 * references runs elsewhere, so its choice is passed through unverified rather
 * than rejected or "verified" against the wrong catalogue. The persona's
 * credentials are deliberately not resolved here: that would put them in the
 * gateway's own process for a convenience check.
 */
export async function verifyModelChoice(
  id: string,
  personaProvider: unknown,
  list: () => Promise<ModelInfo[]> = listModels,
): Promise<boolean> {
  if (personaProvider) return false;
  try {
    return (await list()).some((m) => m.id === id);
  } catch {
    // provider has no /v1/models (non-Anthropic gateway) — pass through.
    return false;
  }
}

/** The model list `/model` shows; refused for a persona on its own provider. */
export async function listModelsFor(personaProvider: unknown, list: () => Promise<ModelInfo[]> = listModels): Promise<ModelInfo[]> {
  if (personaProvider) throw new Error("this persona runs on its own provider; its model list is not available here");
  return list();
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
