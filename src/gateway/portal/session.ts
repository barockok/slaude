/**
 * Self-issued portal session tokens — the end-user counterpart to the panel's.
 *
 * The panel and the portal authenticate against the same identity provider and
 * sign with the same secret, so the boundary between an operator session and an
 * end-user session is the token's `typ` claim plus the cookie's path. Distinct
 * types mean a portal cookie can never be presented as an operator credential,
 * or the reverse, rather than relying on the panel's role lookup to catch it.
 *
 * The issuer travels in the claims because accounts are keyed on (issuer,
 * subject) and the guard re-resolves the account on every request, the way the
 * panel re-resolves roles: a deleted account stops working at the next request
 * rather than at the next refresh.
 */
import { randomBytes } from "node:crypto";
import { env } from "../../config/env";
import { encodeJwt, decodeJwt, type VerifyReason } from "../auth/jwt";

export { parseCookies, setCookie, clearCookie } from "../panel/auth/session";
export type { VerifyReason };

export const PORTAL_AT_COOKIE = "portal_at";
export const PORTAL_RT_COOKIE = "portal_rt";
export const PORTAL_FLOW_COOKIE = "portal_flow";

export const PORTAL_AT_PATH = "/portal";
export const PORTAL_RT_PATH = "/portal/auth/refresh";
export const PORTAL_FLOW_PATH = "/portal/auth";

export const PORTAL_AT_TTL_SEC = 900;
/** Absolute, not sliding: refresh never re-issues the refresh cookie. */
export const PORTAL_RT_TTL_SEC = 28800;
export const PORTAL_FLOW_TTL_SEC = 600;

export type PortalTokenType = "portal_at" | "portal_rt" | "portal_flow";

export interface PortalClaims {
  sub: string;
  email: string;
  /** Identity provider that authenticated this person. */
  iss: string;
  typ: "portal_at" | "portal_rt";
  iat: number;
  exp: number;
  jti?: string;
}

export interface PortalFlowPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

const ttlFor = (typ: "portal_at" | "portal_rt") =>
  typ === "portal_at" ? PORTAL_AT_TTL_SEC : PORTAL_RT_TTL_SEC;

function secretOr(opts: { secret?: string }): string {
  const secret = opts.secret ?? env.panel.secret();
  if (!secret) throw new Error("SLAUDE_PANEL_SECRET is not set — cannot mint portal sessions");
  return secret;
}

export function mintPortalSession(
  who: { sub: string; email: string; iss: string },
  typ: "portal_at" | "portal_rt",
  opts: { secret?: string; now?: number; ttlSec?: number } = {},
): string {
  const secret = secretOr(opts);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: PortalClaims = {
    sub: who.sub,
    email: who.email,
    iss: who.iss,
    typ,
    iat,
    exp: iat + (opts.ttlSec ?? ttlFor(typ)),
    ...(typ === "portal_at" ? { jti: randomBytes(9).toString("base64url") } : {}),
  };
  return encodeJwt(claims, secret);
}

export function verifyPortalSession(
  token: string | null | undefined,
  expect: "portal_at" | "portal_rt",
  opts: { secret?: string; now?: number } = {},
): { ok: true; claims: PortalClaims } | { ok: false; reason: VerifyReason } {
  const r = decodeJwt<PortalClaims>(token, opts.secret ?? env.panel.secret(), opts.now ?? Date.now());
  if (!r.ok) return r;
  const claims = r.payload as PortalClaims;
  // Type first: a panel session or an onboarding link is signed with the same
  // secret and would otherwise be reported as malformed, hiding the real reason
  // — that a token of another kind was presented here.
  if (claims.typ !== expect) return { ok: false, reason: "wrong_type" };
  for (const k of ["sub", "email", "iss"] as const) {
    if (typeof claims[k] !== "string") return { ok: false, reason: "malformed" };
  }
  return { ok: true, claims };
}

export function mintPortalFlow(
  payload: PortalFlowPayload,
  opts: { secret?: string; now?: number } = {},
): string {
  const secret = secretOr(opts);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  return encodeJwt(
    { ...payload, typ: "portal_flow" as const, iat, exp: iat + PORTAL_FLOW_TTL_SEC },
    secret,
  );
}

export function verifyPortalFlow(
  token: string | null | undefined,
  opts: { secret?: string; now?: number } = {},
): { ok: true; payload: PortalFlowPayload } | { ok: false; reason: VerifyReason } {
  const r = decodeJwt<PortalFlowPayload & { typ: PortalTokenType }>(
    token,
    opts.secret ?? env.panel.secret(),
    opts.now ?? Date.now(),
  );
  if (!r.ok) return r;
  const p = r.payload;
  if (p.typ !== "portal_flow") return { ok: false, reason: "wrong_type" };
  for (const k of ["state", "nonce", "verifier", "returnTo"] as const) {
    if (typeof p[k] !== "string") return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    payload: { state: p.state, nonce: p.nonce, verifier: p.verifier, returnTo: p.returnTo },
  };
}
