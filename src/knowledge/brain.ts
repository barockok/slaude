import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { loadKbs } from "./loader";
import { PUBLIC_SOURCE, SHARED_SOURCE, kbSourceId, type BrainScope } from "./scope";
import { isScopeWriteOp } from "./gated-dispatch";
import { getBackend } from "./backend";

// Engine surface kept minimal on purpose: gbrain ships TS sources and its own
// types stay internal to it; slaude only needs lifecycle + handler dispatch.
// Imports go through gbrainImport so tsc never resolves into node_modules/gbrain
// (its sources don't compile under slaude's strictness); Bun resolves at runtime.
const gbrainImport = (subpath: string): Promise<Record<string, unknown>> =>
  import(("gbrain/" + subpath) as string) as Promise<Record<string, unknown>>;

type Engine = {
  connect(c: object): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
};

let enginePromise: Promise<Engine> | null = null;

export function brainHome(): string {
  return process.env.SLAUDE_BRAIN_HOME || join(paths.home, "brain");
}

export function brainEnabled(): boolean {
  return process.env.SLAUDE_BRAIN_DISABLED !== "1";
}

/**
 * True when the operator wired a (remote) embedding model into the brain:
 * `embedding_model` set in $SLAUDE_BRAIN_HOME/config.json (gbrain's own config
 * file; provider key env validated by gbrain itself, which fails loud).
 * Gates the embed step in sync — keyword+graph search needs none of this.
 */
export function embeddingConfigured(): boolean {
  try {
    const raw = readFileSync(join(brainHome(), "config.json"), "utf8");
    return Boolean((JSON.parse(raw) as { embedding_model?: string }).embedding_model);
  } catch {
    return false;
  }
}

// Deterministic embedding provider enum & configuration
export const EMBEDDING_PROVIDERS = [
  "google",
  "openai",
  "voyage",
  "zeroentropyai",
  "openrouter",
  "together",
  "minimax",
  "azure-openai",
  "ollama",
  "litellm",
] as const;

export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export const PROVIDER_ALIASES: Record<string, EmbeddingProvider> = {
  gemini: "google",
  zeroentropy: "zeroentropyai",
  azure: "azure-openai",
};

export function normalizeEmbeddingProvider(raw?: string): EmbeddingProvider | undefined {
  if (!raw) return undefined;
  const p = raw.trim().toLowerCase();
  if ((EMBEDDING_PROVIDERS as readonly string[]).includes(p)) {
    return p as EmbeddingProvider;
  }
  if (p in PROVIDER_ALIASES) {
    return PROVIDER_ALIASES[p];
  }
  return undefined;
}

export interface ProviderConfig {
  canonicalKey?: string;
  aliases: string[];
  defaultModel: string;
  defaultDims: number;
}

export const PROVIDER_CONFIGS: Record<EmbeddingProvider, ProviderConfig> = {
  google: {
    canonicalKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    aliases: ["GEMINI_API_KEY", "EMBEDDING_API_KEY"],
    defaultModel: "text-embedding-004",
    defaultDims: 768,
  },
  openai: {
    canonicalKey: "OPENAI_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "text-embedding-3-small",
    defaultDims: 1536,
  },
  voyage: {
    canonicalKey: "VOYAGE_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "voyage-3",
    defaultDims: 1024,
  },
  zeroentropyai: {
    canonicalKey: "ZEROENTROPY_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "zembed-1",
    defaultDims: 1280,
  },
  openrouter: {
    canonicalKey: "OPENROUTER_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "text-embedding-3-small",
    defaultDims: 1536,
  },
  together: {
    canonicalKey: "TOGETHER_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "togethercomputer/m2-bert-80M-8k-retrieval",
    defaultDims: 768,
  },
  minimax: {
    canonicalKey: "MINIMAX_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "embo-01",
    defaultDims: 1536,
  },
  "azure-openai": {
    canonicalKey: "AZURE_OPENAI_API_KEY",
    aliases: ["OPENAI_API_KEY", "EMBEDDING_API_KEY"],
    defaultModel: "text-embedding-3-small",
    defaultDims: 1536,
  },
  ollama: {
    canonicalKey: "OLLAMA_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "nomic-embed-text",
    defaultDims: 768,
  },
  litellm: {
    aliases: ["EMBEDDING_API_KEY"],
    defaultModel: "text-embedding-3-small",
    defaultDims: 1536,
  },
};

// Backward-compatibility export for PROVIDER_KEY_DEFS
export interface ProviderKeyDef {
  canonical: string;
  aliases: string[];
  defaultDims?: number;
}

export const PROVIDER_KEY_DEFS: Record<string, ProviderKeyDef | null> = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_CONFIGS).map(([prov, def]) => [
      prov,
      def.canonicalKey
        ? { canonical: def.canonicalKey, aliases: def.aliases, defaultDims: def.defaultDims }
        : null,
    ])
  ),
  gemini: {
    canonical: "GOOGLE_GENERATIVE_AI_API_KEY",
    aliases: ["GEMINI_API_KEY", "EMBEDDING_API_KEY"],
    defaultDims: 768,
  },
  zeroentropy: {
    canonical: "ZEROENTROPY_API_KEY",
    aliases: ["EMBEDDING_API_KEY"],
    defaultDims: 1280,
  },
  azure: {
    canonical: "AZURE_OPENAI_API_KEY",
    aliases: ["OPENAI_API_KEY", "EMBEDDING_API_KEY"],
    defaultDims: 1536,
  },
  "llama-server": null,
};

export const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
  // OpenAI
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  // Google / Gemini
  "text-embedding-004": 768,
  "gemini-embedding-001": 768,
  // ZeroEntropy
  "zembed-1": 1280,
  // Voyage
  "voyage-3-lite": 512,
  "voyage-3": 1024,
  "voyage-code-3": 1024,
  "voyage-finance-2": 1024,
  "voyage-law-2": 1024,
  "voyage-4": 1024,
  "voyage-4-large": 1024,
  "voyage-multimodal-3": 1024,
  // Open-source / local
  "bge-small": 384,
  "all-minilm": 384,
  "all-minilm-l6-v2": 384,
  "bge-base": 768,
  "nomic-embed-text": 768,
  "bge-m3": 1024,
  "bge-large": 1024,
};

export const BARE_MODEL_TO_PROVIDER: Record<string, EmbeddingProvider> = {
  "text-embedding-3-small": "openai",
  "text-embedding-3-large": "openai",
  "text-embedding-ada-002": "openai",
  "text-embedding-004": "google",
  "gemini-embedding-001": "google",
  "zembed-1": "zeroentropyai",
  "voyage-3": "voyage",
  "voyage-3-lite": "voyage",
  "voyage-code-3": "voyage",
  "voyage-4": "voyage",
  "voyage-4-large": "voyage",
};

/**
 * Deterministically canonicalize an embedding model string based on provider
 * enum/setting, model string, or explicit base URL.
 */
export function canonicalizeEmbeddingModel(
  rawModel?: string,
  url?: string,
  rawProvider?: string
): string | undefined {
  const explicitProvider = normalizeEmbeddingProvider(rawProvider);
  const trimmedModel = rawModel?.trim();

  // If model already has a provider prefix "provider:model"
  if (trimmedModel?.includes(":")) {
    const colonIdx = trimmedModel.indexOf(":");
    const provPrefix = trimmedModel.slice(0, colonIdx);
    const modelRest = trimmedModel.slice(colonIdx + 1);
    const normalizedPrefix = normalizeEmbeddingProvider(provPrefix) ?? provPrefix.toLowerCase();
    return `${normalizedPrefix}:${modelRest}`;
  }

  // Determine provider
  let provider = explicitProvider;

  if (!provider) {
    if (url) {
      provider = "litellm";
    } else if (trimmedModel) {
      const autoProv = BARE_MODEL_TO_PROVIDER[trimmedModel.toLowerCase()];
      if (autoProv) provider = autoProv;
    }
  }

  if (!provider) {
    return trimmedModel ? `litellm:${trimmedModel}` : undefined;
  }

  // Now we have a provider. Determine the model.
  const chosenModel = trimmedModel || PROVIDER_CONFIGS[provider]?.defaultModel || "text-embedding-3-small";
  return `${provider}:${chosenModel}`;
}

/**
 * Returns default vector embedding dimensions for a model string.
 * Resolves model-specific dimensions first, then known provider defaults,
 * falling back to 2560 for unknown provider-qualified models and 1536 for generic litellm/OpenAI.
 */
export function defaultDimensionsForModel(modelString: string): number {
  const parts = modelString.split(":");
  const modelName = (parts.length > 1 ? parts[1] : parts[0])!.toLowerCase();
  for (const [known, dims] of Object.entries(KNOWN_MODEL_DIMENSIONS)) {
    if (modelName === known || modelName.includes(known)) return dims;
  }
  const provider = parts.length > 1 ? parts[0]!.toLowerCase() : "";
  const normProv = normalizeEmbeddingProvider(provider);
  if (normProv && PROVIDER_CONFIGS[normProv]?.defaultDims) {
    return PROVIDER_CONFIGS[normProv].defaultDims;
  }
  return modelString.includes(":") ? 2560 : 1536;
}

/**
 * Resolves API key for an embedding provider across canonical name and declared aliases.
 * When an alias is detected, sets the canonical env var so gbrain and downstream SDKs find it.
 */
export function resolveEmbeddingApiKey(provider: string): {
  key?: string;
  canonical?: string;
  isRequired: boolean;
} {
  const norm = normalizeEmbeddingProvider(provider);
  const def = norm ? PROVIDER_CONFIGS[norm] : undefined;
  if (!def) {
    if (provider.toLowerCase() === "llama-server") return { isRequired: false };
    return {
      key: process.env.EMBEDDING_API_KEY,
      canonical: "EMBEDDING_API_KEY",
      isRequired: false,
    };
  }
  if (!def.canonicalKey) {
    return {
      key: process.env.LITELLM_API_KEY ?? process.env.EMBEDDING_API_KEY,
      canonical: "LITELLM_API_KEY",
      isRequired: false,
    };
  }

  const { canonicalKey, aliases } = def;
  let key = process.env[canonicalKey];

  if (!key) {
    for (const alias of aliases) {
      const aliasVal = process.env[alias];
      if (aliasVal) {
        process.env[canonicalKey] = aliasVal;
        key = aliasVal;
        break;
      }
    }
  }

  return { key, canonical: canonicalKey, isRequired: true };
}

/**
 * Provider-generic embedding config, mirroring slaude's ANTHROPIC_BASE_URL
 * pattern: EMBEDDING_PROVIDER + EMBEDDING_MODEL (+ EMBEDDING_URL,
 * EMBEDDING_API_KEY, EMBEDDING_DIMENSIONS) configure the embedding provider
 * and model deterministically. An explicit embedding_model already in
 * config.json always wins unless env vars are explicitly set.
 */
export function applyEmbeddingEnv(): void {
  const url = process.env.EMBEDDING_URL?.trim();
  const rawProvider = process.env.EMBEDDING_PROVIDER?.trim();
  const rawModel = process.env.EMBEDDING_MODEL?.trim();
  const explicitDims = process.env.EMBEDDING_DIMENSIONS?.trim();

  const home = brainHome();
  mkdirSync(home, { recursive: true });
  const cfgPath = join(home, "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    // missing or unreadable → start fresh
  }

  const resolvedModel = canonicalizeEmbeddingModel(rawModel, url, rawProvider);

  // If neither env vars nor config.json configure an embedding model, do nothing
  if (!resolvedModel && !cfg.embedding_model && !explicitDims) {
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    return;
  }

  if (url) {
    process.env.LITELLM_BASE_URL = url;
    if (process.env.EMBEDDING_API_KEY) process.env.LITELLM_API_KEY = process.env.EMBEDDING_API_KEY;
  }

  // Target model: explicit resolved env model takes precedence when rawModel or rawProvider is set,
  // falling back to existing config.json model.
  const targetModel =
    rawModel || rawProvider
      ? resolvedModel ?? (typeof cfg.embedding_model === "string" ? cfg.embedding_model : "litellm:text-embedding-3-small")
      : typeof cfg.embedding_model === "string"
        ? cfg.embedding_model
        : (resolvedModel ?? "litellm:text-embedding-3-small");
  const modelChanged = cfg.embedding_model !== targetModel;

  // If model changed and operator didn't explicitly specify dims, reset to target model's default dims
  const targetDims = Number(
    explicitDims ??
      (!modelChanged && typeof cfg.embedding_dimensions === "number"
        ? cfg.embedding_dimensions
        : defaultDimensionsForModel(targetModel))
  );

  const prevDims = typeof cfg.embedding_dimensions === "number" ? cfg.embedding_dimensions : undefined;
  if (prevDims && prevDims !== targetDims) {
    console.warn(`[brain] embedding dimensions changed from ${prevDims} to ${targetDims}. Backing up old PGLite store...`);
    const storePaths = [
      join(home, "db"),
      join(home, "brain.pglite"),
    ];
    for (const storePath of storePaths) {
      if (existsSync(storePath)) {
        const bakPath = `${storePath}.${prevDims}.bak`;
        try {
          if (existsSync(bakPath)) rmSync(bakPath, { recursive: true, force: true });
          renameSync(storePath, bakPath);
          console.warn(`[brain] backed up ${storePath} -> ${bakPath}`);
        } catch (err) {
          console.warn(`[brain] could not backup ${storePath}:`, err);
        }
      }
    }
  }

  const dimsChanged = cfg.embedding_dimensions !== targetDims;
  if (modelChanged || dimsChanged) {
    cfg.embedding_provider = targetModel.split(":")[0];
    cfg.embedding_model = targetModel;
    cfg.embedding_dimensions = targetDims;
    const serialized = JSON.stringify(cfg, null, 2) + "\n";
    writeFileSync(cfgPath, serialized);
    const gbrainCfgDir = join(home, ".gbrain");
    mkdirSync(gbrainCfgDir, { recursive: true });
    writeFileSync(join(gbrainCfgDir, "config.json"), serialized);
    console.log(`[brain] embedding configured: ${targetModel} (${targetDims} dims)`);
  }

  // Synchronize process env for gbrain internals
  process.env.GBRAIN_EMBEDDING_MODEL = targetModel;
  process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(targetDims);
}

/**
 * Clear a leftover PGLite lock before connect. gbrain's staleness check is
 * kill(pid, 0) — after a pod restart the previous container's recorded PID
 * usually maps to SOME live process in the new PID namespace, so the lock
 * never looks stale and connect times out (seen in a staging environment). slaude's
 * deploy contract is one process per brain (one container = one persona,
 * Recreate strategy), so a lock present at fresh-process boot is stale by
 * construction. Opt out with SLAUDE_BRAIN_TAKEOVER=0 if you intentionally
 * share a brain home across processes (don't — PGLite is single-writer).
 */
function takeoverStaleLock(dbDir: string): void {
  if (process.env.SLAUDE_BRAIN_TAKEOVER === "0") return;
  const lockDir = join(dbDir, ".gbrain-lock");
  const pidFile = join(dbDir, "postmaster.pid");
  let removed = false;
  try {
    if (readdirSync(lockDir).length || existsSync(join(lockDir, "lock"))) {
      rmSync(lockDir, { recursive: true, force: true });
      removed = true;
    }
  } catch {}
  try {
    if (existsSync(pidFile)) {
      rmSync(pidFile, { force: true });
      removed = true;
    }
  } catch {}
  if (removed) {
    console.warn("[brain] removing leftover PGLite lock / postmaster.pid (previous process did not shut down cleanly)");
  }
}

let embeddingActiveFlag = false;

/** Runtime truth for "may sync attempt embeds": gateway configured AND the
 *  provider's key env present. config.json alone isn't enough — gbrain's
 *  embedding gateway is a process singleton that hard-fails sync (observed:
 *  process exit in staging) when an embed step runs unconfigured. */
export function embeddingActive(): boolean {
  return embeddingActiveFlag;
}

async function configureEmbeddingGateway(): Promise<void> {
  embeddingActiveFlag = false;
  if (!embeddingConfigured()) return;
  let model = "";
  try {
    const raw = JSON.parse(readFileSync(join(brainHome(), "config.json"), "utf8")) as { embedding_model?: string };
    model = raw.embedding_model ?? "";
  } catch {
    return;
  }
  const provider = model.split(":")[0] ?? "";

  const { key, canonical, isRequired } = resolveEmbeddingApiKey(provider);
  if (isRequired && !key) {
    console.warn(`[brain] embedding_model ${model} configured but ${canonical} is not set — embeds stay off`);
    return;
  }
  try {
    const { buildGatewayConfig } = (await import(
      join(import.meta.dir, "../../node_modules/gbrain/src/core/ai/build-gateway-config.ts")
    )) as { buildGatewayConfig: (c: object) => object };
    const { configureGateway } = (await gbrainImport("ai/gateway")) as { configureGateway: (c: object) => void };
    const { loadConfig } = (await gbrainImport("config")) as { loadConfig: () => object | null };
    configureGateway(buildGatewayConfig(loadConfig() ?? {}));
    embeddingActiveFlag = true;
    console.log(`[brain] embedding gateway configured: ${model}`);
  } catch (e) {
    console.warn("[brain] embedding gateway configuration failed — embeds stay off:", e instanceof Error ? e.message : e);
  }
}

/**
 * Same takeover principle, one layer up: gbrain's sync/dream advisory locks
 * persist as rows in gbrain_cycle_locks (30-min TTL, host+pid attributed).
 * A pod killed mid-sync leaves its row on the PVC; the next pod is a
 * different host so gbrain won't steal it until TTL expiry — every KB sync
 * fails "Another sync is in progress" for up to 30 minutes (seen in staging
 * deployment). At fresh-process boot we own the brain exclusively, so all lock
 * rows are stale by construction.
 */
async function clearStaleDbLocks(engine: Engine): Promise<void> {
  if (process.env.SLAUDE_BRAIN_TAKEOVER === "0") return;
  const db = (engine as { db?: { query: (sql: string) => Promise<{ rows: unknown[] }> } }).db;
  if (!db) return;
  try {
    const { rows } = await db.query("DELETE FROM gbrain_cycle_locks RETURNING id");
    if (rows.length) {
      console.warn(`[brain] cleared ${rows.length} stale gbrain lock row(s) left by a previous process`);
    }
  } catch (e) {
    console.warn("[brain] stale-lock sweep failed (continuing):", e instanceof Error ? e.message : e);
  }
}

type EngineCfg =
  | { engine: "pglite"; database_path: string }
  | { engine: "postgres"; database_url: string };

/**
 * Engine selection. Default PGLite (embedded, single-writer — one process per
 * brain, our deploy contract). Set SLAUDE_BRAIN_ENGINE=postgres +
 * SLAUDE_BRAIN_DATABASE_URL to point at a shared Postgres server, which lets
 * reads/writes distribute across processes (the serving loop plus an
 * out-of-process nightly maintenance) instead of contending for PGLite's
 * single-writer lock. gbrain ships both engines (postgres uses pgvector).
 */
export function brainEngineConfig(): EngineCfg {
  const engine = (process.env.SLAUDE_BRAIN_ENGINE ?? "pglite").toLowerCase();
  if (engine === "postgres") {
    const url = process.env.SLAUDE_BRAIN_DATABASE_URL;
    if (!url) throw new Error("SLAUDE_BRAIN_ENGINE=postgres requires SLAUDE_BRAIN_DATABASE_URL");
    return { engine: "postgres", database_url: url };
  }
  if (engine !== "pglite") throw new Error(`unknown SLAUDE_BRAIN_ENGINE "${engine}" (want pglite|postgres)`);
  return { engine: "pglite", database_path: join(brainHome(), "db") };
}

async function boot(): Promise<Engine> {
  const home = brainHome();
  mkdirSync(home, { recursive: true });
  // gbrain reads GBRAIN_HOME for config.json, lock files, clones.
  process.env.GBRAIN_HOME = home;
  applyEmbeddingEnv();
  // Configure embedding gateway before engine connect & initSchema so schema migrations
  // size the embedding columns to match the configured model dimensions.
  await configureEmbeddingGateway();
  const cfg = brainEngineConfig();
  // Lock takeover assumes exclusive ownership at boot — true only for PGLite's
  // one-process-per-brain contract. Under shared Postgres another process (the
  // out-of-process maintenance) may legitimately hold a cycle lock, so neither
  // the PGLite file-lock rm nor the blanket cycle-lock sweep is safe there.
  if (cfg.engine === "pglite") takeoverStaleLock(cfg.database_path);
  const { createEngine } = (await gbrainImport("engine-factory")) as { createEngine: (c: object) => Promise<Engine> };
  const engine = (await createEngine(cfg)) as Engine;
  await engine.connect(cfg);
  await engine.initSchema();
  if (cfg.engine === "pglite") await clearStaleDbLocks(engine);
  return engine;
}

export function getBrain(): Promise<Engine> {
  return (enginePromise ??= boot());
}

export async function closeBrain(): Promise<void> {
  if (!enginePromise) return;
  const e = await enginePromise;
  enginePromise = null;
  ensureInFlight = null; // next boot may target a different brain home
  embeddingActiveFlag = false;
  delete process.env.GBRAIN_EMBEDDING_MODEL;
  delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  await e.disconnect();
}

const quietLogger = {
  info: () => {},
  warn: (...a: unknown[]) => console.warn("[brain]", ...a),
  error: (...a: unknown[]) => console.error("[brain]", ...a),
};

async function buildCtx(over: Record<string, unknown>) {
  const engine = await getBrain();
  const { loadConfig } = (await gbrainImport("config")) as { loadConfig: () => object | null };
  return {
    engine,
    config: loadConfig() ?? {},
    logger: quietLogger,
    dryRun: false,
    remote: true,
    sourceId: "default",
    ...over,
  };
}

type Op = { name: string; handler: (ctx: unknown, p: Record<string, unknown>) => Promise<unknown> };

async function findOp(name: string): Promise<Op> {
  const { operations } = (await gbrainImport("operations")) as { operations: Op[] };
  const op = (operations as Op[]).find((o) => o.name === name);
  if (!op) throw new Error(`unknown brain op: ${name}`);
  return op;
}

/**
 * Idempotently register a single source (used for write-time sources that
 * ensureSources()/baselineSources() never cover — notably user-<id> slices that
 * a /1on1 lock writes to). Cached so repeat writes don't re-query. Without this,
 * every kb_put_page inside a /1on1 lock FK-failed on pages_source_id_fkey.
 * See docs/findings/2026-06-14-brain-memoize-failure.md.
 */
const ensuredSources = new Set<string>();
export async function ensureSource(id: string): Promise<void> {
  if (ensuredSources.has(id)) return;
  try {
    await brainAdminCall("sources_add", { id, federated: true });
  } catch (e) {
    // already-registered is success for our purposes; gbrain reports it as
    // source_id_taken / "already registered" (Postgres) or duplicate key (pglite).
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string })?.code;
    if (code !== "source_id_taken" && !/duplicate key|already exists|already registered/i.test(msg)) throw e;
  }
  ensuredSources.add(id);
}

/**
 * Synthetic AuthInfo for a scoped op — gbrain reads this to enforce scope in
 * SQL (remote=true path). Pure: same shape the local engine and the remote
 * brain server both construct from a resolved BrainScope.
 */
export function buildScopedCtxAuth(scope: BrainScope): Record<string, unknown> {
  return {
    token: "in-process",
    clientId: scope.clientId,
    clientName: scope.clientId,
    scopes: ["read", "write"],
    sourceId: scope.sourceId,
    allowedSources: scope.allowedSources,
  };
}

/**
 * Run a scoped op against the LOCAL gbrain engine. This is the LocalBackend
 * primitive; the remote brain server reuses it verbatim behind OAuth.
 * remote=true + synthetic AuthInfo → gbrain enforces scope in SQL.
 */
export async function runScopedOp(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> {
  const op = await findOp(name);
  // A write needs its scope source to exist first (FK pages_source_id_fkey).
  if (isScopeWriteOp(name)) await ensureSource(scope.sourceId);
  const ctx = await buildCtx({
    remote: true,
    sourceId: scope.sourceId,
    auth: buildScopedCtxAuth(scope),
    takesHoldersAllowList: [scope.clientId, "world"],
  });
  return op.handler(ctx, params);
}

/** Run a trusted admin op against the LOCAL gbrain engine (boot, admin, sync). */
export async function runAdminOp(name: string, params: Record<string, unknown>, sourceId = "default"): Promise<unknown> {
  const op = await findOp(name);
  const ctx = await buildCtx({ remote: false, sourceId });
  return op.handler(ctx, params);
}

/** User-scoped call: dispatched through the configured backend (local/remote). */
export async function brainCall(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> {
  return getBackend().call(name, params, scope);
}

/** Trusted call (boot, admin, sync): dispatched through the configured backend. */
export async function brainAdminCall(name: string, params: Record<string, unknown>, sourceId = "default"): Promise<unknown> {
  return getBackend().adminCall(name, params, sourceId);
}

export function baselineSources(): string[] {
  // Per-agent `agent-<id>` slices are NOT baseline — like `user-<id>` slices they
  // are ensured lazily at first write (runScopedOp → ensureSource). This keeps the
  // brain server (which doesn't know the agent's identity) free of that concern.
  return [SHARED_SOURCE, PUBLIC_SOURCE, ...loadKbs().map((k) => kbSourceId(k.label))];
}

/**
 * Idempotently create sources. NEVER write to a source before this ran —
 * a put_page into a nonexistent source spins (observed in the spike).
 * KB sources register with their wiki/ dir so sync can import the curated
 * content (raw/ stays out of the index).
 */
let ensureInFlight: Promise<void> | null = null;

export function ensureSources(extra: string[] = []): Promise<void> {
  // Single-flight: gateway boot and the memory provider both call this at
  // startup; concurrent list-then-add races into duplicate sources_pkey.
  if (extra.length === 0 && ensureInFlight) return ensureInFlight;
  const run = (async () => {
    const listed = (await brainAdminCall("sources_list", {})) as { sources: Array<{ id: string }> };
    const existing = new Set(listed.sources.map((s) => s.id));
    const kbs = loadKbs();
    for (const id of [...baselineSources(), ...extra]) {
      if (existing.has(id)) continue;
      const kb = kbs.find((k) => kbSourceId(k.label) === id);
      const kbPath = kb ? (existsSync(join(kb.path, "wiki")) ? join(kb.path, "wiki") : kb.path) : undefined;
      try {
        await brainAdminCall(
          "sources_add",
          kbPath ? { id, path: kbPath, federated: true } : { id, federated: true },
        );
      } catch (e) {
        // lost a create race elsewhere — the source exists, which is all we need
        if (!/duplicate key|already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
  })();
  if (extra.length === 0) {
    ensureInFlight = run.catch((e) => {
      ensureInFlight = null; // allow retry after failure
      throw e;
    });
    return ensureInFlight;
  }
  return run;
}
