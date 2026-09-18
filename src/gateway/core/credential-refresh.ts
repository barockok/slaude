/**
 * Gateway-side refresh of an owner's MCP credential. The gateway is the only
 * party that can do this: nodes are never given a refresh token or a client
 * secret.
 *
 * Single-flight per owner and server. Many sessions on many nodes share the
 * agent's owner and can hit one expiry together, and a rotating refresh token
 * can be spent exactly once — a second, concurrent refresh would present a dead
 * token, be refused, and wrongly tell everyone to reconnect. So:
 *
 *   1. Concurrent callers in this process share one in-flight promise.
 *   2. Across replicas, a lock serialises the refresh (Redis in the gateway
 *      role; see redisLock).
 *   3. Under the lock, the stored entry is re-read first. If its access token
 *      is no longer the one that failed and is not about to expire, someone
 *      already refreshed: return it without calling the provider.
 *
 * Under the lock the result is written unconditionally. A refreshed token can
 * legitimately have a shorter lifetime than the old one's nominal expiry, and
 * refusing it would hand back the very token that was just rejected.
 *
 * Nothing here logs a token. Outcomes name the owner kind and server key.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { discover as discoverDefault } from "../../agent/mcp-oauth/discovery";
import { refreshGrant, RefreshRejected } from "../../agent/mcp-oauth/refresh";
import type { StoredEntry } from "../../agent/mcp-oauth/store";
import type { CredentialOwner } from "../../agent/credential-owner";
import { credentialsFor, putCredential } from "../../db/mcp-credentials";
import { acquireLock, releaseLock } from "../../queue/locks";

/** Treat a token this close to expiry as already expired. */
const EXPIRY_SKEW_MS = 60_000;

export type RefreshOutcome =
  | { ok: true; entry: StoredEntry }
  | { ok: false; reason: "reconnect" | "unknown-server" };

/** Runs `fn` while holding a lock named `key`. */
export type LockFn = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export interface RefresherDeps {
  lock: LockFn;
  discover?: (serverUrl: string) => Promise<{ tokenEndpoint: string }>;
  grant?: typeof refreshGrant;
  now?: () => number;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Unambiguous identity for one owner's one server: a JSON tuple cannot be
 *  forged by an id that happens to contain a separator. */
const flightKey = (o: CredentialOwner, serverKey: string) =>
  JSON.stringify(o.kind === "account" ? ["account", o.accountId, serverKey] : ["agent", o.tenant, o.persona, serverKey]);

export function makeCredentialRefresher(deps: RefresherDeps) {
  const now = deps.now ?? Date.now;
  const discover = deps.discover ?? ((url: string) => discoverDefault(url));
  const grant = deps.grant ?? refreshGrant;
  const inflight = new Map<string, Promise<RefreshOutcome>>();

  async function refreshLocked(
    owner: CredentialOwner,
    serverKey: string,
    failedHash: string | undefined,
  ): Promise<RefreshOutcome> {
    const stored = (await credentialsFor(owner))[serverKey];
    if (!stored) return { ok: false, reason: "unknown-server" };

    const fresh = stored.expiresAt - now() > EXPIRY_SKEW_MS;
    const replaced = failedHash !== undefined && sha256Hex(stored.accessToken) !== failedHash;
    // Someone refreshed since the caller's token failed; or, with no failed
    // token named, the stored one is still good. Either way: do not spend the
    // refresh token.
    if (fresh && (replaced || failedHash === undefined)) return { ok: true, entry: stored };

    if (!stored.refreshToken || !stored.clientId) return { ok: false, reason: "reconnect" };

    let tokens;
    try {
      const meta = await discover(stored.serverUrl);
      tokens = await grant({
        tokenEndpoint: meta.tokenEndpoint,
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        refreshToken: stored.refreshToken,
        resource: stored.serverUrl,
      });
    } catch (e) {
      if (e instanceof RefreshRejected) {
        console.warn(`[credential-refresh] provider refused owner=${owner.kind} server=${serverKey} status=${e.status}`);
        return { ok: false, reason: "reconnect" };
      }
      throw e;
    }

    const entry: StoredEntry = {
      ...stored,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? stored.refreshToken,
      expiresAt: now() + (tokens.expiresIn ?? 3600) * 1000,
    };
    await putCredential(owner, serverKey, entry);
    console.log(`[credential-refresh] refreshed owner=${owner.kind} server=${serverKey}`);
    return { ok: true, entry };
  }

  return {
    /** Refresh `serverKey` for `owner`. `failedHash` is the SHA-256 of the
     *  access token that was rejected, if the caller has one — never the token. */
    refresh(owner: CredentialOwner, serverKey: string, failedHash: string | undefined): Promise<RefreshOutcome> {
      const k = flightKey(owner, serverKey);
      const running = inflight.get(k);
      if (running) return running;
      const p = deps
        .lock(`mcp-refresh:${sha256Hex(k)}`, () => refreshLocked(owner, serverKey, failedHash))
        .finally(() => inflight.delete(k));
      inflight.set(k, p);
      return p;
    },
  };
}

/** In-process lock: correct for one process (mono, tests). */
export function localLock(): LockFn {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    tails.set(key, run);
    try {
      return await run;
    } finally {
      if (tails.get(key) === run) tails.delete(key);
    }
  };
}

/**
 * Cross-replica lock on Redis. Waits for the holder rather than failing, since
 * the waiter's next step — re-reading the store — is exactly what makes a
 * waiter cheap. The TTL bounds a crashed holder; it comfortably exceeds a
 * token-endpoint round trip.
 */
export function redisLock(redis: Redis, opts: { prefix: string; ttlMs?: number; waitMs?: number; pollMs?: number }): LockFn {
  const ttlMs = opts.ttlMs ?? 30_000;
  const waitMs = opts.waitMs ?? 35_000;
  const pollMs = opts.pollMs ?? 100;
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const lockKey = `${opts.prefix}:lock:${key}`;
    const owner = randomBytes(8).toString("hex");
    const deadline = Date.now() + waitMs;
    while (!(await acquireLock(redis, lockKey, owner, ttlMs))) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a credential refresh lock");
      await new Promise((r) => setTimeout(r, pollMs));
    }
    try {
      return await fn();
    } finally {
      await releaseLock(redis, lockKey, owner).catch(() => {});
    }
  };
}
