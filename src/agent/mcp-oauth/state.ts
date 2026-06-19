import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed OAuth `state` carrying a session identifier through the round-trip.
 *
 * A single always-on loopback listener serves every session's OAuth callback, so
 * the callback must say *which* session/flow it belongs to. We put the session id
 * in `state` (RFC 6749 §4.1.1 — opaque, client-set, echoed back verbatim) and HMAC
 * it so the listener can trust the sid it reads back without a server-side map.
 *
 *   state = b64url(sid) "." b64url(nonce) "." b64url(HMAC-SHA256(secret, "<sid>.<nonce>"))
 *
 * The nonce makes each flow's state unique (two concurrent connects for the same
 * session don't collide) and doubles as the CSRF guard. The MAC makes the sid
 * tamper-evident: a caller cannot forge a state for a session it shouldn't drive.
 */
export interface SignedState {
  sid: string;
  nonce: string;
}

function b64u(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

export function signState(sid: string, secret: string, nonce = randomBytes(16).toString("base64url")): string {
  const head = `${b64u(sid)}.${b64u(nonce)}`;
  const mac = createHmac("sha256", secret).update(head).digest("base64url");
  return `${head}.${mac}`;
}

/** Returns the {sid, nonce} when the MAC verifies, else null. Constant-time compare. */
export function verifyState(state: string, secret: string): SignedState | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [sidB, nonceB, mac] = parts as [string, string, string];
  const head = `${sidB}.${nonceB}`;
  const expected = createHmac("sha256", secret).update(head).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // base64url decode is lenient (never throws on bad input), and the MAC has
  // already verified, so the head is one we signed — decode is safe.
  return {
    sid: Buffer.from(sidB, "base64url").toString("utf8"),
    nonce: Buffer.from(nonceB, "base64url").toString("utf8"),
  };
}
