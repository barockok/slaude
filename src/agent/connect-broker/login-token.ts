import { createHmac, timingSafeEqual } from "node:crypto";

export type LoginClaims = { loginId: string; slackUserId: string; exp: number };

function sign(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Mint a URL-safe `body.sig` token. */
export function mintLoginToken(secret: Buffer, claims: LoginClaims): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyLoginToken(secret: Buffer, token: string, opts: { now: number }): LoginClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: LoginClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || opts.now > claims.exp) return null;
  return claims;
}
