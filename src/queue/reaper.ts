/**
 * Dead-node reaper (spec §2, "Node health and reaping"). Designed to run on a
 * gateway replica under leaderLoop("reaper", ...) every ~30s.
 *
 * A node is dead when its `nodes:<id>` heartbeat key is gone but it still has
 * leftovers: `sess:*` registry entries pointing at it, or jobs parked on its
 * per-node queue. The reaper deletes the session entries (so routing falls
 * back to cold resume) and moves the jobs to the queue of the job's own label
 * (`turns` for `default`, `turns.label.<label>` otherwise; node labels spec
 * §4.6) with TurnQueues.moveTo: same job id, payload preserved, the coalesce
 * index and the job-moved marker kept right.
 *
 * Active jobs (H27): a warm-routed turn the dead node had CLAIMED sits active
 * on the node's own queue. No surviving worker consumes that queue, so
 * BullMQ's stall recovery never runs for it: the reaper moves an active job
 * whose BullMQ lock has expired, atomically (the lock is checked in the same
 * Redis step that takes the job). An active job whose lock is still live (the
 * process may be partitioned, not dead) is never touched; the node then stays
 * on the work list, so the next pass looks again. A job whose turn already
 * finished (its turn-done marker exists, read in the same atomic step) is
 * taken off the node's queue and dropped, never copied or merged into another
 * job: its turn ran. Any other rescued job's messages go BEFORE those of the
 * session's newer pending job when the two are merged.
 *
 * moveStalled additionally rescues jobs sitting unclaimed on a *live* node's
 * queue past a threshold (node too busy or its worker wedged): they too go
 * back to their label's queue for anyone to pick up.
 *
 * Duplicate-delivery window: moveTo coalesces via the coalesce index, but
 * that index has its own TTL. A session with a job stranded on a dead node's
 * queue AND an already-pending label job whose index entry has expired ends
 * up with TWO jobs after the reap — the move can no longer see the sibling.
 * This is accepted at-least-once behavior: the session lock serializes the
 * two turns.
 */
import type { Redis } from "ioredis";
import type { Job } from "bullmq";
import { makeKeys, nodeTurnsQueue, TURNS_QUEUE, type Keys } from "./keys";
import { scanKeys, type Registry } from "./registry";
import { jobLabel, type TurnJob, type TurnQueues } from "./turns";

/** Job states that are safe to move: not yet claimed by any worker. */
const MOVABLE_STATES = ["waiting", "delayed", "prioritized"] as const;

export interface ReapReport {
  /** Dead node ids cleaned this pass (had leftovers or were still in nodeset). */
  deadNodes: string[];
  /** sess:* entries deleted. */
  sessionsCleared: number;
  /** Jobs this pass took off per-node queues: moved to their label queues,
   *  merged into the session's pending job, or (turn already done) dropped. */
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

  /**
   * Move one job to its own label's queue. `taken`: this call took it off the
   * node's queue (it is gone from there now). `left`: the move did not report
   * it as still here — also true when an earlier pass already moved it, so a
   * job only `held` by a live lock keeps its node on the work list.
   */
  const moveHome = async (job: Job, rescueActive: boolean): Promise<{ taken: boolean; left: boolean }> => {
    const res = await turns.moveTo(job, jobLabel(job.data as TurnJob), { rescueActive });
    const left = !(res.queue === job.queueName && res.jobId === String(job.id));
    const taken = !(await turns.queue(job.queueName).getJob(String(job.id)));
    return { taken, left: left || taken };
  };

  /**
   * Move every unclaimed job, and every active job whose lock has expired, on
   * a dead node's queue to its label's queue. `held` counts active jobs whose
   * lock is still live: they are left alone this pass.
   */
  const drainNodeQueue = async (nodeId: string): Promise<{ moved: number; held: number }> => {
    const q = turns.queue(nodeTurnsQueue(nodeId));
    let moved = 0;
    let held = 0;
    for (const job of (await q.getJobs([...MOVABLE_STATES])) as Job[]) {
      if ((await moveHome(job, false)).taken) moved++;
    }
    for (const job of (await q.getJobs(["active"])) as Job[]) {
      // moveTo re-checks the lock in the same atomic step that takes the job;
      // a job it leaves in place is still held by a live lock.
      const r = await moveHome(job, true);
      if (r.taken) moved++;
      if (!r.left) held++;
    }
    return { moved, held };
  };

  return {
    keys,

    /**
     * One reap pass. Candidates = nodes that ever registered (nodeset) plus
     * any node referenced by a sess:* entry (covers a lost/flushed nodeset).
     * A candidate whose heartbeat key is missing is dead: clear its sessions,
     * drain its queue, drop it from nodeset — unless an active job on its
     * queue still holds a live lock, in which case it stays for the next pass.
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
        const { moved, held } = await drainNodeQueue(nodeId);
        report.jobsMoved += moved;
        if (held === 0) await registry.forgetNode(nodeId);
        report.deadNodes.push(nodeId);
      }
      return report;
    },

    /**
     * Rescue jobs unclaimed on a per-node queue for longer than the threshold
     * (default 5s): move them to their label's queue. Returns the count moved.
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
        if ((await moveHome(job, false)).taken) moved++;
      }
      return moved;
    },

    /** The shared queue handle (depth metrics, tests). */
    sharedQueue() {
      return turns.queue(TURNS_QUEUE);
    },
  };
}
