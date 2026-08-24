/**
 * Encryption at rest for `(enc)` columns (slack_apps.bot_token, signing_secret,
 * provider_creds.value). AES-256-GCM keyed by SLAUDE_MASTER_KEY (32 bytes,
 * base64). Ciphertext envelope is a versioned, self-describing string so a
 * future key rotation can introduce `v2:` without a data migration:
 *
 *   v1:<iv b64>:<tag b64>:<ciphertext b64>
 *
 * Key rotation is out of scope (spec §4). The key is read lazily so importing
 * this module never throws in deployments that have no encrypted columns yet.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class MasterKeyError extends Error {}

let cachedKey: Buffer | null = null;

/** Decode + validate SLAUDE_MASTER_KEY. Cached after first success. */
export function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.SLAUDE_MASTER_KEY?.trim();
  if (!raw) {
    throw new MasterKeyError(
      "SLAUDE_MASTER_KEY is not set (32 random bytes, base64). Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new MasterKeyError(
      `SLAUDE_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  cachedKey = key;
  return key;
}

/** Test hook: forget the cached key so a changed env is re-read. */
export function __resetMasterKeyCache() {
  cachedKey = null;
}

export function encrypt(plaintext: string, key: Buffer = masterKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(envelope: string, key: Buffer = masterKey()): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`unsupported ciphertext envelope (expected ${VERSION}:iv:tag:ct)`);
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  // An authentication failure (wrong key or tampered ciphertext) throws here.
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** True when `value` looks like one of our envelopes (used to avoid double-encrypting). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}:`) && value.split(":").length === 4;
}
