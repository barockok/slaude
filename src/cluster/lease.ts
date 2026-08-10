import type { RedisClientType } from "redis";
import { env } from "../config/env";

export type ThreadLeaseKey = {
  team_id: string;
  channel_id: string;
  thread_ts: string;
};

function leaseKey(k: ThreadLeaseKey): string {
  return `slaude:lease:${k.team_id}:${k.channel_id}:${k.thread_ts}`;
}

export interface LeaseStore {
  /** Instance id currently holding the lease, or null if unheld. */
  get(key: ThreadLeaseKey): Promise<string | null>;
  /** Atomically claim an unheld lease. True if this instance now owns it. */
  claim(key: ThreadLeaseKey): Promise<boolean>;
  /** Release a lease this instance owns. No-op if it doesn't. */
  release(key: ThreadLeaseKey): Promise<void>;
  /** Atomically take over a lease from a specific (assumed-dead) owner. */
  steal(key: ThreadLeaseKey, fromInstance: string): Promise<boolean>;
  /** Release every lease this instance currently holds (graceful shutdown). */
  releaseAll(): Promise<void>;
  /** Start periodic TTL refresh for every lease this instance holds. */
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

/** Every thread is always "mine" — used when clustering is disabled so the
 *  gateway's lease check is a no-op without special-casing call sites. */
export class LocalLeaseStore implements LeaseStore {
  async get(_key: ThreadLeaseKey): Promise<string | null> {
    return env.cluster.instanceId();
  }
  async claim(_key: ThreadLeaseKey): Promise<boolean> {
    return true;
  }
  async release(_key: ThreadLeaseKey): Promise<void> {}
  async steal(_key: ThreadLeaseKey, _fromInstance: string): Promise<boolean> {
    return true;
  }
  async releaseAll(): Promise<void> {}
  startHeartbeat(): void {}
  stopHeartbeat(): void {}
}

// Both scripts are conditioned on the caller's own identity so a release/steal
// can never clobber a lease a different instance has since claimed.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const STEAL_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
end
return false
`;

export class RedisLeaseStore implements LeaseStore {
  #client: RedisClientType;
  #instanceId = env.cluster.instanceId();
  #ttl = env.cluster.leaseTtlSeconds();
  /** Lease keys this instance currently believes it owns — the heartbeat and
   *  releaseAll universe. Populated by claim/steal, drained by release. */
  #held = new Set<string>();
  #heartbeat?: ReturnType<typeof setInterval>;

  constructor(client: RedisClientType) {
    this.#client = client;
  }

  async get(key: ThreadLeaseKey): Promise<string | null> {
    return await this.#client.get(leaseKey(key));
  }

  async claim(key: ThreadLeaseKey): Promise<boolean> {
    const k = leaseKey(key);
    const res = await this.#client.set(k, this.#instanceId, {
      condition: "NX",
      expiration: { type: "EX", value: this.#ttl },
    });
    if (res === "OK") {
      this.#held.add(k);
      return true;
    }
    return false;
  }

  async release(key: ThreadLeaseKey): Promise<void> {
    const k = leaseKey(key);
    await this.#client.eval(RELEASE_SCRIPT, { keys: [k], arguments: [this.#instanceId] });
    this.#held.delete(k);
  }

  async steal(key: ThreadLeaseKey, fromInstance: string): Promise<boolean> {
    const k = leaseKey(key);
    const res = await this.#client.eval(STEAL_SCRIPT, {
      keys: [k],
      arguments: [fromInstance, this.#instanceId, String(this.#ttl)],
    });
    if (res) {
      this.#held.add(k);
      return true;
    }
    return false;
  }

  async releaseAll(): Promise<void> {
    this.stopHeartbeat();
    const keys = [...this.#held];
    this.#held.clear();
    await Promise.all(
      keys.map((k) => this.#client.eval(RELEASE_SCRIPT, { keys: [k], arguments: [this.#instanceId] })),
    );
  }

  startHeartbeat(): void {
    if (this.#heartbeat) return;
    const intervalMs = Math.max(1000, (this.#ttl * 1000) / 3);
    this.#heartbeat = setInterval(() => {
      for (const k of this.#held) {
        this.#client
          .set(k, this.#instanceId, { condition: "XX", expiration: { type: "EX", value: this.#ttl } })
          .catch((err) => console.error(`[cluster] lease heartbeat failed for ${k}:`, err));
      }
    }, intervalMs);
    this.#heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}

let singleton: LeaseStore | undefined;

/** Lazily builds the lease store. When clustering is off this never imports
 *  the redis module — the returned LocalLeaseStore is pure in-process logic. */
export async function getLeaseStore(): Promise<LeaseStore> {
  if (singleton) return singleton;
  if (!env.cluster.enabled()) {
    singleton = new LocalLeaseStore();
    return singleton;
  }
  const { createClient } = await import("redis");
  const client = createClient({ url: env.cluster.redisUrl() });
  client.on("error", (err) => console.error("[cluster] redis lease client error:", err));
  await client.connect();
  singleton = new RedisLeaseStore(client as RedisClientType);
  return singleton;
}

/** Test/reset seam — clears the cached singleton so a fresh store is built. */
export function resetLeaseStore(): void {
  singleton = undefined;
}
