// tests/helpers/brain-template.ts
//
// A new PGLite brain for a test, without a new initdb.
//
// Every test file runs in one bun process. A fresh PGLite brain (gbrain's copy
// of PGLite: initdb, then 110 gbrain migrations) costs about 1 s early in that
// process, but past a point that depends on what the process has run before
// (fresh brains above all) each one jumps to 12 to 20 s, and every later fresh
// brain pays that. A first scenario transcript that booted one timed out at
// 27 s. Opening an existing data dir stays cheap (about 0.2 s). So each process
// builds one template brain per embedding setup, and a test gets a copy of its
// data dir. See the 2026-11-09 field note.
//
// Use it wherever a test needs a brain that has simply been booted. A test
// about the first boot itself (initdb, its exit code) still needs a fresh dir.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env that decides what a new brain looks like (embedding model and width, engine, role). */
const SHAPING = /^(EMBEDDING_|GBRAIN_)|_API_KEY$|^SLAUDE_BRAIN_(MODE|ENGINE|DISABLED)$|^SLAUDE_ROLE$/;

const templates = new Map<string, Promise<string>>();
const templateDirs: string[] = [];
let cleanupHooked = false;

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
}

async function buildTemplate(env: Record<string, string>): Promise<string> {
  const { closeBrain, getBrain } = await import("../../src/knowledge/brain");
  const dir = mkdtempSync(join(tmpdir(), "slaude-brain-tpl-"));
  if (!cleanupHooked) {
    cleanupHooked = true;
    process.once("exit", () => {
      for (const d of templateDirs) rmSync(d, { recursive: true, force: true });
    });
  }
  templateDirs.push(dir);
  const saved = { ...process.env };
  // A brain open on another home would be returned as-is by getBrain().
  await closeBrain();
  try {
    for (const k of Object.keys(process.env)) if (SHAPING.test(k)) delete process.env[k];
    Object.assign(process.env, env, { SLAUDE_BRAIN_HOME: dir });
    await getBrain();
  } finally {
    await closeBrain();
    restoreEnv(saved);
  }
  return dir;
}

/**
 * The template brain's data dir for this embedding env (built on first use,
 * one per process). `env` is the only shaping env the template boots with:
 * none (the default) is gbrain's default model, unconfigured.
 */
export function brainTemplate(env: Record<string, string> = {}): Promise<string> {
  const key = JSON.stringify(Object.entries(env).sort());
  let t = templates.get(key);
  if (!t) {
    t = buildTemplate(env);
    // A failed build is not cached: the next caller retries.
    t.catch(() => templates.delete(key));
    templates.set(key, t);
  }
  return t;
}

/**
 * Seed `home` with a copy of the template brain, as if a brain had been booted
 * there with `env`. Closes any open brain first (only when it has to build the
 * template). Under SLAUDE_BRAIN_ENGINE=postgres the data dir is not used: it
 * only creates `home`.
 */
export async function seedBrainHome(home: string, env: Record<string, string> = {}): Promise<string> {
  mkdirSync(home, { recursive: true });
  if ((process.env.SLAUDE_BRAIN_ENGINE ?? "pglite").toLowerCase() === "postgres") return home;
  cpSync(await brainTemplate(env), home, { recursive: true });
  return home;
}

/**
 * A keyless 8-dimension embedding model (litellm). Files that boot with any
 * spelling of `litellm:test-embed` at 8 dims (an EMBEDDING_URL with a bare
 * `test-embed` canonicalizes to it) share this template.
 */
export const SMALL_EMBEDDING_ENV: Record<string, string> = { EMBEDDING_MODEL: "litellm:test-embed", EMBEDDING_DIMENSIONS: "8" };

/** A new temp dir (named `<prefix>XXXXXX`) seeded with a copy of the template brain. */
export async function freshBrainHome(prefix: string, env: Record<string, string> = {}): Promise<string> {
  return seedBrainHome(mkdtempSync(join(tmpdir(), prefix)), env);
}
