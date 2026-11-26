/**
 * Which node holds which box image: the console's read-only view (box spec,
 * "Image build, pull and prewarm", "Report").
 *
 * Nodes that offer a sandbox report the digests they hold unpacked, and their
 * occupancy, on their heartbeat (a Redis key per node with the node TTL). This
 * module holds one derived, in-memory snapshot of those reports, refreshed on
 * a timer the way the plugin inventory is (src/gateway/core/plugin-inventory.ts):
 * purely derived, so any number of gateway replicas hold one with no
 * coordination, and a failed refresh keeps the last good snapshot for a
 * bounded time, then reads as empty rather than showing old state.
 *
 * Nothing routes on this snapshot. Dispatch reads the registry itself, at the
 * moment it decides.
 */
import type { NodeBoxReport } from "../../queue/registry";

export const BOX_INVENTORY_REFRESH_MS = 15_000;
export const BOX_INVENTORY_STALE_MS = 2 * 60_000;

export interface BoxNodeRow {
  node: string;
  labels: string[];
  /** `sha256:<digest>` of every image the node holds unpacked, sorted. */
  digests: string[];
  /** Sandboxes running, the most it runs at once, and its free slots; null until the node admits boxes. */
  running: number | null;
  capacity: number | null;
  free: number | null;
}

export interface BoxInventorySnapshot {
  nodes: BoxNodeRow[];
  /** digest to the nodes that hold it, each list sorted. */
  holders: Map<string, string[]>;
  at: number;
}

export const EMPTY_BOX_INVENTORY: BoxInventorySnapshot = { nodes: [], holders: new Map(), at: 0 };

/** Derive the snapshot from the live nodes' reports. Pure. */
export function deriveBoxInventory(live: ReadonlyArray<{ node: string; labels: readonly string[]; boxes: NodeBoxReport }>, at: number): BoxInventorySnapshot {
  const nodes: BoxNodeRow[] = live
    .map((n) => ({
      node: n.node,
      labels: [...n.labels].sort(),
      digests: [...new Set(n.boxes.digests)].sort(),
      running: n.boxes.running ?? null,
      capacity: n.boxes.capacity ?? null,
      free: n.boxes.free ?? null,
    }))
    .sort((a, b) => a.node.localeCompare(b.node));
  const holders = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of n.digests) {
      const list = holders.get(d) ?? [];
      list.push(n.node);
      holders.set(d, list);
    }
  }
  return { nodes, holders, at };
}

/** Occupancy of one label, summed over its nodes that report it: the "active sessions per node" autoscale signal, for the console. */
export function labelOccupancy(snap: BoxInventorySnapshot, label: string): { nodes: number; running: number; capacity: number; full: number } {
  const mine = snap.nodes.filter((n) => n.labels.includes(label) && n.capacity !== null);
  return {
    nodes: mine.length,
    running: mine.reduce((s, n) => s + (n.running ?? 0), 0),
    capacity: mine.reduce((s, n) => s + (n.capacity ?? 0), 0),
    full: mine.filter((n) => n.free === 0).length,
  };
}

let snapshot: BoxInventorySnapshot = EMPTY_BOX_INVENTORY;

/** The current snapshot, or the empty one when none was taken or the last is too old. */
export function currentBoxInventory(now = Date.now()): BoxInventorySnapshot {
  if (snapshot.at === 0 || now - snapshot.at > BOX_INVENTORY_STALE_MS) return EMPTY_BOX_INVENTORY;
  return snapshot;
}

export type BoxInventorySource = () => Promise<Array<{ node: string; labels: string[]; boxes: NodeBoxReport }>>;

/** Recompute from the source. Throws on a source failure (the caller logs). */
export async function refreshBoxInventory(source: BoxInventorySource, now = Date.now()): Promise<BoxInventorySnapshot> {
  snapshot = deriveBoxInventory(await source(), now);
  return snapshot;
}

/**
 * Start the view: one refresh now (a failure is logged, not thrown: the view
 * is for people, and a gateway must start without it) and one per interval.
 */
export async function startBoxInventory(source: BoxInventorySource, everyMs = BOX_INVENTORY_REFRESH_MS): Promise<{ stop(): void }> {
  const tick = () => refreshBoxInventory(source).catch((e: unknown) => console.warn(`[box] inventory refresh failed: ${e instanceof Error ? e.message : String(e)}`));
  await tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** TEST SEAM: forget the snapshot. */
export function __resetBoxInventoryForTests(): void {
  snapshot = EMPTY_BOX_INVENTORY;
}
