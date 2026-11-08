/**
 * Integrity of the stored guardrail set (design section 2).
 *
 * Every guardrail and override row carries an HMAC over its content, and one
 * manifest row per tenant signs the whole set: the sorted (slug, version,
 * enabled) list and the override list. Per-row HMACs alone would let a deleted
 * row or a replayed older row verify. Resolution checks the manifest first,
 * then each row; any mismatch fails closed (the session boot fails, audited
 * as guardrail.integrity.failed), never "run with fewer rules".
 *
 * The key is a subkey of SLAUDE_MASTER_KEY, like the runtime bundle's ETag.
 * Without a master key (a single process on sqlite) a random key is created
 * once under $SLAUDE_HOME/guardrails/.hmac-key (mode 0600), so the import CLI
 * and the server sign alike. That key sits where a session's Bash can read
 * it: on that deployment the HMAC detects drift and accidental edits, and the
 * threat model says so (it does not stop an adversarial agent there).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { masterKey, MasterKeyError } from "../db/crypto";
import { paths } from "../config/home";

export const GUARDRAILS_DIR = join(paths.home, "guardrails");
export const HMAC_KEY_FILE = join(GUARDRAILS_DIR, ".hmac-key");

export type KeySource = "master-key" | "key-file";

let cached: { key: Buffer; source: KeySource } | null = null;

/** The HMAC key and where it came from. Creates the key file when needed. */
export function guardrailKey(): { key: Buffer; source: KeySource } {
  if (cached) return cached;
  try {
    cached = { key: createHmac("sha256", masterKey()).update("slaude/guardrails-hmac/v1").digest(), source: "master-key" };
    return cached;
  } catch (e) {
    if (!(e instanceof MasterKeyError)) throw e;
  }
  let raw: string | null = existsSync(HMAC_KEY_FILE) ? readFileSync(HMAC_KEY_FILE, "utf8").trim() : null;
  if (!raw) {
    mkdirSync(dirname(HMAC_KEY_FILE), { recursive: true });
    raw = randomBytes(32).toString("base64");
    // wx: two processes racing to create it must not both win with different keys.
    try {
      writeFileSync(HMAC_KEY_FILE, `${raw}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      raw = readFileSync(HMAC_KEY_FILE, "utf8").trim();
    }
    try {
      chmodSync(HMAC_KEY_FILE, 0o600);
    } catch {
      /* best effort */
    }
  }
  const key = Buffer.from(raw, "base64");
  if (key.length < 32) throw new Error(`${HMAC_KEY_FILE} does not hold a 32-byte key`);
  cached = { key, source: "key-file" };
  return cached;
}

/** TEST SEAM: forget the cached key (a changed env or key file is re-read). */
export function __resetGuardrailKeyForTests(): void {
  cached = null;
}

function mac(parts: unknown[]): string {
  return createHmac("sha256", guardrailKey().key).update(JSON.stringify(parts)).digest("hex");
}

export function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SignedRow {
  slug: string;
  md: string;
  sha: string;
  source: string;
  version: number;
  enabled: boolean;
}
export interface SignedOverride {
  slug: string;
  md: string;
  baseSha: string;
  version: number;
}
export interface ManifestEntries {
  rows: Array<{ slug: string; version: number; enabled: boolean }>;
  overrides: Array<{ slug: string; version: number }>;
}

export const rowMac = (tenant: string, r: SignedRow) => mac(["row", tenant, r.slug, r.md, r.version, r.enabled, r.source, r.sha]);
export const overrideMac = (tenant: string, o: SignedOverride) => mac(["override", tenant, o.slug, o.md, o.baseSha, o.version]);
export const manifestMac = (tenant: string, version: number, entries: ManifestEntries) => mac(["manifest", tenant, version, entries]);

/** The manifest's entries for a set of rows and overrides, sorted by slug. */
export function manifestEntries(rows: ReadonlyArray<{ slug: string; version: number; enabled: boolean }>, overrides: ReadonlyArray<{ slug: string; version: number }>): ManifestEntries {
  const by = (a: { slug: string }, b: { slug: string }) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return {
    rows: rows.map((r) => ({ slug: r.slug, version: r.version, enabled: r.enabled })).sort(by),
    overrides: overrides.map((o) => ({ slug: o.slug, version: o.version })).sort(by),
  };
}

/** A stored set that does not verify. `reason` names slugs, never content. */
export class GuardrailIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`guardrail integrity check failed: ${reason}`);
  }
}

export interface StoredSet {
  rows: Array<SignedRow & { hmac: string }>;
  overrides: Array<SignedOverride & { hmac: string }>;
  manifest: { version: number; entries: string; hmac: string } | null;
}

/**
 * Verify a stored set: the manifest first, then that the rows and overrides
 * are exactly the ones it lists (same versions, same enabled flags), then each
 * row's own HMAC. Throws GuardrailIntegrityError; returns the manifest version
 * (0 for an empty set that never had a manifest).
 */
export function verifySet(tenant: string, s: StoredSet): number {
  // Version 0 is the unsigned placeholder a first write locks on (Postgres);
  // like a missing manifest it stands for the empty set only.
  if (!s.manifest || (s.manifest.version === 0 && s.manifest.hmac === "")) {
    if (s.rows.length || s.overrides.length) throw new GuardrailIntegrityError("guardrail rows exist but the manifest is missing");
    return 0;
  }
  let entries: ManifestEntries;
  try {
    entries = JSON.parse(s.manifest.entries) as ManifestEntries;
  } catch {
    throw new GuardrailIntegrityError("the manifest entries are not readable");
  }
  if (!sameMac(s.manifest.hmac, manifestMac(tenant, s.manifest.version, entries))) {
    throw new GuardrailIntegrityError("the manifest signature does not verify");
  }
  const actual = manifestEntries(s.rows, s.overrides);
  const listed = new Map(entries.rows.map((r) => [r.slug, r]));
  for (const r of actual.rows) {
    const l = listed.get(r.slug);
    if (!l) throw new GuardrailIntegrityError(`guardrail '${r.slug}' is not in the manifest`);
    if (l.version !== r.version || l.enabled !== r.enabled) throw new GuardrailIntegrityError(`guardrail '${r.slug}' does not match the manifest's version`);
    listed.delete(r.slug);
  }
  if (listed.size) throw new GuardrailIntegrityError(`guardrail '${[...listed.keys()][0]}' is in the manifest but missing`);
  const listedO = new Map(entries.overrides.map((o) => [o.slug, o]));
  for (const o of actual.overrides) {
    const l = listedO.get(o.slug);
    if (!l) throw new GuardrailIntegrityError(`override '${o.slug}' is not in the manifest`);
    if (l.version !== o.version) throw new GuardrailIntegrityError(`override '${o.slug}' does not match the manifest's version`);
    listedO.delete(o.slug);
  }
  if (listedO.size) throw new GuardrailIntegrityError(`override '${[...listedO.keys()][0]}' is in the manifest but missing`);
  for (const r of s.rows) {
    if (!sameMac(r.hmac, rowMac(tenant, r))) throw new GuardrailIntegrityError(`guardrail '${r.slug}' signature does not verify`);
  }
  for (const o of s.overrides) {
    if (!sameMac(o.hmac, overrideMac(tenant, o))) throw new GuardrailIntegrityError(`override '${o.slug}' signature does not verify`);
  }
  return s.manifest.version;
}
