import type { ObjectStore } from "./object-store";

const SESSIONS = "sessions/";
const INBOX = "inbox/";
const DELETE_BATCH = 500;

export interface UnitSweepResult {
  /** Units deleted (or, in a dry run, that would be). */
  unitsDeleted: string[];
  unitsKept: number;
  /** Objects deleted (or, in a dry run, that would be). */
  objectsDeleted: number;
}

async function deleteAll(store: ObjectStore, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) await store.delete(keys.slice(i, i + DELETE_BATCH));
}

/**
 * Delete whole stored directories ("units": `sessions/<unit>/`, their manifests and blobs together) that nothing has
 * written to for `retainMs`. Age is the newest object's `modified` time; reads do not count, so the window is long.
 * A unit is kept when any of its objects reports no time (its age is unknown), when its newest object is younger than
 * the window, or when `skip(unit)` says so (a pending flush). A unit is a directory a session works in and may be
 * shared by several sessions, so the age of the directory decides, never the state of one session.
 */
export async function sweepUnits(
  store: ObjectStore,
  o: { retainMs: number; now?: number; dryRun?: boolean; skip?: (unitId: string) => Promise<boolean> },
): Promise<UnitSweepResult> {
  const now = o.now ?? Date.now();
  const units = new Map<string, { keys: string[]; newest: number; unknownAge: boolean }>();
  for await (const obj of store.list(SESSIONS)) {
    const unit = obj.key.slice(SESSIONS.length).split("/")[0];
    if (!unit) continue;
    let u = units.get(unit);
    if (!u) units.set(unit, (u = { keys: [], newest: 0, unknownAge: false }));
    u.keys.push(obj.key);
    if (obj.modified === undefined) u.unknownAge = true;
    else u.newest = Math.max(u.newest, obj.modified);
  }
  const result: UnitSweepResult = { unitsDeleted: [], unitsKept: 0, objectsDeleted: 0 };
  for (const [unit, u] of units) {
    const old = !u.unknownAge && now - u.newest > o.retainMs;
    if (!old || (o.skip && (await o.skip(unit)))) {
      result.unitsKept++;
      continue;
    }
    if (!o.dryRun) await deleteAll(store, u.keys);
    result.unitsDeleted.push(unit);
    result.objectsDeleted += u.keys.length;
  }
  return result;
}

/**
 * Delete attachments the gateway staged in `inbox/` that no node collected within `ttlMs`. An object with no
 * `modified` time is kept. An object exactly `ttlMs` old is kept.
 */
export async function sweepInbox(store: ObjectStore, o: { ttlMs: number; now?: number; dryRun?: boolean }): Promise<{ objectsDeleted: number }> {
  const now = o.now ?? Date.now();
  const stale: string[] = [];
  for await (const obj of store.list(INBOX)) {
    if (obj.modified !== undefined && now - obj.modified > o.ttlMs) stale.push(obj.key);
  }
  if (!o.dryRun) await deleteAll(store, stale);
  return { objectsDeleted: stale.length };
}
