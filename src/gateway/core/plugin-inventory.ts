/**
 * The gateway's view of the plugin inventory (design:
 * docs/superpowers/specs/2026-11-09-plugin-inventory.md).
 *
 * `bridgeExternalMcp` is synchronous and read per request, the inventory lives
 * in the database, and liveness in Redis. So this module holds one derived,
 * in-memory snapshot, recomputed from those two shared sources:
 *   - at gateway start (awaited, before the gateway serves),
 *   - after a node's report lands on this replica,
 *   - every REFRESH_MS on a timer, which is how the other replicas catch up
 *     (a report, or a node going away, is seen within one interval).
 *
 * The snapshot is purely derived, so any number of replicas can hold one with
 * no coordination. A failed refresh keeps the last good snapshot for at most
 * STALE_AFTER_MS, then reads as empty rather than offering from old state. A
 * process that never starts the view (mono, tests) reads as empty, so nothing
 * changes for a deployment with no plugins.
 */
import type { NodePluginsRow } from "../../db/node-plugins";
import { STATE_OFFERABLE, type ReportedPlugin } from "../../config/plugin-inventory";

export const REFRESH_MS = 15_000;
export const STALE_AFTER_MS = 5 * 60_000;

/** A plugin HTTP server the bridge may serve. `fromPlugin` names it in the
 *  portal row; the rest is the same shape a configured server has. */
export interface PluginBridgeServer {
  type: "http";
  url: string;
  fromPlugin: string;
}

export interface InventorySnapshot {
  /** label → server name → the server (offered and bridged). */
  servers: Map<string, Map<string, PluginBridgeServer>>;
  /** label → names whose nodes report different URLs (neither bridged nor offered). */
  conflicts: Map<string, Set<string>>;
  at: number;
}

export const EMPTY_SNAPSHOT: InventorySnapshot = { servers: new Map(), conflicts: new Map(), at: 0 };

const bucket = <V>(m: Map<string, V>, k: string, make: () => V): V => {
  let v = m.get(k);
  if (!v) {
    v = make();
    m.set(k, v);
  }
  return v;
};

/**
 * Derive the snapshot from each node's latest report and the set of credential
 * ids with a live node. Per label: a name is offered when some live node lists
 * it offerable and every live node listing it agrees on the URL. A server with
 * a state that is not offerable still takes part in the URL comparison, so a
 * disagreement blocks the offer whatever the disagreeing node's state is.
 */
export function computeSnapshot(rows: readonly NodePluginsRow[], live: ReadonlySet<string>, now = Date.now()): InventorySnapshot {
  const seen = new Map<string, Map<string, { urls: Set<string>; offerable: string | null }>>();
  for (const row of rows) {
    if (!live.has(row.nodeId)) continue;
    for (const label of row.labels) {
      const names = bucket(seen, label, () => new Map());
      for (const plugin of row.report.plugins as ReportedPlugin[]) {
        for (const s of plugin.http) {
          if (!s.url) continue;
          const e = bucket(names, s.name, () => ({ urls: new Set<string>(), offerable: null as string | null }));
          e.urls.add(s.url);
          if (s.state === STATE_OFFERABLE && e.offerable === null) e.offerable = plugin.name;
        }
      }
    }
  }
  const servers = new Map<string, Map<string, PluginBridgeServer>>();
  const conflicts = new Map<string, Set<string>>();
  for (const [label, names] of seen) {
    for (const [name, e] of names) {
      if (e.urls.size > 1) {
        bucket(conflicts, label, () => new Set()).add(name);
      } else if (e.offerable) {
        bucket(servers, label, () => new Map()).set(name, { type: "http", url: [...e.urls][0]!, fromPlugin: e.offerable });
      }
    }
  }
  return { servers, conflicts, at: now };
}

export interface InventorySources {
  rows: () => Promise<NodePluginsRow[]>;
  live: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
}

let snapshot: InventorySnapshot = EMPTY_SNAPSHOT;
let sources: InventorySources | null = null;

export function currentSnapshot(now = Date.now()): InventorySnapshot {
  if (snapshot.at !== 0 && now - snapshot.at > STALE_AFTER_MS) return EMPTY_SNAPSHOT;
  return snapshot;
}

/** The offerable plugin servers for a node label, as fresh objects. */
export function pluginServersFor(label: string, now = Date.now()): Record<string, PluginBridgeServer> {
  const out: Record<string, PluginBridgeServer> = {};
  for (const [name, s] of currentSnapshot(now).servers.get(label) ?? []) out[name] = { ...s };
  return out;
}

/** Recompute from the sources. Throws on a source failure (the caller logs). */
export async function refreshPluginInventory(src: InventorySources | null = sources): Promise<void> {
  if (!src) return;
  const rows = await src.rows();
  const live = await src.live(rows.map((r) => r.nodeId));
  snapshot = computeSnapshot(rows, live);
}

/** Refresh after a report landed on this replica; best effort (the timer repairs). */
export function noteReported(): void {
  void refreshPluginInventory().catch((e) => console.warn(`[plugins] inventory refresh failed: ${e instanceof Error ? e.name : typeof e}`));
}

/** Start the gateway's view: loads once, then refreshes on a timer. */
export async function startPluginInventory(src: InventorySources, opts: { intervalMs?: number } = {}): Promise<{ stop(): void }> {
  sources = src;
  await refreshPluginInventory(src).catch((e) => console.warn(`[plugins] first inventory load failed: ${e instanceof Error ? e.name : typeof e}`));
  const timer = setInterval(() => {
    void refreshPluginInventory(src).catch((e) => console.warn(`[plugins] inventory refresh failed: ${e instanceof Error ? e.name : typeof e}`));
  }, opts.intervalMs ?? REFRESH_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      if (sources === src) {
        sources = null;
        snapshot = EMPTY_SNAPSHOT;
      }
    },
  };
}

/** TEST SEAM: set the snapshot directly (null resets it). */
export function __setPluginInventorySnapshot(s: InventorySnapshot | null): void {
  snapshot = s ?? EMPTY_SNAPSHOT;
}
