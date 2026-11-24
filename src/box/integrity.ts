/**
 * Integrity of the stored box set (box spec, "Box definition format": signed
 * the way guardrails are, src/guardrails/integrity.ts).
 *
 * Every box row and every box version row carries an HMAC over its content,
 * and one manifest row per tenant signs the whole set: the sorted list of
 * (name, version, set version) for boxes and for versions. Per-row HMACs alone
 * would let a deleted row or a replayed older row verify. A read checks the
 * manifest first, then that the rows are exactly the ones it lists, then each
 * row's own HMAC; any mismatch fails closed. A box that cannot be verified is
 * never served: the digest in it decides which image a session runs.
 *
 * `set` is the manifest version at which a row was written. It is part of each
 * row's HMAC and of the manifest's list, so a row of a deleted and re-created
 * box (same name, same version number) does not verify in the new set.
 *
 * The key is a subkey of the guardrail key, so it has the same sources: a
 * subkey of SLAUDE_MASTER_KEY, which Postgres requires.
 *
 * Not covered here, stated: a whole signed set replaced by an OLDER signed set
 * (a rollback) verifies. Guardrails close that with a high-water mark kept
 * outside the database; boxes do not have one yet.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { guardrailKey } from "../guardrails/integrity";

let cached: { from: Buffer; key: Buffer } | null = null;
function boxKey(): Buffer {
  const base = guardrailKey().key;
  if (!cached || cached.from !== base) cached = { from: base, key: createHmac("sha256", base).update("slaude/boxes-hmac/v1").digest() };
  return cached.key;
}

function mac(parts: unknown[]): string {
  return createHmac("sha256", boxKey()).update(JSON.stringify(parts)).digest("hex");
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SignedBox {
  name: string;
  description: string;
  /** The box's current version number. */
  version: number;
  /** The manifest version of this row's last write. */
  setVersion: number;
}

export interface SignedBoxVersion {
  name: string;
  version: number;
  /** `<repository>@sha256:<digest>`. */
  image: string;
  /** `sha256:<digest>`. */
  digest: string;
  /** The canonical policy text (src/box/definition.ts, canonicalPolicy). */
  policy: string;
  forced: boolean;
  setVersion: number;
}

export interface BoxManifestEntries {
  boxes: Array<{ name: string; version: number; set: number }>;
  versions: Array<{ name: string; version: number; set: number }>;
}

export const boxMac = (tenant: string, b: SignedBox) => mac(["box", tenant, b.name, b.description, b.version, b.setVersion]);
export const boxVersionMac = (tenant: string, v: SignedBoxVersion) =>
  mac(["box-version", tenant, v.name, v.version, v.image, v.digest, v.policy, v.forced, v.setVersion]);
export const boxManifestMac = (tenant: string, version: number, entries: BoxManifestEntries) => mac(["box-manifest", tenant, version, entries]);

/** The manifest's entries for a set of rows, in one fixed order. */
export function boxManifestEntries(boxes: ReadonlyArray<SignedBox>, versions: ReadonlyArray<SignedBoxVersion>): BoxManifestEntries {
  const by = (a: { name: string; version: number }, b: { name: string; version: number }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version;
  return {
    boxes: boxes.map((b) => ({ name: b.name, version: b.version, set: b.setVersion })).sort(by),
    versions: versions.map((v) => ({ name: v.name, version: v.version, set: v.setVersion })).sort(by),
  };
}

/** A stored set that does not verify. `reason` names boxes, never content. */
export class BoxIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`box integrity check failed: ${reason}`);
  }
}

export interface StoredBoxSet {
  boxes: Array<SignedBox & { hmac: string }>;
  versions: Array<SignedBoxVersion & { hmac: string }>;
  manifest: { version: number; entries: string; hmac: string } | null;
}

/**
 * Verify a stored set. Throws BoxIntegrityError; returns the manifest version
 * (0 for an empty set that never had a manifest).
 */
export function verifyBoxSet(tenant: string, s: StoredBoxSet): number {
  // Version 0 with no signature is the placeholder a first write locks on;
  // like a missing manifest it stands for the empty set only.
  if (!s.manifest || (s.manifest.version === 0 && s.manifest.hmac === "")) {
    if (s.boxes.length || s.versions.length) throw new BoxIntegrityError("box rows exist but the manifest is missing");
    return 0;
  }
  let entries: BoxManifestEntries;
  try {
    entries = JSON.parse(s.manifest.entries) as BoxManifestEntries;
    if (!Array.isArray(entries.boxes) || !Array.isArray(entries.versions)) throw new Error("shape");
  } catch {
    throw new BoxIntegrityError("the manifest entries are not readable");
  }
  if (!sameMac(s.manifest.hmac, boxManifestMac(tenant, s.manifest.version, entries))) {
    throw new BoxIntegrityError("the manifest signature does not verify");
  }
  const actual = boxManifestEntries(s.boxes, s.versions);
  const key = (e: { name: string; version: number }) => `${e.name}#${e.version}`;

  const listedBoxes = new Map(entries.boxes.map((e) => [e.name, e]));
  for (const b of actual.boxes) {
    const l = listedBoxes.get(b.name);
    if (!l) throw new BoxIntegrityError(`box '${b.name}' is not in the manifest`);
    if (l.version !== b.version || l.set !== b.set) throw new BoxIntegrityError(`box '${b.name}' does not match the manifest's version`);
    listedBoxes.delete(b.name);
  }
  if (listedBoxes.size) throw new BoxIntegrityError(`box '${[...listedBoxes.keys()][0]}' is in the manifest but missing`);

  const listedVersions = new Map(entries.versions.map((e) => [key(e), e]));
  for (const v of actual.versions) {
    const l = listedVersions.get(key(v));
    if (!l) throw new BoxIntegrityError(`box '${v.name}' version ${v.version} is not in the manifest`);
    if (l.set !== v.set) throw new BoxIntegrityError(`box '${v.name}' version ${v.version} does not match the manifest`);
    listedVersions.delete(key(v));
  }
  if (listedVersions.size) {
    const first = [...listedVersions.values()][0]!;
    throw new BoxIntegrityError(`box '${first.name}' version ${first.version} is in the manifest but missing`);
  }

  for (const b of s.boxes) {
    if (!sameMac(b.hmac, boxMac(tenant, b))) throw new BoxIntegrityError(`box '${b.name}' signature does not verify`);
    if (!s.versions.some((v) => v.name === b.name && v.version === b.version)) {
      throw new BoxIntegrityError(`box '${b.name}' has no row for its current version`);
    }
  }
  for (const v of s.versions) {
    if (!sameMac(v.hmac, boxVersionMac(tenant, v))) throw new BoxIntegrityError(`box '${v.name}' version ${v.version} signature does not verify`);
    if (!s.boxes.some((b) => b.name === v.name)) throw new BoxIntegrityError(`box '${v.name}' has versions but no box row`);
  }
  return s.manifest.version;
}
