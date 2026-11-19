import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Keys } from "../../queue/keys";
import { acquireLock, releaseLock } from "../../queue/locks";
import type { SweepConfig } from "../../storage/config";
import type { ObjectStore } from "../../storage/object-store";
import { sweepInbox, sweepUnits, type UnitSweepResult } from "../../storage/sweep";

const DAY_MS = 86_400_000;
/** One hour under the interval: a replica's own next tick (and its clock skew) must never find its own lock still held. */
const LOCK_TTL_MS = DAY_MS - 3_600_000;

export interface SweeperDeps {
  store: ObjectStore;
  redis: Pick<Redis, "set" | "get">;
  keys: Pick<Keys, "storageSweepLock" | "needsFlush">;
  cfg: SweepConfig;
  now?: number;
  /** How long the lock is held: one sweep per interval across replicas. Default 23 hours. */
  lockTtlMs?: number;
}

/**
 * One sweep of the bucket, or null when it did not run (mode off, or another replica already took this interval's
 * lock). A unit with a needs-flush mark is never swept: a node still holds edits the store has not got.
 */
export async function runStorageSweep(d: SweeperDeps): Promise<{ units: UnitSweepResult; inbox: { objectsDeleted: number } } | null> {
  if (d.cfg.mode === "off") return null;
  const lockKey = d.keys.storageSweepLock();
  const owner = randomUUID();
  if (!(await acquireLock(d.redis as Redis, lockKey, owner, d.lockTtlMs ?? LOCK_TTL_MS))) return null;
  const dryRun = d.cfg.mode === "dry-run";
  const units = await sweepUnits(d.store, {
    retainMs: d.cfg.retainMs,
    ...(d.now !== undefined ? { now: d.now } : {}),
    dryRun,
    skip: async (unit) => (await d.redis.get(d.keys.needsFlush(unit))) !== null,
  });
  const inbox = await sweepInbox(d.store, { ttlMs: d.cfg.inboxTtlMs, ...(d.now !== undefined ? { now: d.now } : {}), dryRun });
  console.log(
    `[storage-sweep] ${dryRun ? "dry run: would delete" : "deleted"} ${units.unitsDeleted.length} unit(s) (${units.objectsDeleted} objects), ` +
      `${inbox.objectsDeleted} inbox object(s); kept ${units.unitsKept} unit(s)${units.unitsDeleted.length ? `: ${units.unitsDeleted.join(", ")}` : ""}`,
  );
  // A dry run must not take this interval's turn: the operator switches to `on` next, and would otherwise wait a day.
  if (dryRun) await releaseLock(d.redis as Redis, lockKey, owner).catch(() => {});
  return { units, inbox };
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
