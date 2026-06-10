import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/home";
import { loadKbs } from "./loader";
import { AGENT_SOURCE, PUBLIC_SOURCE, SHARED_SOURCE, kbSourceId, type BrainScope } from "./scope";

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

async function boot(): Promise<Engine> {
  const home = brainHome();
  mkdirSync(home, { recursive: true });
  // gbrain reads GBRAIN_HOME for config.json, lock files, clones.
  process.env.GBRAIN_HOME = home;
  const { createEngine } = (await gbrainImport("engine-factory")) as { createEngine: (c: object) => Promise<Engine> };
  const cfg = { engine: "pglite" as const, database_path: join(home, "db") };
  const engine = (await createEngine(cfg)) as Engine;
  await engine.connect(cfg);
  await engine.initSchema();
  return engine;
}

export function getBrain(): Promise<Engine> {
  return (enginePromise ??= boot());
}

export async function closeBrain(): Promise<void> {
  if (!enginePromise) return;
  const e = await enginePromise;
  enginePromise = null;
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

/** User-scoped call: remote=true + synthetic AuthInfo → gbrain enforces scope in SQL. */
export async function brainCall(name: string, params: Record<string, unknown>, scope: BrainScope): Promise<unknown> {
  const op = await findOp(name);
  const ctx = await buildCtx({
    remote: true,
    sourceId: scope.sourceId,
    auth: {
      token: "in-process",
      clientId: scope.clientId,
      clientName: scope.clientId,
      scopes: ["read", "write"],
      sourceId: scope.sourceId,
      allowedSources: scope.allowedSources,
    },
    takesHoldersAllowList: [scope.clientId, "world"],
  });
  return op.handler(ctx, params);
}

/** Trusted local call (boot, admin, sync) — slaude owns the box. */
export async function brainAdminCall(name: string, params: Record<string, unknown>, sourceId = "default"): Promise<unknown> {
  const op = await findOp(name);
  const ctx = await buildCtx({ remote: false, sourceId });
  return op.handler(ctx, params);
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
export async function ensureSources(extra: string[] = []): Promise<void> {
  const listed = (await brainAdminCall("sources_list", {})) as { sources: Array<{ id: string }> };
  const existing = new Set(listed.sources.map((s) => s.id));
  const kbs = loadKbs();
  for (const id of [...baselineSources(), ...extra]) {
    if (existing.has(id)) continue;
    const kb = kbs.find((k) => kbSourceId(k.label) === id);
    await brainAdminCall(
      "sources_add",
      kb ? { id, path: join(kb.path, "wiki"), federated: true } : { id, federated: true },
    );
  }
}
