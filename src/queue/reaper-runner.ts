/**
 * Gateway reaper leadership (spec §2 "Node health and reaping"): one gateway
 * replica at a time runs, every ~30s,
 *
 *   - reapDeadNodes: expired node heartbeat → clear its sess:* entries, move
 *     its per-node jobs to the shared queue, drop it from the work list;
 *   - moveStalled: jobs unclaimed on a LIVE node's queue past the threshold
 *     go back to the shared queue for anyone;
 *   - queue/registry gauges (spec §6): queue depth, nodes alive, sessions
 *     warm — exported by the current leader;
 *   - unserved labels (node labels spec §4.7): a label in use with waiting
 *     jobs and no live node past SLAUDE_LABEL_UNSERVED_SECS sets
 *     slaude_label_unserved{label} (see ./label-status).
 */
import type { Redis } from "ioredis";
import { env } from "../config/env";
import { m as metric } from "../metrics";
import { makeKeys, type Keys } from "./keys";
import { makeLabelMonitor, type LabelMonitor } from "./label-status";
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
  infra?: { turns: TurnQueues; registry: Registry; reaper: Reaper; labels?: LabelMonitor };
  /** Every label a live persona runs on (the persona half of "labels in
   *  use"). Default: none, so only the label queues in Redis count. */
  personaLabels?: () => string[];
  onError?: (err: unknown) => void;
}

export function startReaperLeader(opts: ReaperRunnerOpts): LeaderHandle {
  const keys = opts.keys ?? makeKeys();
  const intervalMs = opts.intervalMs ?? 30_000;
  const infra: NonNullable<ReaperRunnerOpts["infra"]> =
    opts.infra ??
    (() => {
      const turns = new TurnQueues({ connection: opts.redis, keys });
      const registry = makeRegistry({ redis: opts.redis, keys });
      return { turns, registry, reaper: makeReaper({ redis: opts.redis, keys, turns, registry }) };
    })();
  const { registry, reaper } = infra;
  const labels =
    infra.labels ??
    makeLabelMonitor({
      redis: opts.redis,
      keys,
      turns: infra.turns,
      registry,
      personaLabels: opts.personaLabels ?? (() => []),
      unservedSecs: () => env.labelUnservedSec(),
    });
  const onError = opts.onError ?? ((e) => console.error("[reaper]", e));
  const unservedLogged = new Set<string>();

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
          // One series per label queue (node labels spec §4.7): `queue` keeps
          // its meaning (`turns` is still label default) and `label` is added.
          // Bounded by the labels in use, not by nodes.
          for (const { queue, label } of await infra.turns.labelQueues()) {
            const counts = await infra.turns.queue(queue).getJobCounts("waiting", "delayed", "prioritized");
            metric.queueDepth.set(
              (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0),
              { queue, label },
            );
          }
          // Logged on the transition only, not every pass.
          for (const s of await labels.update()) {
            if (s.unserved && !unservedLogged.has(s.label)) {
              unservedLogged.add(s.label);
              console.warn(`[reaper] label '${s.label}' is unserved: ${s.waiting} waiting, no live node`);
            } else if (!s.unserved) unservedLogged.delete(s.label);
          }
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
