import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { loadSoul, soulSystemBlock, loadApproverEntries } from "./loader";
import { SoulDataSchema, EXTRACTION_PROMPT, type SoulData, type ApproverEntry } from "./data";
import { applyOverrides } from "./overrides";
import * as SoulOverrides from "../db/soul-overrides";
import { masterKey } from "../db/crypto";

/** Where extracted SoulData is cached. `SLAUDE_SOUL_CACHE_DIR` overrides the
 *  default `$SLAUDE_HOME/cache`: in the gateway topology `$SLAUDE_HOME` is a
 *  volume every node (and every agent turn) can write, so the gateway points
 *  this at pod-local storage. Read per call so a test or boot can move it. */
function cacheDir(): string {
  const v = process.env.SLAUDE_SOUL_CACHE_DIR?.trim();
  return v ? v : join(paths.home, "cache");
}

function cachePath(sha: string): string {
  return join(cacheDir(), `soul.${sha}.json`);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** The cache file for a soul text: the single derivation, shared by extraction
 *  and anything that pre-seeds the cache (e.g. the k8s-local verifier). */
export function soulCachePath(text: string): string {
  return cachePath(sha256(text));
}

/**
 * The key that binds a cache entry to its writer, derived from SLAUDE_MASTER_KEY
 * (never the master key itself). null: no master key is configured, so entries
 * are plain SoulData as before. "unusable": a key is set but invalid, so no
 * entry can be trusted or written.
 */
function cacheMacKey(): Buffer | null | "unusable" {
  if (!process.env.SLAUDE_MASTER_KEY?.trim()) return null;
  try {
    return createHmac("sha256", masterKey()).update("slaude:soul-cache:v1").digest();
  } catch {
    return "unusable";
  }
}

function cacheMac(key: Buffer, text: string, data: unknown): string {
  return createHmac("sha256", key).update(`${sha256(text)}\n${JSON.stringify(data)}`).digest("hex");
}

/**
 * Read a cache entry for `text`. With a master key the file must be an envelope
 * `{ v: 1, mac, data }` whose MAC verifies: grounding alone cannot stop a
 * planted file swapping roles between ids the soul merely mentions, but only a
 * key holder (the gateway) can sign. Returns null on any miss; never throws.
 */
function readCacheEntry(text: string): { data: SoulData; why?: undefined } | { data: null; why: string } {
  const cp = soulCachePath(text);
  if (!existsSync(cp)) return { data: null, why: "" };
  try {
    const parsed = JSON.parse(readFileSync(cp, "utf8"));
    const key = cacheMacKey();
    let body: unknown = parsed;
    if (key === "unusable") return { data: null, why: "SLAUDE_MASTER_KEY is invalid; not trusting the cache" };
    const isEnvelope = parsed && typeof parsed === "object" && parsed.v === 1 && "data" in parsed;
    if (key) {
      if (!isEnvelope || typeof parsed.mac !== "string") return { data: null, why: "unsigned entry" };
      const want = Buffer.from(cacheMac(key, text, parsed.data), "hex");
      const got = Buffer.from(parsed.mac, "hex");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return { data: null, why: "entry MAC does not verify" };
      body = parsed.data;
    } else if (isEnvelope) {
      body = parsed.data;
    }
    const data = SoulDataSchema.parse(body);
    // Same grounding check a fresh extraction gets.
    assertIdsGroundedInPersona(data, text);
    return { data };
  } catch (e) {
    return { data: null, why: (e as Error).message?.slice(0, 200) ?? "unreadable" };
  }
}

/**
 * Write the cache entry for `text`: signed with the master-key-derived key when
 * one is configured, plain SoulData otherwise. The single writer, used by
 * extraction and by anything that pre-seeds the cache (the k8s-local verifier),
 * so a seed is always an entry extraction accepts. Returns the path, or null
 * when the configured master key is unusable (nothing is written).
 */
export function writeSoulCacheEntry(text: string, data: SoulData): string | null {
  const valid = SoulDataSchema.parse(data);
  const key = cacheMacKey();
  if (key === "unusable") return null;
  const cp = soulCachePath(text);
  mkdirSync(cacheDir(), { recursive: true });
  const body = key ? { v: 1, mac: cacheMac(key, text, valid), data: valid } : valid;
  writeFileSync(cp, JSON.stringify(body, null, 2), "utf8");
  return cp;
}

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Resolve the `max_tokens` budget for the extractor call. Defaults to 8192
 * so thinking-mode providers (e.g. Deepseek's anthropic-compat endpoint
 * that emits `thinking` blocks alongside `text`, both counting against the
 * budget) leave enough headroom for the JSON payload. Operators can raise
 * the cap via `SLAUDE_SOUL_PARSE_MAX_TOKENS` when a slower model needs
 * more breathing room.
 */
function resolveMaxTokens(): number {
  const raw = process.env.SLAUDE_SOUL_PARSE_MAX_TOKENS;
  if (!raw) return DEFAULT_MAX_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_TOKENS;
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
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const model = process.env.SLAUDE_SOUL_PARSE_MODEL
    || process.env.SLAUDE_MODEL
    || "claude-haiku-4-5-20251001";
  if (!key && !oauth && !authToken) {
    throw new Error("missing auth: set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN");
  }

  // API-key auth wins when present (explicit > subscription > gateway bearer).
  // OAuth requires the anthropic-beta: oauth-2025-04-20 header — without it
  // the API rejects bearer tokens with 401. ANTHROPIC_AUTH_TOKEN is a plain
  // bearer token for gateways that prefer Authorization over x-api-key.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (key) {
    headers["x-api-key"] = key;
  } else if (oauth) {
    headers["authorization"] = `Bearer ${oauth}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["authorization"] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${base.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: resolveMaxTokens(),
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
  if (data.backupManager.userId) ids.add(data.backupManager.userId);
  for (const c of data.allowedChannels) ids.add(c);
  for (const c of data.trustedChannels) ids.add(c);
  for (const u of data.blockedUsers) ids.add(u);
  for (const u of data.dmAllowedUsers) ids.add(u);
  for (const a of data.approvers) ids.add(a.userId);
  for (const co of data.channelOverrides) {
    ids.add(co.channel);
    for (const a of co.approvers) ids.add(a.userId);
  }
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
  return extractSoulData(loadSoul(), { strict: false });
}

export class SoulExtractionError extends Error {}

/**
 * Structured extraction for an arbitrary soul text.
 *
 * strict: any failure throws. Used by persona sync, where a degraded extraction
 * would store a soul stripped of its ACLs while reporting success.
 * non-strict: falls back to the regex parse, exactly as loadSoulData always has.
 */
export async function extractSoulData(
  persona: string,
  opts: { strict: boolean; call?: (system: string, prompt: string) => Promise<string> },
): Promise<SoulData> {
  const call = opts.call ?? callExtractor;
  const cp = soulCachePath(persona);

  // A cache file is never trusted: anyone who can write the cache directory
  // could plant approvers or a manager. A hit must pass the writer MAC (when a
  // master key is set), the schema and the grounding check; else it is a miss.
  const hit = readCacheEntry(persona);
  if (hit.data) return hit.data;
  if (hit.why) console.warn(`[soul] cache invalid at ${cp}, re-extracting: ${hit.why}`);

  try {
    const text = await call(soulSystemBlock(persona), EXTRACTION_PROMPT);
    const raw = parseJsonLoose(text);
    const data = SoulDataSchema.parse(raw);
    // Defense in depth: every extracted Slack id MUST appear verbatim in
    // SOUL.md. Blocks the LLM from inventing approvers or whitelisted
    // channels the operator never authorised.
    assertIdsGroundedInPersona(data, persona);
    const written = writeSoulCacheEntry(persona, data);
    console.log(`[soul] extracted ${data.approvers.length} approver(s), ${written ? `cached at ${written}` : "not cached (SLAUDE_MASTER_KEY invalid)"}`);
    return data;
  } catch (e) {
    if (opts.strict) throw new SoulExtractionError(`soul extraction failed: ${(e as Error).message}`);
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
/** Un-overlaid view of SOUL.md (memo / disk cache / regex fallback).
 *  Use for provenance rendering (/soul list); gates must use soulData(). */
export function soulDataBase(): SoulData {
  if (memo) return memo;
  // Best-effort sync read of the freshest cache file for current SOUL.md.
  // NOT memoized into `memo` — operator can edit SOUL.md and a subsequent
  // call should pick that up without a restart (and tests rely on it).
  try {
    const hit = readCacheEntry(loadSoul()); // same rules as extractSoulData's hit
    if (hit.data) return hit.data;
  } catch { /* fall through */ }
  return regexFallback();
}

/** Effective soul: (SOUL.md ∪ runtime adds) − runtime removes. The overlay is
 *  read per call, so a manager override is live on the next inbound message
 *  in every session — no reload. See src/soul/overrides.ts. */
export function soulData(): SoulData {
  const base = soulDataBase();
  try {
    return applyOverrides(base, SoulOverrides.listSync());
  } catch {
    return base; // overlay must never take the gates down
  }
}

/**
 * Effective soul for a specific Slack channel. Starts from the global
 * {@link soulData} (runtime overlays preserved), then applies the matching
 * `## Channel` block: mandate replaced when the override sets one, approvers
 * replaced when the override lists ≥1. No channel / no match → global view.
 *
 * Replace semantics (operator choice): inside an overridden channel the
 * channel approver list is the *only* approver source for the approval gate
 * and approver-based admin auth. manager/backup authority is a separate check
 * and is never affected. See docs/superpowers/specs/2026-06-20-channel-soul-overrides-design.md.
 *
 * Always returns a usable SoulData — any failure falls back to the global
 * view so the gates never break.
 */
/**
 * Guarantee the manager (and backup manager) stay eligible approvers even when
 * a channel override replaces the approver set. Without this, a channel block
 * that lists only e.g. the DBA would lock the operator out of the approval gate
 * in that channel. Manager/backup are appended as catchalls (always eligible)
 * unless already present in the override list.
 */
function withManagerApprover(approvers: ApproverEntry[], base: SoulData): ApproverEntry[] {
  const out = [...approvers];
  const have = new Set(out.map((a) => a.userId));
  for (const id of [base.manager?.userId, base.backupManager?.userId]) {
    if (id && !have.has(id)) {
      out.push({ userId: id, scope: "anything", catchall: true });
      have.add(id);
    }
  }
  return out;
}

export function effectiveSoulForChannel(channelId?: string): SoulData {
  const base = soulData();
  if (!channelId) return base;
  try {
    const ov = base.channelOverrides.find((c) => c.channel === channelId);
    if (!ov) return base;
    return {
      ...base,
      mandate: ov.mandate?.trim() ? ov.mandate : base.mandate,
      approvers: ov.approvers.length
        ? withManagerApprover(ov.approvers, base)
        : base.approvers,
    };
  } catch {
    return base;
  }
}
