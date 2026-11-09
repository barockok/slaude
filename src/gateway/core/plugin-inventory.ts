/**
 * The gateway's view of the plugin inventory (design:
 * docs/superpowers/specs/2026-11-09-plugin-inventory.md).
 *
 * `bridgeExternalMcp` is synchronous and read per request, the inventory lives
 * in the database, and liveness in Redis. So this module holds one derived,
 * in-memory snapshot, recomputed from those shared sources:
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
 *
 * Each row is one node process: liveness is that process's own heartbeat, so a
 * process that failed to report never inherits the previous process's servers.
 */
import { deleteNodePluginInstances, listNodePlugins, type NodePluginsRow } from "../../db/node-plugins";
import {
  STATE_DNS_PENDING,
  STATE_INVALID_URL,
  STATE_OFFERABLE,
  STATE_REFUSED_POLICY,
  STATE_URL_SECRETS,
  isSealedState,
  sanitizeServerUrl,
  urlCarriesSecrets,
  type ReportedHttpServer,
  type ReportedPlugin,
} from "../../config/plugin-inventory";
import { checkOutbound, OutboundBlockedError, type OutboundPolicyOptions } from "../../net/outbound-policy";
import { dbRevocationSource } from "../auth/node-credential";

export const REFRESH_MS = 15_000;
export const STALE_AFTER_MS = 5 * 60_000;
/** A new process's row is not live until its first heartbeat: never prune it sooner. */
export const PRUNE_GRACE_MS = 10 * 60_000;

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
  /** label → names whose sealed reports differ on the URL (neither bridged nor offered). */
  conflicts: Map<string, Set<string>>;
  /** label → offered names an unsealed report disagrees with (a console warning only). */
  unsealedDisagreements: Map<string, Set<string>>;
  at: number;
}

export const EMPTY_SNAPSHOT: InventorySnapshot = { servers: new Map(), conflicts: new Map(), unsealedDisagreements: new Map(), at: 0 };

const bucket = <V>(m: Map<string, V>, k: string, make: () => V): V => {
  let v = m.get(k);
  if (!v) {
    v = make();
    m.set(k, v);
  }
  return v;
};

/**
 * Derive the snapshot from each process's report and the set of live process
 * ids. Per label: a name is offered when a live process lists it offerable and
 * every SEALED report of it agrees on the URL. An unsealed report cannot create
 * a conflict, so an agent-writable plugin cannot veto a sealed server; its
 * disagreement is surfaced as a console warning instead.
 */
export function computeSnapshot(rows: readonly NodePluginsRow[], live: ReadonlySet<string>, now = Date.now()): InventorySnapshot {
  const seen = new Map<string, Map<string, { sealed: Set<string>; unsealed: Set<string>; offerable: string | null }>>();
  for (const row of rows) {
    if (!live.has(row.instance)) continue;
    for (const label of row.labels) {
      const names = bucket(seen, label, () => new Map());
      for (const plugin of row.report.plugins as ReportedPlugin[]) {
        for (const s of plugin.http) {
          if (!s.url) continue;
          const e = bucket(names, s.name, () => ({ sealed: new Set<string>(), unsealed: new Set<string>(), offerable: null as string | null }));
          (isSealedState(s.state) ? e.sealed : e.unsealed).add(s.url);
          if (s.state === STATE_OFFERABLE && e.offerable === null) e.offerable = plugin.name;
        }
      }
    }
  }
  const servers = new Map<string, Map<string, PluginBridgeServer>>();
  const conflicts = new Map<string, Set<string>>();
  const unsealedDisagreements = new Map<string, Set<string>>();
  for (const [label, names] of seen) {
    for (const [name, e] of names) {
      if (e.sealed.size > 1) {
        bucket(conflicts, label, () => new Set()).add(name);
      } else if (e.offerable) {
        const url = [...e.sealed][0]!;
        bucket(servers, label, () => new Map()).set(name, { type: "http", url, fromPlugin: e.offerable });
        if ([...e.unsealed].some((u) => u !== url)) bucket(unsealedDisagreements, label, () => new Set()).add(name);
      }
    }
  }
  return { servers, conflicts, unsealedDisagreements, at: now };
}

/** A claimed-offerable server's state after the checks only the gateway can run. */
export async function guardHttpServer(s: ReportedHttpServer, policy: OutboundPolicyOptions): Promise<ReportedHttpServer> {
  const url = sanitizeServerUrl(s.url);
  if (s.state !== STATE_OFFERABLE) return { ...s, url };
  if (urlCarriesSecrets(s.url)) return { ...s, url, state: STATE_URL_SECRETS };
  if (!url || !url.startsWith("https://")) return { ...s, url, state: STATE_INVALID_URL };
  try {
    await checkOutbound(url, policy);
  } catch (e) {
    if (e instanceof OutboundBlockedError) return { ...s, url, state: e.kind === "unresolved" ? STATE_DNS_PENDING : STATE_REFUSED_POLICY };
    throw e;
  }
  return { ...s, url };
}

export interface InventorySources {
  rows: () => Promise<NodePluginsRow[]>;
  /** Of these process ids, the ones with a live heartbeat. */
  live: (instances: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Unix seconds before which a credential's reports are void; null = not
   *  revoked, undefined = this database cannot revoke (sqlite). */
  revokedBefore?: (nodeId: string) => Promise<number | null | undefined>;
  /** Remove process rows no longer worth keeping. */
  remove?: (instances: readonly string[]) => Promise<void>;
  policy?: OutboundPolicyOptions;
}

/** The sources over the real database and a node registry. */
export function dbInventorySources(liveNodeIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>): InventorySources {
  return { rows: listNodePlugins, live: liveNodeIds, revokedBefore: dbRevocationSource, remove: deleteNodePluginInstances };
}

/** Re-evaluate servers whose host did not resolve at report time, in memory
 *  only: DNS trouble must not stick until the node next rolls. */
async function resolvePending(rows: NodePluginsRow[], live: ReadonlySet<string>, policy: OutboundPolicyOptions): Promise<NodePluginsRow[]> {
  const verdicts = new Map<string, Promise<ReportedHttpServer["state"]>>();
  const verdict = (s: ReportedHttpServer) => {
    let v = verdicts.get(s.url);
    if (!v) {
      v = guardHttpServer({ ...s, state: STATE_OFFERABLE }, policy).then((r) => r.state);
      verdicts.set(s.url, v);
    }
    return v;
  };
  return Promise.all(
    rows.map(async (row) => {
      if (!live.has(row.instance) || !row.report.plugins.some((p) => p.http.some((s) => s.state === STATE_DNS_PENDING))) return row;
      const plugins = await Promise.all(
        row.report.plugins.map(async (p) => ({
          ...p,
          http: await Promise.all(p.http.map(async (s) => (s.state === STATE_DNS_PENDING ? { ...s, state: await verdict(s) } : s))),
        })),
      );
      return { ...row, report: { ...row.report, plugins } };
    }),
  );
}

export interface LoadedInventory {
  rows: NodePluginsRow[];
  live: ReadonlySet<string>;
  /** Rows of a revoked credential, excluded from `rows`. */
  revoked: string[];
}

/** Rows that still count, with their liveness and DNS re-evaluated. A failing
 *  revocation source throws: an unknown revocation must not offer. */
export async function loadInventory(src: InventorySources): Promise<LoadedInventory> {
  const all = await src.rows();
  const before = new Map<string, number | null | undefined>();
  for (const id of new Set(all.map((r) => r.nodeId))) before.set(id, await src.revokedBefore?.(id));
  const isRevoked = (r: NodePluginsRow) => {
    const b = before.get(r.nodeId);
    return b !== null && b !== undefined && r.reportedAt < b * 1000;
  };
  const kept = all.filter((r) => !isRevoked(r));
  const live = await src.live(kept.map((r) => r.instance));
  return { rows: await resolvePending(kept, live, src.policy ?? {}), live, revoked: all.filter(isRevoked).map((r) => r.instance) };
}

/** Process rows to drop: past the grace, not live, and either a sibling of the
 *  same credential is live or a newer offline row stands for that credential
 *  (the console keeps the last report of an offline node). */
export function prunableInstances(rows: readonly NodePluginsRow[], live: ReadonlySet<string>, now = Date.now()): string[] {
  const byNode = new Map<string, NodePluginsRow[]>();
  for (const r of rows) bucket(byNode, r.nodeId, () => []).push(r);
  const out: string[] = [];
  for (const group of byNode.values()) {
    const anyLive = group.some((r) => live.has(r.instance));
    const newest = group.reduce((a, b) => (b.reportedAt > a.reportedAt ? b : a));
    for (const r of group) {
      if (live.has(r.instance) || now - r.reportedAt < PRUNE_GRACE_MS) continue;
      if (anyLive || r !== newest) out.push(r.instance);
    }
  }
  return out;
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
  const { rows, live, revoked } = await loadInventory(src);
  snapshot = computeSnapshot(rows, live);
  // Housekeeping, idempotent across replicas; its failure must not cost the view.
  const drop = [...revoked, ...prunableInstances(rows, live)];
  if (drop.length > 0 && src.remove) {
    await src.remove(drop).catch((e) => console.warn(`[plugins] inventory prune failed: ${e instanceof Error ? e.name : typeof e}`));
  }
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
