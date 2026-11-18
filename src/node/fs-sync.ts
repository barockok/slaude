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
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../config/home";
import { personaConfigDir } from "../agent/oauth-home";
import { m as metric } from "../metrics";
import {
  FencedError,
  RootMissingError,
  drainInbox,
  encodeProjectDir,
  flushTree,
  gcSession,
  hydrateTree,
  ignoreList,
  latestEpoch,
  syncStateDir,
  txUnitId,
  writeMarker,
  wsUnitId,
  type ObjectStore,
  type Root,
  type SyncFlush,
} from "../storage";
import type { Keys } from "../queue/keys";

export { encodeProjectDir };

/** How long a node waits for another, live node to flush before continuing from the last committed manifest. */
const WAIT_FOR_OWNER_MS = 120_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** A unit's old manifests and unreferenced blobs are swept every this many committed flushes. */
const GC_EVERY_FLUSHES = 10;

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
}

interface Unit {
  id: string;
  root: Root;
  epoch: number;
  markerPath: string;
  flushes: number;
}

interface Tracked {
  cwd: string;
  txDir: string;
  ws: Unit;
  tx: Unit;
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
      u = { id, root: { name, dir }, epoch: 0, markerPath: join(this.#state(), `${id}.json`), flushes: 0 };
      this.#units.set(id, u);
    }
    return u;
  }

  #build(cwd: string, persona: string): Tracked {
    const real = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
    const txDir = join(this.#transcriptBase(persona), "projects", encodeProjectDir(real));
    return { cwd, txDir, ws: this.#unit(wsUnitId(cwd), "ws", cwd), tx: this.#unit(txUnitId(txDir), "tx", txDir) };
  }

  #enter(tr: Tracked): void {
    for (const u of [tr.ws, tr.tx]) this.#active.set(u.id, (this.#active.get(u.id) ?? 0) + 1);
  }

  #leave(tr: Tracked): void {
    for (const u of [tr.ws, tr.tx]) {
      const n = (this.#active.get(u.id) ?? 1) - 1;
      if (n <= 0) this.#active.delete(u.id);
      else this.#active.set(u.id, n);
    }
  }

  #isActive(tr: Tracked): boolean {
    return (this.#active.get(tr.ws.id) ?? 0) > 0 || (this.#active.get(tr.tx.id) ?? 0) > 0;
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
    const tr = this.#tracked.get(sessionId) ?? this.#build(cwd, persona);
    this.#enter(tr);
    try {
      for (const unit of [tr.tx, tr.ws]) {
        if ((await this.#prepare(unit)) === "wait") {
          this.#leave(tr);
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
      for (const u of [tr.ws, tr.tx]) rmSync(u.markerPath, { force: true });
      throw e;
    }
    this.#tracked.set(sessionId, tr);
    return "ok";
  }

  async #prepare(unit: Unit): Promise<"ok" | "wait"> {
    const { redis, keys, nodeId, store } = this.#d;
    const raw = await redis.get(keys.needsFlush(unit.id));
    let ownPending = false;
    if (raw) {
      let mark: { node?: string; since?: number } = {};
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
        // The node that held the newest copy is gone: continue from the last committed manifest.
        metric.storageUnflushedLossTotal.inc();
        console.error(`[fs-sync] unflushed edits lost unit=${unit.id} owner=${mark.node ?? "unknown"}: continuing from the last committed manifest`);
        await redis.del(keys.needsFlush(unit.id));
      }
    }
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
        const h = await hydrateTree(store, unit.id, [unit.root], { markerPath: unit.markerPath, ignore: this.#ignore() });
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

  /** Commit one unit, one at a time per unit. Throws FencedError when a newer epoch owns it, anything else on a store failure. */
  #flush(unit: Unit): Promise<void> {
    return this.#serial(unit.id, () => this.#flushNow(unit));
  }

  async #flushNow(unit: Unit): Promise<void> {
    const { store, redis, keys } = this.#d;
    const t0 = this.#now();
    try {
      const r = await flushTree(store, unit.id, [unit.root], {
        epoch: unit.epoch,
        isCurrent: async () => (await redis.get(keys.fsEpoch(unit.id))) === String(unit.epoch),
        ignore: this.#ignore(),
      });
      writeMarker(unit.markerPath, r.id);
      metric.storageFlushTotal.inc({ result: "ok" });
      metric.storageFlushBytesTotal.inc({}, r.uploadedBytes);
      metric.storageFlushDuration.observe((this.#now() - t0) / 1000);
      await this.#clearPending(unit);
      if (r.changed && ++unit.flushes % GC_EVERY_FLUSHES === 0) {
        // Old manifests and the blobs only they referenced. Best effort: a failure costs space, not data.
        void gcSession(store, unit.id, { keep: 5 }).catch((e) => console.error(`[fs-sync] gc failed unit=${unit.id}: ${e instanceof Error ? e.message : String(e)}`));
      }
    } catch (e) {
      if (e instanceof FencedError) metric.storageFlushTotal.inc({ result: "fenced" });
      else if (!(e instanceof RootMissingError)) {
        metric.storageFlushTotal.inc({ result: "error" });
        metric.storageRequestErrorsTotal.inc({ op: "put" });
      }
      throw e;
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
      await redis.set(keys.needsFlush(unit.id), JSON.stringify({ node: nodeId, since }), "EX", 7 * 24 * 3600);
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
      if (p.evict) this.#dropLocal(p.unit);
    } catch (e) {
      if (e instanceof FencedError) {
        console.error(`[fs-sync] retry fenced unit=${p.unit.id}: another node continued without these edits`);
        await this.#clearPending(p.unit);
        return;
      }
      if (e instanceof RootMissingError) {
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
      if (lockLost) return;
      // The transcript flushes every turn whatever the cadence: conversation history is the last thing to risk.
      await this.#flushOrMark(tr.tx);
      if (this.#d.flush() === "turn") await this.#flushOrMark(tr.ws);
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
    for (const unit of [tr.tx, tr.ws]) {
      const ok = await this.#flushOrMark(unit);
      if (ok) this.#dropLocal(unit);
      else {
        const p = this.#pending.get(unit.id);
        if (p) p.evict = true;
      }
    }
  }

  /** Delete a unit's local copy unless a tracked session still works in it or a turn is using it. */
  #dropLocal(unit: Unit): void {
    if ((this.#active.get(unit.id) ?? 0) > 0) return;
    for (const t of this.#tracked.values()) if (t.ws.id === unit.id || t.tx.id === unit.id) return;
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
    for (const tr of this.#tracked.values()) {
      await this.#flushOrMark(tr.tx);
      await this.#flushOrMark(tr.ws);
    }
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
