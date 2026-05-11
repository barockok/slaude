import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { loadSoul, soulSystemBlock, loadApproverEntries } from "./loader";
import { SoulDataSchema, EXTRACTION_PROMPT, type SoulData } from "./data";

const CACHE_DIR = join(paths.home, "cache");

function cachePath(sha: string): string {
  return join(CACHE_DIR, `soul.${sha}.json`);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Run a single non-streaming Claude turn against the configured
 * Anthropic-compatible endpoint. No tools, no MCP, no resume. Returns the
 * raw assistant text. Throws on network/HTTP/parse failure.
 */
async function callExtractor(system: string, prompt: string): Promise<string> {
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const key = process.env.ANTHROPIC_API_KEY;
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const model = process.env.SLAUDE_SOUL_PARSE_MODEL
    || process.env.SLAUDE_MODEL
    || "claude-haiku-4-5-20251001";
  if (!key && !oauth) {
    throw new Error("missing auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  }

  // API-key auth wins when both are present (explicit > subscription). OAuth
  // requires the anthropic-beta: oauth-2025-04-20 header — without it the API
  // rejects bearer tokens with 401.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (key) {
    headers["x-api-key"] = key;
  } else {
    headers["authorization"] = `Bearer ${oauth}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const res = await fetch(`${base.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`extractor http ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("extractor returned empty text");
  return text;
}

/** Strip a single optional ```json fence, then JSON.parse. */
function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

/**
 * Reject any extracted Slack id (manager, allowedChannels, approvers) that
 * does not appear verbatim in the source persona. Stops the extractor from
 * inventing ids that would silently widen the allowlist.
 */
function assertIdsGroundedInPersona(data: SoulData, persona: string): void {
  const ids = new Set<string>();
  if (data.manager.userId) ids.add(data.manager.userId);
  for (const c of data.allowedChannels) ids.add(c);
  for (const a of data.approvers) ids.add(a.userId);
  const missing = [...ids].filter((id) => !persona.includes(id));
  if (missing.length) {
    throw new Error(`extractor produced ungrounded ids: ${missing.join(", ")}`);
  }
}

/** Regex-derived fallback. Only fills `approvers` — other fields stay empty. */
function regexFallback(): SoulData {
  const entries = loadApproverEntries() ?? [];
  return SoulDataSchema.parse({ approvers: entries });
}

/**
 * Resolve structured SoulData. Order:
 *   1. cache hit on sha256(SOUL.md) → return cached
 *   2. LLM extraction → validate via zod → cache → return
 *   3. on any failure → regex fallback (approvers only)
 *
 * Safe to call repeatedly; cheap after first call.
 */
export async function loadSoulData(): Promise<SoulData> {
  const persona = loadSoul();
  const sha = sha256(persona);
  const cp = cachePath(sha);

  if (existsSync(cp)) {
    try {
      const cached = JSON.parse(readFileSync(cp, "utf8"));
      return SoulDataSchema.parse(cached);
    } catch (e) {
      console.warn(`[soul] cache invalid at ${cp}, re-extracting:`, e);
    }
  }

  try {
    const text = await callExtractor(soulSystemBlock(persona), EXTRACTION_PROMPT);
    const raw = parseJsonLoose(text);
    const data = SoulDataSchema.parse(raw);
    // Defense in depth: every extracted Slack id MUST appear verbatim in
    // SOUL.md. Blocks the LLM from inventing approvers or whitelisted
    // channels the operator never authorised.
    assertIdsGroundedInPersona(data, persona);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cp, JSON.stringify(data, null, 2), "utf8");
    console.log(`[soul] extracted ${data.approvers.length} approver(s), cached at ${cp}`);
    return data;
  } catch (e) {
    console.warn("[soul] LLM extraction failed, falling back to regex parser:", e);
    return regexFallback();
  }
}

/**
 * Synchronous accessor for callers that can't await (e.g. inside a tool
 * handler). Returns the last cached value or regex fallback. Call
 * {@link loadSoulData} once at boot to warm the cache.
 */
let memo: SoulData | null = null;
export function setSoulData(d: SoulData) { memo = d; }
/** Test helper: drop the in-memory memo so the next {@link soulData} call
 *  re-reads from disk cache or falls back to regex. */
export function __resetSoulDataMemo() { memo = null; }
export function soulData(): SoulData {
  if (memo) return memo;
  // Best-effort sync read of the freshest cache file for current SOUL.md.
  // NOT memoized into `memo` — operator can edit SOUL.md and a subsequent
  // call should pick that up without a restart (and tests rely on it).
  try {
    const sha = sha256(loadSoul());
    const cp = cachePath(sha);
    if (existsSync(cp)) {
      return SoulDataSchema.parse(JSON.parse(readFileSync(cp, "utf8")));
    }
  } catch { /* fall through */ }
  return regexFallback();
}
