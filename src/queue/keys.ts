/**
 * Every Redis key, channel, queue and stream name used by the horizontal-scale
 * queue layer, as functions off a single prefix. Nothing else in src/queue may
 * hand-build a key string — one place to audit, one place to rename.
 *
 * Pure module: no redis import, so it is loadable (and fully unit-testable)
 * without a Redis server.
 */

/** SLAUDE_REDIS_PREFIX — namespace for every key this process touches. */
export function redisPrefix(): string {
  return process.env.SLAUDE_REDIS_PREFIX || "slaude";
}

/** Shared turn queue name (BullMQ queue, prefix applied via Queue opts). */
export const TURNS_QUEUE = "turns";

/**
 * Per-node turn queue name. The spec names these `turns:<nodeId>` but BullMQ
 * rejects `:` inside a queue name (it is the internal key separator), so the
 * real queue name uses `.` — the conceptual name in the spec maps one-way onto
 * this. Any `:` inside a nodeId is sanitized for the same reason.
 */
export function nodeTurnsQueue(nodeId: string): string {
  return `${TURNS_QUEUE}.${nodeId.replaceAll(":", "-")}`;
}

export interface Keys {
  /** The raw prefix these keys were built from. */
  prefix: string;
  /** BullMQ `prefix` option — segregates queue internals under `<prefix>:bull`. */
  bullPrefix: string;
  /** `sess:<sessionId>` hash `{node, since, lastBeat}`, TTL 2× heartbeat. */
  sess(sessionId: string): string;
  /** SCAN pattern matching every session registry hash. */
  sessPattern(): string;
  /** `nodes:<nodeId>` node heartbeat key, TTL 30s. */
  node(nodeId: string): string;
  /** SCAN pattern matching every live node heartbeat key. */
  nodePattern(): string;
  /** Set of every nodeId that ever registered — reaper work list. */
  nodeSet(): string;
  /** `lock:session:<sessionId>` — one turn at a time per session. */
  sessionLock(sessionId: string): string;
  /** `lock:leader:<role>` — cron / reaper / migrate leader election. */
  leaderLock(role: string): string;
  /** `coalesce:<sessionId>` — pending-job index for message coalescing. */
  coalesce(sessionId: string): string;
  /** Short append lock serializing coalesce read-modify-write per session. */
  coalesceLock(sessionId: string): string;
  /** Pub/sub channel: abort the running turn of a session. */
  abortChannel(sessionId: string): string;
  /** Durable abort flag set alongside the publish — survives a node that
   *  wasn't subscribed at publish time (checked at turn start, GETDEL). */
  abortFlag(sessionId: string): string;
  /** Pub/sub channel: bust a tenant's cached runtime bundle. */
  reloadChannel(tenantId: string): string;
  /** Pub/sub channel: a pending gate was resolved. */
  gateChannel(pendingId: string): string;
  /** `events:<sessionId>` capped stream of serialized AgentEvents. */
  eventsStream(sessionId: string): string;
}

export function makeKeys(prefix: string = redisPrefix()): Keys {
  return {
    prefix,
    bullPrefix: `${prefix}:bull`,
    sess: (sessionId) => `${prefix}:sess:${sessionId}`,
    sessPattern: () => `${prefix}:sess:*`,
    node: (nodeId) => `${prefix}:nodes:${nodeId}`,
    nodePattern: () => `${prefix}:nodes:*`,
    nodeSet: () => `${prefix}:nodeset`,
    sessionLock: (sessionId) => `${prefix}:lock:session:${sessionId}`,
    leaderLock: (role) => `${prefix}:lock:leader:${role}`,
    coalesce: (sessionId) => `${prefix}:coalesce:${sessionId}`,
    coalesceLock: (sessionId) => `${prefix}:lock:coalesce:${sessionId}`,
    abortChannel: (sessionId) => `${prefix}:abort:${sessionId}`,
    abortFlag: (sessionId) => `${prefix}:abort-flag:${sessionId}`,
    reloadChannel: (tenantId) => `${prefix}:reload:${tenantId}`,
    gateChannel: (pendingId) => `${prefix}:gate:${pendingId}`,
    eventsStream: (sessionId) => `${prefix}:events:${sessionId}`,
  };
}
