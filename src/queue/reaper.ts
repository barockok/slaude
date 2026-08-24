/**
 * Dead-node reaper (spec §2, "Node health and reaping"). Designed to run on a
 * gateway replica under leaderLoop("reaper", ...) every ~30s.
 *
 * A node is dead when its `nodes:<id>` heartbeat key is gone but it still has
 * leftovers: `sess:*` registry entries pointing at it, or jobs parked on its
 * per-node queue. The reaper deletes the session entries (so routing falls
 * back to cold resume) and moves the jobs to the shared `turns` queue through
 * the normal coalescing enqueue (payload preserved; attempts/backoff policy
 * re-applied).
 *
 * moveStalled additionally rescues jobs sitting unclaimed on a *live* node's
 * queue past a threshold (node too busy or its worker wedged): they too go
 * back to the shared queue for anyone to pick up.
 *
 * Duplicate-delivery window: moveToShared coalesces via the coalesce index,
 * but that index has its own TTL. A session with a job stranded on a dead
 * node's queue AND an already-pending shared job whose index entry has
 * expired ends up with TWO shared jobs after the reap — the move can no
 * longer see the sibling. This is accepted at-least-once behavior: the
 * session lock serializes the two turns, and the consumer's Slack-ts dedup
 * drops the repeated messages downstream.
 */
import type { Redis } from "ioredis";
import type { Job } from "bullmq";
import { makeKeys, nodeTurnsQueue, TURNS_QUEUE, type Keys } from "./keys";
import { scanKeys, type Registry } from "./registry";
import type { TurnQueues } from "./turns";

/** Job states that are safe to move: not yet claimed by any worker. */
const MOVABLE_STATES = ["waiting", "delayed", "prioritized"] as const;

export interface ReapReport {
  /** Dead node ids cleaned this pass (had leftovers or were still in nodeset). */
  deadNodes: string[];
  /** sess:* entries deleted. */
  sessionsCleared: number;
  /** Jobs moved from per-node queues to the shared queue. */
  jobsMoved: number;
}

export interface ReaperOpts {
  redis: Redis;
  keys?: Keys;
  turns: TurnQueues;
  registry: Registry;
  /** moveStalled default threshold: job unclaimed on a per-node queue for
   *  longer than this. Spec default: 5s. */
  stalledThresholdMs?: number;
}

export type Reaper = ReturnType<typeof makeReaper>;

export function makeReaper(opts: ReaperOpts) {
  const { redis, turns, registry } = opts;
  const keys = opts.keys ?? makeKeys();
  const defaultThreshold = opts.stalledThresholdMs ?? 5000;

  /** Every sess:* entry as {key, sessionId → node}. One scan per pass. */
  const sessionsByNode = async (): Promise<Map<string, string[]>> => {
    const byNode = new Map<string, string[]>();
    for (const key of await scanKeys(redis, keys.sessPattern())) {
      const node = await redis.hget(key, "node");
      if (!node) continue;
      const list = byNode.get(node) ?? [];
      list.push(key);
      byNode.set(node, list);
    }
    return byNode;
  };

  /** Move every unclaimed job on a per-node queue to the shared queue. */
  const drainNodeQueue = async (nodeId: string): Promise<number> => {
    const q = turns.queue(nodeTurnsQueue(nodeId));
    const jobs: Job[] = await q.getJobs([...MOVABLE_STATES]);
    let moved = 0;
    for (const job of jobs) {
      // moveToShared is coalesce-index-aware: it appends into another pending
      // job for the same session when one exists, and otherwise re-adds on
      // shared before removing the original (add-first: a crash between the
      // two duplicates — at-least-once — rather than losing the turn).
      await turns.moveToShared(job);
      moved++;
    }
    return moved;
  };

  return {
    keys,

    /**
     * One reap pass. Candidates = nodes that ever registered (nodeset) plus
     * any node referenced by a sess:* entry (covers a lost/flushed nodeset).
     * A candidate whose heartbeat key is missing is dead: clear its sessions,
     * drain its queue, drop it from nodeset.
     */
    async reapDeadNodes(): Promise<ReapReport> {
      const byNode = await sessionsByNode();
      const candidates = new Set<string>([...(await registry.knownNodes()), ...byNode.keys()]);
      const report: ReapReport = { deadNodes: [], sessionsCleared: 0, jobsMoved: 0 };
      for (const nodeId of candidates) {
        if (await registry.nodeAlive(nodeId)) continue;
        const sessKeys = byNode.get(nodeId) ?? [];
        if (sessKeys.length > 0) {
          await redis.del(...sessKeys);
          report.sessionsCleared += sessKeys.length;
        }
        report.jobsMoved += await drainNodeQueue(nodeId);
        await registry.forgetNode(nodeId);
        report.deadNodes.push(nodeId);
      }
      return report;
    },

    /**
     * Rescue jobs unclaimed on a per-node queue for longer than the threshold
     * (default 5s): move them to the shared queue. Returns the count moved.
     *
     * Guarded on the node's HEARTBEAT, not just the job's age: a busy-but-
     * alive node keeps its warm queue (moving its jobs would churn sessions
     * onto cold nodes for nothing). Jobs move only when the node's heartbeat
     * key is gone or its last beat is older than the heartbeat TTL — i.e. the
     * worker process (whose heartbeat loop and claim loop live and die
     * together) has actually stopped servicing the queue.
     */
    async moveStalled(nodeId: string, thresholdMs: number = defaultThreshold): Promise<number> {
      const lastBeat = await registry.nodeLastBeat(nodeId);
      if (lastBeat !== null && Date.now() - lastBeat <= registry.nodeTtlMs) return 0;
      const q = turns.queue(nodeTurnsQueue(nodeId));
      const now = Date.now();
      let moved = 0;
      for (const job of await q.getJobs(["waiting"])) {
        if (now - job.timestamp <= thresholdMs) continue;
        await turns.moveToShared(job);
        moved++;
      }
      return moved;
    },

    /** The shared queue handle (depth metrics, tests). */
    sharedQueue() {
      return turns.queue(TURNS_QUEUE);
    },
  };
}
