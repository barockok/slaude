/**
 * Box storage (migrations 0054 to 0057). Postgres only, like personas: a box
 * is declared by a persona sync, which sqlite does not run. On sqlite every
 * read here answers "no boxes" without touching a table.
 *
 * A box is a row plus one row per version. Every write goes through
 * {@link applyBoxes}, inside the caller's transaction (the persona sync's): it
 * locks the tenant's manifest, refuses a stored set that does not verify,
 * writes the changed rows with their HMACs, and re-signs the manifest over the
 * resulting set. Reads return the stored set as is; src/box/integrity.ts
 * verifies it.
 *
 * Version rows are never updated. A new one is written when the image digest
 * or the policy differs from the box's current version.
 */
import { boxDiff, canonicalPolicy, type ParsedBox } from "../box/definition";
import {
  boxMac,
  boxManifestEntries,
  boxManifestMac,
  boxVersionMac,
  verifyBoxSet,
  type SignedBox,
  type SignedBoxVersion,
  type StoredBoxSet,
} from "../box/integrity";
import type { BoxPolicy } from "../box/policy";
import { db, type DbClient } from "./client";

export interface BoxRow extends SignedBox {
  hmac: string;
  updatedAt: number;
  updatedBy: string;
}

export interface BoxVersionRow extends SignedBoxVersion {
  hmac: string;
  createdAt: number;
  createdBy: string;
}

export interface StoredBoxes extends StoredBoxSet {
  boxes: BoxRow[];
  versions: BoxVersionRow[];
}

const EMPTY: StoredBoxes = { boxes: [], versions: [], manifest: null };

type RawBox = { name: string; description: string; version: number; set_version: number; hmac: string; updated_at: number; updated_by: string };
type RawVersion = {
  name: string; version: number; image: string; digest: string; policy: string; forced: boolean | number; set_version: number;
  hmac: string; created_at: number; created_by: string;
};

const toBox = (r: RawBox): BoxRow => ({
  name: r.name, description: r.description, version: Number(r.version), setVersion: Number(r.set_version),
  hmac: r.hmac, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});
const toVersion = (r: RawVersion): BoxVersionRow => ({
  name: r.name, version: Number(r.version), image: r.image, digest: r.digest, policy: r.policy, forced: Boolean(r.forced),
  setVersion: Number(r.set_version), hmac: r.hmac, createdAt: Number(r.created_at), createdBy: r.created_by,
});

async function readWith(c: DbClient, tenant: string, lock = false): Promise<StoredBoxes> {
  const manifest = await c.one<{ version: number; entries: string; hmac: string }>(
    `SELECT version, entries, hmac FROM boxes_manifest WHERE tenant_id = ? AND id = 'manifest'${lock ? " FOR UPDATE" : ""}`,
    [tenant],
  );
  const boxes = (await c.query<RawBox>(
    `SELECT name, description, version, set_version, hmac, updated_at, updated_by FROM boxes WHERE tenant_id = ? ORDER BY name`, [tenant])).map(toBox);
  const versions = (await c.query<RawVersion>(
    `SELECT name, version, image, digest, policy, forced, set_version, hmac, created_at, created_by FROM box_versions WHERE tenant_id = ? ORDER BY name, version`,
    [tenant])).map(toVersion);
  return { boxes, versions, manifest: manifest ? { version: Number(manifest.version), entries: manifest.entries, hmac: manifest.hmac } : null };
}

/** The stored set of one tenant, unverified. Empty on sqlite. */
export async function readBoxes(tenant = "default", client: DbClient = db): Promise<StoredBoxes> {
  if (client.dialect !== "pg") return { ...EMPTY, boxes: [], versions: [] };
  return readWith(client, tenant);
}

/** The manifest version alone (0 when none, and on sqlite): a cheap change probe and the bundle's ETag input. */
export async function boxSetVersion(tenant = "default", client: DbClient = db): Promise<number> {
  if (client.dialect !== "pg") return 0;
  const m = await client.one<{ version: number }>(`SELECT version FROM boxes_manifest WHERE tenant_id = ? AND id = 'manifest'`, [tenant]);
  return m ? Number(m.version) : 0;
}

/** Whether migrations 0054 to 0056 are applied (a sync that carries boxes refuses by name when they are not). */
export async function boxTablesPresent(client: DbClient = db): Promise<boolean> {
  if (client.dialect !== "pg") return false;
  try {
    await client.query(`SELECT b.name, v.version, m.version FROM boxes b, box_versions v, boxes_manifest m LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/** One box a sync changed: its name, its version after the sync, and what changed (names and numbers, never a value). */
export interface BoxChange {
  name: string;
  version: number;
  diff: string[];
}

export interface BoxSyncReport {
  created: BoxChange[];
  /** A new version, or a description-only change (which keeps the version). */
  updated: BoxChange[];
  unchanged: string[];
  removed: string[];
}

export const boxesChanged = (r: BoxSyncReport): boolean => r.created.length + r.updated.length + r.removed.length > 0;

/** The current version row of each stored box, by name. */
function currentVersions(stored: StoredBoxes): Map<string, { box: BoxRow; current: BoxVersionRow }> {
  const out = new Map<string, { box: BoxRow; current: BoxVersionRow }>();
  for (const b of stored.boxes) {
    const current = stored.versions.find((v) => v.name === b.name && v.version === b.version);
    if (current) out.set(b.name, { box: b, current });
  }
  return out;
}

/**
 * What a sync of `incoming` (the deploy repo's whole set) would do to the
 * stored set. Pure: the dry run prints it, and {@link applyBoxes} writes
 * exactly it.
 */
export function planBoxes(stored: StoredBoxes, incoming: readonly ParsedBox[]): BoxSyncReport {
  const report: BoxSyncReport = { created: [], updated: [], unchanged: [], removed: [] };
  const have = currentVersions(stored);
  for (const b of incoming) {
    const prev = have.get(b.name);
    if (!prev) {
      report.created.push({ name: b.name, version: 1, diff: boxDiff(null, b) });
      continue;
    }
    const prevPolicy = JSON.parse(prev.current.policy) as BoxPolicy;
    const diff = boxDiff({ digest: prev.current.digest, policy: prevPolicy }, b);
    // The image reference can move between repositories with the digest unchanged: the stored reference follows it.
    if (prev.current.image !== b.image && prev.current.digest === b.digest) diff.push("image: new repository");
    const newVersion = prev.current.digest !== b.digest || prev.current.policy !== canonicalPolicy(b.policy) || prev.current.image !== b.image;
    if (prev.box.description !== b.description) diff.push("description: changed");
    if (diff.length === 0) report.unchanged.push(b.name);
    else report.updated.push({ name: b.name, version: prev.box.version + (newVersion ? 1 : 0), diff });
  }
  const listed = new Set(incoming.map((b) => b.name));
  report.removed = stored.boxes.filter((b) => !listed.has(b.name)).map((b) => b.name);
  return report;
}

/**
 * Write the deploy repo's whole box set in the caller's transaction and
 * re-sign it. A sync that changes nothing writes nothing (the set version does
 * not move). Throws BoxIntegrityError when the stored set does not verify: a
 * write must never launder tampering into a valid signature.
 */
export async function applyBoxes(
  tx: DbClient,
  tenant: string,
  incoming: readonly ParsedBox[],
  meta: { by: string; now?: number },
): Promise<BoxSyncReport> {
  const now = meta.now ?? Date.now();
  await tx.run(
    `INSERT INTO boxes_manifest (tenant_id, id, version, entries, hmac, updated_at) VALUES (?, 'manifest', 0, '{"boxes":[],"versions":[]}', '', ?) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [tenant, now],
  );
  const cur = await readWith(tx, tenant, true);
  const stored = verifyBoxSet(tenant, cur);
  const report = planBoxes(cur, incoming);
  if (!boxesChanged(report)) return report;

  const setVersion = stored + 1;
  const boxes = new Map(cur.boxes.map((b) => [b.name, b]));
  let versions = [...cur.versions];
  const have = currentVersions(cur);
  const byName = new Map(incoming.map((b) => [b.name, b]));

  for (const change of [...report.created, ...report.updated]) {
    const b = byName.get(change.name)!;
    const prev = have.get(b.name);
    if (!prev || change.version !== prev.box.version) {
      const v: BoxVersionRow = {
        name: b.name, version: change.version, image: b.image, digest: b.digest, policy: canonicalPolicy(b.policy),
        forced: b.policy.refresh.force, setVersion, hmac: "", createdAt: now, createdBy: meta.by,
      };
      v.hmac = boxVersionMac(tenant, v);
      await tx.run(
        `INSERT INTO box_versions (tenant_id, name, version, image, digest, policy, forced, set_version, hmac, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenant, v.name, v.version, v.image, v.digest, v.policy, v.forced, v.setVersion, v.hmac, v.createdAt, v.createdBy],
      );
      versions.push(v);
    }
    const row: BoxRow = { name: b.name, description: b.description, version: change.version, setVersion, hmac: "", updatedAt: now, updatedBy: meta.by };
    row.hmac = boxMac(tenant, row);
    await tx.run(
      `INSERT INTO boxes (tenant_id, name, description, version, set_version, hmac, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET description = excluded.description, version = excluded.version, set_version = excluded.set_version,
         hmac = excluded.hmac, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [tenant, row.name, row.description, row.version, row.setVersion, row.hmac, row.updatedAt, row.updatedBy],
    );
    boxes.set(row.name, row);
  }
  for (const name of report.removed) {
    await tx.run(`DELETE FROM box_versions WHERE tenant_id = ? AND name = ?`, [tenant, name]);
    await tx.run(`DELETE FROM boxes WHERE tenant_id = ? AND name = ?`, [tenant, name]);
    boxes.delete(name);
    versions = versions.filter((v) => v.name !== name);
  }
  const entries = boxManifestEntries([...boxes.values()], versions);
  await tx.run(`UPDATE boxes_manifest SET version = ?, entries = ?, hmac = ?, updated_at = ? WHERE tenant_id = ? AND id = 'manifest'`, [
    setVersion, JSON.stringify(entries), boxManifestMac(tenant, setVersion, entries), now, tenant,
  ]);
  return report;
}

/**
 * Pin a session to a box: compare-and-set from NULL, then read the row back,
 * so two first dispatches at once agree on one digest. Returns what the
 * session is pinned to after the call (this pin, or the earlier one).
 */
export async function pinSessionBoxOn(client: DbClient, sessionId: string, box: { name: string; digest: string }): Promise<{ name: string; digest: string; pinned: boolean } | null> {
  const r = await client.run(`UPDATE sessions SET box_name = ?, box_digest = ? WHERE id = ? AND box_digest IS NULL`, [box.name, box.digest, sessionId]);
  const row = await client.one<{ box_name: string | null; box_digest: string | null }>(`SELECT box_name, box_digest FROM sessions WHERE id = ?`, [sessionId]);
  if (!row || !row.box_name || !row.box_digest) return null;
  return { name: row.box_name, digest: row.box_digest, pinned: (r.changes ?? 0) > 0 };
}

export const pinSessionBox = (sessionId: string, box: { name: string; digest: string }) => pinSessionBoxOn(db, sessionId, box);

/** What a session is pinned to, or null. */
export async function sessionBoxOn(client: DbClient, sessionId: string): Promise<{ name: string; digest: string } | null> {
  const row = await client.one<{ box_name: string | null; box_digest: string | null }>(`SELECT box_name, box_digest FROM sessions WHERE id = ?`, [sessionId]);
  return row?.box_name && row.box_digest ? { name: row.box_name, digest: row.box_digest } : null;
}

export const sessionBox = (sessionId: string) => sessionBoxOn(db, sessionId);

/** TEST SEAM: every box table emptied (a persistent test Postgres). */
export async function __clearBoxesForTests(client: DbClient = db): Promise<void> {
  if (client.dialect !== "pg") return;
  for (const t of ["box_versions", "boxes", "boxes_manifest"]) await client.run(`DELETE FROM ${t}`);
}
