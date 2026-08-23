/**
 * Gateway reaper leadership (spec §2 "Node health and reaping"): one gateway
 * replica at a time runs, every ~30s,
 *
 *   - reapDeadNodes: expired node heartbeat → clear its sess:* entries, move
 *     its per-node jobs to the shared queue, drop it from the work list;
 *   - moveStalled: jobs unclaimed on a LIVE node's queue past the threshold
 *     go back to the shared queue for anyone;
 *   - queue/registry gauges (spec §6): queue depth, nodes alive, sessions
 *     warm — exported by the current leader.
 */
import type { Redis } from "ioredis";
import { m as metric } from "../metrics";
import { makeKeys, type Keys } from "./keys";
import { leaderLoop, type LeaderHandle } from "./locks";
import { makeRegistry, scanKeys, type Registry } from "./registry";
import { makeReaper, type Reaper } from "./reaper";
import { TurnQueues } from "./turns";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ReaperRunnerOpts {
  redis: Redis;
  keys?: Keys;
  /** Pass cadence. Spec default 30s. */
  intervalMs?: number;
  /** Injected collaborators (tests). */
  infra?: { turns: TurnQueues; registry: Registry; reaper: Reaper };
  onError?: (err: unknown) => void;
}

export function startReaperLeader(opts: ReaperRunnerOpts): LeaderHandle {
  const keys = opts.keys ?? makeKeys();
  const intervalMs = opts.intervalMs ?? 30_000;
  const infra =
    opts.infra ??
    (() => {
      const turns = new TurnQueues({ connection: opts.redis, keys });
      const registry = makeRegistry({ redis: opts.redis, keys });
      return { turns, registry, reaper: makeReaper({ redis: opts.redis, keys, turns, registry }) };
    })();
  const { registry, reaper } = infra;
  const onError = opts.onError ?? ((e) => console.error("[reaper]", e));

  return leaderLoop(
    "reaper",
    async (signal) => {
      while (!signal.aborted) {
        try {
          const report = await reaper.reapDeadNodes();
          if (report.deadNodes.length) {
            console.log(
              `[reaper] reaped nodes=${report.deadNodes.join(",")} sessions=${report.sessionsCleared} jobs=${report.jobsMoved}`,
            );
          }
          const alive = await registry.listNodes();
          for (const nodeId of alive) {
            const moved = await reaper.moveStalled(nodeId);
            if (moved) console.log(`[reaper] rescued ${moved} stalled job(s) from ${nodeId}`);
          }
          // Gauges (leader-only — one writer per scrape target set).
          const counts = await reaper.sharedQueue().getJobCounts("waiting", "delayed", "prioritized");
          metric.queueDepth.set(
            (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0),
            { queue: "turns" },
          );
          metric.nodesAlive.set(alive.length);
          metric.sessionsWarm.set((await scanKeys(opts.redis, keys.sessPattern())).length);
          metric.reaperLastRun.set(Math.floor(Date.now() / 1000));
        } catch (e) {
          onError(e);
        }
        // Abort-aware nap.
        const napEnd = Date.now() + intervalMs;
        while (!signal.aborted && Date.now() < napEnd) await sleep(Math.min(250, napEnd - Date.now()));
      }
    },
    { redis: opts.redis, keys, onError },
  );
}
