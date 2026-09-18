/**
 * Hand-rolled HS256 shared by every token slaude signs for a browser: the panel
 * session, the portal session and the onboarding link.
 *
 * A library is deliberately not used. We are both minter and verifier, so no
 * algorithm negotiation surface should exist: the header's `alg` is ignored and
 * HS256 is always enforced, which removes the alg-confusion class of bug by
 * construction rather than by configuration.
 *
 * src/gateway/api/auth.ts keeps its own copy on purpose. That is the
 * node-facing tool plane with its own claim validation and tests; it shares the
 * technique, not the code.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type VerifyReason =
  | "missing" | "malformed" | "bad_signature" | "expired" | "wrong_type" | "unconfigured";

const b64uJson = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sign(headerAndPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(headerAndPayload).digest("base64url");
}

/** Constant-time equality; hashing first equalizes lengths so neither content
 *  nor length leaks through the comparison. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function encodeJwt(payload: object, secret: string): string {
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const body = b64uJson(payload);
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

export function decodeJwt<T>(
  token: string | null | undefined,
  secret: string | undefined,
  nowMs: number,
): { ok: true; payload: T & { exp: number } } | { ok: false; reason: VerifyReason } {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  if (!timingSafeStringEqual(sign(`${head}.${body}`, secret), sig)) return { ok: false, reason: "bad_signature" };
  let payload: T & { exp: number };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
