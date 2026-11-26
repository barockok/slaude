import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Keys } from "../../queue/keys";
import { acquireLock, releaseLock } from "../../queue/locks";
import type { SweepConfig } from "../../storage/config";
import type { ObjectStore } from "../../storage/object-store";
import { sweepClosedHomes, sweepInbox, sweepUnits, type UnitSweepResult } from "../../storage/sweep";

const DAY_MS = 86_400_000;
/** One hour under the interval: a replica's own next tick (and its clock skew) must never find its own lock still held. */
const LOCK_TTL_MS = DAY_MS - 3_600_000;

export interface SweeperDeps {
  store: ObjectStore;
  redis: Pick<Redis, "set" | "get">;
  keys: Pick<Keys, "storageSweepLock" | "needsFlush" | "fsInUse">;
  cfg: SweepConfig;
  now?: number;
  /** How long the lock is held: one sweep per interval across replicas. Default 23 hours. */
  lockTtlMs?: number;
  /**
   * Whether a session is closed (started over with `/new`). With it, a closed
   * session's stored home is removed in the same tick, without waiting out
   * the age rule: a home belongs to one session. Absent: homes age out like
   * any unit.
   */
  sessionClosed?: (sessionId: string) => Promise<boolean>;
}

/**
 * One sweep of the bucket, or null when it did not run (mode off, or another replica already took this interval's
 * lock). A unit with a needs-flush mark (a node holds edits the store has not got) or an in-use mark (a node has it open)
 * is never swept.
 */
export async function runStorageSweep(d: SweeperDeps): Promise<{ units: UnitSweepResult; inbox: { objectsDeleted: number }; homes?: { unitsDeleted: string[]; objectsDeleted: number } } | null> {
  if (d.cfg.mode === "off") return null;
  const lockKey = d.keys.storageSweepLock();
  const owner = randomUUID();
  if (!(await acquireLock(d.redis as Redis, lockKey, owner, d.lockTtlMs ?? LOCK_TTL_MS))) return null;
  const dryRun = d.cfg.mode === "dry-run";
  const units = await sweepUnits(d.store, {
    retainMs: d.cfg.retainMs,
    ...(d.now !== undefined ? { now: d.now } : {}),
    dryRun,
    skip: async (unit) => (await d.redis.get(d.keys.needsFlush(unit))) !== null || (await d.redis.get(d.keys.fsInUse(unit))) !== null,
  });
  const inbox = await sweepInbox(d.store, { ttlMs: d.cfg.inboxTtlMs, ...(d.now !== undefined ? { now: d.now } : {}), dryRun });
  const inUse = async (unit: string) => (await d.redis.get(d.keys.needsFlush(unit))) !== null || (await d.redis.get(d.keys.fsInUse(unit))) !== null;
  // A failure here costs this tick's home removal only: the units age out as before.
  const homes = d.sessionClosed
    ? await sweepClosedHomes(d.store, { closed: d.sessionClosed, skip: inUse, dryRun }).catch((e: unknown) => {
        console.error(`[storage-sweep] closed-session homes not removed: ${e instanceof Error ? e.message : String(e)}`);
        return { unitsDeleted: [] as string[], objectsDeleted: 0 };
      })
    : undefined;
  if (homes?.unitsDeleted.length) {
    console.log(`[storage-sweep] ${dryRun ? "dry run: would delete" : "deleted"} the home of ${homes.unitsDeleted.length} closed session(s) (${homes.objectsDeleted} objects)`);
  }
  console.log(
    `[storage-sweep] ${dryRun ? "dry run: would delete" : "deleted"} ${units.unitsDeleted.length} unit(s) (${units.objectsDeleted} objects), ` +
      `${inbox.objectsDeleted} inbox object(s); kept ${units.unitsKept} unit(s)${units.unitsDeleted.length ? `: ${units.unitsDeleted.join(", ")}` : ""}`,
  );
  // A dry run must not take this interval's turn: the operator switches to `on` next, and would otherwise wait a day.
  if (dryRun) await releaseLock(d.redis as Redis, lockKey, owner).catch(() => {});
  return { units, inbox, ...(homes ? { homes } : {}) };
}

/** Run the sweep shortly after start and then once a day. Returns a stop function. A failing sweep is logged and retried next interval. */
export function startStorageSweeper(d: SweeperDeps & { firstRunDelayMs?: number; intervalMs?: number }): () => void {
  if (d.cfg.mode === "off") return () => {};
  const tick = (): void => {
    void runStorageSweep(d).catch((e: unknown) => console.error(`[storage-sweep] failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  const first = setTimeout(tick, d.firstRunDelayMs ?? 60_000);
  const every = setInterval(tick, d.intervalMs ?? DAY_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
