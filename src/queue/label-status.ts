/**
 * Unserved labels (node labels spec §4.7). A label is IN USE when a live
 * persona runs on it or its `turns.label.<label>` queue exists in Redis (a
 * label with no live node has no heartbeat, so heartbeats cannot say it is in
 * use). A label in use is UNSERVED when it has had waiting jobs and no live
 * node carrying it for longer than SLAUDE_LABEL_UNSERVED_SECS (default 60).
 *
 * The reaper leader calls update() every pass: it records, per label, since
 * when the label has been without a node (a Redis hash, so every gateway
 * replica reads the same clock) and exports `slaude_label_unserved{label}`
 * (1/0), dropping the series of a label no longer in use. read() is the same
 * computation without writes, for the panel on any replica.
 *
 * Cardinality: labels match the label regex and come from persona rows and
 * existing queues, and at most MAX_LABELS are reported.
 */
import type { Redis } from "ioredis";
import { m as metric } from "../metrics";
import { DEFAULT_LABEL, labelTurnsQueue, LABEL_RE, makeKeys, type Keys } from "./keys";
import type { Registry } from "./registry";
import type { TurnQueues } from "./turns";

/** At most this many labels are reported (metric series, panel rows). */
export const MAX_LABELS = 100;

export interface LabelStatus {
  label: string;
  /** Live nodes whose heartbeat carries the label. */
  liveNodes: number;
  /** Jobs waiting on the label's queue (waiting + prioritized). */
  waiting: number;
  /** Waiting > 0 and no live node, for longer than the threshold. */
  unserved: boolean;
  /** Since when (ms) the label has had waiting jobs and no live node; null
   *  when it has not, or the leader has not seen it yet. */
  unservedSinceMs: number | null;
}

export interface LabelMonitorOpts {
  redis: Redis;
  keys?: Keys;
  turns: TurnQueues;
  registry: Registry;
  /** The persona half of "in use": every label a live persona runs on. */
  personaLabels: () => string[];
  /** Threshold in seconds. Default SLAUDE_LABEL_UNSERVED_SECS. */
  unservedSecs: () => number;
}

export type LabelMonitor = ReturnType<typeof makeLabelMonitor>;

export function makeLabelMonitor(opts: LabelMonitorOpts) {
  const { redis, turns, registry } = opts;
  const keys = opts.keys ?? makeKeys();
  const hash = keys.labelUnservedSince();

  /** Labels in use, default first then sorted, bounded. */
  const inUse = async (): Promise<string[]> => {
    const set = new Set<string>([DEFAULT_LABEL]);
    for (const l of opts.personaLabels()) if (LABEL_RE.test(l)) set.add(l);
    for (const { label } of await turns.labelQueues()) set.add(label);
    const rest = [...set].filter((l) => l !== DEFAULT_LABEL).sort();
    return [DEFAULT_LABEL, ...rest].slice(0, MAX_LABELS);
  };

  /** Per label: live nodes and waiting jobs, plus the stored since-times. */
  const measure = async () => {
    const labels = await inUse();
    const since = await redis.hgetall(hash);
    const rows: Array<{ label: string; liveNodes: number; waiting: number; since: number | null }> = [];
    for (const label of labels) {
      // Raw reads, not a Queue handle: opening a BullMQ queue writes its
      // `:meta` key, which would make a persona-only label look "in use" by
      // queue forever after.
      const q = `${keys.bullPrefix}:${labelTurnsQueue(label)}`;
      const [wait, prio] = await Promise.all([redis.llen(`${q}:wait`), redis.zcard(`${q}:prioritized`)]);
      const s = Number(since[label]);
      rows.push({
        label,
        liveNodes: (await registry.nodesWithLabel(label)).length,
        waiting: wait + prio,
        since: Number.isFinite(s) && since[label] !== undefined ? s : null,
      });
    }
    return { rows, stored: Object.keys(since) };
  };

  const thresholdMs = () => opts.unservedSecs() * 1000;
  const starving = (r: { liveNodes: number; waiting: number }) => r.waiting > 0 && r.liveNodes === 0;

  return {
    inUse,

    /** Leader pass: record since-times, export the gauge, prune old labels. */
    async update(now: number = Date.now()): Promise<LabelStatus[]> {
      const { rows, stored } = await measure();
      const live = new Set(rows.map((r) => r.label));
      const out: LabelStatus[] = [];
      for (const r of rows) {
        let since = r.since;
        if (starving(r)) {
          if (since === null) {
            await redis.hsetnx(hash, r.label, String(now));
            since = Number(await redis.hget(hash, r.label)) || now;
          }
        } else if (since !== null) {
          await redis.hdel(hash, r.label);
          since = null;
        }
        const unserved = since !== null && now - since >= thresholdMs();
        metric.labelUnserved.set(unserved ? 1 : 0, { label: r.label });
        out.push({ label: r.label, liveNodes: r.liveNodes, waiting: r.waiting, unserved, unservedSinceMs: since });
      }
      const gone = stored.filter((l) => !live.has(l));
      if (gone.length) await redis.hdel(hash, ...gone);
      for (const ls of metric.labelUnserved.labelSets()) {
        if (ls.label !== undefined && !live.has(ls.label)) metric.labelUnserved.remove(ls);
      }
      return out;
    },

    /** Read-only view for the panel: no writes, any replica. */
    async read(now: number = Date.now()): Promise<LabelStatus[]> {
      const { rows } = await measure();
      return rows.map((r) => {
        const since = starving(r) ? r.since : null;
        return {
          label: r.label,
          liveNodes: r.liveNodes,
          waiting: r.waiting,
          unserved: since !== null && now - since >= thresholdMs(),
          unservedSinceMs: since,
        };
      });
    },
  };
}
