/**
 * Self-issued panel session tokens (design §Data flow).
 *
 * The panel mints its own credentials so the identity provider is contacted
 * only during login. Two token types share one format and one secret,
 * distinguished by a `typ` claim so a refresh token can never be replayed as an
 * access token. A third, `flow`, carries the login round-trip state — there is
 * no server-side store to keep it in.
 *
 * HS256 over node:crypto rather than a JWT library: we are both minter and
 * verifier, so no algorithm negotiation surface should exist. The header's
 * `alg` is ignored and HS256 is always enforced, mirroring
 * src/gateway/api/auth.ts.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../../config/env";

export const AT_COOKIE = "panel_at";
export const RT_COOKIE = "panel_rt";
export const FLOW_COOKIE = "panel_flow";

export const AT_PATH = "/panel";
export const RT_PATH = "/panel/auth/refresh";
export const FLOW_PATH = "/panel/auth";

export const AT_TTL_SEC = 900;
/** Absolute, not sliding: refresh never re-issues the refresh cookie. */
export const RT_TTL_SEC = 28800;
export const FLOW_TTL_SEC = 600;

export type TokenType = "at" | "rt" | "flow";

export interface SessionClaims {
  sub: string;
  email: string;
  typ: TokenType;
  iat: number;
  exp: number;
  jti?: string;
}

export interface FlowPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export type VerifyReason = "missing" | "malformed" | "bad_signature" | "expired" | "wrong_type" | "unconfigured";

const b64uJson = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sign(headerAndPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(headerAndPayload).digest("base64url");
}

/** Constant-time equality; hashing first equalizes lengths. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function encode(payload: object, secret: string): string {
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const body = b64uJson(payload);
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

function decode<T>(
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

const ttlFor = (typ: "at" | "rt") => (typ === "at" ? AT_TTL_SEC : RT_TTL_SEC);

export function mintSession(
  who: { sub: string; email: string },
  typ: "at" | "rt",
  opts: { secret?: string; now?: number; ttlSec?: number } = {},
): string {
  const secret = opts.secret ?? env.panel.secret();
  if (!secret) throw new Error("SLAUDE_PANEL_SECRET is not set — cannot mint panel sessions");
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: SessionClaims = {
    sub: who.sub,
    email: who.email,
    typ,
    iat,
    exp: iat + (opts.ttlSec ?? ttlFor(typ)),
    ...(typ === "at" ? { jti: randomBytes(9).toString("base64url") } : {}),
  };
  return encode(claims, secret);
}

export function verifySession(
  token: string | null | undefined,
  expect: "at" | "rt",
  opts: { secret?: string; now?: number } = {},
): { ok: true; claims: SessionClaims } | { ok: false; reason: VerifyReason } {
  const r = decode<SessionClaims>(token, opts.secret ?? env.panel.secret(), opts.now ?? Date.now());
  if (!r.ok) return r;
  const claims = r.payload as SessionClaims;
  if (typeof claims.email !== "string" || typeof claims.sub !== "string") return { ok: false, reason: "malformed" };
  if (claims.typ !== expect) return { ok: false, reason: "wrong_type" };
  return { ok: true, claims };
}

export function mintFlow(payload: FlowPayload, opts: { secret?: string; now?: number } = {}): string {
  const secret = opts.secret ?? env.panel.secret();
  if (!secret) throw new Error("SLAUDE_PANEL_SECRET is not set — cannot mint panel sessions");
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  return encode({ ...payload, typ: "flow" as const, iat, exp: iat + FLOW_TTL_SEC }, secret);
}

export function verifyFlow(
  token: string | null | undefined,
  opts: { secret?: string; now?: number } = {},
): { ok: true; payload: FlowPayload } | { ok: false; reason: VerifyReason } {
  const r = decode<FlowPayload & { typ: TokenType }>(token, opts.secret ?? env.panel.secret(), opts.now ?? Date.now());
  if (!r.ok) return r;
  const p = r.payload;
  if (p.typ !== "flow") return { ok: false, reason: "wrong_type" };
  for (const k of ["state", "nonce", "verifier", "returnTo"] as const) {
    if (typeof p[k] !== "string") return { ok: false, reason: "malformed" };
  }
  return { ok: true, payload: { state: p.state, nonce: p.nonce, verifier: p.verifier, returnTo: p.returnTo } };
}

export function setCookie(name: string, value: string, opts: { path: string; maxAgeSec: number }): string {
  return `${name}=${value}; Max-Age=${opts.maxAgeSec}; Path=${opts.path}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
