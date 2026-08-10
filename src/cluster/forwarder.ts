import type { RedisClientType } from "redis";
import { env } from "../config/env";

export type ForwardEnvelope = {
  eventName: "message" | "app_mention";
  event: unknown;
  context: unknown;
};

export interface Forwarder {
  /** Start listening for events other instances forward to this one. */
  start(onEnvelope: (envelope: ForwardEnvelope) => void): Promise<void>;
  /** Forward an envelope to another instance. Returns the receiver count —
   *  0 means the target instance isn't listening (dead), telling the caller
   *  to steal the lease and handle the event locally instead. */
  publish(instanceId: string, envelope: ForwardEnvelope): Promise<number>;
  stop(): Promise<void>;
}

/** No-op forwarder for non-clustered deployments. Lease ownership is always
 *  local in that mode, so publish() is never on the hot path — kept safe
 *  regardless of how it's called. */
export class LocalForwarder implements Forwarder {
  async start(_onEnvelope: (envelope: ForwardEnvelope) => void): Promise<void> {}
  async publish(_instanceId: string, _envelope: ForwardEnvelope): Promise<number> {
    return 0;
  }
  async stop(): Promise<void> {}
}

export class RedisForwarder implements Forwarder {
  #pub: RedisClientType;
  #sub: RedisClientType;
  #instanceId = env.cluster.instanceId();

  constructor(pub: RedisClientType, sub: RedisClientType) {
    this.#pub = pub;
    this.#sub = sub;
  }

  async start(onEnvelope: (envelope: ForwardEnvelope) => void): Promise<void> {
    await this.#sub.subscribe(`slaude:instance:${this.#instanceId}`, (message) => {
      try {
        onEnvelope(JSON.parse(message) as ForwardEnvelope);
      } catch (err) {
        console.error("[cluster] failed to parse forwarded envelope:", err);
      }
    });
  }

  async publish(instanceId: string, envelope: ForwardEnvelope): Promise<number> {
    return await this.#pub.publish(`slaude:instance:${instanceId}`, JSON.stringify(envelope));
  }

  async stop(): Promise<void> {
    await this.#sub.unsubscribe();
  }
}

let singleton: Forwarder | undefined;

/** Lazily builds the forwarder. When clustering is off this never imports the
 *  redis module — the returned LocalForwarder is pure in-process logic. */
export async function getForwarder(): Promise<Forwarder> {
  if (singleton) return singleton;
  if (!env.cluster.enabled()) {
    singleton = new LocalForwarder();
    return singleton;
  }
  const { createClient } = await import("redis");
  // Pub/sub requires a dedicated connection per node-redis docs — a client
  // that's subscribed can't also run normal commands. Publish and subscribe
  // each get their own connection off the same options.
  const pub = createClient({ url: env.cluster.redisUrl() });
  const sub = pub.duplicate();
  pub.on("error", (err) => console.error("[cluster] redis pub client error:", err));
  sub.on("error", (err) => console.error("[cluster] redis sub client error:", err));
  await Promise.all([pub.connect(), sub.connect()]);
  singleton = new RedisForwarder(pub as RedisClientType, sub as RedisClientType);
  return singleton;
}

/** Test/reset seam — clears the cached singleton so a fresh forwarder is built. */
export function resetForwarder(): void {
  singleton = undefined;
}
