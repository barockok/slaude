/**
 * The boxes of one node worker: which sessions have a sandbox, whether a new
 * one may start, and when idle ones are parked (box spec, "Capacity,
 * admission and autoscaling", "Scale-down and drain").
 *
 * It sits between the worker and a sandbox driver. The driver (gVisor through
 * the supervisor, or bwrap) and the builder of a sandbox's spec (its mounts
 * and proxies) are given to it: this module starts and stops sandboxes and
 * decides, it does not know how one is made. Tests give it a fake driver.
 *
 * The rules it applies are the pure ones in src/box/capacity.ts:
 *
 *   - `prepare` runs before a session's turn, under the session lock and
 *     after its files are hydrated. A session that already has its sandbox is
 *     always served. A sandbox start goes through admission: admit, or park
 *     the longest-idle warm sessions first, or `full`. On `full` the worker
 *     hands the job back to the label queue; nothing is failed and nothing
 *     runs unboxed.
 *   - `tick` runs on a timer: the pressure rule, and the claim gate that
 *     pauses the node's label-queue workers while it is full and resumes them
 *     once room has held for 5 s.
 *   - `drain` stops every sandbox, several at a time, after the worker has
 *     flushed their files.
 *
 * A failure to start a sandbox is a BootFailure. It is never an unboxed run:
 * the resolver this module gives the agent manager throws for a boxed session
 * that has no started sandbox.
 */
import {
  admit, freeSlots, nextClaimGate, parkable, pressure, reservedMb,
  type Admission, type AdmissionState, type ClaimGate, type RunningBox,
} from "../box/capacity";
import type { BoxPolicy } from "../box/policy";
import type { BoxSpec, SandboxDriver, SandboxStopReason, SessionSandbox } from "../box/sandbox";
import { BootFailure } from "../gateway/core/failure-codes";
import type { NodeBoxReport } from "../queue/registry";

/** What the runtime needs to know of a session's box. */
export interface RuntimeBox {
  name: string;
  image: string;
  digest: string;
  policy: BoxPolicy;
}

export interface BoxCapacityConfig {
  maxBoxes: number;
  memoryBudgetMb: number;
  overheadMb: number;
  pressureIdleSec: number;
  /** The supervisor container's memory limit, or null when it is not known (the pressure rule then does not run). */
  memoryLimitMb: number | null;
}

export interface BoxRuntimeMetrics {
  running(n: number): void;
  capacity(n: number): void;
  full(v: 0 | 1): void;
  reservedBytes(n: number): void;
  admission(result: "admit" | "make-room" | "full"): void;
  pressureEviction(): void;
  /** One phase of a sandbox start that this module runs: making the image present, then the sandbox itself. */
  startPhase(phase: "pull" | "start", result: "ok" | "error", seconds: number): void;
}

export interface BoxRuntimeDeps {
  driver: SandboxDriver;
  capacity: BoxCapacityConfig;
  /** The session's box, or null when it is not boxed. Throws a BootFailure when it cannot be decided. */
  boxOf: (sessionId: string) => Promise<RuntimeBox | null>;
  /** The sandbox's spec: its mounts, working directory and tenant. Supplied with the driver. */
  specFor: (sessionId: string, box: RuntimeBox) => Promise<BoxSpec> | BoxSpec;
  /** Make the image present before a sandbox starts (the prewarm module). Throws a BootFailure. */
  ensureImage?: (box: RuntimeBox, o: { onStatus?: (text: string) => void }) => Promise<void>;
  /**
   * Park one warm session to make room: end its CLI, flush its files, drop it
   * from the registry. The worker does this; it calls `stop` here on the way.
   */
  park: (sessionId: string, reason: "pressure" | "idle") => Promise<void>;
  /** Whether a turn of this session is running now (it is then never parked). */
  turnRunning: (sessionId: string) => boolean;
  /** Pause (false) or resume (true) this node's label-queue workers, for capacity. Its own queue is never paused. */
  setClaiming: (on: boolean) => void | Promise<void>;
  /** Free disk on the box data volume in MB, or null when it cannot be read. */
  freeDiskMb?: () => Promise<number | null> | number | null;
  /** Memory the supervisor's container uses now in MB, or null when it cannot be read. */
  memoryUsedMb?: () => Promise<number | null> | number | null;
  /** The digests the node holds, for the heartbeat. */
  digests?: () => string[];
  metrics?: Partial<BoxRuntimeMetrics>;
  now?: () => number;
  log?: (line: string) => void;
  /** Sandboxes stopped at the same time by a drain. Default 4. */
  drainConcurrency?: number;
}

interface Warm {
  sandbox: SessionSandbox;
  box: RuntimeBox;
  /** When its last turn ended, or null while one runs. */
  idleSince: number | null;
}

export type PrepareResult =
  /** The session is not boxed: nothing to do. */
  | "unboxed"
  /** It already has its sandbox. */
  | "warm"
  /** A sandbox was started for it. */
  | "started"
  /** No room and none could be made: hand the job back. */
  | "full";

export type BoxRuntime = ReturnType<typeof makeBoxRuntime>;

export function makeBoxRuntime(deps: BoxRuntimeDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const warm = new Map<string, Warm>();
  /** Sessions being started: they hold their slot and reserve from the moment admission says yes. */
  const starting = new Map<string, RuntimeBox>();
  let admitting = true;
  let gate: ClaimGate = { paused: false, roomSince: null };
  let stopped = false;
  /** One admission decision at a time: two starts must not both take the last slot. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const running = (): RunningBox[] => [
    ...[...warm.entries()].map(([sessionId, w]) => ({
      sessionId,
      reserveMb: w.box.policy.resources.memoryReserveMb,
      // The worker is the authority on a running turn: a turn that started without telling us is still not parked.
      idleSince: deps.turnRunning(sessionId) ? null : w.idleSince,
    })),
    ...[...starting.entries()].map(([sessionId, b]) => ({ sessionId, reserveMb: b.policy.resources.memoryReserveMb, idleSince: null })),
  ];

  async function state(): Promise<AdmissionState> {
    let freeDiskMb: number | null = null;
    try {
      freeDiskMb = (await deps.freeDiskMb?.()) ?? null;
    } catch {
      freeDiskMb = null;
    }
    return {
      maxBoxes: deps.capacity.maxBoxes,
      memoryBudgetMb: deps.capacity.memoryBudgetMb,
      overheadMb: deps.capacity.overheadMb,
      running: running(),
      freeDiskMb,
      admitting,
      now: now(),
      pressureIdleSec: deps.capacity.pressureIdleSec,
    };
  }

  function publish(s: AdmissionState): void {
    deps.metrics?.running?.(warm.size + starting.size);
    deps.metrics?.capacity?.(deps.capacity.maxBoxes);
    deps.metrics?.reservedBytes?.(reservedMb(s.running, s.overheadMb) * 1024 * 1024);
    deps.metrics?.full?.(gate.paused ? 1 : 0);
  }

  /** A typical box's reserve, for the free-slot hint: the smallest among those running, else the default box's. */
  const typicalReserve = (): number => {
    const all = [...warm.values()].map((w) => w.box.policy.resources.memoryReserveMb);
    return all.length ? Math.min(...all) : 1024;
  };

  async function applyGate(hasRoom: boolean): Promise<void> {
    const next = nextClaimGate(gate, hasRoom, now());
    if (next.paused !== gate.paused) {
      log(next.paused ? "[box] this node is full: its label queues are paused, its own queue keeps running" : "[box] this node has room again: its label queues are resumed");
      await deps.setClaiming(!next.paused);
    }
    gate = next;
  }

  async function stop(sessionId: string, reason: SandboxStopReason): Promise<void> {
    const w = warm.get(sessionId);
    if (!w) return;
    warm.delete(sessionId);
    try {
      await w.sandbox.stop(reason);
    } catch (e) {
      console.error(`[box] sandbox stop failed session=${sessionId} reason=${reason}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    /**
     * Before a turn. Returns what was done; `full` means nothing was started
     * and the job must be handed back. Throws a BootFailure when the session's
     * box cannot be decided, its image cannot be made present or its sandbox
     * does not start.
     */
    async prepare(sessionId: string, o: { onStatus?: (text: string) => void } = {}): Promise<PrepareResult> {
      const box = await deps.boxOf(sessionId);
      if (!box) return "unboxed";
      const have = warm.get(sessionId);
      if (have) {
        // Moved to another image since it started (a refresh): the old sandbox goes, and the new one is a start like any other.
        if (have.box.digest === box.digest) {
          have.idleSince = null;
          return "warm";
        }
        await stop(sessionId, "refresh");
      }
      if (stopped) return "full";
      // The decision and the slot are taken one session at a time.
      const decision = await serial(async (): Promise<Admission> => {
        const s = await state();
        const d = admit(s, { reserveMb: box.policy.resources.memoryReserveMb });
        deps.metrics?.admission?.(d.kind);
        if (d.kind !== "full") starting.set(sessionId, box);
        return d;
      });
      if (decision.kind === "full") {
        log(`[box] no room for session=${sessionId} (${decision.reason}): the job goes back to its label queue`);
        await applyGate(false);
        publish(await state());
        return "full";
      }
      try {
        if (decision.kind === "make-room") {
          for (const victim of decision.park) {
            log(`[box] parking idle session=${victim} early to make room for session=${sessionId}`);
            await deps.park(victim, "pressure");
            await stop(victim, "pressure");
          }
        }
        const timed = async <T>(phase: "pull" | "start", fn: () => Promise<T>): Promise<T> => {
          const t0 = now();
          try {
            const r = await fn();
            deps.metrics?.startPhase?.(phase, "ok", (now() - t0) / 1000);
            return r;
          } catch (e) {
            deps.metrics?.startPhase?.(phase, "error", (now() - t0) / 1000);
            throw e;
          }
        };
        await timed("pull", async () => deps.ensureImage?.(box, { onStatus: o.onStatus }));
        const sandbox = deps.driver.create(await deps.specFor(sessionId, box));
        try {
          await timed("start", () => sandbox.start());
        } catch (e) {
          throw e instanceof BootFailure ? e : new BootFailure("BOX_UNAVAILABLE", `the sandbox did not start: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        warm.set(sessionId, { sandbox, box, idleSince: null });
        return "started";
      } finally {
        starting.delete(sessionId);
        publish(await state());
      }
    },

    /**
     * The agent manager's sandbox resolver. Null for an unboxed session. For
     * a boxed one, the sandbox `prepare` started; none started is a failure,
     * never an unboxed spawn.
     */
    async sandboxFor(sessionId: string): Promise<SessionSandbox | null> {
      const box = await deps.boxOf(sessionId);
      if (!box) return null;
      const w = warm.get(sessionId);
      if (!w || w.box.digest !== box.digest) throw new BootFailure("BOX_UNAVAILABLE", "the session runs in a box and has no started sandbox on this node");
      return w.sandbox;
    },

    /** A turn of this session ended: it is idle from now. */
    turnEnded(sessionId: string): void {
      const w = warm.get(sessionId);
      if (w) w.idleSince = now();
    },

    /** Stop a session's sandbox (idle, evicted, fenced, drained). Home and workspace stay for the sync. */
    stop,

    has: (sessionId: string): boolean => warm.has(sessionId),
    sessions: (): string[] => [...warm.keys()],
    /** The digests sessions on this node run on: never evicted from the image cache. */
    digestsInUse: (): Set<string> => new Set([...warm.values(), ...[...starting.values()].map((box) => ({ box }))].map((w) => w.box.digest)),
    admitting: (): boolean => admitting,
    claimsPaused: (): boolean => gate.paused,

    /**
     * The periodic check: memory pressure first (it can stop admission and
     * park idle sessions), then the claim gate.
     */
    async tick(): Promise<void> {
      if (stopped) return;
      let used: number | null = null;
      try {
        used = (await deps.memoryUsedMb?.()) ?? null;
      } catch {
        used = null;
      }
      if (used !== null) {
        const p = pressure(used, deps.capacity.memoryLimitMb, { admitting });
        if (p.admitting !== admitting) log(p.admitting ? "[box] memory is back under 80 percent of the limit: admitting again" : `[box] memory is at ${Math.round((p.ratio ?? 0) * 100)} percent of the limit: no new sandbox is admitted, idle sessions are parked`);
        admitting = p.admitting;
        if (p.evict) {
          // One per tick, longest idle first: the next tick reads memory again before parking another.
          const victim = parkable({ running: running(), now: now(), pressureIdleSec: deps.capacity.pressureIdleSec })[0];
          if (victim) {
            deps.metrics?.pressureEviction?.();
            log(`[box] memory pressure: parking idle session=${victim.sessionId}`);
            await deps.park(victim.sessionId, "pressure");
            await stop(victim.sessionId, "pressure");
          }
        }
      }
      const s = await state();
      // Room is a free slot, or an idle session that may be parked for one: a node whose every
      // session sits idle must not stay paused until their idle timeout, with work waiting.
      await applyGate(admit(s, { reserveMb: typicalReserve() }).kind !== "full");
      publish(s);
    },

    /** What the heartbeat reports: the images held and the occupancy. */
    async report(): Promise<NodeBoxReport> {
      const s = await state();
      return {
        digests: deps.digests?.() ?? [],
        running: warm.size + starting.size,
        capacity: deps.capacity.maxBoxes,
        // A paused node offers nothing, whatever the arithmetic says: the gate's hold is not over.
        free: gate.paused ? 0 : freeSlots(s, typicalReserve()),
      };
    },

    /**
     * Drain: stop every sandbox, several at a time. The worker flushes each
     * session's files first. After this nothing is admitted.
     */
    async drain(): Promise<void> {
      stopped = true;
      const ids = [...warm.keys()];
      const n = Math.max(1, deps.drainConcurrency ?? 4);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(n, ids.length) }, async () => {
          while (next < ids.length) await stop(ids[next++]!, "drain");
        }),
      );
      deps.metrics?.running?.(0);
    },
  };
}
