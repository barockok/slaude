/**
 * Boundary resolver for the write path (domain sessions, slice D).
 *
 * `boundaryForCached(team, channel)` is what a writer calls beside its legacy
 * insert: synchronous, no query, never awaited, never throws. It answers from a
 * per-process cache; on a miss it answers "unknown" (undefined) and starts one
 * deduped, non-awaited read that warms the cache for the next write. The writer
 * stores NULL for an unknown boundary and the fill repairs the row later, so a
 * slow or dead boundaries table can never slow or fail a turn or a session
 * create.
 *
 *  - Read-only: this module never inserts a boundary. Creation stays in first
 *    sight (`observeSlackChannel`), which primes this cache after it creates or
 *    finds one.
 *  - A missing team (null or '') or a channel first sight would never record is
 *    "known absent" without a query. A Slack boundary never has workspace ''.
 *  - Single flight per key, a timeout (`SLAUDE_BOUNDARY_TIMEOUT_MS`), and every
 *    failure leaves the key unknown (never cached as absent).
 *  - Positive entries last RECHECK_MS, negative ones NEG_TTL_MS, the cache holds
 *    LRU_CAP keys (the same figures as first sight).
 *  - A node has no database: it answers unknown and never reads one.
 *  - `SLAUDE_BOUNDARY_WRITE=off` makes the cached answer unknown and starts no
 *    read, so writers store NULL pairs.
 */
import { env } from "../config/env";
import { m } from "../metrics";
import { db as globalDb, type DbClient } from "../db/schema";
import { trackFirstSight } from "./first-sight-flush";

export const LRU_CAP = 5000;
export const RECHECK_MS = 10 * 60 * 1000;
export const NEG_TTL_MS = 30 * 1000;
/** After a timeout or an error the key is not asked again for this long (it stays unknown, not absent). */
export const FAIL_BACKOFF_MS = 30 * 1000;

/** Channel ids first sight records (and so the only ones a boundary can exist for). */
export const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;

export type BoundaryRef = { id: string };

export interface BoundaryResolverDeps {
  db?: () => DbClient;
  role?: () => string;
  now?: () => number;
  timeoutMs?: () => number;
  /** Default: the SLAUDE_BOUNDARY_WRITE switch. */
  enabled?: () => boolean;
}

export interface BoundaryResolver {
  cached(team: string | null | undefined, channel: string | null | undefined): BoundaryRef | null | undefined;
  resolve(team: string | null | undefined, channel: string | null | undefined): Promise<BoundaryRef | null>;
  prime(team: string, channel: string, id: string): void;
  reset(): void;
}

const keyOf = (team: string, channel: string): string => `slack|${team}|${channel}`;
const count = (outcome: string): void => {
  try {
    m.boundaryResolveTotal.inc({ outcome });
  } catch {
    /* metrics never reach a writer */
  }
};

export function createBoundaryResolver(deps: BoundaryResolverDeps = {}): BoundaryResolver {
  const getDb = deps.db ?? (() => globalDb);
  const role = deps.role ?? (() => env.role());
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? (() => env.boundary.timeoutMs());
  const enabled = deps.enabled ?? (() => env.boundary.write());

  /** key -> answer and when it was learned. Map order is recency. */
  const cache = new Map<string, { id: string | null; at: number }>();
  const inflight = new Map<string, Promise<BoundaryRef | null>>();
  /** key -> when its last read failed. */
  const failedAt = new Map<string, number>();

  const peek = (key: string): { id: string | null } | undefined => {
    const e = cache.get(key);
    if (!e) return undefined;
    if (now() - e.at > (e.id ? RECHECK_MS : NEG_TTL_MS)) {
      cache.delete(key);
      return undefined;
    }
    return e;
  };
  const put = (key: string, id: string | null): void => {
    cache.delete(key);
    cache.set(key, { id, at: now() });
    while (cache.size > LRU_CAP) cache.delete(cache.keys().next().value as string);
  };

  /** Null and a channel nobody records need no query. */
  const absentWithoutQuery = (team: string | null | undefined, channel: string | null | undefined): boolean =>
    !team || !channel || !CHANNEL_RE.test(channel);

  function resolve(team: string | null | undefined, channel: string | null | undefined): Promise<BoundaryRef | null> {
    if (role() === "node") return Promise.resolve(null);
    if (!team) {
      count("no_team");
      return Promise.resolve(null);
    }
    if (absentWithoutQuery(team, channel)) return Promise.resolve(null);
    const key = keyOf(team, channel!);
    const hit = peek(key);
    if (hit) return Promise.resolve(hit.id ? { id: hit.id } : null);
    const running = inflight.get(key);
    if (running) return running;
    const failed = failedAt.get(key);
    if (failed !== undefined) {
      if (now() - failed < FAIL_BACKOFF_MS) return Promise.resolve(null); // a stalled database gets no new SELECT per write
      failedAt.delete(key);
    }
    const p = (async (): Promise<BoundaryRef | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const read = Promise.resolve(
          getDb().one<{ id: string }>("SELECT id FROM boundaries WHERE service = ? AND workspace = ? AND value = ?", ["slack", team, channel]),
        );
        read.catch(() => {}); // a read that loses the race must not become an unhandled rejection
        const ms = timeoutMs();
        const row = await (ms > 0
          ? Promise.race([
              read,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), ms);
              }),
            ])
          : read);
        if (row?.id) {
          failedAt.delete(key);
          put(key, row.id);
          count("found");
          return { id: row.id };
        }
        // A boundary first sight primed while this read ran is newer than "absent".
        if (!peek(key)?.id) put(key, null);
        count("absent");
        return null;
      } catch (e) {
        // Unknown, not absent: the next write asks again.
        if (failedAt.size >= LRU_CAP) failedAt.clear();
        failedAt.set(key, now());
        count(e instanceof Error && e.message === "timeout" ? "timeout" : "error");
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  return {
    cached(team, channel) {
      try {
        if (!enabled() || role() === "node") return undefined;
        if (!team) {
          count("no_team");
          return null;
        }
        if (absentWithoutQuery(team, channel)) return null;
        const hit = peek(keyOf(team, channel!));
        if (hit) {
          count("hit");
          return hit.id ? { id: hit.id } : null;
        }
        count("miss");
        // Tracked with first sight's work so a test flush also waits for the warm read.
        void trackFirstSight(resolve(team, channel)).catch(() => {});
        return undefined;
      } catch {
        return undefined;
      }
    },
    resolve,
    prime(team, channel, id) {
      try {
        if (!team || !channel || !id || !CHANNEL_RE.test(channel)) return;
        put(keyOf(team, channel), id);
      } catch {
        /* never into the caller */
      }
    },
    reset() {
      cache.clear();
      inflight.clear();
      failedAt.clear();
    },
  };
}

let shared: BoundaryResolver | undefined;
const resolver = (): BoundaryResolver => (shared ??= createBoundaryResolver());

/** Sync, no query: the boundary for a channel when known (`undefined` unknown, `null` known absent). */
export const boundaryForCached = (team: string | null | undefined, channel: string | null | undefined): BoundaryRef | null | undefined =>
  resolver().cached(team, channel);

/** One read, never an insert; fills the cache; failures resolve null and leave the key unknown. */
export const boundaryFor = (team: string | null | undefined, channel: string | null | undefined): Promise<BoundaryRef | null> =>
  resolver().resolve(team, channel);

/** First sight calls this after it creates or finds a boundary. */
export const primeBoundary = (team: string, channel: string, id: string): void => resolver().prime(team, channel, id);

export const resetBoundaryResolver = (): void => resolver().reset();

/** Tests: replace the shared resolver (undefined restores a fresh default). */
export const __setBoundaryResolver = (r: BoundaryResolver | undefined): void => {
  shared = r;
};

/** The opaque conversation key inside a boundary: the thread column verbatim; empty is none. */
export function locatorOf(threadTs: string | null | undefined): string | null {
  return threadTs ? threadTs : null;
}
