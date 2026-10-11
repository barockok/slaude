import { utils } from "ssh2";

export interface SshKeyPair {
  privateKey: string;
  publicKey: string;
}

type RawGenerator = (comment: string) => { private: string; public: string };

const MAX_ATTEMPTS = 8;
/** ssh-ed25519 public blob: string "ssh-ed25519" (4 + 11) + string key (4 + 32). */
const ED25519_BLOB_LEN = 51;

const ssh2Generate: RawGenerator = (comment) => utils.generateKeyPairSync("ed25519", { comment });

/** True when both halves parse, describe the same key, and the key is a full
 *  32-byte ed25519 key. */
export function isValidSshKeyPair(privateKey: string, publicKey: string): boolean {
  const priv = utils.parseKey(privateKey);
  const pub = utils.parseKey(publicKey);
  if (!priv || !pub || priv instanceof Error || pub instanceof Error) return false;
  if (Array.isArray(priv) || Array.isArray(pub)) return false;
  const a = priv.getPublicSSH();
  const b = pub.getPublicSSH();
  return a.length === ED25519_BLOB_LEN && a.equals(b);
}

/** Generate an ed25519 pair that ssh2 can read back. ssh2's generator drops a
 *  leading zero byte of the public key (about 1 in 256 keys), producing a key
 *  that its own parser rejects; such results are discarded and regenerated. */
export function generateSshKeyPair(comment: string, generate: RawGenerator = ssh2Generate): SshKeyPair {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const k = generate(comment);
    if (isValidSshKeyPair(k.private, k.public)) return { privateKey: k.private, publicKey: k.public };
  }
  throw new Error("could not generate a valid ssh key");
}
