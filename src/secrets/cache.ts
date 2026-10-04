/**
 * Per-reference value cache with single flight (WS-A §6.4).
 *
 * Keyed by the canonical (normalised) reference. Within CACHE_TTL the cached
 * value is served. Past it, the next caller refreshes; concurrent callers of
 * one key always share one upstream request, whatever the TTL. If a refresh
 * fails because Vault is not answering (a TRANSIENT reason) and the entry is
 * younger than STALE_MAX, the cached value is served and `onStale` fires.
 * A definitive answer — the secret or field is gone, the policy denies it —
 * is never masked: it fails and drops the entry. TTL 0 means no cache at all
 * (every resolve fetches, and there is nothing to serve stale).
 *
 * Per process, in memory only; never persisted.
 */
import { SecretResolutionError, TRANSIENT_REASONS } from "./errors";

export type CacheOutcome = "ok" | "cached" | "stale";

export type SecretCache = {
  get(key: string, fetch: () => Promise<string>): Promise<{ value: string; outcome: CacheOutcome }>;
  /** number of entries held (tests) */
  size(): number;
};

export function createSecretCache(opts: {
  ttlMs: number;
  staleMaxMs: number;
  /** a MONOTONIC clock in ms; default performance.now() (wall time can step backwards) */
  now?: () => number;
  onStale?: () => void;
}): SecretCache {
  const now = opts.now ?? (() => performance.now());
  const entries = new Map<string, { value: string; fetchedAt: number }>();
  const inflight = new Map<string, Promise<{ value: string; outcome: CacheOutcome }>>();
  // Past both windows an entry can neither be served nor rescue a failure.
  const keepMs = Math.max(opts.ttlMs, opts.staleMaxMs);

  /** Age of an entry; Infinity when the clock went backwards (age unknown ⇒ trust nothing). */
  const ageOf = (e: { fetchedAt: number }): number => {
    const age = now() - e.fetchedAt;
    return age < 0 ? Infinity : age;
  };

  /** Drop entries nothing can use any more (deleted personas, rotated refs). */
  function sweep(): void {
    for (const [k, e] of entries) if (ageOf(e) >= keepMs) entries.delete(k);
  }

  async function refresh(key: string, fetch: () => Promise<string>): Promise<{ value: string; outcome: CacheOutcome }> {
    try {
      const value = await fetch();
      if (opts.ttlMs > 0) entries.set(key, { value, fetchedAt: now() });
      return { value, outcome: "ok" };
    } catch (err) {
      const entry = entries.get(key);
      const transient = err instanceof SecretResolutionError && TRANSIENT_REASONS.has(err.reason);
      if (entry && transient && ageOf(entry) < opts.staleMaxMs) {
        opts.onStale?.();
        return { value: entry.value, outcome: "stale" };
      }
      entries.delete(key);
      throw err;
    }
  }

  return {
    size: () => entries.size,
    get(key, fetch) {
      sweep();
      const entry = entries.get(key);
      if (entry && opts.ttlMs > 0 && ageOf(entry) < opts.ttlMs) {
        return Promise.resolve({ value: entry.value, outcome: "cached" as const });
      }
      const running = inflight.get(key);
      if (running) return running;
      const p = refresh(key, fetch).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
