import { createHash, randomBytes } from "node:crypto";

export interface Pkce { verifier: string; challenge: string; method: "S256"; }

/** RFC 7636 PKCE pair. Verifier is 32 random bytes base64url-encoded (43 chars). */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** Opaque CSRF state token. */
export function randomState(): string {
  return randomBytes(16).toString("base64url");
}
