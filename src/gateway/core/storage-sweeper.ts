import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Keys } from "../../queue/keys";
import { acquireLock } from "../../queue/locks";
import type { SweepConfig } from "../../storage/config";
import type { ObjectStore } from "../../storage/object-store";
import { sweepInbox, sweepUnits, type UnitSweepResult } from "../../storage/sweep";

const DAY_MS = 86_400_000;

export interface SweeperDeps {
  store: ObjectStore;
  redis: Pick<Redis, "set" | "get">;
  keys: Pick<Keys, "storageSweepLock" | "needsFlush">;
  cfg: SweepConfig;
  now?: number;
  /** How long the lock is held: one sweep per interval across replicas. Default 24 hours. */
  lockTtlMs?: number;
}

/**
 * One sweep of the bucket, or null when it did not run (mode off, or another replica already took this interval's
 * lock). A unit with a needs-flush mark is never swept: a node still holds edits the store has not got.
 */
export async function runStorageSweep(d: SweeperDeps): Promise<{ units: UnitSweepResult; inbox: { objectsDeleted: number } } | null> {
  if (d.cfg.mode === "off") return null;
  if (!(await acquireLock(d.redis as Redis, d.keys.storageSweepLock(), randomUUID(), d.lockTtlMs ?? DAY_MS))) return null;
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
  return { units, inbox };
}

/** Run the sweep shortly after start and then once a day. Returns a stop function. A failing sweep is logged and retried next interval. */
export function startStorageSweeper(d: SweeperDeps & { firstRunDelayMs?: number; intervalMs?: number }): () => void {
  if (d.cfg.mode === "off") return () => {};
  const tick = (): void => {
    runStorageSweep(d).catch((e: unknown) => console.error(`[storage-sweep] failed: ${e instanceof Error ? e.message : String(e)}`));
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
