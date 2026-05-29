import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const NONCE_BYTES = 12; // 96-bit, the GCM standard
const TAG_BYTES = 16;

/**
 * Encrypt a credential blob with AES-256-GCM.
 * Layout: base64( nonce(12) || ciphertext || tag(16) ).
 * `connectionId` is bound as AAD so a row's ciphertext is useless in another row.
 */
export function encryptCred(key: Buffer, connectionId: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(connectionId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function decryptCred(key: Buffer, connectionId: string, packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(connectionId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
