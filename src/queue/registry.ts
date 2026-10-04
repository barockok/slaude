/**
 * Session registry + node heartbeat (spec §2).
 *
 * `sess:<sessionId>` — hash {node, since, lastBeat}, TTL 2× heartbeat: which
 * node holds the warm Query for a session. Routing consults it; expiry or
 * absence means "cold — anyone can resume".
 *
 * `nodes:<nodeId>` — value = last beat ms, TTL 30s: node liveness. The
 * `nodeset` set additionally records every node that ever came up, so the
 * reaper has a work list that survives the heartbeat key's expiry (an expired
 * key is precisely the signal the reaper is looking for).
 */
import type { Redis } from "ioredis";
import { DEFAULT_LABEL, makeKeys, type Keys } from "./keys";
import { heartbeatSec } from "./redis";

const HEARTBEAT_IF_EXISTS = `
if redis.call("exists", KEYS[1]) == 1 then
  redis.call("hset", KEYS[1], "lastBeat", ARGV[1])
  redis.call("pexpire", KEYS[1], ARGV[2])
  return 1
else
  return 0
end`;

export interface SessionLocation {
  node: string;
  since: number;
  lastBeat: number;
  /** lastBeat within the TTL window (2× heartbeat). A key that still exists
   *  is normally fresh by construction; stale can only be observed transiently. */
  fresh: boolean;
}

export interface RegistryOpts {
  redis: Redis;
  keys?: Keys;
  /** Session heartbeat cadence in seconds; TTL is 2×. Default: SLAUDE_HEARTBEAT_SEC. */
  heartbeatSec?: number;
  /** Node heartbeat key TTL in seconds. Spec default: 30. */
  nodeTtlSec?: number;
}

export type Registry = ReturnType<typeof makeRegistry>;

// Labels match LABEL_RE, which excludes ',', so a comma join is unambiguous.
const encodeLabels = (labels: readonly string[]) => [...new Set(labels)].sort().join(",");
const decodeLabels = (v: string | null): ReadonlySet<string> =>
  v === null ? new Set([DEFAULT_LABEL]) : new Set(v.split(",").filter(Boolean));

/** Cursor-safe SCAN. Shared with the reaper. */
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    out.push(...batch);
  } while (cursor !== "0");
  return out;
}

export function makeRegistry(opts: RegistryOpts) {
  const redis = opts.redis;
  const keys = opts.keys ?? makeKeys();
  const hbSec = opts.heartbeatSec ?? heartbeatSec();
  const sessTtlMs = Math.max(1, Math.round(2 * hbSec * 1000));
  const nodeTtlMs = Math.max(1, Math.round((opts.nodeTtlSec ?? 30) * 1000));
  const sessIdOf = (key: string) => key.slice(`${keys.prefix}:sess:`.length);
  const nodeIdOf = (key: string) => key.slice(`${keys.prefix}:nodes:`.length);
  const listLive = async () => (await scanKeys(redis, keys.nodePattern())).map(nodeIdOf);

  return {
    keys,
    sessTtlMs,

    /** A node took (or resumed) a session's warm Query. */
    async register(sessionId: string, nodeId: string): Promise<void> {
      const now = Date.now();
      await redis
        .multi()
        .hset(keys.sess(sessionId), { node: nodeId, since: now, lastBeat: now })
        .pexpire(keys.sess(sessionId), sessTtlMs)
        .exec();
    },

    /** Refresh a live session's TTL. False = the entry already expired (the
     *  beat does NOT resurrect it — the node must re-register). */
    async heartbeat(sessionId: string): Promise<boolean> {
      const r = await redis.eval(HEARTBEAT_IF_EXISTS, 1, keys.sess(sessionId), Date.now(), sessTtlMs);
      return r === 1;
    },

    /** Where is this session warm? null = nowhere (cold resume). */
    async lookup(sessionId: string): Promise<SessionLocation | null> {
      const h = await redis.hgetall(keys.sess(sessionId));
      if (!h.node) return null;
      const lastBeat = Number(h.lastBeat);
      return {
        node: h.node,
        since: Number(h.since),
        lastBeat,
        fresh: Date.now() - lastBeat <= sessTtlMs,
      };
    },

    /** Idle expiry / drain: the node dropped its warm Query. */
    async unregister(sessionId: string): Promise<void> {
      await redis.del(keys.sess(sessionId));
    },

    /** Session ids currently registered to a node (SCAN — reaper cadence). */
    async listByNode(node: string): Promise<string[]> {
      const found: string[] = [];
      for (const key of await scanKeys(redis, keys.sessPattern())) {
        if ((await redis.hget(key, "node")) === node) found.push(sessIdOf(key));
      }
      return found;
    },

    /** Node boot: announce liveness and join the reaper's work list. The
     *  node's labels (from its verified credential) ride in the same
     *  transaction; omitted = an unlabelled node, i.e. `{default}`. */
    async nodeUp(node: string, labels?: readonly string[]): Promise<void> {
      const tx = redis.multi().set(keys.node(node), Date.now(), "PX", nodeTtlMs);
      if (labels) tx.set(keys.nodeLabels(node), encodeLabels(labels), "PX", nodeTtlMs);
      await tx.sadd(keys.nodeSet(), node).exec();
    },

    /** Periodic node heartbeat — refreshes the 30s liveness key, and the
     *  labels key beside it in the same transaction. */
    async beatNode(node: string, labels?: readonly string[]): Promise<void> {
      if (!labels) {
        await redis.set(keys.node(node), Date.now(), "PX", nodeTtlMs);
        return;
      }
      await redis
        .multi()
        .set(keys.node(node), Date.now(), "PX", nodeTtlMs)
        .set(keys.nodeLabels(node), encodeLabels(labels), "PX", nodeTtlMs)
        .exec();
    },

    /**
     * The labels a node consumes (spec §4.8). A node with no `nodelabels:`
     * key predates labels and consumes only `turns`, so it counts as
     * `{default}` — warm routing keeps working during a rolling upgrade.
     */
    async nodeLabels(node: string): Promise<ReadonlySet<string>> {
      return decodeLabels(await redis.get(keys.nodeLabels(node)));
    },

    /** Whether `node` consumes `label` (warm-routing check at dispatch). */
    async nodeCarries(node: string, label: string): Promise<boolean> {
      return decodeLabels(await redis.get(keys.nodeLabels(node))).has(label);
    },

    /** Live nodes (heartbeat key present) that carry `label`. */
    async nodesWithLabel(label: string): Promise<string[]> {
      const live = await listLive();
      if (live.length === 0) return [];
      const vals = await redis.mget(...live.map((n) => keys.nodeLabels(n)));
      return live.filter((_, i) => decodeLabels(vals[i] ?? null).has(label));
    },

    /** Every label at least one live node carries. */
    async liveLabels(): Promise<Set<string>> {
      const live = await listLive();
      const out = new Set<string>();
      if (live.length === 0) return out;
      const vals = await redis.mget(...live.map((n) => keys.nodeLabels(n)));
      for (const v of vals) for (const l of decodeLabels(v ?? null)) out.add(l);
      return out;
    },

    async nodeAlive(node: string): Promise<boolean> {
      return (await redis.exists(keys.node(node))) === 1;
    },

    /** Last node heartbeat (ms), or null when the key is gone (dead/expired).
     *  The value is the beat timestamp, so staleness is observable even while
     *  the key's TTL hasn't lapsed yet. */
    async nodeLastBeat(node: string): Promise<number | null> {
      const v = await redis.get(keys.node(node));
      if (v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    },

    /** The node-heartbeat TTL this registry was built with (ms). */
    nodeTtlMs,

    /** Currently-alive node ids (heartbeat key present). */
    async listNodes(): Promise<string[]> {
      return (await scanKeys(redis, keys.nodePattern())).map(nodeIdOf);
    },

    /** Every node id that ever registered — includes dead ones, until reaped. */
    async knownNodes(): Promise<string[]> {
      return await redis.smembers(keys.nodeSet());
    },

    /** Graceful shutdown: leave both liveness key and reaper work list. */
    async nodeDown(node: string): Promise<void> {
      await redis.multi().del(keys.node(node), keys.nodeLabels(node)).srem(keys.nodeSet(), node).exec();
    },

    /** Reaper bookkeeping: forget a dead node after cleaning it up. */
    async forgetNode(node: string): Promise<void> {
      await redis.srem(keys.nodeSet(), node);
    },
  };
}
