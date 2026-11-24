/**
 * Remote filesystem sync for a node (spec: docs/superpowers/specs/2026-11-18-remote-filesystem-sync.md).
 *
 * With SLAUDE_STORAGE=s3, a session's files do not live on a shared volume.
 * Under the session lock a node hydrates the session's workspace and its SDK
 * transcript directory from the object store onto pod-local disk, runs the
 * turn, and flushes back. Another node can then continue the session.
 *
 * Two sync units per session, each its own manifest series and fencing epoch:
 *   ws-<hash of the working dir>      the workspace
 *   tx-<hash of the transcript dir>   the SDK's projects/<encoded cwd> directory
 * They are keyed by directory, not session, because a proactive or channel
 * folder is shared by several sessions (and already serialised across nodes by
 * the workspace lock): keying by session would make two sessions overwrite each
 * other's copy. Sessions sharing a folder share one Unit object here too, so
 * they share one epoch, one retry and one flush queue.
 *
 * Flush failure never holds a lock. The unit is marked needs-flush in Redis,
 * this node keeps its local copy and retries; its next turn flushes before it
 * hydrates, so the newest copy is never overwritten by an older remote one.
 * Another node that finds the mark waits while the owner is alive and, once the
 * owner is gone, continues from the last committed manifest and counts the loss.
 *
 * A unit is never flushed from a tree that is not known to match what was
 * stored or what a turn wrote: a hydrate that fails half way clears the local
 * marker and drops the session from the tracked set, and a flush refuses a root
 * directory that is missing (the store would otherwise be told the tree is empty).
 *
 * A boxed session (spec: docs/superpowers/specs/2026-11-24-box-design.md, "Durability
 * and sync") has two more units, stored as packed archives instead of one object per file:
 *   wx-<hash of the working dir>-<image digest>   the workspace trees the ignore list skips
 *   hm-<session>                                  the sandbox's home directory
 * They follow the same lifecycle, epochs, marks and markers; only the flush and the
 * hydrate differ (`kind: "pack"`), and the file work is done by the packer, not here.
 * Order everywhere: tx, ws, wx, hm. When a boxed session goes idle its local copies
 * are kept ("parked") under a disk budget, so a return to this node hydrates nothing.
 * Without the `boxOf` and `packer` dependencies none of this exists.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../config/home";
import { personaConfigDir } from "../agent/oauth-home";
import { m as metric } from "../metrics";
import {
  FencedError,
  PackQuotaError,
  RootMissingError,
  drainInbox,
  encodeProjectDir,
  flushPack,
  flushTree,
  gcSession,
  hmUnitId,
  hydratePack,
  hydrateTree,
  isIgnored,
  readMarker,
  ignoreList,
  latestEpoch,
  latestManifest,
  syncStateDir,
  txUnitId,
  writeMarker,
  wsUnitId,
  wxUnitId,
  type ObjectStore,
  type PackPort,
  type PackUnitRef,
  type Root,
  type SyncFlush,
} from "../storage";
import type { Keys } from "../queue/keys";

export { encodeProjectDir };

/** How long a node waits for another, live node to flush before continuing from the last committed manifest. */
const WAIT_FOR_OWNER_MS = 120_000;
/** How long a unit counts as open after its last prepare or flush. A turn longer than this refreshes it at its flush. */
const IN_USE_TTL_MS = 30 * 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** A unit's old manifests and unreferenced blobs are swept every this many committed flushes. */
const GC_EVERY_FLUSHES = 10;
/** Sessions flushed at the same time by a drain of a node that runs boxes. */
const DRAIN_CONCURRENCY = 4;
/** Parked copies are dropped, least recently used first, while the volume has less free space than this. */
const MIN_FREE_DISK_MB = 1024;
const MB = 1024 * 1024;

/** What the sync needs to know about a boxed session. */
export interface BoxFacts {
  /** The pinned image digest: workspace extras are kept per image. */
  digest: string;
  /** The session's home directory on this node's disk. */
  homeDir: string;
  /** Home paths never packed (the box's `durable.exclude`). */
  exclude?: readonly string[];
  /** Soft limits. Over one: reported, the flush still happens. Over twice: the pack is refused. */
  homeMb?: number;
  extrasMb?: number;
}

export interface QuotaEvent {
  unitId: string;
  /** Warm sessions that hold the unit (none when it is flushed as its session goes idle). */
  sessionIds: string[];
  unit: "hm" | "wx";
  /** `over`: above the limit, still flushed. `refused`: above twice the limit, not flushed. */
  state: "over" | "refused";
  bytes: number;
  limitBytes: number;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface FsSyncDeps {
  store: ObjectStore;
  redis: RedisLike;
  keys: Keys;
  nodeId: string;
  flush: () => SyncFlush;
  /** The session's working directory (the gateway's row), or undefined when unknown. */
  workingDirOf: (sessionId: string) => Promise<string | undefined>;
  nodeAlive: (nodeId: string) => Promise<boolean>;
  /** Where local markers live; pod-local, outside every synced root. */
  stateDir?: string;
  ignore?: readonly string[];
  now?: () => number;
  /**
   * A session's box facts, or undefined for an unboxed session. With this and `packer`, a boxed session gets
   * the `wx` and `hm` units and is parked when it goes idle. Without either, nothing here changes.
   */
  boxOf?: (sessionId: string) => Promise<BoxFacts | undefined> | BoxFacts | undefined;
  /** Who walks, archives and applies the pack units' directories (the box supervisor). */
  packer?: PackPort;
  /** Where the packer's indexes live; the sync state directory by default. */
  packIndexDir?: string;
  /** Disk budget for parked copies. Default `SLAUDE_BOX_PARK_BUDGET_MB`; with neither, only free disk bounds them. */
  parkBudgetMb?: number;
  /** Free space on the volume that holds the local copies. With it, parked copies are dropped while it is below `minFreeDiskMb`. */
  freeDiskMb?: () => number | Promise<number>;
  minFreeDiskMb?: number;
  /** A flush was fenced: another node owns the unit. For a boxed session the caller stops the sandbox. */
  onFenced?: (unitId: string, sessionIds: string[]) => void;
  onQuota?: (e: QuotaEvent) => void;
  /** A session's local copies were parked (true), or are no longer parked: it resumed, or was dropped (false). */
  onPark?: (sessionId: string, parked: boolean) => void;
  drainConcurrency?: number;
}

interface PackInfo {
  label: "hm" | "wx";
  ref: PackUnitRef;
  /** The soft limit in bytes, when the box sets one. */
  limitBytes?: number;
}

interface Unit {
  id: string;
  /** `tree`: one object per file (tx, ws). `pack`: a few archives (wx, hm). */
  kind: "tree" | "pack";
  root: Root;
  epoch: number;
  markerPath: string;
  flushes: number;
  pack?: PackInfo;
  /** Bytes the unit held at its last flush or hydrate, when known (pack units). */
  bytes?: number;
  /** A flush was fenced since the unit was last prepared: another node owns it. */
  lost?: boolean;
}

interface Tracked {
  cwd: string;
  txDir: string;
  ws: Unit;
  tx: Unit;
  /** Boxed sessions only. */
  wx?: Unit;
  hm?: Unit;
}

/** A unit of a parked session, with what is needed to drop its local copy later (also after a restart). */
interface ParkedUnit {
  id: string;
  kind: "tree" | "pack";
  name: string;
  dir: string;
  bytes: number;
  pack?: PackInfo;
}

interface Parked {
  units: ParkedUnit[];
  lastUsed: number;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/** Bytes of the regular files under a directory, skipping what the ignore list names. Links are not followed. */
function dirBytes(dir: string, ignore: readonly string[]): number {
  let total = 0;
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (isIgnored(r, ignore)) continue;
      try {
        const st = lstatSync(join(abs, name));
        if (st.isDirectory()) walk(join(abs, name), r);
        else if (st.isFile()) total += st.size;
      } catch {
        /* gone since the listing */
      }
    }
  };
  walk(dir, "");
  return total;
}

interface Pending {
  unit: Unit;
  since: number;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Delete the local copy once the flush finally lands (the session was evicted meanwhile). */
  evict: boolean;
}

export class FsSync {
  readonly #d: FsSyncDeps;
  readonly #tracked = new Map<string, Tracked>();
  readonly #units = new Map<string, Unit>();
  readonly #pending = new Map<string, Pending>();
  /** Sessions between a turn's hydrate starting and its flush ending, counted per unit. */
  readonly #active = new Map<string, number>();
  readonly #chains = new Map<string, { tail: Promise<void> }>();
  /** Boxed sessions whose local copies stay on disk after they went idle, oldest use first when pruned. */
  #park: Map<string, Parked> | null = null;
  /** Boxed sessions that lost a unit to another node: at eviction their copies are discarded, not parked. */
  readonly #fenced = new Set<string>();
  #stopped = false;

  constructor(deps: FsSyncDeps) {
    this.#d = deps;
  }

  #now = (): number => (this.#d.now ?? Date.now)();
  #state = (): string => this.#d.stateDir ?? syncStateDir() ?? join(paths.home, ".sync-state");
  #ignore = (): readonly string[] => this.#d.ignore ?? ignoreList();

  /** One queue per unit: flushes, hydrates and retries of a directory never overlap. */
  #serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#chains.get(id);
    const run = before ? before.tail.then(fn) : fn();
    const slot = {
      tail: run.then(
        () => {},
        () => {},
      ),
    };
    this.#chains.set(id, slot);
    void slot.tail.then(() => {
      if (this.#chains.get(id) === slot) this.#chains.delete(id);
    });
    return run;
  }

  /** The base config home whose projects/ directory the SDK writes this persona's transcripts into. */
  #transcriptBase(persona: string): string {
    return persona && persona !== "default" ? personaConfigDir(persona) : process.env.CLAUDE_CONFIG_DIR?.trim() || paths.claudeConfig;
  }

  #unit(id: string, name: string, dir: string): Unit {
    let u = this.#units.get(id);
    if (!u) {
      u = { id, kind: "tree", root: { name, dir }, epoch: 0, markerPath: join(this.#state(), `${id}.json`), flushes: 0 };
      this.#units.set(id, u);
    }
    return u;
  }

  #markerOf = (unitId: string): string => join(this.#state(), `${unitId}.json`);
  #indexOf = (unitId: string): string => join(this.#d.packIndexDir ?? this.#state(), `${unitId}.index.json`);

  #packUnit(id: string, info: Omit<PackInfo, "ref"> & { dir: string; filter: PackUnitRef["filter"] }): Unit {
    let u = this.#units.get(id);
    if (!u) {
      u = { id, kind: "pack", root: { name: info.label, dir: info.dir }, epoch: 0, markerPath: this.#markerOf(id), flushes: 0 };
      this.#units.set(id, u);
    }
    // The filter and the limit follow the box definition, which can change between two turns of a warm unit.
    u.pack = { label: info.label, ref: { root: info.dir, filter: info.filter, indexPath: this.#indexOf(id) }, ...(info.limitBytes !== undefined ? { limitBytes: info.limitBytes } : {}) };
    return u;
  }

  #build(cwd: string, persona: string, sessionId?: string, box?: BoxFacts): Tracked {
    const real = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
    const txDir = join(this.#transcriptBase(persona), "projects", encodeProjectDir(real));
    const tr: Tracked = { cwd, txDir, ws: this.#unit(wsUnitId(cwd), "ws", cwd), tx: this.#unit(txUnitId(txDir), "tx", txDir) };
    if (box && sessionId !== undefined) {
      // The extras are exactly what the per-file unit skips, so the two split the workspace with no overlap and no gap.
      tr.wx = this.#packUnit(wxUnitId(cwd, box.digest), { label: "wx", dir: cwd, filter: { kind: "ignored", names: [...this.#ignore()] }, ...(box.extrasMb ? { limitBytes: box.extrasMb * MB } : {}) });
      tr.hm = this.#packUnit(hmUnitId(sessionId), { label: "hm", dir: box.homeDir, filter: { kind: "all", exclude: [...(box.exclude ?? [])] }, ...(box.homeMb ? { limitBytes: box.homeMb * MB } : {}) });
    }
    return tr;
  }

  /** A session's units in the order they are prepared and flushed: tx, ws, then wx and hm for a boxed session. */
  #unitsOf(tr: Tracked): Unit[] {
    const out = [tr.tx, tr.ws];
    if (tr.wx) out.push(tr.wx);
    if (tr.hm) out.push(tr.hm);
    return out;
  }

  #enter(tr: Tracked): void {
    for (const u of this.#unitsOf(tr)) this.#active.set(u.id, (this.#active.get(u.id) ?? 0) + 1);
  }

  #leave(tr: Tracked): void {
    for (const u of this.#unitsOf(tr)) {
      const n = (this.#active.get(u.id) ?? 1) - 1;
      if (n <= 0) this.#active.delete(u.id);
      else this.#active.set(u.id, n);
    }
  }

  #isActive(tr: Tracked): boolean {
    return this.#unitsOf(tr).some((u) => (this.#active.get(u.id) ?? 0) > 0);
  }

  /**
   * Under the session lock, before the turn: make this node's disk match the
   * stored state. "wait" means another live node holds unflushed edits: requeue.
   * On "ok" the caller must call afterTurn exactly once, even if the turn throws.
   */
  async beforeTurn(sessionId: string, persona: string): Promise<"ok" | "wait"> {
    const cwd = await this.#d.workingDirOf(sessionId);
    if (!cwd) return "ok";
    // The transcript directory is named after the directory's real path, so the directory must exist before it is
    // worked out. With remote storage nothing else has made it yet (the gateway leaves that to the node).
    if (!this.#tracked.has(sessionId)) {
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        /* the hydrate reports a directory it cannot make, with its own error */
      }
    }
    let tr = this.#tracked.get(sessionId);
    // A parked session is coming back: it is warm again, or (on "wait" or a failure below) parked again.
    let wasParked: Parked | undefined;
    if (!tr) {
      const box = this.#d.boxOf && this.#d.packer ? await this.#d.boxOf(sessionId) : undefined;
      tr = this.#build(cwd, persona, sessionId, box);
      wasParked = this.#unpark(sessionId, tr);
    }
    const repark = (): void => {
      if (wasParked) this.#setParked(sessionId, wasParked);
    };
    this.#enter(tr);
    try {
      for (const unit of this.#unitsOf(tr)) {
        if (unit.pack?.label === "wx") await this.#claimExtras(unit);
        if (unit.pack?.label === "hm") {
          try {
            mkdirSync(unit.root.dir, { recursive: true });
          } catch {
            /* the supervisor makes it when this process may not; a flush refuses a home that is still missing */
          }
        }
        if ((await this.#prepare(unit)) === "wait") {
          this.#leave(tr);
          repark();
          return "wait";
        }
      }
      try {
        const n = await drainInbox(this.#d.store, tr.ws.id, tr.ws.root.dir);
        if (n > 0) console.log(`[fs-sync] ${n} file(s) staged by the gateway written into ${tr.cwd}`);
      } catch (e) {
        // The turn can run without them; they stay in the box for the next one.
        console.error(`[fs-sync] could not take staged files for unit=${tr.ws.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      // A hydrate that died half way left a tree that matches neither state. Nothing may flush it: drop
      // the session, and make sure the next hydrate is a full one.
      this.#leave(tr);
      this.#tracked.delete(sessionId);
      for (const u of this.#unitsOf(tr)) {
        rmSync(u.markerPath, { force: true });
        if (u.pack) rmSync(u.pack.ref.indexPath, { force: true });
      }
      repark();
      throw e;
    }
    this.#tracked.set(sessionId, tr);
    return "ok";
  }

  /**
   * One directory holds the extras of one image at a time. Two sessions pinned to different images can share a
   * folder (one refreshed, one not), and their `wx` units differ, but the files sit in the same place. So the
   * directory has an owner, recorded beside the markers: when another unit takes it, the owner's edits are
   * flushed first, both units' markers and indexes are cleared (neither can call the directory its own copy any
   * more), and the old image's extras are deleted, so the hydrate that follows starts from what is stored for
   * this image, or from nothing. A directory with no recorded owner is adopted as it is.
   */
  async #claimExtras(unit: Unit): Promise<void> {
    const file = join(this.#state(), `wxown-${wsUnitId(unit.root.dir)}.json`);
    let owner: string | undefined;
    try {
      owner = (JSON.parse(readFileSync(file, "utf8")) as { unit?: string }).unit;
    } catch {
      owner = undefined;
    }
    if (owner === unit.id) return;
    if (owner !== undefined) {
      const other = this.#units.get(owner);
      if (other && (this.#sessionsOf(other.id).length > 0 || this.#pending.has(other.id))) {
        await this.#flushOrMark(other);
        if (this.#pending.has(other.id)) {
          // It could not be stored, and a retry after this point would store the other image's files under its name.
          metric.storageUnflushedLossTotal.inc();
          console.error(`[fs-sync] unflushed edits lost unit=${other.id}: its directory is taken by ${unit.id} and its flush failed`);
          await this.#clearPending(other);
        }
      }
      for (const id of [owner, unit.id]) {
        rmSync(this.#markerOf(id), { force: true });
        rmSync(this.#indexOf(id), { force: true });
      }
      await this.#d.packer!.clear(unit.pack!.ref);
      console.log(`[fs-sync] workspace extras in ${unit.root.dir} change image: ${owner} -> ${unit.id}`);
    }
    mkdirSync(this.#state(), { recursive: true });
    writeFileSync(file, JSON.stringify({ unit: unit.id }));
  }

  /** Tracked sessions that hold a unit. */
  #sessionsOf(unitId: string): string[] {
    const out: string[] = [];
    for (const [sid, t] of this.#tracked) if (this.#unitsOf(t).some((u) => u.id === unitId)) out.push(sid);
    return out;
  }

  /** True when the mark was left by this very disk and its marker names the newest stored manifest, so a warm hydrate keeps the local files. Any read failure counts as "no". */
  async #ownCopyIsCurrent(unit: Unit, markDisk: string | undefined): Promise<boolean> {
    try {
      // The marker only says this disk matches the store. The edits are here only if THIS disk is the one that left the mark;
      // a mark from another disk (the unit moved) or from before disks were identified means they are somewhere we cannot reach.
      if (markDisk === undefined || markDisk !== this.#diskId()) return false;
      const marker = readMarker(unit.markerPath);
      if (marker === null) return false;
      const latest = await latestManifest(this.#d.store, unit.id);
      return latest !== null && latest.id === marker;
    } catch {
      return false;
    }
  }

  #disk: string | null = null;
  /**
   * An id for THIS disk (the sync state directory), created once and kept with the markers. A needs-flush mark records it,
   * so a recreated process on the same disk can tell its own unflushed edits from edits that sit on some other disk.
   */
  #diskId(): string {
    if (this.#disk) return this.#disk;
    const file = join(this.#state(), "disk-id");
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return (this.#disk = existing);
    } catch {
      /* none yet */
    }
    const id = randomUUID();
    mkdirSync(this.#state(), { recursive: true });
    writeFileSync(file, id);
    return (this.#disk = id);
  }

  /** Tell the bucket sweeper this unit is open on this node. Refreshed at every prepare and flush, so it outlives a long turn. */
  async #markInUse(unit: Unit): Promise<void> {
    await this.#d.redis.set(this.#d.keys.fsInUse(unit.id), this.#d.nodeId, "PX", IN_USE_TTL_MS);
  }

  async #prepare(unit: Unit): Promise<"ok" | "wait"> {
    const { redis, keys, nodeId, store } = this.#d;
    await this.#markInUse(unit);
    const raw = await redis.get(keys.needsFlush(unit.id));
    let ownPending = false;
    if (raw) {
      let mark: { node?: string; since?: number; disk?: string } = {};
      try {
        mark = JSON.parse(raw);
      } catch {
        /* an unreadable mark is treated as stale */
      }
      if (mark.node === nodeId && this.#pending.has(unit.id)) {
        ownPending = true;
      } else if (mark.node && (await this.#d.nodeAlive(mark.node)) && this.#now() - (mark.since ?? 0) < WAIT_FOR_OWNER_MS) {
        return "wait";
      } else {
        // The node that held the newest copy is gone. A process recreated on the same disk still has those
        // edits: when its marker names the newest stored manifest the hydrate below is a warm no-op and the
        // next flush uploads them, so nothing is lost. Otherwise continue from the last committed manifest.
        if (await this.#ownCopyIsCurrent(unit, mark.disk)) {
          console.log(`[fs-sync] recovered local copy unit=${unit.id} previous-owner=${mark.node ?? "unknown"}`);
        } else {
          metric.storageUnflushedLossTotal.inc();
          console.error(`[fs-sync] unflushed edits lost unit=${unit.id} owner=${mark.node ?? "unknown"}: continuing from the last committed manifest`);
        }
        await redis.del(keys.needsFlush(unit.id));
      }
    }
    unit.lost = false;
    unit.epoch = await redis.incr(keys.fsEpoch(unit.id));
    // The counter lives in Redis, the manifests in the store. If Redis lost the counter (a restart
    // with no persistence), an epoch below what is stored would be fenced forever: start above it.
    const stored = await latestEpoch(store, unit.id);
    if (unit.epoch <= stored) {
      unit.epoch = stored + 1;
      await redis.set(keys.fsEpoch(unit.id), String(unit.epoch));
    }
    if (ownPending) {
      // Our local copy is the newest state: it goes to the store before anything is read back.
      await this.#flush(unit);
    }
    await this.#serial(unit.id, async () => {
      const t0 = this.#now();
      try {
        const h = unit.pack ? await this.#hydratePack(unit, unit.pack) : await hydrateTree(store, unit.id, [unit.root], { markerPath: unit.markerPath, ignore: this.#ignore() });
        metric.storageHydrateTotal.inc({ result: "ok", mode: h.mode === "cold" ? "cold" : "warm" });
        metric.storageHydrateBytesTotal.inc({}, h.downloadedBytes);
        metric.storageHydrateDuration.observe((this.#now() - t0) / 1000);
      } catch (e) {
        metric.storageHydrateTotal.inc({ result: "error", mode: "cold" });
        metric.storageRequestErrorsTotal.inc({ op: "get" });
        throw e;
      }
    });
    return "ok";
  }

  async #hydratePack(unit: Unit, pack: PackInfo): Promise<{ mode: "warm" | "cold" | "empty"; downloadedBytes: number }> {
    const packer = this.#d.packer!;
    const t0 = this.#now();
    const h = await hydratePack(this.#d.store, unit.id, { markerPath: unit.markerPath, spoolDir: packer.spoolDir, apply: (req) => packer.apply(pack.ref, req) });
    if (h.liveBytes !== undefined) unit.bytes = h.liveBytes;
    // A warm hydrate (the marker is current, nothing is read) is not a measurement of the store.
    if (h.mode === "cold") {
      metric.boxPackSeconds.observe((this.#now() - t0) / 1000, { unit: pack.label, op: "hydrate" });
      metric.boxPackBytesTotal.inc({ unit: pack.label, op: "hydrate" }, h.downloadedBytes);
    }
    return h;
  }

  /** Commit one unit, one at a time per unit. Throws FencedError when a newer epoch owns it, anything else on a store failure. */
  #flush(unit: Unit): Promise<void> {
    return this.#serial(unit.id, () => this.#flushNow(unit));
  }

  async #flushNow(unit: Unit): Promise<void> {
    const { store, redis, keys } = this.#d;
    await this.#markInUse(unit).catch(() => {}); // best effort: a failed mark must not fail the flush
    const t0 = this.#now();
    try {
      const isCurrent = async (): Promise<boolean> => (await redis.get(keys.fsEpoch(unit.id))) === String(unit.epoch);
      const r = unit.pack ? await this.#flushPack(unit, unit.pack, isCurrent) : await flushTree(store, unit.id, [unit.root], { epoch: unit.epoch, isCurrent, ignore: this.#ignore() });
      writeMarker(unit.markerPath, r.id);
      metric.storageFlushTotal.inc({ result: "ok" });
      metric.storageFlushBytesTotal.inc({}, r.uploadedBytes);
      metric.storageFlushDuration.observe((this.#now() - t0) / 1000);
      await this.#clearPending(unit);
      // A compaction leaves every earlier layer unreferenced by the newest manifest: sweep then too.
      const compacted = unit.pack !== undefined && "full" in r && r.full && unit.flushes > 0;
      if (r.changed && (++unit.flushes % GC_EVERY_FLUSHES === 0 || compacted)) {
        // Old manifests and the blobs only they referenced. Best effort: a failure costs space, not data.
        void gcSession(store, unit.id, { keep: 5 }).catch((e) => console.error(`[fs-sync] gc failed unit=${unit.id}: ${e instanceof Error ? e.message : String(e)}`));
      }
    } catch (e) {
      if (e instanceof FencedError) metric.storageFlushTotal.inc({ result: "fenced" });
      else if (!(e instanceof RootMissingError) && !(e instanceof PackQuotaError)) {
        metric.storageFlushTotal.inc({ result: "error" });
        metric.storageRequestErrorsTotal.inc({ op: "put" });
      }
      throw e;
    }
  }

  async #flushPack(unit: Unit, pack: PackInfo, isCurrent: () => Promise<boolean>) {
    const packer = this.#d.packer!;
    const t0 = this.#now();
    const r = await flushPack(this.#d.store, unit.id, {
      epoch: unit.epoch,
      isCurrent,
      pack: (req) => packer.pack(pack.ref, req),
      ...(pack.limitBytes !== undefined ? { maxLiveBytes: 2 * pack.limitBytes } : {}),
    });
    metric.boxPackSeconds.observe((this.#now() - t0) / 1000, { unit: pack.label, op: "flush" });
    metric.boxPackBytesTotal.inc({ unit: pack.label, op: "flush" }, r.uploadedBytes);
    if (r.liveBytes !== undefined) {
      if (pack.label === "hm") metric.boxHomeBytes.observe(r.liveBytes);
      unit.bytes = r.liveBytes;
      if (pack.limitBytes !== undefined && r.liveBytes > pack.limitBytes) this.#quota(unit, pack, "over", r.liveBytes);
    }
    return r;
  }

  #quota(unit: Unit, pack: PackInfo, state: QuotaEvent["state"], bytes: number): void {
    metric.boxQuotaExceededTotal.inc({ kind: pack.label === "hm" ? "home" : "extras", state });
    try {
      this.#d.onQuota?.({ unitId: unit.id, sessionIds: this.#sessionsOf(unit.id), unit: pack.label, state, bytes, limitBytes: pack.limitBytes ?? 0 });
    } catch {
      /* a notice that could not be sent never fails a flush */
    }
  }

  /** Another node owns the unit. A pack unit's marker and index go: this copy is not a base for anything any more. */
  #lost(unit: Unit): void {
    const sessions = this.#sessionsOf(unit.id);
    unit.lost = true;
    if (unit.pack) {
      rmSync(unit.markerPath, { force: true });
      rmSync(unit.pack.ref.indexPath, { force: true });
    }
    for (const sid of sessions) if (this.#tracked.get(sid)?.hm) this.#fenced.add(sid);
    try {
      this.#d.onFenced?.(unit.id, sessions);
    } catch {
      /* the caller's reaction never fails the sync */
    }
  }

  /** Flush a unit, never throwing: a failure marks it needs-flush and schedules a retry. */
  async #flushOrMark(unit: Unit): Promise<boolean> {
    try {
      await this.#flush(unit);
      return true;
    } catch (e) {
      if (e instanceof FencedError) {
        console.error(`[fs-sync] flush fenced unit=${unit.id}: another node owns it now; this copy is discarded`);
        await this.#clearPending(unit);
        this.#lost(unit);
        return false;
      }
      if (e instanceof PackQuotaError) {
        // Over twice its limit: not stored, and a retry cannot help until space is freed. The session keeps working on its local copy.
        console.error(`[fs-sync] ${unit.id}: ${e.message}`);
        await this.#clearPending(unit);
        if (unit.pack) this.#quota(unit, unit.pack, "refused", e.liveBytes);
        return false;
      }
      if (e instanceof RootMissingError) {
        // Nothing to write: the directory is gone. Retrying cannot help, and the store must not be told it is empty.
        console.error(`[fs-sync] ${e.message}`);
        return false;
      }
      console.error(`[fs-sync] flush failed unit=${unit.id}: ${e instanceof Error ? e.message : String(e)}`);
      await this.#markPending(unit);
      return false;
    }
  }

  async #markPending(unit: Unit): Promise<void> {
    const { redis, keys, nodeId } = this.#d;
    const prior = this.#pending.get(unit.id);
    const since = prior?.since ?? this.#now();
    const p: Pending = { unit, since, attempts: prior?.attempts ?? 0, evict: prior?.evict ?? false, ...(prior?.timer ? { timer: prior.timer } : {}) };
    this.#pending.set(unit.id, p);
    try {
      await redis.set(keys.needsFlush(unit.id), JSON.stringify({ node: nodeId, since, disk: this.#diskId() }), "EX", 7 * 24 * 3600);
    } catch (e) {
      console.error(`[fs-sync] could not record needs-flush unit=${unit.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.#gauges();
    if (!p.timer && !this.#stopped) this.#schedule(p);
  }

  #schedule(p: Pending): void {
    const delay = Math.min(RETRY_BASE_MS * 2 ** p.attempts, RETRY_MAX_MS);
    p.timer = setTimeout(() => {
      p.timer = undefined;
      p.attempts++;
      void this.#retry(p);
    }, delay);
    p.timer.unref?.();
  }

  async #retry(p: Pending): Promise<void> {
    if (this.#stopped || this.#pending.get(p.unit.id) !== p) return;
    this.#gauges(); // the age gauge moves with time, not only with state changes
    try {
      await this.#flush(p.unit);
      if (p.evict) {
        if (p.unit.kind === "tree") this.#dropLocal(p.unit);
        else await this.#dropPack(p.unit);
      }
    } catch (e) {
      if (e instanceof FencedError) {
        console.error(`[fs-sync] retry fenced unit=${p.unit.id}: another node continued without these edits`);
        await this.#clearPending(p.unit);
        this.#lost(p.unit);
        return;
      }
      if (e instanceof RootMissingError || e instanceof PackQuotaError) {
        await this.#clearPending(p.unit);
        return;
      }
      if (this.#pending.get(p.unit.id) === p) this.#schedule(p);
    }
  }

  /** Forget this node's pending flush of a unit, and delete the Redis mark only if it is this node's own. */
  async #clearPending(unit: Unit): Promise<void> {
    const p = this.#pending.get(unit.id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.#pending.delete(unit.id);
    try {
      const raw = await this.#d.redis.get(this.#d.keys.needsFlush(unit.id));
      let owner: string | undefined;
      try {
        owner = raw ? (JSON.parse(raw) as { node?: string }).node : undefined;
      } catch {
        owner = undefined;
      }
      // Another node may have taken the unit and set its own mark since: never delete that one.
      if (raw && (owner === this.#d.nodeId || owner === undefined)) await this.#d.redis.del(this.#d.keys.needsFlush(unit.id));
    } catch {
      /* the key expires */
    }
    this.#gauges();
  }

  #gauges(): void {
    metric.storageFlushPending.set(this.#pending.size);
    let oldest = 0;
    for (const p of this.#pending.values()) oldest = Math.max(oldest, (this.#now() - p.since) / 1000);
    metric.storageFlushPendingAge.set(oldest);
  }

  /**
   * After the turn, still under the lock (call it from a `finally`, even when the turn threw). A lost
   * lock means another node owns the unit: flush nothing.
   */
  async afterTurn(sessionId: string, lockLost: boolean): Promise<void> {
    const tr = this.#tracked.get(sessionId);
    if (!tr) return;
    try {
      if (lockLost) {
        // Another node may own the session now: a boxed session's copies are not parked on this evidence.
        if (tr.hm) this.#fenced.add(sessionId);
        return;
      }
      // The transcript flushes every turn whatever the cadence: conversation history is the last thing to risk.
      await this.#flushOrMark(tr.tx);
      if (this.#d.flush() === "turn") {
        await this.#flushOrMark(tr.ws);
        // The packed units flush when the workspace does. An unchanged one costs a walk and writes nothing.
        if (tr.wx) await this.#flushOrMark(tr.wx);
        if (tr.hm) await this.#flushOrMark(tr.hm);
      }
    } finally {
      this.#leave(tr);
    }
  }

  /** The session is no longer warm here: flush everything, then free the disk. Never throws. */
  async evict(sessionId: string): Promise<void> {
    const tr = this.#tracked.get(sessionId);
    if (!tr) return;
    // A turn is starting or running in this directory (the session came back, or a sibling in the
    // same folder is working): it is not idle, so there is nothing to evict.
    if (this.#isActive(tr)) return;
    this.#tracked.delete(sessionId);
    if (tr.hm) return this.#evictBoxed(sessionId, tr);
    for (const unit of [tr.tx, tr.ws]) {
      const ok = await this.#flushOrMark(unit);
      if (ok) this.#dropLocal(unit);
      else {
        const p = this.#pending.get(unit.id);
        if (p) p.evict = true;
      }
    }
  }

  /**
   * A boxed session went idle: flush its four units and keep the local copies (it is "parked"), so a return to
   * this node finds every marker current and hydrates nothing. A unit whose flush failed keeps its copy and its
   * retry, as for any session. A session that lost a unit or its lock to another node is not parked: what
   * could be flushed is, and the copies are deleted.
   */
  async #evictBoxed(sessionId: string, tr: Tracked): Promise<void> {
    const units = this.#unitsOf(tr);
    for (const unit of units) await this.#flushOrMark(unit);
    const fenced = this.#fenced.delete(sessionId);
    if (fenced || units.some((u) => u.lost)) {
      for (const unit of units) {
        const p = this.#pending.get(unit.id);
        if (p) p.evict = true;
        else if (unit.kind === "tree") this.#dropLocal(unit);
        else await this.#dropPack(unit);
      }
      return;
    }
    this.#setParked(sessionId, { lastUsed: this.#now(), units: units.map((u) => this.#parkedUnit(u)) });
    try {
      this.#d.onPark?.(sessionId, true);
    } catch {
      /* the hint is best effort */
    }
    await this.prune();
  }

  #parkedUnit(u: Unit): ParkedUnit {
    const bytes = u.pack ? (u.bytes ?? 0) : dirBytes(u.root.dir, u.root.name === "ws" ? this.#ignore() : []);
    return { id: u.id, kind: u.kind, name: u.root.name, dir: u.root.dir, bytes, ...(u.pack ? { pack: u.pack } : {}) };
  }

  #parkFile = (): string => join(this.#state(), "parked.json");

  /** The park table, read once from the state directory: a recreated process on the same disk still accounts for what an earlier one left. */
  #parkTable(): Map<string, Parked> {
    if (this.#park) return this.#park;
    this.#park = new Map();
    if (!this.#d.boxOf || !this.#d.packer) return this.#park;
    try {
      const raw = JSON.parse(readFileSync(this.#parkFile(), "utf8")) as { sessions?: Record<string, Parked> };
      for (const [sid, p] of Object.entries(raw.sessions ?? {})) if (Array.isArray(p.units) && typeof p.lastUsed === "number") this.#park.set(sid, p);
    } catch {
      /* none yet, or unreadable: copies it named are found again when their sessions return, or age out with the disk */
    }
    return this.#park;
  }

  #saveParked(): void {
    try {
      mkdirSync(this.#state(), { recursive: true });
      const tmp = `${this.#parkFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(this.#parkTable()) }));
      renameSync(tmp, this.#parkFile());
    } catch (e) {
      console.error(`[fs-sync] could not record the park table: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  #setParked(sessionId: string, p: Parked): void {
    this.#parkTable().set(sessionId, p);
    this.#saveParked();
  }

  /** Take a returning session out of the park table, handing what is known of its units' sizes to the new ones. */
  #unpark(sessionId: string, tr: Tracked): Parked | undefined {
    if (!tr.hm) return undefined;
    const p = this.#parkTable().get(sessionId);
    if (!p) return undefined;
    this.#parkTable().delete(sessionId);
    this.#saveParked();
    for (const u of this.#unitsOf(tr)) {
      const known = p.units.find((x) => x.id === u.id);
      if (known && u.pack && u.bytes === undefined) u.bytes = known.bytes;
    }
    try {
      this.#d.onPark?.(sessionId, false);
    } catch {
      /* the hint is best effort */
    }
    return p;
  }

  /** Sessions whose local copies are parked on this node. */
  parked(): string[] {
    return [...this.#parkTable().keys()];
  }

  /** Bytes the parked copies hold, a unit shared by several sessions counted once. */
  parkedBytes(): number {
    const seen = new Map<string, number>();
    for (const p of this.#parkTable().values()) for (const u of p.units) seen.set(u.id, u.bytes);
    let n = 0;
    for (const b of seen.values()) n += b;
    return n;
  }

  /**
   * Drop parked copies, least recently used first, while they exceed the budget or the disk is short. A parked
   * session is flushed already, so dropping one is a delete; one with a flush still pending is never dropped.
   * Runs after every park; call it from a timer too, since free disk moves on its own. Returns the sessions dropped.
   */
  async prune(): Promise<string[]> {
    const dropped: string[] = [];
    const env = Number(process.env.SLAUDE_BOX_PARK_BUDGET_MB);
    const budgetMb = this.#d.parkBudgetMb ?? (Number.isFinite(env) && env >= 0 && process.env.SLAUDE_BOX_PARK_BUDGET_MB?.trim() ? env : undefined);
    const minFree = this.#d.minFreeDiskMb ?? MIN_FREE_DISK_MB;
    for (;;) {
      const table = this.#parkTable();
      if (table.size === 0) break;
      const over = budgetMb !== undefined && this.parkedBytes() > budgetMb * MB;
      let short = false;
      if (!over && this.#d.freeDiskMb) {
        try {
          short = (await this.#d.freeDiskMb()) < minFree;
        } catch {
          short = false;
        }
      }
      if (!over && !short) break;
      const victim = [...table.entries()].filter(([, p]) => !p.units.some((u) => this.#pending.has(u.id))).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!victim) break;
      await this.dropParked(victim[0]);
      dropped.push(victim[0]);
    }
    return dropped;
  }

  /** Delete one parked session's local copies (those no other session on this node still uses). Never throws. */
  async dropParked(sessionId: string): Promise<void> {
    const p = this.#parkTable().get(sessionId);
    if (!p) return;
    this.#parkTable().delete(sessionId);
    this.#saveParked();
    for (const pu of p.units) {
      const unit: Unit = this.#units.get(pu.id) ?? { id: pu.id, kind: pu.kind, root: { name: pu.name, dir: pu.dir }, epoch: 0, markerPath: this.#markerOf(pu.id), flushes: 0, ...(pu.pack ? { pack: pu.pack } : {}) };
      if (this.#pending.has(unit.id)) continue;
      if (unit.kind === "tree") this.#dropLocal(unit);
      else await this.#dropPack(unit);
    }
    console.log(`[fs-sync] parked copy dropped session=${sessionId}`);
    try {
      this.#d.onPark?.(sessionId, false);
    } catch {
      /* the hint is best effort */
    }
  }

  /** True when a session on this node, warm or parked, still holds the unit, or a turn is using it. */
  #held(unitId: string): boolean {
    if ((this.#active.get(unitId) ?? 0) > 0) return true;
    for (const t of this.#tracked.values()) if (this.#unitsOf(t).some((u) => u.id === unitId)) return true;
    if (this.#park) for (const p of this.#park.values()) if (p.units.some((u) => u.id === unitId)) return true;
    return false;
  }

  /** Delete a pack unit's local copy unless something on this node still holds it. The packer does the file work. Never throws. */
  async #dropPack(unit: Unit): Promise<void> {
    if (this.#held(unit.id) || !unit.pack || !this.#d.packer) return;
    const { label, ref } = unit.pack;
    try {
      if (label === "hm") {
        // The session leaves this node: the paths its box keeps out of the packs go with the rest.
        await this.#d.packer.clear({ ...ref, filter: { kind: "all", exclude: [] } });
        try {
          rmdirSync(unit.root.dir);
        } catch {
          /* not empty, or not this process's to remove: the supervisor sweeps session directories */
        }
      } else {
        const ownerFile = join(this.#state(), `wxown-${wsUnitId(unit.root.dir)}.json`);
        let owner: string | undefined;
        try {
          owner = (JSON.parse(readFileSync(ownerFile, "utf8")) as { unit?: string }).unit;
        } catch {
          owner = undefined;
        }
        // Only the image that owns the directory's extras deletes them; another image's files are not this unit's copy.
        if (owner === unit.id) {
          await this.#d.packer.clear(ref);
          rmSync(ownerFile, { force: true });
        }
      }
    } catch (e) {
      console.error(`[fs-sync] could not free the local copy of unit=${unit.id}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    rmSync(unit.markerPath, { force: true });
    rmSync(ref.indexPath, { force: true });
    this.#units.delete(unit.id);
  }

  /** Delete a unit's local copy unless a tracked session still works in it or a turn is using it. */
  #dropLocal(unit: Unit): void {
    if (this.#held(unit.id)) return;
    // What is stored is safe already (the flush succeeded), so a leftover the node may not delete, such as a file
    // an earlier root process wrote into a shared directory, costs disk, never the turn: log it and move on.
    try {
      rmSync(unit.root.dir, { recursive: true, force: true });
    } catch (e) {
      // The copy is still there, so the marker that says what it matches stays too: dropping it would make the next
      // hydrate treat a leftover tree as unknown.
      console.error(`[fs-sync] could not free the local copy of unit=${unit.id}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    rmSync(unit.markerPath, { force: true });
    this.#units.delete(unit.id);
  }

  /** Graceful stop: flush everything warm once, stop retrying. */
  async drain(): Promise<void> {
    // A node that runs boxes flushes several sessions at a time: a drain window has to fit every warm box. Units
    // shared by two sessions still flush one at a time (the per-unit queue), and the second flush finds nothing to do.
    const n = this.#d.boxOf && this.#d.packer ? Math.max(1, this.#d.drainConcurrency ?? DRAIN_CONCURRENCY) : 1;
    await pool([...this.#tracked.entries()], n, async ([sessionId, tr]) => {
      let ok = true;
      for (const unit of this.#unitsOf(tr)) ok = (await this.#flushOrMark(unit)) && ok;
      // The copies stay on this disk. If the process comes back on it, they are accounted for like any parked copy.
      if (tr.hm && ok && !this.#fenced.has(sessionId)) this.#setParked(sessionId, { lastUsed: this.#now(), units: this.#unitsOf(tr).map((u) => this.#parkedUnit(u)) });
    });
    for (const p of this.#pending.values()) await this.#flushOrMark(p.unit);
    this.stop();
  }

  stop(): void {
    this.#stopped = true;
    for (const p of this.#pending.values()) if (p.timer) clearTimeout(p.timer);
  }

  /** Sessions this node currently tracks (tests and the heartbeat's warm set). */
  tracked(): string[] {
    return [...this.#tracked.keys()];
  }
}
