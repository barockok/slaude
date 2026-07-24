import { AGENT_SOURCE, agentSourceId, type BrainScope } from "./scope";

/**
 * The agent's own stable identity, anchoring its private `agent-<id>` brain
 * slice. Resolution order:
 *   1. SLAUDE_AGENT_ID env — deterministic, no network; recommended for
 *      multi-agent deploys sharing one brain.
 *   2. auth.test on the agent's Slack token (bot user id, or the user id when
 *      running post-as-user) — resolved once at gateway boot.
 *   3. "default" fallback — single-agent / test / brain-disabled paths.
 *
 * Cached process-wide once resolved. Pure sync reads (scope building, gate
 * classification) call agentIdSync(); early brain writers (memory provider)
 * await agentIdReady() so nothing lands in `agent-default` before auth.test
 * settles.
 */

const sanitize = (s: string): string => s.trim();

/** SLAUDE_AGENT_ID, trimmed, or null when unset/blank. Single read path. */
function readEnv(): string | null {
  const env = process.env.SLAUDE_AGENT_ID?.trim();
  return env && env.length > 0 ? env : null;
}

let cached: string | null = null;
let resolving: Promise<string> | null = null;
let warnedNoResolver = false;

/** Synchronous best-effort id: resolved value → env → "default". */
export function agentIdSync(): string {
  return cached ?? readEnv() ?? "default";
}

/** Test/boot hook: pin the agent id explicitly. */
export function setAgentId(id: string): void {
  cached = sanitize(id);
}

/** Test hook: forget the resolved id (and any in-flight resolution). */
export function resetAgentId(): void {
  cached = null;
  resolving = null;
  warnedNoResolver = false;
}

/**
 * Resolve the agent id once. If SLAUDE_AGENT_ID is set it wins immediately;
 * otherwise call authTest() (Slack auth.test) and take its user_id. Errors
 * (fake client in sim, missing token) fall back to agentIdSync(). Idempotent —
 * repeat calls return the same in-flight/settled promise.
 */
export function resolveAgentId(authTest: () => Promise<{ user_id?: string }>): Promise<string> {
  if (cached) return Promise.resolve(cached);
  const env = readEnv();
  if (env) {
    cached = sanitize(env);
    return Promise.resolve(cached);
  }
  return (resolving ??= (async () => {
    try {
      const r = await authTest();
      cached = sanitize(r?.user_id && r.user_id.length > 0 ? r.user_id : "default");
    } catch {
      cached = agentIdSync();
    }
    return cached;
  })());
}

/** Await the resolved id: settled cache / env immediately, else the in-flight
 *  resolution, else the sync fallback (no resolver wired). MUST be called after
 *  resolveAgentId() has been kicked off (gateway boot) to await the real id —
 *  the bare fallback below returns "default" and cannot chain on a later resolve. */
export function agentIdReady(): Promise<string> {
  if (cached) return Promise.resolve(cached);
  const env = readEnv();
  if (env) {
    cached = sanitize(env);
    return Promise.resolve(cached);
  }
  if (resolving) return resolving;
  // No resolver wired and no env — settle on the fallback, but warn once: a caller
  // is awaiting identity before boot resolved it (C3).
  if (!warnedNoResolver) {
    warnedNoResolver = true;
    console.warn("[brain] agentIdReady() called before resolveAgentId() wired an identity — falling back to 'default'");
  }
  return Promise.resolve(agentIdSync());
}

/**
 * Write/read scope for the agent's own mind (memory provider, backfill). Writes
 * target the per-agent slice; reads also union the legacy `agent` source so
 * historical memory from a pre-per-agent brain stays visible.
 */
export function agentScope(): BrainScope {
  const id = agentIdSync();
  const src = agentSourceId(id);
  return { clientId: id, sourceId: src, allowedSources: [src, AGENT_SOURCE] };
}
