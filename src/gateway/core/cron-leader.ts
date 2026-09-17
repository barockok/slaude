/**
 * Run the cron scheduler on exactly one gateway replica.
 *
 * Every gateway constructs a scheduler, and the scheduler's own guard against
 * running a job twice is an in-process Set. Due jobs are selected with a plain
 * query that claims nothing, and a job's next run is only written after its turn
 * finishes, so nothing in the database marks a job as taken either. Two gateways
 * therefore both fire every due job, and the user gets the run twice.
 *
 * Leader election is how this codebase already handles singleton loops: the
 * reaper uses it, and the loop helper names cron as one of its intended roles.
 * The lock's TTL bounds how long the schedule stalls if the leader dies —
 * another replica takes over and fires the job late rather than never, since
 * due jobs stay due until they run.
 *
 * mono does not need this: it is one process, and it has no Redis to elect with.
 */
import type { Redis } from "ioredis";
import type { Keys } from "../../queue/keys";
import { leaderLoop, type LeaderHandle } from "../../queue/locks";

export interface SchedulerLike {
  start(): void;
  stop(): void;
}

export interface CronLeaderOpts {
  redis: Redis;
  keys?: Keys;
  /** Lock TTL in seconds. Default matches leaderLoop's own default. */
  ttlSec?: number;
  onError?: (err: unknown) => void;
}

export function startCronLeader(scheduler: SchedulerLike, opts: CronLeaderOpts): LeaderHandle {
  return leaderLoop(
    "cron",
    async (signal) => {
      scheduler.start();
      try {
        // Hold leadership until the term ends. Losing the lock (missed renewals)
        // aborts the signal, and the scheduler must stop immediately: another
        // replica may already have taken over.
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        scheduler.stop();
      }
    },
    opts,
  );
}
