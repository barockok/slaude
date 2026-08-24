/**
 * Gate wake-up bus: the `gate:<pendingId>` pub/sub channel (spec §4, §5) as a
 * tiny seam the Slack gates and the /v1/pending long-poll share.
 *
 * Durable truth stays in the pending_gates table; the bus only trades latency
 * — a missed publish costs one poll interval, never a decision. That is what
 * lets the default be `null` (no Redis configured → mono keeps its in-process
 * waiters and DB polling, byte-identical to before).
 *
 * `defaultGateBus()` is process-wide and env-gated on SLAUDE_REDIS_URL being
 * EXPLICITLY set: redisUrl() falls back to localhost, and a mono deploy
 * without Redis must not spend its boot dialing one.
 */
import { makePubSub, type PubSub } from "./pubsub";
import { getRedis, getSubRedis } from "./redis";

export interface GateBus {
  /** A gate settled — wake every long-poller / waiter on it. */
  publish(pendingId: string): Promise<void>;
  /** Subscribe to one gate's wake-ups. Returns the unsubscribe fn. */
  subscribe(pendingId: string, cb: () => void): Promise<() => Promise<void>>;
}

/** Redis-backed bus over the shared pub/sub helper. */
export function redisGateBus(pubsub: PubSub): GateBus {
  return {
    async publish(id) {
      await pubsub.publishGate(id);
    },
    subscribe(id, cb) {
      return pubsub.onGate(id, cb);
    },
  };
}

/** In-process bus for tests and sims: same semantics, no Redis. */
export function memoryGateBus(): GateBus {
  const subs = new Map<string, Set<() => void>>();
  return {
    async publish(id) {
      for (const cb of [...(subs.get(id) ?? [])]) cb();
    },
    async subscribe(id, cb) {
      let set = subs.get(id);
      if (!set) {
        set = new Set();
        subs.set(id, set);
      }
      set.add(cb);
      return async () => {
        set!.delete(cb);
        if (set!.size === 0) subs.delete(id);
      };
    },
  };
}

let defaultBus: GateBus | null | undefined;

/**
 * Process-wide bus, or null when Redis isn't configured. Lazy: first call
 * opens the shared connections.
 */
export function defaultGateBus(): GateBus | null {
  if (defaultBus !== undefined) return defaultBus;
  if (!process.env.SLAUDE_REDIS_URL) {
    defaultBus = null;
    return defaultBus;
  }
  defaultBus = redisGateBus(makePubSub({ redis: getRedis(), sub: getSubRedis() }));
  return defaultBus;
}

/** Test hook: forget the memoized default so env changes take effect. */
export function __resetGateBusForTests(): void {
  defaultBus = undefined;
}
