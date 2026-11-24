/**
 * The gateway's read path for boxes: the stored set, verified before anything
 * in it is used (the manifest row first, then the rows, fail closed), modelled
 * on the guardrail snapshot.
 *
 * A box that cannot be verified is never served. The digest in it decides
 * which image a session runs and the policy decides where it may connect, so a
 * set that does not verify is an error for every caller (BoxIntegrityError),
 * never "run without a box".
 *
 * Nothing here is consulted while SLAUDE_BOX is off, apart from the set
 * version, which is an ETag input of the runtime bundle.
 */
import { BoxIntegrityError, verifyBoxSet } from "../../box/integrity";
import type { BoxPolicy } from "../../box/policy";
import { boxSetVersion, readBoxes, type BoxVersionRow } from "../../db/boxes";
import { db, type DbClient } from "../../db/client";

export { BoxIntegrityError };

/** One version of a box, verified. */
export interface BoxVersion {
  name: string;
  version: number;
  /** `<repository>@sha256:<digest>`. */
  image: string;
  /** `sha256:<digest>`. */
  digest: string;
  policy: BoxPolicy;
  forced: boolean;
}

export interface BoxEntry {
  name: string;
  description: string;
  current: BoxVersion;
  /** Every version, oldest first. */
  versions: BoxVersion[];
}

export interface BoxSnapshot {
  /** The manifest version the snapshot was verified at (0: no boxes). */
  setVersion: number;
  boxes: ReadonlyMap<string, BoxEntry>;
}

function toVersion(v: BoxVersionRow): BoxVersion {
  let policy: BoxPolicy;
  try {
    policy = JSON.parse(v.policy) as BoxPolicy;
  } catch {
    throw new BoxIntegrityError(`box '${v.name}' version ${v.version} holds a policy that is not readable`);
  }
  return { name: v.name, version: v.version, image: v.image, digest: v.digest, policy, forced: v.forced };
}

/** Read and verify one tenant's boxes. Throws BoxIntegrityError when the set does not verify. */
export async function loadBoxes(tenant = "default", client: DbClient = db): Promise<BoxSnapshot> {
  const stored = await readBoxes(tenant, client);
  const setVersion = verifyBoxSet(tenant, stored);
  const boxes = new Map<string, BoxEntry>();
  for (const b of stored.boxes) {
    const versions = stored.versions.filter((v) => v.name === b.name).sort((x, y) => x.version - y.version).map(toVersion);
    // verifyBoxSet guarantees the current version's row exists.
    const current = versions.find((v) => v.version === b.version)!;
    boxes.set(b.name, { name: b.name, description: b.description, current, versions });
  }
  return { setVersion, boxes };
}

const cache = new Map<string, BoxSnapshot>();

/**
 * The verified snapshot, re-read only when the manifest version moved. A
 * failed read or a failed check drops the cached snapshot and throws: an
 * older verified answer is not served in place of a set that no longer verifies.
 */
export async function boxSnapshot(tenant = "default", client: DbClient = db): Promise<BoxSnapshot> {
  const key = `${client === db ? "" : "seam:"}${tenant}`;
  try {
    const v = await boxSetVersion(tenant, client);
    const hit = cache.get(key);
    // Version 0 is never trusted from cache: rows without a manifest must be seen.
    if (hit && v > 0 && hit.setVersion === v) return hit;
    const fresh = await loadBoxes(tenant, client);
    cache.set(key, fresh);
    return fresh;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

/** A box's current version, or null when the tenant has no box of that name. */
export async function currentBox(tenant: string, name: string, client: DbClient = db): Promise<BoxVersion | null> {
  return (await boxSnapshot(tenant, client)).boxes.get(name)?.current ?? null;
}

/**
 * What a session pinned to `digest` of box `name` runs with: the image of the
 * newest version that has that digest, and the box's CURRENT policy. Policy is
 * not image: a policy change reaches a pinned session with no refresh, an
 * image change never does. Null when the box or the digest is gone.
 */
export async function pinnedBox(tenant: string, name: string, digest: string, client: DbClient = db): Promise<(BoxVersion & { stale: boolean }) | null> {
  const entry = (await boxSnapshot(tenant, client)).boxes.get(name);
  if (!entry) return null;
  const at = [...entry.versions].reverse().find((v) => v.digest === digest);
  if (!at) return null;
  // Stale: a newer version with another digest was marked forced (the refresh itself is a later phase).
  const stale = entry.versions.some((v) => v.version > at.version && v.forced && v.digest !== digest);
  return { ...at, policy: entry.current.policy, forced: entry.current.forced, version: at.version, stale };
}

/** TEST SEAM: forget every cached snapshot. */
export function __resetBoxRegistryForTests(): void {
  cache.clear();
}
