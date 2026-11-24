/**
 * Everything a node worker needs for boxes, assembled in one place so the
 * worker itself changes little: the refusal to start without a driver, the
 * boot sizing check, the image cache and its prewarm loop, the box runtime
 * (admission, pressure, drain) and the box facts the file sync needs.
 *
 * On tier `none`, the default, `setupNodeBoxes` returns null and the worker
 * behaves exactly as it did before boxes existed.
 *
 * A node on a sandbox tier MUST have a driver for it. Without one it would
 * advertise a sandbox it cannot start, the gateway would send it boxed
 * sessions, and the agent manager (which has no sandbox resolver then) would
 * run them on the node itself. So the worker refuses to start. This build
 * ships no driver: the gVisor and bwrap drivers are later phases, and tests
 * pass a fake.
 */
import { join } from "node:path";
import { statfsSync } from "node:fs";
import { checkSizing, defaultParkBudgetMb } from "../box/capacity";
import { cliImageRunner, makeImageStore, type ImageStore } from "../box/image";
import { DEFAULT_BOX_RESOURCES, defaultMemoryReserveMb, type BoxTier } from "../box/policy";
import type { PackPort } from "../storage/pack-sync";
import type { BoxSpec, SandboxDriver } from "../box/sandbox";
import { env } from "../config/env";
import { BootFailure } from "../gateway/core/failure-codes";
import { m as metric } from "../metrics";
import type { NodeBoxReport } from "../queue/registry";
import { makeBoxPrewarm, type BoxPrewarm, type WantedImage } from "./box-images";
import { makeBoxRuntime, type BoxRuntime, type RuntimeBox } from "./box-runtime";
import type { BoxFacts } from "./fs-sync";
import type { NodeSessionBoxes } from "./session-boxes";

/** What the supervisor's container allows: read once at boot, for the sizing check and the pressure rule. */
export interface NodeBoxLimits {
  /** Its cgroup memory limit in MB, or null when it has none or it cannot be read. */
  memoryLimitMb: number | null;
  /** The size of the box data volume in MB, or null when it cannot be read. */
  diskMb: number | null;
}

export interface NodeBoxOpts {
  /** Default: SLAUDE_BOX_TIER. */
  tier?: BoxTier;
  /**
   * TEST SEAM: which box a session runs in. Default: the join of the runtime
   * bundle and the session view (./session-boxes), which is the only source a
   * deployment has.
   */
  boxOf?: (sessionId: string) => Promise<RuntimeBox | null>;
  /** The sandbox driver of the tier. Absent on a sandbox tier: the worker refuses to start. */
  driver?: SandboxDriver;
  /** Build a sandbox's spec (mounts, working directory). Comes with the driver. */
  specFor?: (sessionId: string, box: RuntimeBox, ctx: { homeDir: string }) => Promise<BoxSpec> | BoxSpec;
  /** The image cache. Default: one under SLAUDE_BOX_DIR with the skopeo and umoci runner. null: none (images are the driver's business). */
  images?: ImageStore | null;
  /** The supervisor's limits. Default: unknown (null), which the sizing check then says. */
  limits?: () => Promise<NodeBoxLimits> | NodeBoxLimits;
  /** Memory the supervisor's container uses now (MB). Without it the pressure rule does not run. */
  memoryUsedMb?: () => Promise<number | null> | number | null;
  /** Free disk on the box data volume (MB). Default: statfs of the box directory. */
  freeDiskMb?: () => Promise<number | null> | number | null;
  /** Who packs the home and workspace-extras units (the supervisor). Without it those two units are not synced. */
  packer?: PackPort;
  /** A session's home directory on this node. Default: under the box directory. */
  homeDirOf?: (sessionId: string) => string;
  capacity?: { maxBoxes?: number; memoryBudgetMb?: number | null; overheadMb?: number; pressureIdleSec?: number; smallestReserveMb?: number; parkBudgetMb?: number | null };
  /** How often the pressure rule and the claim gate run (ms). Default 5000. */
  tickMs?: number;
  /** How long a starting node waits for its current images (ms). Default SLAUDE_BOX_PREWARM_TIMEOUT_SEC. */
  prewarmTimeoutMs?: number;
}

export interface NodeBoxContext {
  nodeId: string;
  turnConcurrency: number;
  sessionBoxes: NodeSessionBoxes;
  /** GET /v1/node/boxes. */
  listBoxes: (tenant: string) => Promise<WantedImage[] | null>;
  /** End a warm session's CLI, flush its files and drop it from the registry. */
  park: (sessionId: string, reason: "pressure" | "idle") => Promise<void>;
  turnRunning: (sessionId: string) => boolean;
  /** Pause or resume the label-queue workers for capacity. */
  setClaiming: (on: boolean) => void | Promise<void>;
  /** Digests of sessions parked on this node (their images are kept). */
  parkedDigests?: () => ReadonlySet<string>;
}

export interface NodeBoxes {
  tier: Exclude<BoxTier, "none">;
  runtime: BoxRuntime;
  prewarm: BoxPrewarm | null;
  /** The disk budget for parked sessions (MB). */
  parkBudgetMb: number;
  /** Box facts for the file sync, or undefined for an unboxed session. */
  syncFacts: (sessionId: string) => Promise<BoxFacts | undefined>;
  packer: PackPort | undefined;
  freeDiskMb: () => Promise<number | null>;
  report: () => Promise<NodeBoxReport>;
  /** Resolves once the current images are present, or the timeout passed. Immediately without an image cache. */
  ready: () => Promise<void>;
  tickMs: number;
}

/** The refusal a sandbox tier with no driver gets. Exported so the boot path and its test use one text. */
export const noDriverRefusal = (tier: BoxTier): string =>
  `refusing to start: SLAUDE_BOX_TIER=${tier}, and this build has no sandbox driver for that tier. A node must not advertise a sandbox it cannot start: ` +
  `boxed sessions sent to it could only be refused or run on the node itself. Set SLAUDE_BOX_TIER=none on this node.`;

const safeSegment = (sessionId: string): string => (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId) && !sessionId.includes("..") ? sessionId : Buffer.from(sessionId).toString("hex").slice(0, 64));

/** Free space of the volume that holds `dir`, in MB; null when it cannot be read. */
export function statfsFreeMb(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * Build the node's box machinery, or null on tier `none`. Throws (and so
 * stops the node) when the tier has no driver, the driver's probe fails, or
 * the pod is too small for the boxes it is configured to hold.
 */
export async function setupNodeBoxes(opts: NodeBoxOpts | undefined, ctx: NodeBoxContext): Promise<NodeBoxes | null> {
  const tier = opts?.tier ?? env.box.tier();
  if (tier === "none") return null;
  const driver = opts?.driver;
  if (!driver) throw new Error(noDriverRefusal(tier));
  if (driver.tier !== tier) throw new Error(`refusing to start: SLAUDE_BOX_TIER=${tier}, but the sandbox driver is for tier ${driver.tier}`);
  const probe = await driver.probe();
  if (!probe.ok) throw new Error(`refusing to start: this node cannot run sandbox tier ${tier}: ${probe.reason}`);

  const boxDir = env.box.dir();
  const limits = (await opts?.limits?.()) ?? { memoryLimitMb: null, diskMb: null };
  const maxBoxes = opts?.capacity?.maxBoxes ?? env.box.maxBoxes();
  const overheadMb = opts?.capacity?.overheadMb ?? env.box.sandboxOverheadMb();
  const imageBudgetMb = env.box.imageBudgetMb();
  const configuredBudget = opts?.capacity?.memoryBudgetMb !== undefined ? opts.capacity.memoryBudgetMb : env.box.memoryBudgetMb();
  const configuredPark = opts?.capacity?.parkBudgetMb !== undefined ? opts.capacity.parkBudgetMb : env.box.parkBudgetMb();
  const parkBudgetMb = configuredPark ?? defaultParkBudgetMb({ diskMb: limits.diskMb, imageBudgetMb, maxBoxes });
  const sizing = checkSizing({
    maxBoxes,
    memoryBudgetMb: configuredBudget,
    memoryLimitMb: limits.memoryLimitMb,
    overheadMb,
    // The boxes a node will serve are not known at boot (they come from the gateway): the default box's reserve stands in.
    smallestReserveMb: opts?.capacity?.smallestReserveMb ?? defaultMemoryReserveMb(DEFAULT_BOX_RESOURCES.memoryMb),
    diskMb: limits.diskMb,
    imageBudgetMb,
    parkBudgetMb,
    turnConcurrency: ctx.turnConcurrency,
  });
  for (const w of sizing.warnings) console.warn(`[node] box sizing: ${w}`);
  if (!sizing.ok) throw new Error(`refusing to start: this pod is too small for its boxes. ${sizing.errors.join("; ")}`);
  console.log(`[node] boxes: tier ${tier}, at most ${maxBoxes} at once, ${sizing.memoryBudgetMb} MB reservable (${overheadMb} MB overhead each), parked sessions up to ${parkBudgetMb} MB`);

  const freeDiskMb = async (): Promise<number | null> => (opts?.freeDiskMb ? await opts.freeDiskMb() : statfsFreeMb(boxDir));
  const homeDirOf = opts?.homeDirOf ?? ((sessionId: string) => join(boxDir, "sessions", safeSegment(sessionId), "home"));

  const images = opts?.images !== undefined ? opts.images : makeImageStore({ dir: boxDir, runner: cliImageRunner(), budgetMb: imageBudgetMb, ...(env.box.registryAuth() ? { auth: env.box.registryAuth()! } : {}) });
  // Declared before the runtime that it reads, used only after both exist.
  let runtime: BoxRuntime | null = null;
  const prewarm = images
    ? makeBoxPrewarm({
        images,
        list: ctx.listBoxes,
        inUse: () => new Set([...(runtime?.digestsInUse() ?? []), ...(ctx.parkedDigests?.() ?? [])]),
        pullTimeoutMs: env.box.pullTimeoutSec() * 1000,
      })
    : null;
  images?.sweep();

  const specFor = opts?.specFor;
  runtime = makeBoxRuntime({
    driver,
    capacity: { maxBoxes, memoryBudgetMb: sizing.memoryBudgetMb, overheadMb, pressureIdleSec: opts?.capacity?.pressureIdleSec ?? env.box.pressureIdleSec(), memoryLimitMb: limits.memoryLimitMb },
    boxOf: (id) => ctx.sessionBoxes.boxOf(id),
    specFor: (id, box) => {
      if (!specFor) throw new BootFailure("BOX_UNAVAILABLE", "this node has a sandbox driver but nothing that builds a sandbox's spec");
      return specFor(id, box, { homeDir: homeDirOf(id) });
    },
    ...(prewarm ? { ensureImage: (box: RuntimeBox, o: { onStatus?: (text: string) => void }) => prewarm.ensureFor(box, { deadlineMs: env.box.pullTimeoutSec() * 1000, onStatus: o.onStatus }) } : {}),
    park: ctx.park,
    turnRunning: ctx.turnRunning,
    setClaiming: ctx.setClaiming,
    freeDiskMb,
    ...(opts?.memoryUsedMb ? { memoryUsedMb: opts.memoryUsedMb } : {}),
    digests: () => prewarm?.digests() ?? [],
    metrics: {
      running: (n) => metric.nodeBoxesRunning.set(n),
      capacity: (n) => metric.nodeBoxesCapacity.set(n),
      full: (v) => metric.nodeBoxesFull.set(v),
      reservedBytes: (n) => metric.boxMemoryReservedBytes.set(n),
      admission: (result) => metric.boxAdmissionTotal.inc({ result }),
      pressureEviction: () => metric.boxPressureEvictionsTotal.inc(),
    },
  });
  metric.nodeBoxesCapacity.set(maxBoxes);
  metric.nodeBoxesRunning.set(0);
  metric.nodeBoxesFull.set(0);
  const rt = runtime;

  return {
    tier,
    runtime: rt,
    prewarm,
    parkBudgetMb,
    packer: opts?.packer,
    freeDiskMb,
    tickMs: opts?.tickMs ?? 5_000,
    async syncFacts(sessionId) {
      const box = await ctx.sessionBoxes.boxOf(sessionId);
      if (!box) return undefined;
      const r = box.policy.resources;
      return { digest: box.digest, homeDir: homeDirOf(sessionId), exclude: box.policy.durable.exclude, homeMb: r.homeMb, extrasMb: r.workspaceExtrasMb };
    },
    report: () => rt.report(),
    async ready() {
      if (!prewarm) return;
      void prewarm.refresh("default");
      await prewarm.waitReady(opts?.prewarmTimeoutMs ?? env.box.prewarmTimeoutSec() * 1000);
    },
  };
}
