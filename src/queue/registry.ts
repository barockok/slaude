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

/** How long a refresh mark waits for the session's next turn: a thread can sit idle for weeks. */
export const BOX_REFRESH_NOTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a node that offers a sandbox reports about boxes on its heartbeat: the
 * image digests it holds unpacked and, once it admits boxes, its occupancy.
 * `free` is a hint for routing. The node's own admission check is the authority.
 */
export interface NodeBoxReport {
  digests: string[];
  running?: number;
  capacity?: number;
  free?: number;
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : undefined);

const encodeBoxes = (r: NodeBoxReport): string =>
  JSON.stringify({
    digests: [...new Set(r.digests.filter((d) => DIGEST_RE.test(d)))].sort().slice(0, 500),
    ...(count(r.running) !== undefined ? { running: r.running } : {}),
    ...(count(r.capacity) !== undefined ? { capacity: r.capacity } : {}),
    ...(count(r.free) !== undefined ? { free: r.free } : {}),
  });

/** A stored report, or null when absent or unreadable. Anything that is not a digest is dropped: a node's report is data, not trusted text. */
function decodeBoxes(v: string | null | undefined): NodeBoxReport | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as { digests?: unknown; running?: unknown; capacity?: unknown; free?: unknown };
    if (!Array.isArray(o.digests)) return null;
    const out: NodeBoxReport = { digests: o.digests.filter((d): d is string => typeof d === "string" && DIGEST_RE.test(d)).sort() };
    for (const k of ["running", "capacity", "free"] as const) {
      const n = count(o[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  } catch {
    return null;
  }
}

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
  // The labels key must outlive every warm session on the node (whose
  // freshness window is 2× heartbeat), or warm routing would read an expired
  // key as {default} while the node still holds a live Query: so at least the
  // node key's TTL and at least 3× heartbeat, refreshed on every beat.
  const nodeLabelsTtlMs = Math.max(nodeTtlMs, Math.round(3 * hbSec * 1000));
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

    /** lookup() for many sessions in ONE pipeline (one round trip), in order. */
    async lookupMany(sessionIds: readonly string[]): Promise<Array<SessionLocation | null>> {
      if (sessionIds.length === 0) return [];
      const p = redis.pipeline();
      for (const id of sessionIds) p.hgetall(keys.sess(id));
      const res = (await p.exec()) ?? [];
      const now = Date.now();
      return sessionIds.map((_, i) => {
        const [err, h] = res[i] ?? [null, null];
        const row = (err ? null : h) as Record<string, string> | null;
        if (!row?.node) return null;
        const lastBeat = Number(row.lastBeat);
        return { node: row.node, since: Number(row.since), lastBeat, fresh: now - lastBeat <= sessTtlMs };
      });
    },

    /** Idle expiry / drain: the node dropped its warm Query. */
    async unregister(sessionId: string): Promise<void> {
      await redis.del(keys.sess(sessionId));
    },

    /** How many sessions are warm on some node (SCAN of `sess:*`; each key
     *  expires with its heartbeat, so a key that exists is a warm session). */
    async countWarm(): Promise<number> {
      return (await scanKeys(redis, keys.sessPattern())).length;
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
    async nodeUp(node: string, labels?: readonly string[], caps?: readonly string[], boxes?: NodeBoxReport): Promise<void> {
      const tx = redis.multi().set(keys.node(node), Date.now(), "PX", nodeTtlMs);
      if (labels) tx.set(keys.nodeLabels(node), encodeLabels(labels), "PX", nodeLabelsTtlMs);
      if (caps) tx.set(keys.nodeCaps(node), [...new Set(caps)].sort().join(","), "PX", nodeLabelsTtlMs);
      if (boxes) tx.set(keys.nodeBoxes(node), encodeBoxes(boxes), "PX", nodeLabelsTtlMs);
      await tx.sadd(keys.nodeSet(), node).exec();
    },

    /** Periodic node heartbeat — refreshes the 30s liveness key, and the
     *  labels key beside it in the same transaction. */
    async beatNode(node: string, labels?: readonly string[], caps?: readonly string[], boxes?: NodeBoxReport): Promise<void> {
      if (!labels && !caps && !boxes) {
        await redis.set(keys.node(node), Date.now(), "PX", nodeTtlMs);
        return;
      }
      const tx = redis.multi().set(keys.node(node), Date.now(), "PX", nodeTtlMs);
      if (labels) tx.set(keys.nodeLabels(node), encodeLabels(labels), "PX", nodeLabelsTtlMs);
      if (caps) tx.set(keys.nodeCaps(node), [...new Set(caps)].sort().join(","), "PX", nodeLabelsTtlMs);
      // Written with the node TTL beside its capabilities: a dead node's images and free slots expire with it.
      if (boxes) tx.set(keys.nodeBoxes(node), encodeBoxes(boxes), "PX", nodeLabelsTtlMs);
      await tx.exec();
    },

    /** What a node last reported about boxes, or null (it offers no sandbox, or it is gone). */
    async nodeBoxes(node: string): Promise<NodeBoxReport | null> {
      return decodeBoxes(await redis.get(keys.nodeBoxes(node)));
    },

    /**
     * Live nodes that carry `label` and advertise every capability in `caps`,
     * each with whether it holds `digest` unpacked and the free slots it last
     * reported (null: it reports none yet). Sorted by node. One listing and
     * three MGETs, so a node's facts never come from a later read than the one
     * that selected it.
     */
    async liveNodesWithBox(label: string, caps: readonly string[], digest: string): Promise<Array<{ node: string; hasDigest: boolean; free: number | null }>> {
      const live = await listLive();
      if (live.length === 0) return [];
      const [labels, capVals, boxVals] = await Promise.all([
        redis.mget(...live.map((n) => keys.nodeLabels(n))),
        redis.mget(...live.map((n) => keys.nodeCaps(n))),
        redis.mget(...live.map((n) => keys.nodeBoxes(n))),
      ]);
      const out: Array<{ node: string; hasDigest: boolean; free: number | null }> = [];
      live.forEach((node, i) => {
        if (!decodeLabels(labels[i] ?? null).has(label)) return;
        const have = new Set((capVals[i] ?? "").split(",").filter(Boolean));
        if (!caps.every((c) => have.has(c))) return;
        const report = decodeBoxes(boxVals[i]);
        out.push({ node, hasDigest: !!report && report.digests.includes(digest), free: report?.free ?? null });
      });
      return out.sort((a, b) => a.node.localeCompare(b.node));
    },

    /**
     * Every live node that reports boxes, with its labels and its report,
     * sorted by node: the console's "which node holds which image".
     */
    async liveBoxInventory(): Promise<Array<{ node: string; labels: string[]; boxes: NodeBoxReport }>> {
      const live = await listLive();
      if (live.length === 0) return [];
      const [labels, boxVals] = await Promise.all([redis.mget(...live.map((n) => keys.nodeLabels(n))), redis.mget(...live.map((n) => keys.nodeBoxes(n)))]);
      const out: Array<{ node: string; labels: string[]; boxes: NodeBoxReport }> = [];
      live.forEach((node, i) => {
        const boxes = decodeBoxes(boxVals[i]);
        if (boxes) out.push({ node, labels: [...decodeLabels(labels[i] ?? null)].sort(), boxes });
      });
      return out.sort((a, b) => a.node.localeCompare(b.node));
    },

    /** Of the given node process ids, those with a live heartbeat. */
    async liveNodeIds(ids: readonly string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const vals = await redis.mget(...ids.map((id) => keys.node(id)));
      return new Set(ids.filter((_, i) => vals[i] !== null));
    },

    /** The capabilities a node advertises (none for a node that predates them). */
    async nodeCaps(node: string): Promise<ReadonlySet<string>> {
      const v = await redis.get(keys.nodeCaps(node));
      return new Set((v ?? "").split(",").filter(Boolean));
    },

    /** Live nodes carrying `label`, each with whether it advertises `cap`. Sorted by node. */
    async liveNodesWithCap(label: string, cap: string): Promise<Array<{ node: string; has: boolean }>> {
      const live = await listLive();
      if (live.length === 0) return [];
      const [labels, caps] = await Promise.all([
        redis.mget(...live.map((n) => keys.nodeLabels(n))),
        redis.mget(...live.map((n) => keys.nodeCaps(n))),
      ]);
      return live
        .map((node, i) => ({ node, carries: decodeLabels(labels[i] ?? null).has(label), has: (caps[i] ?? "").split(",").includes(cap) }))
        .filter((n) => n.carries)
        .map((n) => ({ node: n.node, has: n.has }))
        .sort((a, b) => a.node.localeCompare(b.node));
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

    /** Live nodes that carry `label`, each with ALL its labels (sorted), from
     *  the same listing and MGET that decide membership: a node's labels can
     *  never come from a later read than the one that selected it. Sorted by node. */
    async liveNodesHolding(label: string): Promise<Array<{ node: string; labels: string[] }>> {
      const live = await listLive();
      if (live.length === 0) return [];
      const vals = await redis.mget(...live.map((n) => keys.nodeLabels(n)));
      return live
        .map((node, i) => ({ node, set: decodeLabels(vals[i] ?? null) }))
        .filter((n) => n.set.has(label))
        .map((n) => ({ node: n.node, labels: [...n.set].sort() }))
        .sort((a, b) => a.node.localeCompare(b.node));
    },

    /** How many live nodes carry each label, from ONE listing of the live
     *  nodes (label status reads every label in use per pass). */
    async liveNodesPerLabel(): Promise<Map<string, number>> {
      const live = await listLive();
      const out = new Map<string, number>();
      if (live.length === 0) return out;
      const vals = await redis.mget(...live.map((n) => keys.nodeLabels(n)));
      for (const v of vals) for (const l of decodeLabels(v ?? null)) out.set(l, (out.get(l) ?? 0) + 1);
      return out;
    },

    /** Every live node with all its labels (sorted) and its last heartbeat
     *  (ms; null when the key went between the listing and the read), sorted
     *  by node. Two MGETs over one listing. */
    async liveNodeDetails(): Promise<Array<{ node: string; labels: string[]; lastBeat: number | null }>> {
      const live = await listLive();
      if (live.length === 0) return [];
      const [beats, labels] = await Promise.all([
        redis.mget(...live.map((n) => keys.node(n))),
        redis.mget(...live.map((n) => keys.nodeLabels(n))),
      ]);
      return live
        .map((node, i) => {
          const b = beats[i] == null ? NaN : Number(beats[i]);
          return { node, labels: [...decodeLabels(labels[i] ?? null)].sort(), lastBeat: Number.isFinite(b) ? b : null };
        })
        .sort((a, b) => a.node.localeCompare(b.node));
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
    /** The labels key TTL (ms): max(node TTL, 3× heartbeat). */
    nodeLabelsTtlMs,

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
      await redis.multi().del(keys.node(node), keys.nodeLabels(node), keys.nodeCaps(node), keys.nodeBoxes(node)).srem(keys.nodeSet(), node).exec();
    },

    /** Reaper bookkeeping: forget a dead node after cleaning it up. */
    async forgetNode(node: string): Promise<void> {
      await redis.srem(keys.nodeSet(), node);
    },

    /**
     * Whether a node is running a turn of this session right now: the session
     * lock is held for exactly the length of a turn (src/queue/locks.ts), on
     * whichever node runs it, so it answers the same on every gateway replica.
     */
    async turnRunning(sessionId: string): Promise<boolean> {
      return (await redis.exists(keys.sessionLock(sessionId))) === 1;
    },

    /**
     * A session was moved to a new box image: remember it until its next turn
     * is dispatched. A later refresh before that turn replaces the mark (the
     * note says "a new image", once, whatever number of moves there were).
     */
    async markBoxRefresh(sessionId: string, mark: { box: string; from: string; to: string; at: number }): Promise<void> {
      await redis.set(keys.boxRefreshNote(sessionId), JSON.stringify(mark), "PX", BOX_REFRESH_NOTE_TTL_MS);
    },

    /** Take the mark, at most once (GETDEL): the dispatch that gets it carries the note. Null: none, or unreadable. */
    async takeBoxRefresh(sessionId: string): Promise<{ box: string; from: string; to: string; at: number } | null> {
      const raw = await redis.getdel(keys.boxRefreshNote(sessionId));
      if (raw === null) return null;
      try {
        const v = JSON.parse(raw) as { box?: unknown; from?: unknown; to?: unknown; at?: unknown };
        if (typeof v.box !== "string" || typeof v.from !== "string" || typeof v.to !== "string") return null;
        return { box: v.box, from: v.from, to: v.to, at: typeof v.at === "number" ? v.at : 0 };
      } catch {
        return null;
      }
    },
  };
}
