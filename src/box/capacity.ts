/**
 * Capacity of a node pod for boxes (box spec, "Capacity, admission and
 * autoscaling"). Pure functions: no clock, no environment, no I/O. The worker
 * gathers the numbers and applies the answers.
 *
 * A node pod is the unit of capacity. Per box, `memoryMb` is a hard ceiling
 * its own cgroup enforces, and `memoryReserveMb` (about a third of the
 * ceiling by default) is what admission sets aside, so memory is overcommitted
 * on purpose. Three rules keep that safe:
 *
 *   - sizing, checked once at node boot: the pod must be able to hold the
 *     number of boxes it is configured for. A violation stops the node and
 *     names the numbers;
 *   - admission, checked before every sandbox start: a slot, the reserve and
 *     a floor of free disk. When something is missing, room is made by
 *     parking the longest-idle warm session; when none can be parked the node
 *     is full and stops claiming new work;
 *   - pressure, checked on a timer: above 90 percent of the supervisor's
 *     memory limit the node stops admitting and parks idle sessions until it
 *     is under 80 percent.
 *
 * A warm session's next turn is never subject to admission: it already has
 * its sandbox.
 */

/** The share of the supervisor container's memory limit that boxes may reserve, when no budget is set. */
export const MEMORY_BUDGET_SHARE = 0.85;
/** Free disk a new sandbox needs, whatever its box says (MB). */
export const DISK_FLOOR_MB = 1024;
/** Disk one live session is assumed to use, for the boot check (MB): a home, workspace extras and a root overlay in ordinary use. */
export const TYPICAL_LIVE_DISK_MB = 3072;
/** Above this share of the memory limit the node stops admitting and parks idle sessions. */
export const PRESSURE_HIGH = 0.9;
/** It admits again below this share. */
export const PRESSURE_LOW = 0.8;
/** A free slot must hold this long before a full node claims new work again (ms). */
export const RESUME_HOLD_MS = 5_000;

export interface SizingInput {
  /** SLAUDE_NODE_MAX_BOXES. */
  maxBoxes: number;
  /** SLAUDE_BOX_MEMORY_BUDGET_MB, or null to derive it from the limit. */
  memoryBudgetMb: number | null;
  /** The supervisor container's cgroup memory limit, or null when it has none or it cannot be read. */
  memoryLimitMb: number | null;
  /** SLAUDE_BOX_SANDBOX_OVERHEAD_MB: added to each reserve for the sandbox's own processes. */
  overheadMb: number;
  /** The smallest memoryReserveMb of a box this node will serve. */
  smallestReserveMb: number;
  /** Size of the box data volume, or null when it cannot be read. */
  diskMb: number | null;
  imageBudgetMb: number;
  parkBudgetMb: number;
  /** The node's total turn concurrency, for the warning. */
  turnConcurrency: number;
  typicalLiveDiskMb?: number;
}

export interface SizingResult {
  ok: boolean;
  /** Each names the numbers. Any one stops the node. */
  errors: string[];
  warnings: string[];
  /** The budget admission uses: the configured one, or the derived one. 0 when it cannot be known. */
  memoryBudgetMb: number;
}

/** The boot check. A node that fails it must not start: it could be pushed past its pod's memory. */
export function checkSizing(i: SizingInput): SizingResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const perBox = i.smallestReserveMb + i.overheadMb;
  if (!Number.isInteger(i.maxBoxes) || i.maxBoxes < 1) errors.push(`SLAUDE_NODE_MAX_BOXES must be at least 1 (it is ${i.maxBoxes})`);
  const maxBoxes = Math.max(1, Math.floor(i.maxBoxes) || 1);

  let budget = 0;
  if (i.memoryBudgetMb !== null) {
    budget = i.memoryBudgetMb;
    if (budget < 1) errors.push(`SLAUDE_BOX_MEMORY_BUDGET_MB must be at least 1 (it is ${budget})`);
    if (i.memoryLimitMb !== null && budget > i.memoryLimitMb) {
      errors.push(`SLAUDE_BOX_MEMORY_BUDGET_MB (${budget} MB) is above the supervisor's memory limit (${i.memoryLimitMb} MB)`);
    }
  } else if (i.memoryLimitMb !== null) {
    budget = Math.floor(i.memoryLimitMb * MEMORY_BUDGET_SHARE);
  } else {
    errors.push("the supervisor container has no readable memory limit, so the memory budget cannot be derived: set a memory limit on it, or set SLAUDE_BOX_MEMORY_BUDGET_MB");
  }
  if (i.memoryLimitMb === null && i.memoryBudgetMb !== null) {
    warnings.push("the supervisor container has no readable memory limit: nothing but SLAUDE_BOX_MEMORY_BUDGET_MB bounds the boxes' memory, and the pressure rule cannot run");
  }
  if (budget > 0 && budget < maxBoxes * perBox) {
    const need = Math.ceil((maxBoxes * perBox) / MEMORY_BUDGET_SHARE);
    errors.push(
      i.memoryBudgetMb !== null
        ? `${maxBoxes} boxes need ${maxBoxes * perBox} MB reserved (${maxBoxes} x (${i.smallestReserveMb} reserve + ${i.overheadMb} overhead)), and SLAUDE_BOX_MEMORY_BUDGET_MB is ${budget} MB: raise it or lower SLAUDE_NODE_MAX_BOXES`
        : `${maxBoxes} boxes need the supervisor's memory limit to be at least ${need} MB (${maxBoxes} x (${i.smallestReserveMb} reserve + ${i.overheadMb} overhead) / ${MEMORY_BUDGET_SHARE}), and it is ${i.memoryLimitMb} MB: raise the limit or lower SLAUDE_NODE_MAX_BOXES`,
    );
  }

  const live = i.typicalLiveDiskMb ?? TYPICAL_LIVE_DISK_MB;
  const diskNeed = i.imageBudgetMb + maxBoxes * live + i.parkBudgetMb;
  if (i.diskMb === null) warnings.push("the size of the box data volume could not be read: the disk half of the sizing rule was not checked");
  else if (i.diskMb < diskNeed) {
    errors.push(`the box data volume is ${i.diskMb} MB and must hold at least ${diskNeed} MB (${i.imageBudgetMb} for images + ${maxBoxes} x ${live} for live sessions + ${i.parkBudgetMb} for parked sessions): enlarge it, or lower the budgets or SLAUDE_NODE_MAX_BOXES`);
  }

  if (maxBoxes < i.turnConcurrency) {
    warnings.push(`SLAUDE_NODE_MAX_BOXES (${maxBoxes}) is below this node's turn concurrency (${i.turnConcurrency}): a turn can be claimed that no sandbox can be started for, and is handed back`);
  }
  return { ok: errors.length === 0, errors, warnings, memoryBudgetMb: Math.max(0, budget) };
}

/** A sandbox running on this node. */
export interface RunningBox {
  sessionId: string;
  /** Its box's memoryReserveMb. */
  reserveMb: number;
  /** When its last turn ended (ms), or null while a turn is running. */
  idleSince: number | null;
}

export interface AdmissionState {
  maxBoxes: number;
  memoryBudgetMb: number;
  overheadMb: number;
  running: readonly RunningBox[];
  /** Free disk on the box data volume, or null when it cannot be read (the floor is then not checked). */
  freeDiskMb: number | null;
  /** False while the pressure rule holds admission. */
  admitting: boolean;
  now: number;
  /** SLAUDE_BOX_PRESSURE_IDLE_SEC: how long a warm session must be idle before it may be parked for room. */
  pressureIdleSec: number;
}

export type Admission =
  /** Start the sandbox. */
  | { kind: "admit" }
  /** Park these warm sessions first (longest idle first), then start it. */
  | { kind: "make-room"; park: string[] }
  /** Do not start it: stop claiming new work and hand this job back to the label queue. */
  | { kind: "full"; reason: "slots" | "memory" | "disk" | "pressure" };

const reserved = (running: readonly RunningBox[], overheadMb: number): number => running.reduce((n, b) => n + b.reserveMb + overheadMb, 0);

/** Warm sessions that may be parked for room: no running turn, idle long enough. Longest idle first. */
export function parkable(s: Pick<AdmissionState, "running" | "now" | "pressureIdleSec">): RunningBox[] {
  return s.running
    .filter((b) => b.idleSince !== null && s.now - b.idleSince >= s.pressureIdleSec * 1000)
    .sort((a, b) => a.idleSince! - b.idleSince! || (a.sessionId < b.sessionId ? -1 : 1));
}

/**
 * Whether a new sandbox for a box with `reserveMb` may start. A session that
 * already has its sandbox is never asked about: call this only for a sandbox
 * start (a new session, or a cold or parked resume).
 */
export function admit(s: AdmissionState, box: { reserveMb: number }): Admission {
  if (!s.admitting) return { kind: "full", reason: "pressure" };
  if (s.freeDiskMb !== null && s.freeDiskMb < DISK_FLOOR_MB) return { kind: "full", reason: "disk" };
  const need = box.reserveMb + s.overheadMb;
  const fits = (running: readonly RunningBox[]) => running.length < s.maxBoxes && reserved(running, s.overheadMb) + need <= s.memoryBudgetMb;
  if (fits(s.running)) return { kind: "admit" };
  // Make room: park the longest idle first, as few as it takes.
  const park: string[] = [];
  let left = [...s.running];
  for (const b of parkable(s)) {
    park.push(b.sessionId);
    left = left.filter((x) => x.sessionId !== b.sessionId);
    if (fits(left)) return { kind: "make-room", park };
  }
  // Which one is short, as it stands (for the log and the metric).
  return { kind: "full", reason: s.running.length >= s.maxBoxes ? "slots" : "memory" };
}

/**
 * How many more sandboxes of a typical box this node could start now: what
 * its heartbeat reports. A hint for routing; `admit` is the authority.
 */
export function freeSlots(s: Pick<AdmissionState, "maxBoxes" | "memoryBudgetMb" | "overheadMb" | "running" | "admitting" | "freeDiskMb">, typicalReserveMb: number): number {
  if (!s.admitting) return 0;
  if (s.freeDiskMb !== null && s.freeDiskMb < DISK_FLOOR_MB) return 0;
  const bySlots = s.maxBoxes - s.running.length;
  const per = typicalReserveMb + s.overheadMb;
  const byMemory = per > 0 ? Math.floor((s.memoryBudgetMb - reserved(s.running, s.overheadMb)) / per) : bySlots;
  return Math.max(0, Math.min(bySlots, byMemory));
}

/** The memory the running boxes have set aside, overhead included (MB). */
export const reservedMb = (running: readonly RunningBox[], overheadMb: number): number => reserved(running, overheadMb);

export interface PressureState {
  /** False from the moment use passes the high mark until it is under the low mark. */
  admitting: boolean;
}

export interface PressureResult extends PressureState {
  /** Park idle sessions now (longest idle first) and check again. */
  evict: boolean;
  /** used / limit, or null when the limit is not known. */
  ratio: number | null;
}

/**
 * The pressure rule, with its hysteresis. At or above 90 percent: stop
 * admitting and park. Between 80 and 90: whatever it was doing before. Under
 * 80: admit. An unknown or zero limit decides nothing.
 */
export function pressure(memoryUsedMb: number, memoryLimitMb: number | null, prev: PressureState): PressureResult {
  if (memoryLimitMb === null || memoryLimitMb <= 0) return { admitting: true, evict: false, ratio: null };
  const ratio = memoryUsedMb / memoryLimitMb;
  if (ratio >= PRESSURE_HIGH) return { admitting: false, evict: true, ratio };
  if (ratio >= PRESSURE_LOW && !prev.admitting) return { admitting: false, evict: true, ratio };
  return { admitting: true, evict: false, ratio };
}

/** Whether a full node's label-queue workers are paused, and since when it has had room. */
export interface ClaimGate {
  paused: boolean;
  /** When room was first seen after being full (ms), or null. */
  roomSince: number | null;
}

/**
 * The pause of a full node's label-queue workers, with its hysteresis: pause
 * the moment there is no room; resume only after room has been there for
 * `holdMs` without a break, so one session ending does not make the node
 * claim a job it must hand straight back.
 */
export function nextClaimGate(prev: ClaimGate, hasRoom: boolean, now: number, holdMs = RESUME_HOLD_MS): ClaimGate {
  if (!hasRoom) return { paused: true, roomSince: null };
  if (!prev.paused) return { paused: false, roomSince: null };
  const since = prev.roomSince ?? now;
  return now - since >= holdMs ? { paused: false, roomSince: null } : { paused: true, roomSince: since };
}

/**
 * The grace period a pod needs to drain: the drain window, plus the flush of
 * its warm boxes, several at a time. The overlay's 300 s is this for the
 * defaults (120 s drain, 8 to 10 boxes, 15 s each, 4 at a time), rounded up.
 */
export function drainGraceSec(o: { drainSec: number; warmBoxes: number; flushSecPerBox?: number; flushParallelism?: number }): number {
  const per = o.flushSecPerBox ?? 15;
  const par = Math.max(1, o.flushParallelism ?? 4);
  return Math.ceil(o.drainSec + (Math.max(0, o.warmBoxes) * per) / par);
}

/**
 * The park budget when SLAUDE_BOX_PARK_BUDGET_MB is not set: half of the box
 * data volume, but never more than what the volume has left after the image
 * budget and the live sessions, so the default cannot fail the boot check it
 * is part of. 0 when the volume's size is not known: nothing is parked beyond
 * what free disk allows, and the pruner's free-disk rule still applies.
 */
export function defaultParkBudgetMb(o: { diskMb: number | null; imageBudgetMb: number; maxBoxes: number; typicalLiveDiskMb?: number }): number {
  if (o.diskMb === null || o.diskMb <= 0) return 0;
  const left = o.diskMb - o.imageBudgetMb - Math.max(1, o.maxBoxes) * (o.typicalLiveDiskMb ?? TYPICAL_LIVE_DISK_MB);
  return Math.max(0, Math.min(Math.floor(o.diskMb / 2), left));
}
