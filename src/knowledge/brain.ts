import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { loadKbs } from "./loader";
import { AGENT_SOURCE, PUBLIC_SOURCE, SHARED_SOURCE, kbSourceId, type BrainScope } from "./scope";
import { isScopeWriteOp } from "./gated-dispatch";

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

/**
 * Provider-generic embedding config, mirroring slaude's ANTHROPIC_BASE_URL
 * pattern: EMBEDDING_URL (+ EMBEDDING_API_KEY, EMBEDDING_MODEL,
 * EMBEDDING_DIMENSIONS) point at any OpenAI-compatible /v1/embeddings
 * endpoint. Mapped onto gbrain's `litellm:` recipe (its generic
 * base-URL+key passthrough). An explicit embedding_model already in
 * config.json always wins — env never clobbers operator config.
 */
export function applyEmbeddingEnv(): void {
  const url = process.env.EMBEDDING_URL;
  const model = process.env.EMBEDDING_MODEL;
  // Provider-qualified model ("zeroentropyai:zembed-1") needs no URL — the
  // native recipe resolves its own endpoint from its provider key env.
  const providerQualified = !!model && model.includes(":");
  if (!url && !providerQualified) return;
  if (url) {
    process.env.LITELLM_BASE_URL = url;
    if (process.env.EMBEDDING_API_KEY) process.env.LITELLM_API_KEY = process.env.EMBEDDING_API_KEY;
  }
  if (embeddingConfigured()) return;
  const home = brainHome();
  mkdirSync(home, { recursive: true });
  const cfgPath = join(home, "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    // missing or unreadable → start fresh
  }
  cfg.embedding_model = providerQualified ? model! : `litellm:${model ?? "text-embedding-3-small"}`;
  cfg.embedding_dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? (providerQualified ? 2560 : 1536));
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Clear a leftover PGLite lock before connect. gbrain's staleness check is
 * kill(pid, 0) — after a pod restart the previous container's recorded PID
 * usually maps to SOME live process in the new PID namespace, so the lock
 * never looks stale and connect times out (seen on maria UAT). slaude's
 * deploy contract is one process per brain (one container = one persona,
 * Recreate strategy), so a lock present at fresh-process boot is stale by
 * construction. Opt out with SLAUDE_BRAIN_TAKEOVER=0 if you intentionally
 * share a brain home across processes (don't — PGLite is single-writer).
 */
function takeoverStaleLock(dbDir: string): void {
  if (process.env.SLAUDE_BRAIN_TAKEOVER === "0") return;
  const lockDir = join(dbDir, ".gbrain-lock");
  try {
    if (!readdirSync(lockDir).length && !existsSync(join(lockDir, "lock"))) return;
  } catch {
    return; // no lock dir — nothing to do
  }
  console.warn("[brain] removing leftover PGLite lock (previous process did not shut down cleanly)");
  rmSync(lockDir, { recursive: true, force: true });
}

let embeddingActiveFlag = false;

/** Runtime truth for "may sync attempt embeds": gateway configured AND the
 *  provider's key env present. config.json alone isn't enough — gbrain's
 *  embedding gateway is a process singleton that hard-fails sync (observed:
 *  process exit on maria UAT) when an embed step runs unconfigured. */
export function embeddingActive(): boolean {
  return embeddingActiveFlag;
}

// Provider prefix → required key env. null = keyless/optional-key provider.
const PROVIDER_KEY_ENV: Record<string, string | null> = {
  zeroentropyai: "ZEROENTROPY_API_KEY",
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  minimax: "MINIMAX_API_KEY",
  together: "TOGETHER_API_KEY",
  litellm: null,
  ollama: null,
  "llama-server": null,
};

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
  const keyEnv = PROVIDER_KEY_ENV[provider];
  if (keyEnv && !process.env[keyEnv]) {
    console.warn(`[brain] embedding_model ${model} configured but ${keyEnv} is not set — embeds stay off`);
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
 * fails "Another sync is in progress" for up to 30 minutes (seen on maria
 * UAT). At fresh-process boot we own the brain exclusively, so all lock
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

async function boot(): Promise<Engine> {
  const home = brainHome();
  mkdirSync(home, { recursive: true });
  // gbrain reads GBRAIN_HOME for config.json, lock files, clones.
  process.env.GBRAIN_HOME = home;
  applyEmbeddingEnv();
  takeoverStaleLock(join(home, "db"));
  const { createEngine } = (await gbrainImport("engine-factory")) as { createEngine: (c: object) => Promise<Engine> };
  const cfg = { engine: "pglite" as const, database_path: join(home, "db") };
  const engine = (await createEngine(cfg)) as Engine;
  await engine.connect(cfg);
  await engine.initSchema();
  await clearStaleDbLocks(engine);
  await configureEmbeddingGateway();
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
  return runScopedOp(name, params, scope);
}

/** Trusted call (boot, admin, sync): dispatched through the configured backend. */
export async function brainAdminCall(name: string, params: Record<string, unknown>, sourceId = "default"): Promise<unknown> {
  return runAdminOp(name, params, sourceId);
}

export function baselineSources(): string[] {
  return [AGENT_SOURCE, SHARED_SOURCE, PUBLIC_SOURCE, ...loadKbs().map((k) => kbSourceId(k.label))];
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
      try {
        await brainAdminCall(
          "sources_add",
          kb ? { id, path: join(kb.path, "wiki"), federated: true } : { id, federated: true },
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
