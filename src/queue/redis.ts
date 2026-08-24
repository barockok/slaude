/**
 * ioredis connection factory for the queue layer.
 *
 * Two lazy process-wide singletons: a main connection (commands) and a
 * subscriber connection — a Redis connection in subscribe mode cannot issue
 * regular commands, so pub/sub consumers always get their own. BullMQ Workers
 * additionally need a dedicated blocking connection each; those are created
 * fresh via createRedis() by the caller (P6), never shared.
 */
import { Redis } from "ioredis";

/** SLAUDE_REDIS_URL — the one Redis behind queues, registry, locks, pub/sub. */
export function redisUrl(): string {
  return process.env.SLAUDE_REDIS_URL || "redis://localhost:6379";
}

/** SLAUDE_HEARTBEAT_SEC — session/node heartbeat cadence (default 10s).
 *  Registry entry TTL is 2× this. */
export function heartbeatSec(): number {
  const n = Number(process.env.SLAUDE_HEARTBEAT_SEC || "10");
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** SLAUDE_NODE_DRAIN_SEC — SIGTERM grace for in-flight turns (default 120s).
 *  Consumed by the node runtime (P6); parsed here so the knob has one home. */
export function nodeDrainSec(): number {
  const n = Number(process.env.SLAUDE_NODE_DRAIN_SEC || "120");
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

/** New dedicated connection. `maxRetriesPerRequest: null` is a BullMQ
 *  requirement (blocking commands must not be retried out from under it). */
export function createRedis(url: string = redisUrl()): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

let main: Redis | null = null;
let sub: Redis | null = null;

/** Lazy shared connection for regular commands (locks, registry, XADD…). */
export function getRedis(): Redis {
  return (main ??= createRedis());
}

/** Lazy shared connection reserved for SUBSCRIBE — never issue commands on it. */
export function getSubRedis(): Redis {
  return (sub ??= createRedis());
}

/** Quit both singletons (best-effort) and reset, so a fresh getRedis()
 *  reconnects. Used on shutdown and between tests. */
export async function closeRedis(): Promise<void> {
  const open = [main, sub].filter((c): c is Redis => c !== null);
  main = null;
  sub = null;
  await Promise.all(
    open.map(async (c) => {
      try {
        await c.quit();
      } catch {
        c.disconnect();
      }
    }),
  );
}
