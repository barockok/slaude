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
 * other's copy.
 *
 * Flush failure never holds a lock. The unit is marked needs-flush in Redis,
 * this node keeps its local copy and retries; its next turn flushes before it
 * hydrates, so the newest copy is never overwritten by an older remote one.
 * Another node that finds the mark waits while the owner is alive and, once the
 * owner is gone, continues from the last committed manifest and counts the loss.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "../config/home";
import { personaConfigDir } from "../agent/oauth-home";
import { m as metric } from "../metrics";
import {
  FencedError,
  flushTree,
  hydrateTree,
  ignoreList,
  writeMarker,
  type ObjectStore,
  type Root,
  type SyncFlush,
} from "../storage";
import type { Keys } from "../queue/keys";

/** How long a node waits for another, live node to flush before continuing from the last committed manifest. */
const WAIT_FOR_OWNER_MS = 120_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

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

/** The SDK names a project directory after its cwd with every non-alphanumeric character replaced by `-`. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const hash = (p: string): string => createHash("sha256").update(resolve(p)).digest("hex").slice(0, 32);

interface Unit {
  id: string;
  root: Root;
  epoch: number;
  markerPath: string;
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
  readonly #pending = new Map<string, Pending>();
  #stopped = false;

  constructor(deps: FsSyncDeps) {
    this.#d = deps;
  }

  #now = (): number => (this.#d.now ?? Date.now)();
  #state = (): string => this.#d.stateDir ?? join(paths.home, ".sync-state");
  #ignore = (): readonly string[] => this.#d.ignore ?? ignoreList();

  /** The base config home whose projects/ directory the SDK writes this persona's transcripts into. */
  #transcriptBase(persona: string): string {
    return persona && persona !== "default" ? personaConfigDir(persona) : process.env.CLAUDE_CONFIG_DIR?.trim() || paths.claudeConfig;
  }

  #units(sessionId: string, cwd: string, persona: string): Tracked {
    const real = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
    const txDir = join(this.#transcriptBase(persona), "projects", encodeProjectDir(real));
    const mk = (id: string, name: string, dir: string): Unit => ({
      id,
      root: { name, dir },
      epoch: 0,
      markerPath: join(this.#state(), `${id}.json`),
    });
    return { cwd, txDir, ws: mk(`ws-${hash(cwd)}`, "ws", cwd), tx: mk(`tx-${hash(txDir)}`, "tx", txDir) };
  }

  /**
   * Under the session lock, before the turn: make this node's disk match the
   * stored state. "wait" means another live node holds unflushed edits: requeue.
   */
  async beforeTurn(sessionId: string, persona: string): Promise<"ok" | "wait"> {
    const cwd = await this.#d.workingDirOf(sessionId);
    if (!cwd) return "ok";
    const tr = this.#tracked.get(sessionId) ?? this.#units(sessionId, cwd, persona);
    for (const unit of [tr.tx, tr.ws]) {
      const r = await this.#prepare(unit);
      if (r === "wait") return "wait";
    }
    this.#tracked.set(sessionId, tr);
    return "ok";
  }

  async #prepare(unit: Unit): Promise<"ok" | "wait"> {
    const { redis, keys, nodeId } = this.#d;
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
    if (ownPending) {
      // Our local copy is the newest state: it goes to the store before anything is read back.
      await this.#flush(unit);
    }
    const t0 = this.#now();
    try {
      const h = await hydrateTree(this.#d.store, unit.id, [unit.root], { markerPath: unit.markerPath, ignore: this.#ignore() });
      metric.storageHydrateTotal.inc({ result: "ok", mode: h.mode === "cold" ? "cold" : "warm" });
      metric.storageHydrateBytesTotal.inc({}, h.downloadedBytes);
      metric.storageHydrateDuration.observe((this.#now() - t0) / 1000);
    } catch (e) {
      metric.storageHydrateTotal.inc({ result: "error", mode: "cold" });
      metric.storageRequestErrorsTotal.inc({ op: "get" });
      throw e;
    }
    return "ok";
  }

  /** Commit one unit. Throws FencedError when a newer epoch owns it, anything else on a store failure. */
  async #flush(unit: Unit): Promise<void> {
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
    } catch (e) {
      if (e instanceof FencedError) metric.storageFlushTotal.inc({ result: "fenced" });
      else {
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
    try {
      await this.#flush(p.unit);
      if (p.evict) this.#dropLocal(p.unit.id);
    } catch (e) {
      if (e instanceof FencedError) {
        console.error(`[fs-sync] retry fenced unit=${p.unit.id}: another node continued without these edits`);
        await this.#clearPending(p.unit);
        return;
      }
      if (this.#pending.get(p.unit.id) === p) this.#schedule(p);
    }
  }

  async #clearPending(unit: Unit): Promise<void> {
    const p = this.#pending.get(unit.id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.#pending.delete(unit.id);
    try {
      await this.#d.redis.del(this.#d.keys.needsFlush(unit.id));
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

  /** After the turn, still under the lock. A lost lock means another node owns the unit: flush nothing. */
  async afterTurn(sessionId: string, lockLost: boolean): Promise<void> {
    const tr = this.#tracked.get(sessionId);
    if (!tr || lockLost) return;
    // The transcript flushes every turn whatever the cadence: conversation history is the last thing to risk.
    await this.#flushOrMark(tr.tx);
    if (this.#d.flush() === "turn") await this.#flushOrMark(tr.ws);
  }

  /** The session is no longer warm here: flush everything, then free the disk. Never throws. */
  async evict(sessionId: string): Promise<void> {
    const tr = this.#tracked.get(sessionId);
    if (!tr) return;
    this.#tracked.delete(sessionId);
    for (const unit of [tr.tx, tr.ws]) {
      const ok = await this.#flushOrMark(unit);
      if (ok) this.#dropLocal(unit.id, unit);
      else {
        const p = this.#pending.get(unit.id);
        if (p) p.evict = true;
      }
    }
  }

  /** Delete a unit's local copy unless another tracked session still works in it. */
  #dropLocal(unitId: string, unit?: Unit): void {
    const u = unit ?? this.#pending.get(unitId)?.unit;
    if (!u) return;
    for (const t of this.#tracked.values()) if (t.ws.id === unitId || t.tx.id === unitId) return;
    rmSync(u.root.dir, { recursive: true, force: true });
    rmSync(u.markerPath, { force: true });
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
