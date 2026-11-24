import type { ObjectStore } from "./object-store";

const SESSIONS = "sessions/";
const INBOX = "inbox/";
const DELETE_BATCH = 500;

/** True when the unit now holds a key the first listing did not, or any object newer than it saw (or of unknown age). */
async function changedSince(store: ObjectStore, unit: string, before: { keys: string[]; newest: number }): Promise<boolean> {
  const known = new Set(before.keys);
  for await (const obj of store.list(`${SESSIONS}${unit}/`)) {
    if (!known.has(obj.key) || obj.modified === undefined || obj.modified > before.newest) return true;
  }
  return false;
}

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
    if (!o.dryRun) {
      // A resuming session may have started writing this unit after the listing above: look again right before the
      // delete and keep the unit if anything is new or newer. (The nodes' in-use mark closes the rest of the window.)
      if (await changedSince(store, unit, u)) {
        result.unitsKept++;
        continue;
      }
      await deleteAll(store, u.keys);
    }
    result.unitsDeleted.push(unit);
    result.objectsDeleted += u.keys.length;
  }
  return result;
}

/** A home unit whose id is the session id itself (src/storage/units.ts, hmUnitId). A hashed id cannot be traced back and is left to the age rule. */
const HOME_UNIT_RE = /^hm-([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;

/**
 * Remove the stored home of every session that is closed (box spec, "Node and
 * gateway changes": session close and `/new` remove the session's `hm` unit).
 *
 * A home belongs to one session, unlike a workspace, so closing the session
 * decides its fate and it need not wait out the age rule. `closed` answers
 * for a session id; anything it does not positively call closed is kept. A
 * unit a node still holds open, or owes a flush for (`skip`), is kept too.
 */
export async function sweepClosedHomes(
  store: ObjectStore,
  o: { closed: (sessionId: string) => Promise<boolean>; skip?: (unitId: string) => Promise<boolean>; dryRun?: boolean },
): Promise<{ unitsDeleted: string[]; objectsDeleted: number }> {
  const units = new Map<string, string[]>();
  for await (const obj of store.list(`${SESSIONS}hm-`)) {
    const unit = obj.key.slice(SESSIONS.length).split("/")[0];
    if (!unit) continue;
    const keys = units.get(unit) ?? [];
    keys.push(obj.key);
    units.set(unit, keys);
  }
  const result = { unitsDeleted: [] as string[], objectsDeleted: 0 };
  for (const [unit, keys] of units) {
    const m = HOME_UNIT_RE.exec(unit);
    if (!m || m[1]!.includes("..")) continue;
    if (!(await o.closed(m[1]!))) continue;
    if (o.skip && (await o.skip(unit))) continue;
    if (!o.dryRun) await deleteAll(store, keys);
    result.unitsDeleted.push(unit);
    result.objectsDeleted += keys.length;
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
